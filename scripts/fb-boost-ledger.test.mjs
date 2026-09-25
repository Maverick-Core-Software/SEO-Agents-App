import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fb-boost-ledger.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-boost-ledger-'));
const schedulePath = path.join(tempDir, 'facebook_posting_schedule.md');

const cases = [
  ['## Week of August 31 – September 5, 2026', '2026-08-31'], // cross-month heading
  ['## Week of August 17–22, 2026', '2026-08-17'],            // same-month heading
  ['**Week of August 17–22, 2026**', '2026-08-17'],           // bold form
  // Real heading from the 2026-09-18 crew run: single date + "| Focus:" suffix.
  ['## Week of September 21, 2026 | Focus: Home Generator Installation, DFW', '2026-09-21'],
  // No Week-of heading at all — the bold per-post DATE field is the only source.
  ['**DATE:** 2026-09-18', '2026-09-18'],
];

try {
  for (const [heading, expected] of cases) {
    fs.writeFileSync(schedulePath, `${heading}\n`);
    const output = execFileSync(process.execPath, [script, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, FB_SCHEDULE_PATH: schedulePath },
    });

    assert.equal(JSON.parse(output).week, expected, heading);
  }

  // ── Scenario block: eligible across the real shape of a posted week ────────
  // Day 1 and Day 3 boosted $25 x 1d; Day 5/6 NO. The week is anchored to the
  // Monday of the CURRENT week rather than a hardcoded date: `eligible` fails
  // closed on a schedule older than its own 8-day window (the staleness gate in
  // fb-boost-ledger.mjs), so a pinned week expires and turns every case below
  // into 'schedule stale'. The offsets preserve the scenario shape exactly.
  const weekMonday = new Date();
  weekMonday.setHours(12, 0, 0, 0);
  weekMonday.setDate(weekMonday.getDate() - ((weekMonday.getDay() + 6) % 7)); // back to Monday
  const isoDate = (offsetDays = 0) => {
    const d = new Date(weekMonday);
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const day1Key = 'day1-whole-home-surge-protection';
  const day3Key = 'day3-ev-charger-installation';
  fs.writeFileSync(schedulePath, [
    `**Start Date:** ${isoDate(0)}`,
    '',
    '## DAY 1',
    `**DATE:** ${isoDate(0)}`,
    '**DAY:** 1',
    '**SERVICE:** Whole-Home Surge Protection',
    '**BOOST:** yes:$25',
    '',
    '## DAY 3',
    `**DATE:** ${isoDate(2)}`,
    '**DAY:** 3',
    '**SERVICE:** EV Charger Installation',
    '**BOOST:** yes:$25',
    '',
    '## DAY 5',
    `**DATE:** ${isoDate(4)}`,
    '**DAY:** 5',
    '**SERVICE:** Panel Replacement',
    '**BOOST:** no',
    '',
    '## DAY 6',
    `**DATE:** ${isoDate(5)}`,
    '**DAY:** 6',
    '**SERVICE:** Ceiling Fan Install',
    '**BOOST:** no',
    '',
    '## BOOST BUDGET SUMMARY',
    '',
    '| Day | Service | Decision | Budget |',
    '| --- | ------- | -------- | ------ |',
    '| Day 1 | Whole-Home Surge Protection | YES | $25/day × 1 day |',
    '| Day 3 | EV Charger Installation | YES | $25/day × 1 day |',
    '| Day 5 | Panel Replacement | NO | — |',
    '| Day 6 | Ceiling Fan Install | NO | — |',
    ''].join('\n'));
  const ledgerPath = path.join(tempDir, 'fb-boost-ledger.json');
  const published = (key, date) => ({
    key,
    post_id: `108252941997164_test_${key}`,
    daily: 25,
    days: 1,
    total: 25,
    status: 'published',
    reserved_at: `${date}T14:00:00.000Z`,
    published_at: `${date}T14:01:00.000Z`,
  });
  const scenarios = [
    [isoDate(0), [], true, 'day1-'],
    [isoDate(1), [published(day1Key, isoDate(0))], false, 'no eligible boosts'],
    [isoDate(1), [], true, 'day1-'],
    [isoDate(2), [published(day1Key, isoDate(0))], true, 'day3-'],
    [isoDate(3), [published(day1Key, isoDate(0)), published(day3Key, isoDate(2))], false, 'no eligible boosts'],
  ];
  for (const [today, boosts, wantEligible, want] of scenarios) {
    fs.writeFileSync(ledgerPath, `${JSON.stringify({ weeks: { [isoDate(0)]: { boosts } } }, null, 2)}\n`);
    const output = execFileSync(process.execPath, [script, 'eligible'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FB_SCHEDULE_PATH: schedulePath,
        FB_BOOST_LEDGER_PATH: ledgerPath,
        FB_BOOST_TODAY: today,
      },
    });
    const json = JSON.parse(output);
    if (wantEligible) {
      assert.equal(json.eligible, true, `${today}: expected eligible, got ${JSON.stringify(json)}`);
      assert.ok(json.pick.key.startsWith(want), `${today}: expected ${want}*, got ${json.pick.key}`);
    } else {
      assert.equal(json.eligible, false, `${today}: expected not eligible, got ${JSON.stringify(json)}`);
      assert.equal(json.reason, want, `${today}: reason`);
    }
  }

  console.log('ok fb-boost-ledger');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
