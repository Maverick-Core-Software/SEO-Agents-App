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
 *   node gbp-worker.mjs               Poll forever (default; the Scheduled Task runs this)
 *   node gbp-worker.mjs --once        One poll pass, then exit (can claim + post)
 *   node gbp-worker.mjs --probe-only  Record session health and exit (no claims, no polling)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { makeRunPhase } from './lib/run-phase.mjs';
import { centralDateHour, runGbpForApprovedRun, runDailyGbp, markGbpPostedAndArchive, applyDriverResult, parseDriverJson } from './lib/gbp-runner.mjs';
import { sendHermesAlert } from './lib/hermes-alert.mjs';

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

// Import-safe: focused tests need the pure queue-policy helper without starting
// a worker or requiring database credentials.
const invokedDirectly = process.argv[1]
  && fs.realpathSync.native(fileURLToPath(import.meta.url))
    === fs.realpathSync.native(path.resolve(process.argv[1]));
const POLL_INTERVAL_MS = parseInt(process.env.GBP_WORKER_POLL_MS || process.env.MAV_BRIDGE_POLL_MS || '30000');
const SEO_AGENTS_EXE = process.env.SEO_AGENTS_EXE
  || [
    path.join(PROJECT_ROOT, '.venv', 'Scripts', 'seo-agents.exe'),
    path.join(PROJECT_ROOT, '.venv', 'bin', 'seo-agents'),
    'C:\\Users\\carte\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\seo-agents.exe',
  ].find((p) => fs.existsSync(p))
  || path.join(PROJECT_ROOT, '.venv', 'Scripts', 'seo-agents.exe');
// GBP_POSTER selects the posting engine: 'playwright' (default while project
// quota stays 0) or 'api' (direct REST via gbp-api-poster.mjs once quota >0).
const GBP_MODE = (process.env.GBP_POSTER || 'playwright').toLowerCase();
const GBP_POSTER_PATH = GBP_MODE === 'playwright'
  ? path.join(PROJECT_ROOT, 'scripts', 'gbp-poster', 'driver.mjs')
  : path.join(PROJECT_ROOT, 'scripts', 'gbp-api-poster.mjs');
const PHOTO_PICK_PATH = path.join(PROJECT_ROOT, 'scripts', 'gbp-photo-pick.mjs');
const WORKER_LOCK_PATH = path.join(PROJECT_ROOT, 'state', 'gbp-worker.pid');
const STUCK_POLL_MS = parseInt(process.env.GBP_WORKER_STUCK_MS || String(20 * 60 * 1000), 10);

export function gbpWorkerProcessExists(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Single-instance lock. A live owner keeps the pidfile; a stale pid (dead
// process after a crash or schtasks /end orphan) is taken over so the daily
// 8am trigger can start a replacement instead of dying with 0x800710E0 while
// a zombie from days ago still holds IgnoreNew.
// The create is exclusive (flag 'wx'): if the pidfile appears between the read and
// the create, the holder is re-checked and only a dead/mine holder is taken over.
export function acquireGbpWorkerLock({
  pidPath = WORKER_LOCK_PATH,
  pid = process.pid,
  isAlive = gbpWorkerProcessExists,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  writeFile = (p, c) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c, { flag: 'wx' });
  },
  unlink = (p) => fs.unlinkSync(p),
} = {}) {
  const readPid = () => {
    try { return parseInt(String(readFile(pidPath) || '').trim(), 10) || 0; } catch { return 0; }
  };
  const existingPid = readPid();
  if (existingPid && existingPid !== pid && isAlive(existingPid)) {
    return { ok: false, existingPid, pidPath };
  }
  try {
    writeFile(pidPath, String(pid));
    return { ok: true, existingPid: existingPid || null, pidPath };
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }
  // A concurrent starter or a stale file won the create. Refuse a live foreign
  // owner; otherwise remove the stale file once and retry (another starter may
  // still beat us to it — that is a refusal, not a second owner).
  const holder = readPid();
  if (holder && holder !== pid && isAlive(holder)) return { ok: false, existingPid: holder, pidPath };
  try {
    unlink(pidPath);
    writeFile(pidPath, String(pid));
  } catch (retryErr) {
    if (retryErr?.code !== 'EEXIST') throw retryErr;
    return { ok: false, existingPid: null, pidPath };
  }
  return { ok: true, existingPid: existingPid || null, pidPath };
}

