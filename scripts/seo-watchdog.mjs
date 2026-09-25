#!/usr/bin/env node
/**
 * seo-watchdog.mjs
 * Last-line-of-defense watchdog for the weekly SEO run — INDEPENDENT of the
 * Friday Task Scheduler trigger.
 *
 * WHY THIS EXISTS: the monitor (seo-monitor.mjs) shares its trigger with the
 * run it watches — 'Grizzly SEO Monitor' fires Friday 08:30 alongside
 * 'Grizzly SEO Weekly Run'. If Task Scheduler misfires, the task is disabled,
 * or the machine is off past the trigger window, the watchdog dies with its
 * target and a missed week is silent (exactly what happened 2026-07-24).
 * This script runs DAILY on its own trigger and only reads the runner health
 * marker, so a dead Friday trigger still produces an alert.
 *
 * Checks (any hit → alert via hermes SMS, SMTP best-effort secondary):
 *   1. Run-day no-show: it's the expected run day, past the deadline, and the
 *      health marker was not written today.
 *   2. Run-day failure: today's health marker says 'failed'.
 *   3. Run-day hung: health still says 'started' ≥90 min after it was written.
 *   4. Notify miss: health says success but outputs/approval-notify.json is
 *      missing or sent !== true (2026-08-28 silent success).
 *   5. Auto-approve miss: SEO_AUTO_APPROVE is on and latest run is still
 *      pending_approval.
 *   6. Staleness: the health marker is older than STALE_DAYS.
 *
 * Shadow/new pipeline (T3, additive and config-gated on SEO_PIPELINE): once the
 * wrapper runs the rebuilt pipeline, its attempt-derived `shadow` block in the same
 * health file is the run's evidence, so the watchdog also alerts on
 * PIPELINE NO-SHOW / FAILED / HUNG / NOTIFY MISS and on a stale memory pass
 * (reconcile `last_success_at`). `legacy` watches none of it.
 *
 * Single-shot: checks once, alerts if needed, exits. Exit codes:
 *   0 = healthy or alert delivered; 1 = alert needed but ALL channels failed
 *   (so Task Scheduler's LastTaskResult itself becomes a visible signal).
 *
 * Register with a DAILY trigger (see setup-scheduled-tasks.ps1):
 *   node scripts/seo-watchdog.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sendHermesAlert } from './lib/hermes-alert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ── Config (same env vars as seo-monitor.mjs) ────────────────────────────────
const NO_SHOW_DEADLINE_HHMM = process.env.SEO_NO_SHOW_DEADLINE || '09:00';
const EXPECTED_RUN_DOW      = parseInt(process.env.SEO_RUN_DOW ?? '5', 10); // 0=Sun … 5=Fri
const STALE_DAYS            = parseInt(process.env.SEO_WATCHDOG_STALE_DAYS ?? '8', 10);
const RUNNER_HEALTH_FILE    = path.join(PROJECT_ROOT, 'outputs', 'weekly-runner-health.json');
const NOTIFY_RESULT_FILE    = path.join(PROJECT_ROOT, 'outputs', 'approval-notify.json');
const LOG_FILE              = path.join(PROJECT_ROOT, 'outputs', 'watchdog.jsonl');
const HUNG_MINUTES          = parseInt(process.env.SEO_WATCHDOG_HUNG_MINUTES ?? '90', 10);

// ── Rebuilt pipeline (T3) ────────────────────────────────────────────────────
// Only the modes where run-weekly-seo.py actually launches the rebuilt pipeline are
// watched; `legacy` (the default, and an unset/unrecognized value) adds no checks.
const PIPELINE_MODE          = (process.env.SEO_PIPELINE || 'legacy').trim().toLowerCase();
const WATCHED_PIPELINE_MODES = new Set(['shadow', 'new']);
const RECONCILE_HEALTH_FILE  = path.join(PROJECT_ROOT, 'outputs', 'reconcile-health.json');
// The daily reconcile pass is the pipeline's memory. Freshness is read from
// `last_success_at` (only a clean pass advances it), never from table rows.
const RECONCILE_STALE_HOURS  = parseInt(process.env.SEO_RECONCILE_STALE_HOURS ?? '48', 10);
const PIPELINE_UNFINISHED    = new Set(['running', 'started']);
const PIPELINE_GOOD          = new Set(['succeeded', 'degraded']);

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function log(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  console.log(`[watchdog] ${level}: ${msg}`);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* logging must never kill the watchdog */ }
}

