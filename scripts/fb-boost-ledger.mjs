#!/usr/bin/env node
/**
 * fb-boost-ledger.mjs — deterministic money gate for weekly FB boost automation.
 *
 * The weekly boost recommendation is interpreted by a scheduled Claude session
 * (see FB-BOOST-RUNBOOK.md), but every dollar must pass through this ledger
 * BEFORE the Publish click. The ledger enforces the hard weekly cap in code so
 * a misread schedule or UI mishap can never overspend.
 *
 * Commands:
 *   status                       Print week key, cap, spent, remaining, entries (JSON)
 *   reserve --key K --post ID --daily N --days N [--week YYYY-MM-DD]
 *                                Reserve budget before publishing. EXITS 1 and writes
 *                                nothing if the reservation would exceed the cap or
 *                                duplicate an existing reserved/published entry.
 *   publish --key K [--week W]   Mark a reserved entry as published (after the FB
 *                                "Ad in review" confirmation is observed).
 *   fail --key K [--note S] [--week W]
 *                                Mark a reserved entry failed — frees its budget.
 *   notify <message>             Send an SMS to Carter via hermes (alert path).
 *
 * Cap: FB_BOOST_WEEKLY_CAP env (default $50). Week key = Start Date of the
 * newest outputs/facebook_posting_schedule.md unless --week is given.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendHermesAlert } from './lib/hermes-alert.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = path.join(PROJECT_ROOT, 'outputs', 'fb-boost-ledger.json');
const SCHEDULE_PATH = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const CAP = Number(process.env.FB_BOOST_WEEKLY_CAP || 50);

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return { weeks: {} };
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tmp = `${LEDGER_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, LEDGER_PATH);
}

function scheduleWeekStart() {
  if (!fs.existsSync(SCHEDULE_PATH)) return null;
  const text = fs.readFileSync(SCHEDULE_PATH, 'utf8');
  // Match explicit Start Date field
  let m = text.match(/\*\*Start Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Match "Week of August 7–12, 2026" — extract start date from first day
  m = text.match(/\*\*Week of\s+(\w+)\s+(\d{1,2})[–-]\d{1,2},?\s*(\d{4})/i);
  if (m) {
    const months = { january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
                     july:'07', august:'08', september:'09', october:'10', november:'11', december:'12' };
    const mon = months[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${String(m[2]).padStart(2, '0')}`;
  }
  // Fallback: extract from first DAY block's DATE field
  m = text.match(/DATE:\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function weekEntries(ledger, week) {
  if (!ledger.weeks[week]) ledger.weeks[week] = { boosts: [] };
  return ledger.weeks[week].boosts;
}

function spentInWeek(ledger, week) {
  return weekEntries(ledger, week)
    .filter((b) => b.status === 'reserved' || b.status === 'published')
    .reduce((sum, b) => sum + b.total, 0);
}

function resolveWeek(args) {
  const week = args.week || scheduleWeekStart();
  if (!week) {
    console.error('ERROR: no --week given and no Start Date found in facebook_posting_schedule.md');
    process.exit(1);
  }
  return week;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === 'status') {
  const ledger = readLedger();
  const week = args.week || scheduleWeekStart();
  const out = { week, cap: CAP, schedulePath: SCHEDULE_PATH };
  if (week) {
    out.spent = spentInWeek(ledger, week);
    out.remaining = Math.max(0, CAP - out.spent);
    out.entries = weekEntries(ledger, week);
    // A schedule older than its own 7-day window has nothing left to boost;
    // the scheduled task must treat stale=true as "do nothing".
    const ageDays = (Date.now() - new Date(`${week}T00:00:00`).getTime()) / 86_400_000;
    out.stale = ageDays > 8;
  } else {
    out.error = 'no schedule found';
  }
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === 'reserve') {
  for (const field of ['key', 'post', 'daily', 'days']) {
    if (!args[field]) {
      console.error(`ERROR: --${field} is required`);
      process.exit(1);
    }
  }
  const daily = Number(args.daily);
  const days = Number(args.days);
  const total = daily * days;
  if (!Number.isFinite(total) || total <= 0) {
    console.error('ERROR: --daily and --days must be positive numbers');
    process.exit(1);
  }
  const week = resolveWeek(args);
  const ledger = readLedger();
  const entries = weekEntries(ledger, week);
  const dup = entries.find(
    (b) => b.status !== 'failed' && (b.key === args.key || b.post_id === args.post),
  );
  if (dup) {
    console.error(`REFUSED: ${dup.key} (post ${dup.post_id}) already ${dup.status} this week`);
    process.exit(1);
  }
  const spent = spentInWeek(ledger, week);
  if (spent + total > CAP) {
    console.error(`REFUSED: $${spent} already committed for week ${week}; +$${total} would exceed the $${CAP} cap`);
    process.exit(1);
  }
  entries.push({
    key: args.key,
    post_id: args.post,
    daily,
    days,
    total,
    status: 'reserved',
    reserved_at: new Date().toISOString(),
  });
  writeLedger(ledger);
  console.log(JSON.stringify({ ok: true, week, key: args.key, total, remaining: CAP - spent - total }));
} else if (cmd === 'publish' || cmd === 'fail') {
  if (!args.key) {
    console.error('ERROR: --key is required');
    process.exit(1);
  }
  const week = resolveWeek(args);
  const ledger = readLedger();
  const entry = weekEntries(ledger, week).find((b) => b.key === args.key && b.status === 'reserved');
  if (!entry) {
    console.error(`ERROR: no reserved entry "${args.key}" in week ${week}`);
    process.exit(1);
  }
  if (cmd === 'publish') {
    entry.status = 'published';
    entry.published_at = new Date().toISOString();
  } else {
    entry.status = 'failed';
    entry.failed_at = new Date().toISOString();
    if (args.note) entry.note = args.note;
  }
  writeLedger(ledger);
  console.log(JSON.stringify({ ok: true, week, key: entry.key, status: entry.status }));
} else if (cmd === 'notify') {
  const message = args._.slice(1).join(' ');
  if (!message) {
    console.error('ERROR: notify requires a message');
    process.exit(1);
  }
  try {
    await sendHermesAlert(message);
    console.log(JSON.stringify({ ok: true }));
  } catch (e) {
    console.error(`ERROR: hermes alert failed: ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'eligible') {
  // Read the schedule, find posts with BOOST: yes:$N, check if
  // the post's date is today or past AND not already in the ledger.
  const ledger = readLedger();
  const week = args.week || scheduleWeekStart();
  if (!week) {
    console.log(JSON.stringify({ eligible: false, reason: 'no schedule found' }));
    process.exit(0);
  }
  const ageDays = (Date.now() - new Date(`${week}T00:00:00`).getTime()) / 86_400_000;
  if (ageDays > 8) {
    console.log(JSON.stringify({ eligible: false, reason: 'schedule stale', week }));
    process.exit(0);
  }
  if (!fs.existsSync(SCHEDULE_PATH)) {
    console.log(JSON.stringify({ eligible: false, reason: 'schedule file missing' }));
    process.exit(0);
  }
  const text = fs.readFileSync(SCHEDULE_PATH, 'utf8');
  const entries = weekEntries(ledger, week);
  const today = new Date().toISOString().slice(0, 10);

  // Parse each post block for DATE + BOOST fields (handles both **DATE:** and DATE: formats)
  const blocks = text.split(/\n(?=## DAY \d)/);
  const candidates = [];
  for (const block of blocks) {
    const dateM = block.match(/\*{0,2}DATE:\*{0,2}\s*(\d{4}-\d{2}-\d{2})/);
    if (!dateM) continue;
    const postDate = dateM[1];
    const boostM = block.match(/\*{0,2}BOOST:\*{0,2}\s*yes:\$?(\d+)/i);
    if (!boostM) continue;
    const daily = Number(boostM[1]);
    const durM = block.match(/\*{0,2}BOOST_DURATION:\*{0,2}\s*(\d+)\s*days?/i);
    const days = durM ? Number(durM[1]) : 2;
    const total = daily * days;
    const dayM = block.match(/\*{0,2}DAY:\*{0,2}\s*(\d+)/);
    const svcM = block.match(/\*{0,2}SERVICE:\*{0,2}\s*(.+)/);
    const key = `day${dayM?.[1] || '?'}-${(svcM?.[1] || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

    // Already handled?
    if (entries.find(b => b.status !== 'failed' && b.key === key)) continue;
    // Date not reached yet?
    if (postDate > today) continue;

    candidates.push({ key, date: postDate, daily, days, total, service: svcM?.[1] || '' });
  }

  if (!candidates.length) {
    console.log(JSON.stringify({ eligible: false, reason: 'no eligible boosts', week, today }));
    process.exit(0);
  }

  // Return the first (earliest date) eligible boost
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  const pick = candidates[0];
  const spent = spentInWeek(ledger, week);
  const remaining = Math.max(0, CAP - spent);
  if (pick.total > remaining) {
    console.log(JSON.stringify({ eligible: false, reason: `next boost ($${pick.total}) exceeds remaining budget ($${remaining})`, week, pick }));
    process.exit(0);
  }

  console.log(JSON.stringify({ eligible: true, week, pick, spent, remaining }));
} else {
  console.error('Usage: fb-boost-ledger.mjs status|reserve|publish|fail|notify|eligible [options]');
  process.exit(1);
}