export function releaseGbpWorkerLock(pidPath = WORKER_LOCK_PATH, pid = process.pid) {
  try {
    const existing = parseInt(String(fs.readFileSync(pidPath, 'utf8') || '').trim(), 10) || 0;
    if (!existing || existing === pid) fs.unlinkSync(pidPath);
  } catch { /* no lock to release */ }
}

if (invokedDirectly && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
  console.error('[gbp-worker] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}

const supabase = invokedDirectly ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// ─────────────────────────────────────────────
// Logging — own Supabase client, but same run_logs schema mav-bridge writes.
// ─────────────────────────────────────────────

// supabase-js puts the whole response body into error.message. When Supabase is
// behind a Cloudflare 5xx that body is a full HTML error page, so a single failed
// query dumps ~10KB into the log — 17 of them made up 180KB of a 182KB log file and
// buried the actual symptom. Summarise HTML down to its <title>, truncate the rest.
function briefErr(err) {
  const raw = String(err?.message ?? err ?? '');
  if (!raw.trimStart().startsWith('<')) {
    return raw.length > 300 ? `${raw.slice(0, 300)}… (${raw.length} chars)` : raw;
  }
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/\s+/g, ' ').trim();
  return `HTML error page (${raw.length} bytes): ${title || 'no <title>'}`;
}

async function log(runId, phase, level, message) {
  const line = `[gbp-worker][${phase}][${level}] ${message}`;
  console.log(line);
  if (runId) {
    const { error } = await supabase.from('run_logs').insert({ run_id: runId, phase, level, message });
    if (error) console.error(`[gbp-worker][gbp-worker→supabase][error] log insert failed: ${briefErr(error)}`);
  }
}

// Structured per-hop error logging, mirroring mav-bridge's hopError. `hop` is e.g.
// 'gbp-worker→supabase', 'gbp-worker→subprocess:gbp'.
async function hopError(runId, phase, hop, message, err) {
  const detail = err ? `${message}: ${briefErr(err)}` : message;
  const rec = { ts: new Date().toISOString(), source: 'gbp-worker', hop, phase, message: detail };
  console.error(`[gbp-worker][${hop}][error] ${detail}`);
  console.error(`  ↳ ${JSON.stringify(rec)}`);
  if (runId) {
    const { error } = await supabase.from('run_logs')
      .insert({ run_id: runId, phase, level: 'error', message: `[${hop}] ${detail}` });
    if (error) console.error(`[gbp-worker][gbp-worker→supabase][error] could not write hop error: ${briefErr(error)}`);
  }
}

// makeRunPhase takes a hopPrefix (defaults to 'mav-bridge'). Pass 'gbp-worker' so
// this process's subprocess faults are attributed to the worker, not the service.
const runPhase = makeRunPhase({ log, hopError, projectRoot: PROJECT_ROOT, hopPrefix: 'gbp-worker' });
const paths = { photoPick: PHOTO_PICK_PATH, gbpPoster: GBP_POSTER_PATH, seoAgentsExe: SEO_AGENTS_EXE };

// ─────────────────────────────────────────────
// G3: session probe + ownership handoff
// ─────────────────────────────────────────────
// The probe is `driver.mjs --check-session`: same saved profile, same login check,
// no composer, no schedule row. It gates every posting path — an expired, captcha'd
// or unverifiable session must not claim approved rows, run the 9am path, or retry a
// Grok verdict. GBP_POSTER=api has no browser session, so API mode is unchanged.
const SESSION_PROBE_SUPPORTED = GBP_MODE === 'playwright';
const SESSION_HEALTH_PATH = path.join(PROJECT_ROOT, 'state', 'gbp-session-health.json');
const SESSION_PROBE_HOUR = 8;                 // 08:00 Central, before the 09:00 posting tick
const SESSION_PROBE_TIMEOUT_MS = parseInt(process.env.GBP_SESSION_PROBE_MS || '300000', 10);
const SESSION_PROBE_BACKOFF_MS = parseInt(process.env.GBP_SESSION_PROBE_BACKOFF_MS || String(15 * 60 * 1000), 10);

// The driver's --check-session contract is one bounded {ok, reason} JSON line and
// exit 0 or 2. Anything else (crash, timeout, a live-post result) is not a pass.
export function parseSessionProbe(result) {
  const parsed = parseDriverJson(result?.stdout || '');
  if (parsed.ok === true) return { ok: true, reason: 'ok' };
  return { ok: false, reason: (String(parsed.reason || '').trim() || 'unknown').slice(0, 40) };
}

// state/gbp-session-health.json carries the fresh timestamp, the probing PID, the
// worker context and the reason, so a stale or foreign record cannot be taken for
// this probe's result. The posting gate is in-memory per ownership and never reads
// this file back.
export function writeGbpSessionHealth(record, {
  source = SESSION_HEALTH_PATH,
  writeFile = (p, c) => fs.writeFileSync(p, c),
} = {}) {
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    writeFile(source, JSON.stringify(record));
  } catch (e) {
    console.error(`[gbp-worker][health] write failed: ${briefErr(e)}`);
  }
  return record;
}