// Watchdog runs on CartersPC, so local time is already CST/CDT.
function localDateISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localHHMM(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function sendAlert(subject, body) {
  let delivered = false;
  try {
    await sendHermesAlert(`[SEO Watchdog] ${subject}\n${body}`);
    log('info', 'Alert sent via hermes', { subject, to: process.env.HERMES_ALERT_TO || 'slack' });
    delivered = true;
  } catch (e) {
    log('warn', 'Hermes alert failed', { subject, error: e.message });
  }
  const smtpPass = process.env.SMTP_APP_PASSWORD || '';
  const smtpFrom = process.env.SMTP_FROM || process.env.SMTP_FROM_EMAIL || 'barnscarter@gmail.com';
  const smtpTo   = process.env.SMTP_TO   || process.env.SMTP_TO_EMAIL   || 'barnscarter@gmail.com';
  if (smtpPass) {
    try {
      const { createTransport } = await import('nodemailer');
      const transport = createTransport({ service: 'gmail', auth: { user: smtpFrom, pass: smtpPass } });
      await transport.sendMail({ from: smtpFrom, to: smtpTo, subject: `[SEO Watchdog] ${subject}`, text: body });
      log('info', 'Alert email sent', { subject });
      delivered = true;
    } catch (e) {
      log('warn', 'Alert email failed', { subject, error: e.message });
    }
  }
  return delivered;
}

export function evaluateWatchdog({
  now,
  health,
  notify,
  autoApprove = false,
  latestRun = null,
  staleDays = STALE_DAYS,
  deadline = NO_SHOW_DEADLINE_HHMM,
  expectedDow = EXPECTED_RUN_DOW,
  hungMinutes = HUNG_MINUTES,
} = {}) {
  const today = localDateISO(now);
  const hhmm = localHHMM(now);
  const isRunDay = now.getDay() === expectedDow;
  const pastDeadline = hhmm >= deadline;
  const problems = [];

  if (isRunDay && pastDeadline && (!health || health.date !== today)) {
    problems.push(
      `NO-SHOW: today is ${DOW_NAMES[expectedDow]} (run day), it is past ` +
      `${deadline} local, and the weekly runner never started ` +
      `(health marker ${health ? `is from ${health.date}` : 'does not exist'}). ` +
      `Check the 'Grizzly SEO Weekly Run' scheduled task on CartersPC.`
    );
  } else if (isRunDay && health?.date === today && health.status === 'failed') {
    problems.push(
      `RUN FAILED today: ${health.error || 'no error captured'} ` +
      `(see ${health.log_file || 'outputs/'}).`
    );
  } else if (isRunDay && pastDeadline && health?.date === today && health.status === 'started') {
    const ageMin = health.at ? (now - new Date(health.at)) / 60_000 : Infinity;
    if (ageMin >= hungMinutes) {
      problems.push(
        `HUNG: weekly runner still 'started' after ${ageMin.toFixed(0)} min ` +
        `(threshold ${hungMinutes}m). Check Task Scheduler / crew log.`
      );
    }
  }

  if (isRunDay && pastDeadline && health?.date === today && health.status === 'success') {
    const notified = notify && notify.sent === true;
    if (!notified) {
      problems.push(
        `NOTIFY MISS: runner succeeded but approval-notify.json ` +
        `${notify ? `sent=${notify.sent} reason=${notify.reason || '?'}` : 'is missing'}. ` +
        `Hermes/SMTP did not confirm a ping — last week's silent Saturday-approve loop.`
      );
    }
    if (autoApprove) {
      const took = notify && notify.autoApprove === true;
      const stillPending = latestRun
        ? latestRun.status === 'pending_approval'
        : !took;
      if (stillPending && !took) {
        problems.push(
          `AUTO-APPROVE DID NOT TAKE: SEO_AUTO_APPROVE is on but ` +
          `${latestRun ? `seo_runs ${latestRun.id || ''} is still pending_approval` : 'approval-notify.json does not show autoApprove=true'}.`
        );
      }
    }
  }

  if (health?.at) {
    const ageDays = (now - new Date(health.at)) / 86_400_000;
    if (ageDays > staleDays) {
      problems.push(
        `STALE: last weekly-runner activity was ${health.date} (${ageDays.toFixed(1)} days ago, ` +
        `threshold ${staleDays}d). The Friday trigger is likely dead or disabled — a full week ` +
        `has been missed. Check Task Scheduler on CartersPC.`
      );
    }
  }

  return problems;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * T3: what the rebuild's own health evidence says — independent of the legacy
 * status, so `new` mode needs no "legacy succeeded" dependency.
 *
 * `health.shadow` is the block run-weekly-seo.py derives from the attempt record
 * (never from the child's exit code). Reconcile freshness is checked every day
 * (the pass is daily); the run-day checks fire like the legacy ones.
 */
export function evaluatePipelineWatchdog({
  now,
  pipelineMode = PIPELINE_MODE,
  health,
  reconcile,
  reconcileStaleHours = RECONCILE_STALE_HOURS,
  deadline = NO_SHOW_DEADLINE_HHMM,
  expectedDow = EXPECTED_RUN_DOW,
  hungMinutes = HUNG_MINUTES,
} = {}) {
  const mode = String(pipelineMode || '').trim().toLowerCase();
  const problems = [];
  if (!WATCHED_PIPELINE_MODES.has(mode)) return problems;

  const lastSuccess = reconcile?.last_success_at ? new Date(reconcile.last_success_at) : null;
  const successAgeH = lastSuccess && !Number.isNaN(lastSuccess.getTime())
    ? (now - lastSuccess) / 3_600_000
    : Infinity;
  if (successAgeH > reconcileStaleHours) {
    problems.push(
      `RECONCILE STALE: the last clean memory pass was ` +
      `${Number.isFinite(successAgeH) ? `${successAgeH.toFixed(1)} h ago` : 'never recorded'} ` +
      `(threshold ${reconcileStaleHours}h; last reconcile status ` +
      `${reconcile ? `'${reconcile.status}'` : 'no outputs/reconcile-health.json'}). ` +
      `The daily 'Grizzly SEO Reconcile' task is not advancing last_success_at.`
    );
  }

  if (now.getDay() !== expectedDow || localHHMM(now) < deadline) return problems;

  const shadow = health && typeof health.shadow === 'object' && health.shadow ? health.shadow : null;
  const shadowAt = shadow?.at ? new Date(shadow.at) : null;
  const fresh = Boolean(shadowAt) && !Number.isNaN(shadowAt.getTime())
    && localDateISO(shadowAt) === localDateISO(now);
  const where = `(SEO_PIPELINE=${mode}; see outputs/weekly-runner-health.json 'shadow'` +
    `${shadow?.log_file ? ` and ${shadow.log_file}` : ''})`;

  if (!fresh) {
    problems.push(
      `PIPELINE NO-SHOW: the ${mode} pipeline wrote no health block today ` +
      `(shadow block ${shadow ? `says '${shadow.status}' from ${shadow.at}` : 'is missing'}). ` +
      `Check the wrapper started and launched the rebuilt pipeline ${where}.`
    );
    return problems;
  }

  const status = String(shadow.status || 'unknown');
  if (PIPELINE_UNFINISHED.has(status)) {
    const ageMin = (now - shadowAt) / 60_000;
    if (ageMin >= hungMinutes) {
      problems.push(
        `PIPELINE HUNG: the ${mode} attempt is still '${status}' after ${ageMin.toFixed(0)} min ` +
        `(threshold ${hungMinutes}m) ${where}.`
      );
    }
    return problems;
  }

  if (status.startsWith('failed')) {
    problems.push(
      `PIPELINE FAILED: the ${mode} attempt record reads '${status}' ` +
      `(week of ${shadow.week_of || 'unknown'})` +
      `${shadow.error ? `: ${shadow.error}` : ''} ${where}.`
    );
    return problems;
  }

  if (PIPELINE_GOOD.has(status) && !(shadow.notify && shadow.notify.sent === true)) {
    problems.push(
      `PIPELINE NOTIFY MISS: the ${mode} attempt finished '${status}' but its alert was not ` +
      `confirmed delivered (notify receipt ` +
      `${shadow.notify ? `${shadow.notify.status}${shadow.notify.error ? `: ${shadow.notify.error}` : ''}` : 'absent'}) ` +
      `${where}.`
    );
  }
  return problems;
}

async function main() {
  const now = new Date();
  const health = readJson(RUNNER_HEALTH_FILE);
  const notify = readJson(NOTIFY_RESULT_FILE);
  const reconcile = readJson(RECONCILE_HEALTH_FILE);
  const autoApprove = /^(1|true|yes)$/i.test(process.env.SEO_AUTO_APPROVE || '');

  if (!health && now.getDay() !== EXPECTED_RUN_DOW) {
    log('warn', 'No runner health marker found', { file: RUNNER_HEALTH_FILE });
  }

  const problems = [
    ...evaluateWatchdog({ now, health, notify, autoApprove }),
    ...evaluatePipelineWatchdog({ now, health, reconcile }),
  ];

  if (problems.length === 0) {
    log('info', 'Healthy', {
      last_run_date: health?.date ?? null,
      last_status: health?.status ?? null,
      notify_sent: notify?.sent ?? null,
      pipeline: PIPELINE_MODE,
      shadow_status: health?.shadow?.status ?? null,
      reconcile_last_success_at: reconcile?.last_success_at ?? null,
    });
    return;
  }

  const subject = 'Weekly SEO run problem detected';
  const body = problems.join('\n\n') + `\n\nChecked at ${now.toISOString()} by the daily watchdog on CartersPC.`;
  log('error', subject, { problems });
  const delivered = await sendAlert(subject, body);
  if (!delivered) {
    log('error', 'ALL alert channels failed — watchdog alert not delivered');
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]
  && fs.realpathSync.native(fileURLToPath(import.meta.url))
    === fs.realpathSync.native(path.resolve(process.argv[1]));

if (invokedDirectly) {
  main().catch((e) => {
    log('error', 'Watchdog crashed', { error: e.message });
    process.exitCode = 1;
  });
}
