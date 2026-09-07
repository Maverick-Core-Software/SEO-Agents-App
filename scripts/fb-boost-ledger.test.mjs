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

  // ── Scenario block: eligible across the real shape of the 2026-09-07 week ──
  // Day 1 (2026-09-07) and Day 3 (2026-09-09) boosted $25 x 1d; Day 5/6 NO.
  const day1Key = 'day1-whole-home-surge-protection';
  const day3Key = 'day3-ev-charger-installation';
  fs.writeFileSync(schedulePath, [
    '**Start Date:** 2026-09-07',
    '',
    '## DAY 1',
    '**DATE:** 2026-09-07',
    '**DAY:** 1',
    '**SERVICE:** Whole-Home Surge Protection',
    '**BOOST:** yes:$25',
    '',
    '## DAY 3',
    '**DATE:** 2026-09-09',
    '**DAY:** 3',
    '**SERVICE:** EV Charger Installation',
    '**BOOST:** yes:$25',
    '',
    '## DAY 5',
    '**DATE:** 2026-09-11',
    '**DAY:** 5',
    '**SERVICE:** Panel Replacement',
    '**BOOST:** no',
    '',
    '## DAY 6',
    '**DATE:** 2026-09-12',
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
    ['2026-09-07', [], true, 'day1-'],
    ['2026-09-08', [published(day1Key, '2026-09-07')], false, 'no eligible boosts'],
    ['2026-09-08', [], true, 'day1-'],
    ['2026-09-09', [published(day1Key, '2026-09-07')], true, 'day3-'],
    ['2026-09-10', [published(day1Key, '2026-09-07'), published(day3Key, '2026-09-09')], false, 'no eligible boosts'],
  ];
  for (const [today, boosts, wantEligible, want] of scenarios) {
    fs.writeFileSync(ledgerPath, `${JSON.stringify({ weeks: { '2026-09-07': { boosts } } }, null, 2)}\n`);
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