// Ownership + session state machine. Every side effect is injected, so the handoff
// (failed probe → release → interactive takeover → idle → reacquire + passing probe)
// is testable without a browser, a pidfile, or Supabase.
export function createGbpSessionState({
  pid = process.pid,
  supported = SESSION_PROBE_SUPPORTED,
  acquire = () => acquireGbpWorkerLock(),
  release = () => releaseGbpWorkerLock(WORKER_LOCK_PATH, pid),
  probe = async () => ({ ok: false, reason: 'unknown' }),
  // P2.8: refresh the exported storageState after a passing probe. Injected so the
  // handoff stays testable without a browser; production passes the driver child.
  refreshState = async () => ({ ok: false, reason: 'not_supported' }),
  recordHealth = (record) => writeGbpSessionHealth(record),
  alert = async () => {},
  log = async () => {},
  now = () => Date.now(),
  backoffMs = SESSION_PROBE_BACKOFF_MS,
} = {}) {
  let owned = false;
  let sessionOk = !supported;   // API mode has no session to probe
  let alerted = false;
  let releasePending = false;
  let lastDailyProbeDate = '';
  let lastProbeAt = 0;
  let idleLogged = false;

  return {
    get owned() { return owned; },
    get sessionOk() { return sessionOk; },

    // Posting work needs ownership AND a passing probe for that ownership.
    canPost() { return owned && sessionOk; },

    // Exclusive reacquisition. acquireGbpWorkerLock refuses while a different live
    // pid owns the pidfile, so an idle process never touches a live lock — and never
    // reaches the profile or the health record either.
    async tryAcquire() {
      if (owned) return { ok: true, existingPid: pid };
      // Wait out the probe backoff before reacquiring. After a failing probe released
      // ownership, reacquiring on the very next poll tick would relaunch Chromium
      // every ~30s against Google — the hammer that trips unusual-traffic detection
      // and worsens the failure it reports. The retry cadence is the backoff, not the
      // poll interval, so a solo worker stays idle in between.
      if (!sessionOk && lastProbeAt && (now() - lastProbeAt) < backoffMs) {
        if (!idleLogged) {
          idleLogged = true;
          await log(`idle — session probe failed; waiting out the ${Math.round(backoffMs / 60000)}min retry backoff before the next attempt (not touching the lock, profile, or health record)`);
        }
        return { ok: false, existingPid: null, backoff: true };
      }
      const result = await acquire();
      if (!result?.ok) {
        sessionOk = false;
        if (!idleLogged) {
          idleLogged = true;
          await log(`idle — pidfile held by live pid ${result?.existingPid || '?'}; not touching its lock, profile, or health record`);
        }
        return result || { ok: false, existingPid: null };
      }
      owned = true;
      sessionOk = !supported;     // resumption needs a fresh passing probe
      releasePending = false;
      // lastProbeAt is deliberately NOT reset here: a fresh acquisition must not
      // defeat the failure backoff (the F-1 release→reacquire probe hammer).
      idleLogged = false;
      await log('ownership acquired');
      return result;
    },

    // null = nothing due. 'startup' = no passing probe yet (fresh process, or a
    // failure retried once the backoff has elapsed). 'daily' = the 08:00 Central
    // window has not run today.
    probeDue({ cstHour = 0, todayDate = '' } = {}) {
      if (!owned || !supported) return null;
      const dailyWindow = cstHour >= SESSION_PROBE_HOUR && lastDailyProbeDate !== todayDate;
      if (!sessionOk) {
        // lastProbeAt = 0 means no probe has run in this process yet; otherwise the
        // backoff carries across ownership episodes so a release→reacquire cycle
        // cannot force a probe every tick.
        const due = !lastProbeAt || (now() - lastProbeAt) >= backoffMs;
        return due ? (dailyWindow ? 'daily' : 'startup') : null;
      }
      return dailyWindow ? 'daily' : null;
    },

    async runProbe(context, todayDate = '') {
      if (!owned) return { ok: false, reason: 'not_owner' };
      if (!supported) return { ok: true, reason: 'not_supported' };
      lastProbeAt = now();
      let result;
      try {
        result = await probe(context);
      } catch (e) {
        await log(`session probe threw: ${briefErr(e)}`);
        result = { ok: false, reason: 'unknown' };
      }
      const ok = result?.ok === true;
      const reason = ok ? 'ok' : (String(result?.reason || '').trim() || 'unknown');
      sessionOk = ok;
      if (context === 'daily') lastDailyProbeDate = todayDate;
      recordHealth({ ts: new Date(now()).toISOString(), pid, context, mode: GBP_MODE, ok, reason });
      if (ok) {
        alerted = false;
        await log(`session probe (${context}) ok`);
        // Refresh the exported session state now, while this process owns the pidfile
        // and the probe browser has exited — the only moment a second Chromium may
        // touch the profile. Best-effort: a failed export never changes a passing
        // probe, and the persistent profile stays the session source.
        try {
          const refreshed = await refreshState();
          if (!refreshed?.ok && refreshed?.reason !== 'not_supported') {
            await log(`session state export skipped (${refreshed?.reason || 'unknown'}) — the persistent profile stays the session source`);
          }
        } catch (e) {
          await log(`session state export failed: ${briefErr(e)} — the persistent profile stays the session source`);
        }
      } else {
        releasePending = true;
        if (!alerted) {
          alerted = true;         // one alert per failure episode
          await alert(reason);
        }
      }
      return { ok, reason };
    },

    // Called only after the browser and the active pass have settled. Idling then
    // means: no claims, no daily path, no retries, and nothing written until a fresh
    // exclusive reacquisition plus a passing probe.
    async settle() {
      if (!releasePending) return false;
      releasePending = false;
      owned = false;
      sessionOk = false;
      await release();
      await log('session probe failed — released ownership after the pass settled; idling until reacquired + a passing probe');
      return true;
    },
  };
}

