import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAfterTime,
  shouldRunFbBoostTick,
  decideBoostLaunch,
  parseBoostResult,
  summarizeBoostRun,
} from './fb-boost-tick.mjs';

// ── parseAfterTime ────────────────────────────
test('parseAfterTime parses valid H:MM and HH:MM, 24h', () => {
  assert.deepEqual(parseAfterTime('09:30'), { hour: 9, minute: 30 });
  assert.deepEqual(parseAfterTime('9:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseAfterTime('23:59'), { hour: 23, minute: 59 });
  assert.deepEqual(parseAfterTime('0:00'), { hour: 0, minute: 0 });
});

test('parseAfterTime falls back on invalid or empty input', () => {
  assert.deepEqual(parseAfterTime(''), { hour: 9, minute: 30 });
  assert.deepEqual(parseAfterTime(undefined), { hour: 9, minute: 30 });
  assert.deepEqual(parseAfterTime('banana'), { hour: 9, minute: 30 });
  assert.deepEqual(parseAfterTime('24:00'), { hour: 9, minute: 30 }); // hour out of range
  assert.deepEqual(parseAfterTime('09:99'), { hour: 9, minute: 30 }); // minute out of range
  assert.deepEqual(parseAfterTime('bad', '10:15'), { hour: 10, minute: 15 });
});

// ── shouldRunFbBoostTick ──────────────────────
test('shouldRunFbBoostTick gates on the after boundary (inclusive)', () => {
  const after = { hour: 9, minute: 30 };
  const base = { todayDate: '2026-09-07', lastTickDate: '' };
  assert.equal(shouldRunFbBoostTick({ ...base, cstHour: 8, cstMinute: 59, after }), false);
  assert.equal(shouldRunFbBoostTick({ ...base, cstHour: 9, cstMinute: 29, after }), false);
  assert.equal(shouldRunFbBoostTick({ ...base, cstHour: 9, cstMinute: 30, after }), true);
  assert.equal(shouldRunFbBoostTick({ ...base, cstHour: 10, cstMinute: 0, after }), true);
});

test('shouldRunFbBoostTick blocks same-day repeat, allows a new day', () => {
  const base = { todayDate: '2026-09-07', cstHour: 10, cstMinute: 0, after: { hour: 9, minute: 30 } };
  assert.equal(shouldRunFbBoostTick({ ...base, lastTickDate: '2026-09-07' }), false);
  assert.equal(shouldRunFbBoostTick({ ...base, lastTickDate: '2026-09-06' }), true);
});

// ── decideBoostLaunch ─────────────────────────
test('decideBoostLaunch launches when eligible', () => {
  assert.deepEqual(
    decideBoostLaunch({ eligible: true, week: '2026-09-07', pick: { key: 'day1-2026-09-07' } }),
    { launch: true, reason: 'eligible' },
  );
});

test('decideBoostLaunch launches on human-review reasons', () => {
  assert.deepEqual(
    decideBoostLaunch({ eligible: false, reason: 'BOOST BUDGET SUMMARY present but no decisions parsed — human review required' }),
    { launch: true, reason: 'BOOST BUDGET SUMMARY present but no decisions parsed — human review required' },
  );
});

test('decideBoostLaunch skips everything else, with reason or default', () => {
  assert.deepEqual(decideBoostLaunch({ eligible: false, reason: 'no eligible boosts' }),
    { launch: false, reason: 'no eligible boosts' });
  assert.deepEqual(decideBoostLaunch({ eligible: false, reason: 'schedule stale' }),
    { launch: false, reason: 'schedule stale' });
  assert.deepEqual(decideBoostLaunch(null), { launch: false, reason: 'not eligible' });
});

// ── parseBoostResult ──────────────────────────
test('parseBoostResult parses clean JSON', () => {
  const j = parseBoostResult('{"ok":true,"stage":"eligible"}');
  assert.equal(j.ok, true);
  assert.equal(j.stage, 'eligible');
});

test('parseBoostResult extracts JSON around a trailing assertion line', () => {
  const stdout = '{\n  "ok": true,\n  "stage": "publish"\n}\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c';
  const j = parseBoostResult(stdout);
  assert.equal(j.stage, 'publish');
});

test('parseBoostResult returns null on garbage or empty stdout', () => {
  assert.equal(parseBoostResult('not json at all'), null);
  assert.equal(parseBoostResult(''), null);
  assert.equal(parseBoostResult(undefined), null);
});

// ── summarizeBoostRun ─────────────────────────
test('summarizeBoostRun: no parseable JSON -> error with exit code and first 300 chars', () => {
  const s = summarizeBoostRun({ stdout: 'garbage out', stderr: 'stderr boom', exitCode: 3, error: 'Command failed' });
  assert.equal(s.level, 'error');
  assert.equal(s.line, 'failed: exit 3 Command failed');
  assert.equal(s.result, null);
});

test('summarizeBoostRun: boost applied -> info with key, ad id, total', () => {
  const s = summarizeBoostRun({
    stdout: JSON.stringify({
      ok: true, boost_applied: true,
      pick: { key: 'day1-2026-09-07', total: 25 },
      created: { ad_id: '120209999' },
    }),
    exitCode: 0,
  });
  assert.equal(s.level, 'info');
  assert.equal(s.line, 'applied day1-2026-09-07 ad=120209999 total=$25');
  assert.equal(s.result.ok, true);
});

test('summarizeBoostRun: ok false -> error naming stage and error/detail/reason', () => {
  const s = summarizeBoostRun({ stdout: JSON.stringify({ ok: false, stage: 'verify', error: 'post deleted' }), exitCode: 1 });
  assert.equal(s.level, 'error');
  assert.equal(s.line, 'failed at verify: post deleted');

  const s2 = summarizeBoostRun({ stdout: JSON.stringify({ ok: false, stage: 'reserve', detail: 'REFUSED: ledger mismatch' }), exitCode: 1 });
  assert.equal(s2.level, 'error');
  assert.equal(s2.line, 'failed at reserve: REFUSED: ledger mismatch');

  const s3 = summarizeBoostRun({ stdout: JSON.stringify({ ok: false, stage: 'eligible', reason: 'boom' }), exitCode: 1 });
  assert.equal(s3.line, 'failed at eligible: boom');
});

test('summarizeBoostRun: eligible skip -> info', () => {
  const s = summarizeBoostRun({
    stdout: JSON.stringify({ ok: true, stage: 'eligible', eligible: false, reason: 'no eligible boosts' }),
    exitCode: 0,
  });
  assert.equal(s.level, 'info');
  assert.equal(s.line, 'skip: no eligible boosts (not eligible)');
});

test('summarizeBoostRun: resolve not applied -> warn pending, plus ESCALATED flag', () => {
  const base = { ok: true, boost_applied: false, stage: 'resolve', reason: 'post not found in feed', pick: { key: 'day1-2026-09-07' } };
  const s = summarizeBoostRun({ stdout: JSON.stringify(base), exitCode: 0 });
  assert.equal(s.level, 'warn');
  assert.equal(s.line, 'pending: post not live for day1-2026-09-07 (post not found in feed); next attempt tomorrow');

  const e = summarizeBoostRun({ stdout: JSON.stringify({ ...base, escalate: true }), exitCode: 0 });
  assert.equal(e.level, 'warn');
  assert.equal(e.line, 'pending: post not live for day1-2026-09-07 (post not found in feed); next attempt tomorrow ESCALATED');
});

test('summarizeBoostRun: config skip -> warn', () => {
  const s = summarizeBoostRun({ stdout: JSON.stringify({ ok: true, stage: 'config', reason: 'FB_BOOST_API=0 (live spend disabled)' }), exitCode: 0 });
  assert.equal(s.level, 'warn');
  assert.equal(s.line, 'skip: FB_BOOST_API=0 (live spend disabled)');
});

test('summarizeBoostRun: other stages -> info with reason or ok', () => {
  const s = summarizeBoostRun({ stdout: JSON.stringify({ ok: true, stage: 'publish' }), exitCode: 0 });
  assert.equal(s.level, 'info');
  assert.equal(s.line, 'publish: ok');

  const s2 = summarizeBoostRun({ stdout: JSON.stringify({ ok: true, stage: 'reserve', reason: 'reserved day3' }), exitCode: 0 });
  assert.equal(s2.level, 'info');
  assert.equal(s2.line, 'reserve: reserved day3');
});

test('summarizeBoostRun: non-zero exit with ok JSON appends ignored note', () => {
  const s = summarizeBoostRun({
    stdout: '{\n  "ok": true,\n  "boost_applied": true,\n  "pick": { "key": "day1-2026-09-07", "total": 25 },\n  "created": { "ad_id": "9" }\n}\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING)',
    stderr: 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)',
    exitCode: 134,
    error: 'Command failed',
  });
  assert.equal(s.level, 'info');
  assert.equal(s.line, 'applied day1-2026-09-07 ad=9 total=$25 (exit 134 after result; ignored)');
});

test('summarizeBoostRun: non-zero exit with ok:false JSON gets no ignored note', () => {
  const s = summarizeBoostRun({ stdout: JSON.stringify({ ok: false, stage: 'verify', error: 'nope' }), exitCode: 1, error: 'Command failed' });
  assert.equal(s.level, 'error');
  assert.equal(s.line, 'failed at verify: nope');
});
