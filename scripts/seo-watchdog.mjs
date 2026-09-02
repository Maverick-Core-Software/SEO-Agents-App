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

async function main() {
  const now = new Date();
  const health = readJson(RUNNER_HEALTH_FILE);
  const notify = readJson(NOTIFY_RESULT_FILE);
  const autoApprove = /^(1|true|yes)$/i.test(process.env.SEO_AUTO_APPROVE || '');

  if (!health && now.getDay() !== EXPECTED_RUN_DOW) {
    log('warn', 'No runner health marker found', { file: RUNNER_HEALTH_FILE });
  }

  const problems = evaluateWatchdog({ now, health, notify, autoApprove });

  if (problems.length === 0) {
    log('info', 'Healthy', {
      last_run_date: health?.date ?? null,
      last_status: health?.status ?? null,
      notify_sent: notify?.sent ?? null,
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
