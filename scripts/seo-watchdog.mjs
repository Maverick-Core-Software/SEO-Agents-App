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
 *   2. Run-day failure: today's health marker says 'failed' (covers the case
 *      where the monitor never launched to report it).
 *   3. Staleness: the health marker is older than STALE_DAYS — the trigger has
 *      been dead long enough that a whole week slipped. Fires daily until fixed.
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
const LOG_FILE              = path.join(PROJECT_ROOT, 'outputs', 'watchdog.jsonl');

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
  const smtpFrom = process.env.SMTP_FROM || 'barnscarter@gmail.com';
  const smtpTo   = process.env.SMTP_TO   || 'barnscarter@gmail.com';
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

function readHealth() {
  try {
    return JSON.parse(fs.readFileSync(RUNNER_HEALTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const now = new Date();
  const today = localDateISO(now);
  const health = readHealth();
  const problems = [];

  const isRunDay = now.getDay() === EXPECTED_RUN_DOW;
  const pastDeadline = localHHMM(now) >= NO_SHOW_DEADLINE_HHMM;

  if (isRunDay && pastDeadline && (!health || health.date !== today)) {
    problems.push(
      `NO-SHOW: today is ${DOW_NAMES[EXPECTED_RUN_DOW]} (run day), it is past ` +
      `${NO_SHOW_DEADLINE_HHMM} local, and the weekly runner never started ` +
      `(health marker ${health ? `is from ${health.date}` : 'does not exist'}). ` +
      `Check the 'Grizzly SEO Weekly Run' scheduled task on CartersPC.`
    );
  } else if (isRunDay && health?.date === today && health.status === 'failed') {
    problems.push(
      `RUN FAILED today: ${health.error || 'no error captured'} ` +
      `(see ${health.log_file || 'outputs/'}).`
    );
  }

  if (health?.at) {
    const ageDays = (now - new Date(health.at)) / 86_400_000;
    if (ageDays > STALE_DAYS) {
      problems.push(
        `STALE: last weekly-runner activity was ${health.date} (${ageDays.toFixed(1)} days ago, ` +
        `threshold ${STALE_DAYS}d). The Friday trigger is likely dead or disabled — a full week ` +
        `has been missed. Check Task Scheduler on CartersPC.`
      );
    }
  } else if (!health && !isRunDay) {
    // No marker at all and it's not run day: either a fresh checkout or someone
    // deleted outputs/. Worth one line in the log, not an SMS.
    log('warn', 'No runner health marker found', { file: RUNNER_HEALTH_FILE });
  }

  if (problems.length === 0) {
    log('info', 'Healthy', {
      last_run_date: health?.date ?? null,
      last_status: health?.status ?? null,
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

main().catch((e) => {
  log('error', 'Watchdog crashed', { error: e.message });
  process.exitCode = 1;
});