// Busy-flag guard for the poll loop. It owns every transition of the flag so the
// stuck path can never clear it: the old "release the busy flag so 9am posts can
// resume" reset the flag while a browser or driver child could still be alive, which
// is how a duplicate post happens. A stuck pass now fails closed (one operator alert)
// and no new pass or probe runs until it settles.
export function createGbpPollGuard({ stuckMs = STUCK_POLL_MS, now = Date.now, onStuck = async () => {} } = {}) {
  let busy = false;
  let busySince = 0;
  let alerted = false;
  return {
    get busy() { return busy; },
    // true = this tick may run; false = a pass is already running (or is stuck).
    async begin() {
      if (busy) {
        if (busySince && (now() - busySince) > stuckMs && !alerted) {
          alerted = true;
          await onStuck(busySince);
        }
        return false;
      }
      busy = true;
      busySince = now();
      return true;
    },
    // Only the pass that began may end it, and a settled pass allows the next one.
    end() {
      busy = false;
      busySince = 0;
      alerted = false;
    },
  };
}

// Alerts are best-effort: a delivery failure (Hermes is a known-broken hop) must
// never kill a pass, a probe, or a release.
async function sendWorkerAlert(subject, body) {
  const message = `⚠️ Grizzly SEO: ${subject}\n${body}`;
  console.error(`[gbp-worker][alert] ${message}`);
  try {
    await sendHermesAlert(message);
  } catch (e) {
    console.error(`[gbp-worker][alert] delivery failed: ${briefErr(e)}`);
  }
}

