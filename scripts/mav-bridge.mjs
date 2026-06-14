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

import http from 'node:http';
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
const BRIDGE_PORT = parseInt(process.env.MAV_BRIDGE_PORT || '8790');
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
    const detail = [e.message, e.stderr, e.stdout].filter(Boolean).join('\n').slice(0, 1500);
    await log(runId, phase, 'error', detail);
    return { ok: false, error: detail };
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

    const result = await runPhase(runId, 'gbp', SEO_AGENTS_EXE, ['sync-gbp-schedule'], PROJECT_ROOT);

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
// HTTP server (MCC dashboard connects here)
// ─────────────────────────────────────────────

function sendJsonHttp(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function handleHttpRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  const { method } = req;

  // ── GET /health ─────────────────────────────
  if (method === 'GET' && url.pathname === '/health') {
    sendJsonHttp(res, 200, { state: 'online', service: 'mav-bridge', uptime: process.uptime() });
    return;
  }

  // ── GET /seo/status ─────────────────────────
  if (method === 'GET' && url.pathname === '/seo/status') {
    const [runsRes, postsRes] = await Promise.all([
      supabase.from('seo_runs').select('*').order('created_at', { ascending: false }).limit(20),
      supabase.from('weekly_posts').select('platform,status').order('created_at', { ascending: false }).limit(100),
    ]);
    const runs = runsRes.data || [];
    const posts = postsRes.data || [];
    const latest = runs[0] || null;

    const statusCounts = { complete: 0, partial: 0, blocked: 0, incomplete: 0 };
    for (const r of runs) {
      if (r.status === 'done') statusCounts.complete++;
      else if (['posting', 'posted', 'executing'].includes(r.status)) statusCounts.partial++;
      else if (r.status === 'error') statusCounts.blocked++;
      else statusCounts.incomplete++;
    }

    const pendingPosts = posts.filter(p => p.status === 'pending_approval');
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const reports = runs
      .filter(r => ['done', 'posted', 'pending_approval', 'approved', 'error'].includes(r.status))
      .map(r => ({
        id: r.id,
        date: r.created_at,
        updatedAt: r.done_at || r.created_at,
        status: r.status === 'pending_approval' ? 'needs_approval' : r.status === 'error' ? 'blocked' : 'complete',
        source: 'mav-bridge',
        label: `Run ${r.week_of || r.id?.slice(0, 8) || '?'}`,
      }));

    sendJsonHttp(res, 200, {
      state: latest?.status || 'idle',
      reports,
      faults: runs.filter(r => r.status === 'error').slice(0, 3)
        .map(r => r.error || `Run ${r.id?.slice(0, 8)} failed`),
      activeWorkflow: {
        name: 'SEO Automation',
        phase: latest?.status || 'idle',
        reportsGenerated: reports.filter(r => new Date(r.date).getTime() > sevenDaysAgo).length,
      },
      statusCounts,
      workflowStatus: {
        actions: {
          actions: [],
          summary: {
            needs_approval: pendingPosts.length,
            blocked_access: posts.filter(p => p.status === 'error').length,
          },
        },
      },
      runHealth: null,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // ── GET /seo/actions ────────────────────────
  if (method === 'GET' && url.pathname === '/seo/actions') {
    const [runsRes, postsRes, tasksRes] = await Promise.all([
      supabase.from('seo_runs').select('*').eq('status', 'pending_approval').order('created_at').limit(10),
      supabase.from('weekly_posts').select('*').in('status', ['pending_approval', 'error']).order('day').limit(50),
      supabase.from('website_tasks').select('*').eq('status', 'pending_approval').order('priority').limit(20),
    ]);
    const runs = runsRes.data || [];
    const posts = postsRes.data || [];
    const tasks = tasksRes.data || [];

    const actions = [
      ...runs.map(r => ({
        id: r.id,
        type: 'seo_run',
        status: 'needs_approval',
        label: `SEO Run ${r.week_of || r.id?.slice(0, 8)}`,
        approval_required: true,
        approval: null,
        live_adapter: 'mav-bridge',
        posts_count: posts.filter(p => p.run_id === r.id).length,
      })),
      ...tasks.map(t => ({
        id: t.id,
        type: 'website_task',
        status: 'needs_approval',
        label: t.title || `Task ${t.id?.slice(0, 8)}`,
        approval_required: true,
        approval: null,
        live_adapter: 'mav-bridge',
      })),
    ];

    sendJsonHttp(res, 200, {
      actions,
      summary: {
        needs_approval: runs.length + tasks.length,
        blocked_access: posts.filter(p => p.status === 'error').length,
      },
    });
    return;
  }

  // ── POST /seo/actions/approve ────────────────
  if (method === 'POST' && url.pathname === '/seo/actions/approve') {
    const { actionId, note } = await readBody(req);
    if (!actionId) { sendJsonHttp(res, 400, { error: 'actionId required' }); return; }

    // Try seo_run first
    const { data: run } = await supabase.from('seo_runs')
      .update({ status: 'approved', approved_by: 'MCC', approved_at: new Date().toISOString(), note: note || null })
      .eq('id', actionId).eq('status', 'pending_approval')
      .select().maybeSingle();

    if (run) { sendJsonHttp(res, 200, { ok: true, type: 'seo_run', id: run.id }); return; }

    // Try website_task
    const { data: task } = await supabase.from('website_tasks')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', actionId)
      .select().maybeSingle();

    if (task) { sendJsonHttp(res, 200, { ok: true, type: 'website_task', id: task.id }); return; }

    sendJsonHttp(res, 404, { error: 'Action not found or already approved' });
    return;
  }

  // ── POST /seo/actions/run ────────────────────
  if (method === 'POST' && url.pathname === '/seo/actions/run') {
    const { actionId, live } = await readBody(req);
    if (!live) {
      sendJsonHttp(res, 200, { ok: true, mode: 'dry_run', message: 'Dry run — no changes made.' });
      return;
    }
    const { data: run } = await supabase.from('seo_runs')
      .update({ status: 'approved' })
      .eq('id', actionId)
      .select().maybeSingle();

    if (!run) { sendJsonHttp(res, 404, { error: 'Run not found' }); return; }
    sendJsonHttp(res, 200, { ok: true, mode: 'live', runId: run.id, message: 'Approved — bridge will execute on next poll.' });
    return;
  }

  sendJsonHttp(res, 404, { error: 'Not found' });
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

console.log(`[mav-bridge] Starting — polling Supabase every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[mav-bridge] Project root: ${PROJECT_ROOT}`);

const httpServer = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch(e => {
    console.error('[mav-bridge][http] Unhandled error:', e.message);
    try { sendJsonHttp(res, 500, { error: 'Internal server error' }); } catch {}
  });
});
httpServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[mav-bridge] HTTP server listening on http://127.0.0.1:${BRIDGE_PORT}`);
});

poll(); // run immediately on start
setInterval(poll, POLL_INTERVAL_MS);
