#!/usr/bin/env node
/**
 * gbp-worker.mjs
 * User-session GBP poster. Runs as `carte` via a Windows Scheduled Task
 * ("run only when user is logged on") so the saved Google session
 * (C:\Users\carte\.claude\gbp-session), the H:\ Drive mount, and a visible
 * browser are all available — none of which exist under the LocalSystem
 * mav-bridge service.
 *
 * Owns the `gbp` slice of weekly_posts; mav-bridge owns facebook/website.
 * Disjoint platform ownership over the shared Supabase queue = no double-post.
 * The worker writes error/needs_verification status to weekly_posts; mav-bridge's
 * existing fault-detection alerts on it. The worker does NOT own seo_runs.status —
 * that truthfulness is derived by mav-bridge's liveRunStatus from all posts.
 *
 * Usage:
 *   node gbp-worker.mjs           Poll forever (default; the Scheduled Task runs this)
 *   node gbp-worker.mjs --once    One poll pass, then exit (smoke/manual test)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { makeRunPhase } from './lib/run-phase.mjs';
import { centralDateHour, runGbpForApprovedRun, runDailyGbp } from './lib/gbp-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env — mirrors mav-bridge's manual loader exactly (same project-root path,
// same line regex, same "don't clobber an already-set env var" rule).
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.GBP_WORKER_POLL_MS || process.env.MAV_BRIDGE_POLL_MS || '30000');
const SEO_AGENTS_EXE = process.env.SEO_AGENTS_EXE
  || 'C:\\Users\\carte\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\seo-agents.exe';
const GBP_POSTER_PATH = path.join(PROJECT_ROOT, 'scripts', 'gbp-poster', 'driver.mjs');
const PHOTO_PICK_PATH = path.join(PROJECT_ROOT, 'scripts', 'gbp-photo-pick.mjs');
const GBP_VERIFY_PATH = path.join(PROJECT_ROOT, 'scripts', 'verify-gbp-posts.mjs');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[gbp-worker] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─────────────────────────────────────────────
// Logging — own Supabase client, but same run_logs schema mav-bridge writes.
// ─────────────────────────────────────────────

async function log(runId, phase, level, message) {
  const line = `[gbp-worker][${phase}][${level}] ${message}`;
  console.log(line);
  if (runId) {
    const { error } = await supabase.from('run_logs').insert({ run_id: runId, phase, level, message });
    if (error) console.error(`[gbp-worker][gbp-worker→supabase][error] log insert failed: ${error.message}`);
  }
}

// Structured per-hop error logging, mirroring mav-bridge's hopError. `hop` is e.g.
// 'gbp-worker→supabase', 'gbp-worker→subprocess:gbp'.
async function hopError(runId, phase, hop, message, err) {
  const detail = err ? `${message}: ${err.message || err}` : message;
  const rec = { ts: new Date().toISOString(), source: 'gbp-worker', hop, phase, message: detail };
  console.error(`[gbp-worker][${hop}][error] ${detail}`);
  console.error(`  ↳ ${JSON.stringify(rec)}`);
  if (runId) {
    const { error } = await supabase.from('run_logs')
      .insert({ run_id: runId, phase, level: 'error', message: `[${hop}] ${detail}` });
    if (error) console.error(`[gbp-worker][gbp-worker→supabase][error] could not write hop error: ${error.message}`);
  }
}

// makeRunPhase takes a hopPrefix (defaults to 'mav-bridge'). Pass 'gbp-worker' so
// this process's subprocess faults are attributed to the worker, not the service.
const runPhase = makeRunPhase({ log, hopError, projectRoot: PROJECT_ROOT, hopPrefix: 'gbp-worker' });
const paths = { photoPick: PHOTO_PICK_PATH, gbpPoster: GBP_POSTER_PATH, seoAgentsExe: SEO_AGENTS_EXE };

// ─────────────────────────────────────────────
// Poll loop
// ─────────────────────────────────────────────

let busy = false;
let lastDailyGbpDate = '';

// Post-posting verification state. After a GBP post runs (or an unverified row is
// detected), schedule verification checks: wait 10min, then check every 15min
// up to 4 attempts. If none succeed, mark the post as error.
let verifyQueue = [];  // { postId, date, runId, attempt, nextAt }
let lastVerifyCheckAt = 0;
const VERIFY_INITIAL_DELAY_MS = 10 * 60 * 1000;   // 10 min after post
const VERIFY_RETRY_INTERVAL_MS = 15 * 60 * 1000;  // 15 min between retries
const VERIFY_MAX_ATTEMPTS = 4;

async function poll() {
  if (busy) return;
  busy = true;
  try {
    // 1. Approved-run GBP: claim this run's gbp rows (approved -> posting) so a second
    //    poll can't double-process, then run curation + sync + Day-1 + mark Days 2-7.
    const { data: approved, error: apprErr } = await supabase
      .from('weekly_posts')
      .select('*')
      .eq('platform', 'gbp')
      .eq('status', 'approved')
      .order('run_id');
    if (apprErr) console.error(`[gbp-worker][gbp-worker→supabase][error] approved query: ${apprErr.message}`);

    if (approved?.length) {
      // Process the earliest run_id only (mirrors mav-bridge's one-run-per-poll).
      const runId = approved[0].run_id;
      // Claim BEFORE running so a concurrent poll (or mav-bridge's GBP_ON path)
      // can't double-process. Atomic CAS on status='approved' — only rows still
      // 'approved' at claim time are returned; a race loses and gets zero rows.
      const { data: claimed, error: claimErr } = await supabase.from('weekly_posts')
        .update({ status: 'posting' })
        .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved')
        .select('id');
      if (claimErr || !claimed?.length) {
        await log(runId, 'gbp', 'warn', `GBP claim race: ${claimErr?.message || 'no rows claimed'} — another worker may own these`);
      } else {
        await log(runId, 'gbp', 'info', `Claimed ${claimed.length} gbp post(s) for run ${String(runId).slice(0, 8)}`);
        const claimedIds = new Set(claimed.map(c => c.id));
        const gbpPosts = approved.filter(p => p.run_id === runId && claimedIds.has(p.id));
        await runGbpForApprovedRun({
          runId,
          gbpPosts,
          deps: { supabase, runPhase, log, env: process.env, projectRoot: PROJECT_ROOT, paths },
        });
      }
    }

    // 2. Daily poster: today's scheduled gbp rows, once/day >=9am Central.
    const { todayDate, cstHour } = centralDateHour(new Date());
    if (cstHour >= 9 && lastDailyGbpDate !== todayDate) {
      await runDailyGbp({
        supabase, runPhase, log,
        env: process.env,
        todayDate, gbpPosterPath: GBP_POSTER_PATH, projectRoot: PROJECT_ROOT,
      });
      // Mark the day done only after a successful run — a throw here lets the next
      // poll retry today instead of silently skipping the day's posts.
      lastDailyGbpDate = todayDate;
    }

    // 3. Post-posting verification: after a GBP post runs, we want to confirm it
    //    actually landed. The driver.mjs does its own inline verification, but if
    //    the process gets interrupted (exit code mismatch, timeout, bash kill),
    //    the row may sit at 'posted' with no platform_post_id.
    //
    //    Flow: wait 10min → check every 15min up to 4 attempts → mark error if
    //    still unverified. This is driven by verifyQueue, populated when a post
    //    is freshly claimed/posted and the result is missing a platform_post_id.
    const now = Date.now();

    // Seed the queue: find posted rows from the last 24h with no platform_post_id
    // that aren't already in the queue.
    if (now - lastVerifyCheckAt > 60_000) {  // scan Supabase at most once per minute
      lastVerifyCheckAt = now;
      const cutoff = new Date(now - 24 * 3600000).toISOString();
      const { data: unverified } = await supabase
        .from('weekly_posts')
        .select('id, run_id, post_date')
        .eq('platform', 'gbp')
        .in('status', ['posted', 'needs_verification'])
        .is('platform_post_id', null)
        .gte('updated_at', cutoff);
      for (const row of unverified || []) {
        if (!verifyQueue.some(q => q.postId === row.id)) {
          verifyQueue.push({
            postId: row.id,
            date: row.post_date,
            runId: row.run_id,
            attempt: 0,
            nextAt: now + VERIFY_INITIAL_DELAY_MS,
          });
          await log(row.run_id, 'gbp', 'info',
            `Queued verification for ${row.post_date} (check in ${VERIFY_INITIAL_DELAY_MS / 60000}min)`);
        }
      }
    }

    // Process the queue: run checks that are due.
    const due = verifyQueue.filter(q => q.attempt < VERIFY_MAX_ATTEMPTS && now >= q.nextAt);
    for (const item of due) {
      item.attempt++;
      const isLast = item.attempt >= VERIFY_MAX_ATTEMPTS;

      if (fs.existsSync(GBP_VERIFY_PATH)) {
        await log(item.runId, 'gbp', 'info',
          `Verify attempt ${item.attempt}/${VERIFY_MAX_ATTEMPTS} for ${item.date}`);
        const r = await runPhase(item.runId, 'gbp', 'node',
          [GBP_VERIFY_PATH, '--date', String(item.date).slice(0, 10), '--headless', '--once'],
          PROJECT_ROOT);

        if (r.ok) {
          try {
            const lastLine = (r.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
            if (lastLine) {
              const parsed = JSON.parse(lastLine);
              if (parsed.verified > 0) {
                // Verification succeeded — remove from queue
                verifyQueue = verifyQueue.filter(q => q.postId !== item.postId);
                await log(item.runId, 'gbp', 'info', `Verification confirmed for ${item.date}`);
                continue;
              }
            }
          } catch { /* parse failure — treat as unverified */ }
        }

        // Not verified yet
        if (isLast) {
          await log(item.runId, 'gbp', 'warn',
            `Verification failed after ${VERIFY_MAX_ATTEMPTS} attempts for ${item.date} — marking error`);
          await supabase.from('weekly_posts')
            .update({ status: 'error', error: 'GBP verification failed after 4 attempts over 1hr — post may not be live' })
            .eq('id', item.postId);
          verifyQueue = verifyQueue.filter(q => q.postId !== item.postId);
        } else {
          item.nextAt = now + VERIFY_RETRY_INTERVAL_MS;
          await log(item.runId, 'gbp', 'info',
            `Not found yet, retry in ${VERIFY_RETRY_INTERVAL_MS / 60000}min`);
        }
      }
    }
  } catch (e) {
    console.error(`[gbp-worker][gbp-worker→poll][error] poll exception: ${e.message}`);
  } finally {
    busy = false;
  }
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

const once = process.argv.includes('--once');
console.log(`[gbp-worker] Starting — project root: ${PROJECT_ROOT}`);
if (once) {
  await poll();
  console.log('[gbp-worker] --once complete');
  process.exit(0);
} else {
  console.log(`[gbp-worker] Polling Supabase every ${POLL_INTERVAL_MS / 1000}s`);
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}
