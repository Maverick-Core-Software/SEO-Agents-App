#!/usr/bin/env node
/**
 * mav-bridge.mjs
 * Local bridge service — polls Supabase for approved items and executes them.
 * Run via PM2. Survives reboots and restarts automatically.
 *
 * Responsibilities:
 *   - Picks up approved facebook/gbp posts and runs posting scripts
 *   - Picks up approved website tasks and runs the relevant agents
 *   - Writes execution results back to Supabase
 *   - Logs everything to run_logs table
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.MAV_BRIDGE_POLL_MS || '30000');
const SEO_AGENTS_EXE = process.env.SEO_AGENTS_EXE
  || 'C:\\Users\\carte\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\seo-agents.exe';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[mav-bridge] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────

async function log(runId, phase, level, message) {
  const line = `[mav-bridge][${phase}][${level}] ${message}`;
  console.log(line);
  if (runId) {
    await supabase.from('run_logs').insert({ run_id: runId, phase, level, message });
  }
}

// ─────────────────────────────────────────────
// Run a phase and capture output
// ─────────────────────────────────────────────

async function runPhase(runId, phase, exe, args, cwd) {
  await log(runId, phase, 'info', `Starting: ${exe} ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      cwd: cwd || PROJECT_ROOT,
      timeout: 15 * 60 * 1000,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (stderr) await log(runId, phase, 'info', stderr.slice(0, 2000));
    await log(runId, phase, 'info', `Done: ${stdout.slice(0, 500)}`);
    return { ok: true, stdout, stderr };
  } catch (e) {
    await log(runId, phase, 'error', e.message.slice(0, 500));
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────
// Handle an approved run
// ─────────────────────────────────────────────

async function executeApprovedRun(run) {
  const { id: runId } = run;
  await log(runId, 'bridge', 'info', `Executing approved run ${runId}`);

  // Mark as executing
  await supabase.from('seo_runs').update({ status: 'executing' }).eq('id', runId);

  let allOk = true;

  // ── 1. Facebook posts (highest priority) ──────────────────────
  const { data: fbPosts } = await supabase
    .from('weekly_posts')
    .select('*')
    .eq('run_id', runId)
    .eq('platform', 'facebook')
    .eq('status', 'approved')
    .order('day');

  if (fbPosts?.length) {
    await log(runId, 'facebook', 'info', `Posting ${fbPosts.length} Facebook posts`);
    await supabase.from('weekly_posts')
      .update({ status: 'posting' })
      .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'approved');

    const result = await runPhase(runId, 'facebook', 'node', [
      path.join(PROJECT_ROOT, 'scripts', 'facebook-post-week.mjs'),
    ], PROJECT_ROOT);

    const status = result.ok ? 'posted' : 'error';
    await supabase.from('weekly_posts')
      .update({ status, error: result.ok ? null : result.error, posted_at: new Date().toISOString() })
      .eq('run_id', runId).eq('platform', 'facebook').eq('status', 'posting');

    if (!result.ok) allOk = false;
  }

  // ── 2. GBP posts ───────────────────────────────────────────────
  const { data: gbpPosts } = await supabase
    .from('weekly_posts')
    .select('*')
    .eq('run_id', runId)
    .eq('platform', 'gbp')
    .eq('status', 'approved');

  if (gbpPosts?.length) {
    await log(runId, 'gbp', 'info', `Posting ${gbpPosts.length} GBP posts`);
    await supabase.from('weekly_posts')
      .update({ status: 'posting' })
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');

    const result = await runPhase(runId, 'gbp', SEO_AGENTS_EXE, ['gbp-post'], PROJECT_ROOT);

    const status = result.ok ? 'posted' : 'error';
    await supabase.from('weekly_posts')
      .update({ status, error: result.ok ? null : result.error, posted_at: new Date().toISOString() })
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'posting');

    if (!result.ok) allOk = false;
  }

  // ── 3. Website tasks (approved, ordered by priority) ──────────
  const { data: tasks } = await supabase
    .from('website_tasks')
    .select('*')
    .eq('run_id', runId)
    .eq('status', 'approved')
    .order('priority'); // critical first

  if (tasks?.length) {
    await log(runId, 'website', 'info', `Executing ${tasks.length} website tasks`);
    for (const task of tasks) {
      await supabase.from('website_tasks').update({ status: 'executing' }).eq('id', task.id);
      const result = await runPhase(runId, 'website', SEO_AGENTS_EXE,
        ['website-task', '--task-id', task.id], PROJECT_ROOT);
      await supabase.from('website_tasks').update({
        status: result.ok ? 'done' : 'error',
        error: result.ok ? null : result.error,
        completed_at: new Date().toISOString(),
      }).eq('id', task.id);
      if (!result.ok) allOk = false;
    }
  }

  // ── Mark run done ──────────────────────────────────────────────
  await supabase.from('seo_runs').update({
    status: allOk ? 'done' : 'error',
    done_at: new Date().toISOString(),
    error: allOk ? null : 'One or more phases failed — check run_logs',
  }).eq('id', runId);

  await log(runId, 'bridge', allOk ? 'info' : 'warn',
    `Run ${runId} complete — ${allOk ? 'all phases succeeded' : 'some phases failed'}`);
}

// ─────────────────────────────────────────────
// Poll loop
// ─────────────────────────────────────────────

let busy = false;

async function poll() {
  if (busy) return;
  busy = true;
  try {
    // Find runs that are approved and not yet executing
    const { data: runs, error } = await supabase
      .from('seo_runs')
      .select('*')
      .eq('status', 'approved')
      .order('created_at')
      .limit(1);

    if (error) {
      console.error('[mav-bridge] Supabase poll error:', error.message);
      return;
    }

    if (runs?.length) {
      await executeApprovedRun(runs[0]);
    }
  } catch (e) {
    console.error('[mav-bridge] Poll exception:', e.message);
  } finally {
    busy = false;
  }
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

console.log(`[mav-bridge] Starting — polling Supabase every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[mav-bridge] Project root: ${PROJECT_ROOT}`);

poll(); // run immediately on start
setInterval(poll, POLL_INTERVAL_MS);