async function alertSessionProbeFailure(reason) {
  await sendWorkerAlert(
    'GBP session probe failed',
    `The GBP session probe failed (${reason}). Claiming approved rows, the 9am daily post, and Grok-verdict retries are gated until a probe passes. Re-authenticate interactively in the user session; the worker resumes by itself only after reacquiring the pidfile and passing a fresh probe.`,
  );
}

async function alertStuckPoll(since) {
  const minutes = Math.round((Date.now() - since) / 60000);
  await sendWorkerAlert(
    'GBP worker pass stuck',
    `A GBP worker pass (pid ${process.pid}) has been busy for ${minutes}min. The worker failed closed: no new pass, claim, or session probe until it settles. Check for a hung Playwright browser or driver child, then restart the worker if it is wedged.`,
  );
}

async function probeGbpSession(context) {
  const result = await runPhase(null, 'gbp', 'node', [GBP_POSTER_PATH, '--check-session'], PROJECT_ROOT, { timeoutMs: SESSION_PROBE_TIMEOUT_MS });
  const { ok, reason } = parseSessionProbe(result);
  await log(null, 'gbp', ok ? 'info' : 'warn', `session probe (${context}) → ${ok ? 'ok' : reason} (exit ${result.exitCode})`);
  return { ok, reason };
}

// P2.8: re-export the profile's cookies to the durable storageState file. Only ever
// called after a passing probe, so the exported session is never refreshed from a
// logged-out profile. Never prints the state file's contents or path.
async function refreshGbpSessionState() {
  if (!SESSION_PROBE_SUPPORTED) return { ok: false, reason: 'not_supported' };
  const result = await runPhase(null, 'gbp', 'node', [GBP_POSTER_PATH, '--export-session'], PROJECT_ROOT, { timeoutMs: SESSION_PROBE_TIMEOUT_MS });
  const ok = result.exitCode === 0;
  await log(null, 'gbp', ok ? 'info' : 'warn', `session state export → ${ok ? 'ok' : `exit ${result.exitCode}`}`);
  return { ok, reason: ok ? 'ok' : `exit ${result.exitCode}` };
}

const session = createGbpSessionState({
  probe: probeGbpSession,
  refreshState: refreshGbpSessionState,
  alert: alertSessionProbeFailure,
  log: (message) => log(null, 'gbp', 'info', message),
});
const pollGuard = createGbpPollGuard({ onStuck: alertStuckPoll });

// ─────────────────────────────────────────────
// Poll loop
// ─────────────────────────────────────────────

// busy/ownership/probe state lives in pollGuard + session; only the daily latch is
// kept here.
let lastDailyGbpDate = '';

