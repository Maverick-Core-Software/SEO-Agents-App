// scripts/lib/gbp-runner.test.mjs
import assert from 'node:assert/strict';
import {
  excelDateToIso,
  parseDriverJson,
  gbpNeedsVerificationMessage,
  gbpDailyStatusForExit,
  gbpScheduleStatusForExit,
  centralDateHour,
  runDailyGbp,
  runGbpForApprovedRun,
} from './gbp-runner.mjs';

// excelDateToIso: Date, Excel serial, and string forms
assert.equal(excelDateToIso(new Date('2026-06-27T00:00:00Z')), '2026-06-27');
assert.equal(excelDateToIso(46200), '2026-06-27'); // Excel serial 46200 => 2026-06-27 (xlsx.SSF source of truth)
assert.equal(excelDateToIso('2026-06-27 extra'), '2026-06-27');
assert.equal(excelDateToIso(''), '');

// parseDriverJson: last JSON line wins; junk => {}
assert.deepEqual(parseDriverJson('noise\n{"result":"posted","postUrl":"u"}'), { result: 'posted', postUrl: 'u' });
assert.deepEqual(parseDriverJson('not json at all'), {});

// gbpNeedsVerificationMessage: includes attempt count + snapshot path
const m = gbpNeedsVerificationMessage({ verificationAttempts: 3, verificationSnapshot: { textFile: 'C:/x.json' } });
assert.ok(m.includes('3'));
assert.ok(m.includes('C:/x.json'));

// gbpDailyStatusForExit: exit code => weekly_posts update intent
assert.deepEqual(gbpDailyStatusForExit(0, { postUrl: 'u' }),
  { status: 'posted', error: null, archive: true, platform_post_id: 'u' });
assert.equal(gbpDailyStatusForExit(3, { verificationAttempts: 5 }).status, 'needs_verification');
assert.equal(gbpDailyStatusForExit(3, {}).archive, false);
assert.deepEqual(gbpDailyStatusForExit(4, {}), { status: 'pending_approval', error: null, archive: false, platform_post_id: null });
assert.equal(gbpDailyStatusForExit(1, {}).status, 'error');
assert.equal(gbpDailyStatusForExit(1, {}).archive, false);

// centralDateHour: 2026-06-27 14:30 UTC is 09:30 CDT (UTC-5 in June)
const { todayDate, cstHour } = centralDateHour(new Date('2026-06-27T14:30:00Z'));
assert.equal(todayDate, '2026-06-27');
assert.equal(cstHour, 9);
// 05:30 UTC same day is 00:30 CDT => still 2026-06-27, hour 0
const early = centralDateHour(new Date('2026-06-27T05:30:00Z'));
assert.equal(early.todayDate, '2026-06-27');
assert.equal(early.cstHour, 0);

console.log('ok gbp-runner pure helpers');

// gbpScheduleStatusForExit: exit code => scheduled-post update intent
assert.deepEqual(gbpScheduleStatusForExit(0, {}),
  { status: 'scheduled_native', error: null });
assert.equal(gbpScheduleStatusForExit(3, {}).status, 'scheduled_native');
assert.ok(gbpScheduleStatusForExit(3, {}).error.includes('unconfirmed'));
assert.deepEqual(gbpScheduleStatusForExit(4, {}),
  { status: 'pending_approval', error: null });
assert.deepEqual(gbpScheduleStatusForExit(1, {}),
  { status: 'scheduled', error: null });

console.log('ok gbpScheduleStatusForExit');

