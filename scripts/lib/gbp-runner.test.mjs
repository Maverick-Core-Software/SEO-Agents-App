// scripts/lib/gbp-runner.test.mjs
import assert from 'node:assert/strict';
import {
  excelDateToIso,
  parseDriverJson,
  gbpNeedsVerificationMessage,
  gbpListingUnverifiedMessage,
  gbpDailyStatusForExit,
  gbpScheduleStatusForExit,
  gbpVerifyDisposition,
  isAbnormalExit,
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
  { status: 'posted', error: null, archive: false, platform_post_id: 'u' });
assert.equal(gbpDailyStatusForExit(3, { verificationAttempts: 5 }).status, 'needs_verification');
assert.equal(gbpDailyStatusForExit(3, {}).archive, false);
assert.deepEqual(gbpDailyStatusForExit(4, {}), { status: 'pending_approval', error: null, archive: false, platform_post_id: null });
assert.equal(gbpDailyStatusForExit(1, {}).status, 'error');
assert.equal(gbpDailyStatusForExit(1, {}).archive, false);
assert.equal(isAbnormalExit(3221226505), true);
assert.equal(isAbnormalExit(1), false);
assert.equal(gbpDailyStatusForExit(3221226505, { result: 'posted', verified: true, postUrl: 'u' }).status, 'posted');
assert.equal(gbpDailyStatusForExit(3221226505, { result: 'posted', verified: false }).status, 'needs_verification');
assert.equal(gbpDailyStatusForExit(3221226505, {}).status, 'needs_verification');
assert.equal(gbpVerifyDisposition({
  ok: false, exitCode: 3221226505, stdout: '{"result":"complete","verified":1}\n', currentStatus: 'posted',
}).action, 'confirmed');
assert.equal(gbpVerifyDisposition({
  ok: false, exitCode: 3221226505, stdout: '', currentStatus: 'posted',
}).action, 'crash');
assert.equal(gbpVerifyDisposition({
  ok: false, exitCode: 3221226505, stdout: '', currentStatus: 'posted',
}).status, 'needs_verification');
assert.equal(gbpVerifyDisposition({
  ok: false, exitCode: 3221226505, stdout: '', currentStatus: 'posted', platformPostId: 'https://x/post',
}).action, 'confirmed');
assert.equal(gbpVerifyDisposition({
  ok: false, exitCode: 3221226505, stdout: '', currentStatus: 'needs_verification',
}).action, 'crash');
assert.equal(gbpVerifyDisposition({
  ok: true, exitCode: 0, stdout: '{"result":"complete","verified":0,"failed":1}\n', currentStatus: 'posted',
}).action, 'miss');
assert.equal(gbpVerifyDisposition({
  ok: true, exitCode: 0, stdout: '{"result":"complete","verified":0,"failed":1}\n', currentStatus: 'posted', lastAttempt: true,
}).action, 'unverified');
assert.equal(gbpVerifyDisposition({
  ok: true, exitCode: 0, stdout: '{"result":"complete","verified":0,"failed":1}\n', currentStatus: 'posted', lastAttempt: true,
}).status, 'needs_verification');
assert.ok(gbpVerifyDisposition({
  ok: true, exitCode: 0, stdout: '{"result":"complete","verified":0,"failed":1}\n', currentStatus: 'posted', lastAttempt: true,
}).error.includes('do not re-post'));
assert.equal(gbpVerifyDisposition({
  ok: true, exitCode: 0, stdout: '{"result":"complete","verified":0,"error":"GBP session expired (marketing page shown)"}\n', currentStatus: 'posted',
}).action, 'crash');
assert.ok(gbpListingUnverifiedMessage().includes('do not re-post'));
assert.deepEqual(gbpDailyStatusForExit(0, { result: 'already_live', postUrl: 'https://x/post' }),
  { status: 'posted', error: null, archive: true, platform_post_id: 'https://x/post' });
assert.deepEqual(gbpDailyStatusForExit(0, { result: 'already_queued' }),
  { status: 'posted', error: null, archive: false, platform_post_id: null });

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
assert.equal(gbpScheduleStatusForExit(3221226505, {}).status, 'scheduled_native');

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

// --- runDailyGbp 9am path: scheduled_native must run the driver (no skip) ---
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
  const supabase = makeQb([{ id: 'p1', run_id: 'r1', post_date: '2026-08-31', photo_file: '', status: 'scheduled_native' }]);
  const runPhaseCalls = [];
  const runPhase = async (runId, phase, cmd, args) => {
    runPhaseCalls.push({ cmd, args });
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","verified":true,"postUrl":"https://x/post"}', stderr: '' };
  };

  await runDailyGbp({
    supabase,
    runPhase,
    log: async () => {},
    env: {},
    todayDate: '2026-08-31',
    gbpPosterPath: 'C:/fake/driver.mjs',
    projectRoot: process.cwd(),
  });

  assert.equal(runPhaseCalls.length, 1, 'runDailyGbp must invoke the driver for scheduled_native rows');
  assert.equal(runPhaseCalls[0].args[0], 'C:/fake/driver.mjs');
  assert.ok(runPhaseCalls[0].args.includes('--date'));
  assert.ok(runPhaseCalls[0].args.includes('2026-08-31'));
  assert.equal(runPhaseCalls[0].args.includes('--schedule'), false, '9am path is a live post, not --schedule');
  const posted = updates.find(u => u.status === 'posted');
  assert.ok(posted, 'runDailyGbp should mark scheduled_native posted after a verified driver run');
  assert.equal(posted.platform_post_id, 'https://x/post');
}