// ─────────────────────────────────────────────
// Grok verification reconciliation
// ─────────────────────────────────────────────
// The Grok bot independently checks the GBP listing (no Google sign-in) and writes
// one verdict file per post-date under state/gbp-grok/. The worker applies each
// verdict to weekly_posts: live → posted + platform_post_id; not_found → retry the
// post once, then needs_verification (never an infinite retry loop).
const GROK_VERDICT_DIR = path.join(PROJECT_ROOT, 'state', 'gbp-grok');
const GROK_APPLIED_DIR = path.join(GROK_VERDICT_DIR, 'applied');
const GROK_RETRIED_PATH = path.join(PROJECT_ROOT, 'state', 'gbp-grok-retried.json');

// Pure verdict decision, unit-tested in gbp-worker.test.mjs.
export function grokVerdictDecision({ verdict, alreadyRetried }) {
  const v = String(verdict || '').toLowerCase();
  if (v === 'live') return 'confirm';
  if (v === 'not_found') return alreadyRetried ? 'give_up' : 'retry';
  return 'ignore';
}

function loadGrokRetried() {
  try { return JSON.parse(fs.readFileSync(GROK_RETRIED_PATH, 'utf8')); }
  catch { return {}; }
}

function saveGrokRetried(ledger) {
  fs.writeFileSync(GROK_RETRIED_PATH, JSON.stringify(ledger, null, 2));
}

function archiveGrokVerdict(filePath) {
  try {
    fs.mkdirSync(GROK_APPLIED_DIR, { recursive: true });
    fs.renameSync(filePath, path.join(GROK_APPLIED_DIR, path.basename(filePath)));
  } catch (e) {
    // File may still be locked/mid-write — leave it; the next poll re-applies
    // (apply is idempotent, retry is gated by the retried ledger).
    console.error(`[gbp-worker][grok] could not archive verdict ${filePath}: ${briefErr(e)}`);
  }
}

async function reconcileGrokVerdicts() {
  if (!fs.existsSync(GROK_VERDICT_DIR)) return;
  const entries = fs.readdirSync(GROK_VERDICT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(GROK_VERDICT_DIR, entry.name);
    let verdict;
    try {
      verdict = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // bot may still be writing the file
    }
    const date = String(verdict.post_date || entry.name.replace(/\.json$/, '')).slice(0, 10);

    const { data: row } = await supabase
      .from('weekly_posts')
      .select('id, run_id, post_date, status, platform_post_id, posted_at')
      .eq('platform', 'gbp')
      .eq('post_date', date)
      .maybeSingle();

    if (!row) {
      await log(null, 'gbp', 'warn', `Grok verdict ${entry.name}: no gbp row for ${date} — archiving without apply`);
      archiveGrokVerdict(filePath);
      continue;
    }

    const decision = grokVerdictDecision({ verdict: verdict.verdict, alreadyRetried: Boolean(loadGrokRetried()[date]) });

    if (decision === 'confirm') {
      const update = { status: 'posted', error: null, platform_post_id: verdict.post_url || 'verified-no-url' };
      if (!row.posted_at) update.posted_at = new Date().toISOString();
      await supabase.from('weekly_posts').update(update).eq('id', row.id);
      await log(row.run_id, 'gbp', 'info', `Grok verified ${date} LIVE → posted (${update.platform_post_id})`);
      await markGbpPostedAndArchive({ postDate: date, exitCode: 0, runId: row.run_id, env: process.env, log });
      archiveGrokVerdict(filePath);
      continue;
    }

    if (decision === 'give_up') {
      await supabase.from('weekly_posts')
        .update({ status: 'needs_verification', error: 'Grok verified: not on listing after retry. Check listing, do not re-post.' })
        .eq('id', row.id);
      await log(row.run_id, 'gbp', 'warn', `Grok verified ${date} not_found after retry → needs_verification`);
      archiveGrokVerdict(filePath);
      continue;
    }

    if (decision === 'retry') {
      const retried = loadGrokRetried();
      retried[date] = true;
      saveGrokRetried(retried);
      await log(row.run_id, 'gbp', 'warn', `Grok verified ${date} not_found — retrying post once`);
      const r = await runPhase(row.run_id, 'gbp', 'node', [GBP_POSTER_PATH, '--date', date], PROJECT_ROOT);
      await applyDriverResult({ supabase, post: row, result: r, env: process.env, log });
      await log(row.run_id, 'gbp', r.ok ? 'info' : 'warn', `Grok-triggered retry for ${date} → exit ${r.exitCode}`);
      archiveGrokVerdict(filePath);
      continue;
    }

    // decision === 'ignore' — unrecognized verdict; archive so we don't loop.
    await log(row.run_id, 'gbp', 'warn', `Grok verdict ${entry.name}: unrecognized "${verdict.verdict}" — ignored`);
    archiveGrokVerdict(filePath);
  }
}