// --- runDailyGbp wiring: a verified post (exit 0) marks the row 'posted' ---
{
  const updates = [];
  // Minimal chainable Supabase stub. select-chain ends at .order() (awaitable);
  // update-chain ends at .eq() (awaitable).
  const makeQb = (rows) => {
    const qb = {
      from: () => qb,
      select: () => qb,
      eq: () => qb,
      in: () => qb,
      order: () => Promise.resolve({ data: rows }),
      update: (vals) => { updates.push(vals); return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    };
    return qb;
  };
  const supabase = makeQb([{ id: 'p1', run_id: 'r1', post_date: '2026-06-27', photo_file: '' }]);
  const runPhase = async () => ({ ok: true, exitCode: 0, stdout: '{"result":"posted","postUrl":"https://x/post"}', stderr: '' });

  await runDailyGbp({
    supabase,
    runPhase,
    log: async () => {},
    env: {}, // no GBP_WORKBOOK_PATH => markGbpPostedAndArchive short-circuits, no Excel touched
    todayDate: '2026-06-27',
    gbpPosterPath: 'C:/fake/driver.mjs',
    projectRoot: process.cwd(),
  });

  const posted = updates.find(u => u.status === 'posted');
  assert.ok(posted, 'runDailyGbp should mark the row posted on exit 0');
  assert.equal(posted.platform_post_id, 'https://x/post');
}

// --- runDailyGbp native flip: a scheduled_native row flips to posted without driver run ---
{
  const updates = [];
  const makeQb = (rows) => {
    const qb = {
      from: () => qb,
      select: () => qb,
      in: () => qb,
      eq: () => qb,
      order: () => Promise.resolve({ data: rows }),
      update: (vals) => { updates.push(vals); return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    };
    return qb;
  };
  const supabase = makeQb([{ id: 'p1', run_id: 'r1', post_date: '2026-07-12', photo_file: '', status: 'scheduled_native' }]);
  const runPhaseCalls = [];
  const runPhase = async (runId, phase, cmd, args) => {
    runPhaseCalls.push({ cmd, args });
    return { ok: true, exitCode: 0, stdout: '{}', stderr: '' };
  };

  await runDailyGbp({
    supabase,
    runPhase,
    log: async () => {},
    env: {},
    todayDate: '2026-07-12',
    gbpPosterPath: 'C:/fake/driver.mjs',
    projectRoot: process.cwd(),
  });

  assert.equal(runPhaseCalls.length, 0, 'runPhase should never be called for scheduled_native rows');
  const flipped = updates.find(u => u.status === 'posted' && u.platform_post_id === null);
  assert.ok(flipped, 'runDailyGbp should flip scheduled_native to posted with null platform_post_id');
}

console.log('ok gbp-runner orchestration');

// --- runGbpForApprovedRun: Day 1's workbook approval gate must be stamped
// (mark-gbp-approved --date <day1>) BEFORE the Day-1 driver runs, or the driver
// exits 4 (pending_approval) every time. Regression: run 2c5fc296, 2026-07-10.
{
  const calls = [];
  const makeQb = () => {
    const qb = {
      from: () => qb,
      select: () => qb,
      gt: () => Promise.resolve({ data: null, error: null }),
      eq: () => qb,
      update: () => qb,
    };
    return qb;
  };
  const runPhase = async (runId, phase, cmd, args) => {
    calls.push({ cmd, args });
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","postUrl":"u"}', stderr: '' };
  };

  await runGbpForApprovedRun({
    runId: 'r1',
    gbpPosts: [
      { id: 'p1', day: 1, post_date: '2026-07-10', run_id: 'r1' },
      { id: 'p2', day: 2, post_date: '2026-07-11', run_id: 'r1' },
    ],
    deps: {
      supabase: makeQb(),
      runPhase,
      log: async () => {},
      env: {}, // no GBP_WORKBOOK_PATH => no Excel touched
      projectRoot: process.cwd(),
      paths: { photoPick: 'C:/nonexistent/photo-pick.mjs', gbpPoster: 'C:/fake/driver.mjs', seoAgentsExe: 'seo-agents.exe' },
    },
  });

  const approveIdx = calls.findIndex(c =>
    c.args?.[0] === 'mark-gbp-approved' && c.args.includes('2026-07-10'));
  const driverIdx = calls.findIndex(c => c.args?.[0] === 'C:/fake/driver.mjs');
  assert.ok(approveIdx !== -1, 'mark-gbp-approved must include Day 1 post_date');
  assert.ok(driverIdx !== -1, 'Day 1 driver should run');
  assert.ok(approveIdx < driverIdx, 'Day 1 approval must be stamped before the driver runs');
  // Day 2 must still be approved too (same call or a later one).
  assert.ok(calls.some(c => c.args?.[0] === 'mark-gbp-approved' && c.args.includes('2026-07-11')),
    'mark-gbp-approved must still cover Days 2-7');
}

// --- runGbpForApprovedRun native scheduling loop: Days 2-7 run with --schedule ---
{
  const updates = [];
  const makeQb = () => {
    const qb = {
      from: () => qb,
      select: () => qb,
      eq: () => qb,
      update: (vals) => { updates.push(vals); return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    };
    return qb;
  };
  const runPhaseCalls = [];
  const runPhase = async (runId, phase, cmd, args) => {
    runPhaseCalls.push({ cmd, args });
    if (args?.[args.length - 2] === '--schedule') {
      return { ok: true, exitCode: 0, stdout: '{"result":"scheduled_native"}', stderr: '' };
    }
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","postUrl":"u"}', stderr: '' };
  };

  await runGbpForApprovedRun({
    runId: 'r1',
    gbpPosts: [
      { id: 'p1', day: 1, post_date: '2026-07-10', run_id: 'r1' },
      { id: 'p2', day: 2, post_date: '2026-07-11', run_id: 'r1' },
    ],
    deps: {
      supabase: makeQb(),
      runPhase,
      log: async () => {},
      env: {},
      projectRoot: process.cwd(),
      paths: { photoPick: 'C:/nonexistent/photo-pick.mjs', gbpPoster: 'C:/fake/driver.mjs', seoAgentsExe: 'seo-agents.exe' },
    },
  });

  const scheduleCall = runPhaseCalls.find(c => c.args?.includes('--schedule'));
  assert.ok(scheduleCall, 'Day 2 driver should be called with --schedule flag');
  assert.ok(scheduleCall.args.includes('2026-07-11'), '--schedule invocation should include the post_date');
  const nativeUpdate = updates.find(u => u.status === 'scheduled_native');
  assert.ok(nativeUpdate, 'Day 2 row should be updated to scheduled_native');
}

console.log('ok gbp-runner day1 approval gate');