// --- runDailyGbp 9am path: scheduled rows still post (unchanged fallback) ---
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
  const supabase = makeQb([{ id: 'p2', run_id: 'r1', post_date: '2026-08-31', photo_file: '', status: 'scheduled' }]);
  const runPhaseCalls = [];
  const runPhase = async (_runId, _phase, _cmd, args) => {
    runPhaseCalls.push(args);
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","verified":true,"postUrl":"https://x/sched"}', stderr: '' };
  };

  await runDailyGbp({
    supabase,
    runPhase,
    log: async () => {},
    env: {},
    todayDate: '2026-08-31',
    gbpPosterPath: 'C:/fake/driver.mjs',
    projectRoot: process.cwd(),
  });

  assert.equal(runPhaseCalls.length, 1);
  assert.equal(runPhaseCalls[0].includes('--schedule'), false);
  assert.equal(updates.find(u => u.status === 'posted')?.platform_post_id, 'https://x/sched');
}

// --- runDailyGbp shifted-schedule recovery: driver "No post found" → restore
// workbook row from Supabase → retry the driver once ---
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
  const supabase = makeQb([{
    id: 'p1', run_id: 'r1', post_date: '2026-08-31', photo_file: 'IMG_4931.JPG', status: 'scheduled_native',
    day: 4, service: 'Generator Interlock / Inlet', hook: 'Portable Generator + Interlock = Real Backup Power',
    body: 'Body copy', cta: 'CTA copy',
  }]);
  const runPhaseCalls = [];
  const runPhase = async () => {
    runPhaseCalls.push(runPhaseCalls.length + 1);
    if (runPhaseCalls.length === 1) {
      return { ok: false, exitCode: 1, stdout: '{"result":"failed","failure_reason":"data","error":"No post found for date: 2026-08-31"}', stderr: 'No post found for date: 2026-08-31' };
    }
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","verified":true,"postUrl":"https://x/post"}', stderr: '' };
  };
  const restored = [];
  const syncGbpRow = async ({ post }) => { restored.push(post); return true; };

  await runDailyGbp({
    supabase, runPhase, log: async () => {}, env: {},
    todayDate: '2026-08-31', gbpPosterPath: 'C:/fake/driver.mjs', projectRoot: process.cwd(),
    syncGbpRow,
  });

  assert.equal(runPhaseCalls.length, 2, 'data-missing driver failure must retry once after workbook restore');
  assert.equal(restored.length, 1, 'syncGbpRow must be called with today row');
  assert.equal(restored[0].post_date, '2026-08-31');
  assert.equal(restored[0].day, 4);
  assert.equal(updates.find(u => u.status === 'posted')?.platform_post_id, 'https://x/post');
}

// --- runDailyGbp recovery guard: if the workbook restore fails, do NOT retry ---
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
  const supabase = makeQb([{ id: 'p1', run_id: 'r1', post_date: '2026-08-31', photo_file: '', status: 'scheduled_native' }]);
  const runPhaseCalls = [];
  const runPhase = async () => {
    runPhaseCalls.push(1);
    return { ok: false, exitCode: 1, stdout: '{"result":"failed","failure_reason":"data","error":"No post found for date: 2026-08-31"}', stderr: '' };
  };

  await runDailyGbp({
    supabase, runPhase, log: async () => {}, env: {},
    todayDate: '2026-08-31', gbpPosterPath: 'C:/fake/driver.mjs', projectRoot: process.cwd(),
    syncGbpRow: async () => false,
  });

  assert.equal(runPhaseCalls.length, 1, 'no retry when the workbook restore fails');
  assert.ok(updates.find(u => u.status === 'error'), 'row marked error when restore fails');
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
    c.args?.includes('--approve-dates') && c.args.includes('2026-07-10'));
  const driverIdx = calls.findIndex(c => c.args?.[0] === 'C:/fake/driver.mjs');
  assert.ok(approveIdx !== -1, 'mark-gbp-approved must include Day 1 post_date');
  assert.ok(driverIdx !== -1, 'Day 1 driver should run');
  assert.ok(approveIdx < driverIdx, 'Day 1 approval must be stamped before the driver runs');
  // Day 2 must still be approved too (same call or a later one).
  assert.ok(calls.some(c => c.args?.includes('--approve-dates') && c.args.includes('2026-07-11')),
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