async function poll() {
  // Fail closed: a pass that is still running (or whose browser or driver child is
  // still alive) is never declared dead — see createGbpPollGuard.
  if (!(await pollGuard.begin())) return;
  try {
    // 0. Ownership + session probe. An idle worker reacquires exclusively; if another
    //    live pid holds the pidfile it touches nothing. The probe runs at startup (per
    //    ownership) and daily at 08:00 Central, and a failed one gates every step
    //    below — no approved-row claims, no daily path, no Grok retries.
    if (!session.owned) {
      const lock = await session.tryAcquire();
      if (!lock?.ok) return;   // another live worker owns it
    }
    const { todayDate, cstHour } = centralDateHour(new Date());
    const probeContext = session.probeDue({ cstHour, todayDate });
    if (probeContext) await session.runProbe(probeContext, todayDate);
    if (!session.canPost()) return;

    // 1. Approved-run GBP: claim this run's gbp rows (approved -> posting) so a second
    //    poll can't double-process, then run curation + sync + Day-1 + mark Days 2-7.
    const { data: approved, error: apprErr } = await supabase
      .from('weekly_posts')
      .select('*')
      .eq('platform', 'gbp')
      .eq('status', 'approved')
      .order('run_id');
    if (apprErr) console.error(`[gbp-worker][gbp-worker→supabase][error] approved query: ${briefErr(apprErr)}`);

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

    // 3. Grok verification reconciliation: the Grok bot independently checks the
    //    GBP listing (no Google sign-in) and writes one verdict file per post-date.
    //    live → posted + platform_post_id; not_found → retry once, then give up.
    await reconcileGrokVerdicts();
  } catch (e) {
    console.error(`[gbp-worker][gbp-worker→poll][error] poll exception: ${briefErr(e)}`);
  } finally {
    pollGuard.end();
    // Ownership is released only now that the pass (probe browser + child processes)
    // and the busy flag have settled — never while a pass is still alive.
    await session.settle();
  }
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

if (invokedDirectly) {
  const once = process.argv.includes('--once');
  const probeOnly = process.argv.includes('--probe-only');
  const lock = await session.tryAcquire();
  if (!lock?.ok) {
    console.error(`[gbp-worker] already running (pid ${lock?.existingPid || '?'}) — exiting`);
    process.exit(0);
  }
  const release = () => releaseGbpWorkerLock(WORKER_LOCK_PATH, process.pid);
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
  console.log(`[gbp-worker] Starting — project root: ${PROJECT_ROOT}`);
  console.log(`[gbp-worker] GBP_POSTER=${GBP_MODE} → ${path.basename(GBP_POSTER_PATH)}`);
  if (probeOnly) {
    // Probe-only startup mode: record session health, release, exit. No claims, no
    // daily path, no polling — the documented session probe.
    const { todayDate } = centralDateHour(new Date());
    await session.runProbe('probe-only', todayDate);
    release();
    console.log(`[gbp-worker] --probe-only complete (session ${session.sessionOk ? 'ok' : 'not usable'})`);
    process.exit(session.sessionOk ? 0 : 2);
  }
  if (once) {
    await poll();
    console.log('[gbp-worker] --once complete');
    process.exit(0);
  } else {
    console.log(`[gbp-worker] Polling Supabase every ${POLL_INTERVAL_MS / 1000}s`);
    await poll();
    setInterval(poll, POLL_INTERVAL_MS);
  }
}
