// scripts/lib/gbp-runner.test.mjs
import assert from 'node:assert/strict';
import {
  excelDateToIso,
  parseDriverJson,
  gbpNeedsVerificationMessage,
  gbpListingUnverifiedMessage,
  gbpDailyStatusForExit,
  gbpScheduleStatusForExit,
  gbpPolicyViolationMessage,
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
assert.equal(
  gbpDailyStatusForExit(1, { result: 'failed', failure_reason: 'data', error: 'Post image not found: x.jpg' }).status,
  'error',
  'missing photo is an error, not posted',
);
assert.equal(
  gbpDailyStatusForExit(1, { result: 'failed', failure_reason: 'data', error: 'Post image not found: x.jpg' }).archive,
  false,
);
assert.ok(
  gbpDailyStatusForExit(1, { result: 'failed', failure_reason: 'data', error: 'Post image not found: x.jpg' }).error.includes('Post image not found'),
);
assert.equal(
  gbpDailyStatusForExit(1, { result: 'failed', failure_reason: 'session_expired', error: 'logged out' }).status,
  'error',
);
assert.equal(
  gbpDailyStatusForExit(1, { result: 'failed', failure_reason: 'captcha', error: 'unusual traffic' }).status,
  'error',
);
// G2: exit 5 (content policy) is an error on both paths, with the violation detail.
const policyResult = {
  result: 'policy_violation',
  error: 'Post 2026-09-26 violates GBP content policy:\n- [phone] caption contains a phone number',
  violations: [{ rule: 'phone' }],
};
assert.equal(gbpScheduleStatusForExit(5, policyResult).status, 'error',
  'exit 5 must not fall through to scheduled (the legacy daily path would re-post it)');
assert.ok(gbpScheduleStatusForExit(5, policyResult).error.includes('phone number'),
  'exit 5 keeps the policy detail');
assert.equal(gbpDailyStatusForExit(5, policyResult).status, 'error');
assert.ok(gbpDailyStatusForExit(5, policyResult).error.includes('phone number'),
  'the daily path keeps the policy detail too');
assert.equal(gbpDailyStatusForExit(5, policyResult).archive, false);
assert.ok(gbpPolicyViolationMessage({ violations: [{}, {}] }).includes('2 violations'),
  'a detail-free policy result still names the violation count');
assert.equal(gbpScheduleStatusForExit(5, {}).status, 'error');

// centralDateHour: 2026-06-27 14:30 UTC is 09:30 CDT (UTC-5 in June)
const { todayDate, cstHour, cstMinute } = centralDateHour(new Date('2026-06-27T14:30:00Z'));
assert.equal(todayDate, '2026-06-27');
assert.equal(cstHour, 9);
assert.equal(cstMinute, 30);
// 05:30 UTC same day is 00:30 CDT => still 2026-06-27, hour 0
const early = centralDateHour(new Date('2026-06-27T05:30:00Z'));
assert.equal(early.todayDate, '2026-06-27');
assert.equal(early.cstHour, 0);

console.log('ok gbp-runner pure helpers');

// gbpScheduleStatusForExit: exit code => scheduled-post update intent
assert.deepEqual(gbpScheduleStatusForExit(0, {}),
  { status: 'scheduled_native', error: null });
assert.deepEqual(
  gbpScheduleStatusForExit(1, {
    result: 'failed',
    failure_reason: 'session_expired',
    error: 'GBP session expired (logged-out Business Profile marketing page shown).',
  }),
  {
    status: 'error',
    error: 'GBP session expired — Carter must re-authenticate interactively in the user session with node scripts/gbp-poster/driver.mjs --auth. Do not re-post.',
  },
  'session expiry must alert instead of falling back to scheduled',
);
assert.deepEqual(
  gbpScheduleStatusForExit(1, {
    result: 'failed',
    failure_reason: 'captcha',
    error: 'CAPTCHA / unusual traffic interstitial from Google',
  }),
  {
    status: 'error',
    error: 'GBP blocked by CAPTCHA/unusual traffic — a human must resolve it in the user session. Do not re-post automatically.',
  },
  'captcha must alert instead of falling back to scheduled',
);
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

// --- runDailyGbp 9am path: missing photo must stay error, never posted ---
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
  const supabase = makeQb([{ id: 'p1', run_id: 'r1', post_date: '2026-09-09', photo_file: '', status: 'scheduled' }]);
  const runPhase = async () => ({
    ok: false,
    exitCode: 1,
    stdout: '{"result":"failed","failure_reason":"data","error":"Post image not found: old.jpg"}',
    stderr: 'Post image not found: old.jpg',
  });

  await runDailyGbp({
    supabase, runPhase, log: async () => {}, env: {},
    todayDate: '2026-09-09', gbpPosterPath: 'C:/fake/driver.mjs', projectRoot: process.cwd(),
  });

  const posted = updates.find(u => u.status === 'posted');
  assert.equal(posted, undefined, 'missing photo must not be treated as posted');
  const errored = updates.find(u => u.status === 'error');
  assert.ok(errored, 'missing photo marks the row error');
  assert.ok(String(errored.error || '').includes('Post image not found'));
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

// ---------------------------------------------------------------------------
// G1 (cutover Phase D): API-mode scheduling semantics.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { dailyTickDue, applyDriverResult } from './gbp-runner.mjs';

// dailyTickDue: the once-per-day latch the workers keep around runDailyGbp.
assert.equal(dailyTickDue({ cstHour: 8, todayDate: '2026-10-14', lastDailyGbpDate: '' }), false, 'before 09:00 CT: not due');
assert.equal(dailyTickDue({ cstHour: 9, todayDate: '2026-10-14', lastDailyGbpDate: '' }), true, '09:00 CT, untouched day: due');
assert.equal(dailyTickDue({ cstHour: 15, todayDate: '2026-10-14', lastDailyGbpDate: '2026-10-14' }), false, 'same day already ticked: not due');
assert.equal(dailyTickDue({ cstHour: 9, todayDate: '2026-10-15', lastDailyGbpDate: '2026-10-14' }), true, 'next day: due again');
assert.equal(dailyTickDue({ cstHour: 9, todayDate: '', lastDailyGbpDate: '' }), false, 'no date: never due');

// --- runGbpForApprovedRun in API mode: Day 1 posts, Days 2-7 are marked
// `scheduled` with NO poster call (the API has no native scheduling) ---
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
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","verified":true,"postUrl":"accounts/1/locations/2/localPosts/day1"}', stderr: '' };
  };

  await runGbpForApprovedRun({
    runId: 'r1',
    gbpPosts: [
      { id: 'p1', day: 1, post_date: '2026-10-16', run_id: 'r1' },
      { id: 'p2', day: 2, post_date: '2026-10-17', run_id: 'r1' },
      { id: 'p3', day: 3, post_date: '2026-10-18', run_id: 'r1' },
    ],
    deps: {
      supabase: makeQb(),
      runPhase,
      log: async () => {},
      env: { GBP_POSTER: 'api' },
      projectRoot: process.cwd(),
      paths: { photoPick: 'C:/nonexistent/photo-pick.mjs', gbpPoster: 'C:/fake/gbp-api-poster.mjs', seoAgentsExe: 'seo-agents.exe' },
    },
  });

  assert.equal(runPhaseCalls.some(c => c.args?.includes('--schedule')), false, 'API mode must never spawn --schedule');
  const posterCalls = runPhaseCalls.filter(c => c.args?.[0] === 'C:/fake/gbp-api-poster.mjs');
  assert.equal(posterCalls.length, 1, 'only Day 1 invokes the API poster at approval time');
  assert.ok(posterCalls[0].args.includes('2026-10-16'), 'Day 1 poster call carries its date');
  assert.equal(updates.filter(u => u.status === 'scheduled').length, 2, 'Days 2 and 3 are marked scheduled');
  assert.equal(updates.some(u => u.status === 'scheduled_native'), false, 'no scheduled_native in API mode');
  assert.equal(updates.find(u => u.status === 'posted')?.platform_post_id, 'accounts/1/locations/2/localPosts/day1');
}

// --- API mode: applyDriverResult closes the workbook Posted gate for every
// post the API created, including exit 3 (created, GET-back not LIVE yet).
// Playwright mode keeps the gate open on exit 3 (unchanged legacy behaviour). ---
{
  const makeWorkbook = (dir) => {
    const file = path.join(dir, 'schedule.xlsx');
    const ws = xlsx.utils.aoa_to_sheet([
      ['Date', 'Status', 'Posted', 'AssetIdOrDescription'],
      ['2026-10-17', 'Approved', false, ''],
    ]);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Posts');
    xlsx.writeFile(wb, file);
    return file;
  };
  const readPosted = (file) => {
    const wb = xlsx.readFile(file);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets.Posts, { defval: '' });
    return rows[0].Posted;
  };
  const makeQb = (updates) => {
    const qb = {
      from: () => qb,
      update: (vals) => { updates.push(vals); return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    };
    return qb;
  };
  const exit3 = { ok: false, exitCode: 3, stdout: '{"result":"posted","verified":false,"postUrl":"accounts/1/locations/2/localPosts/day2"}', stderr: '' };

  const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-runner-api-'));
  const apiBook = makeWorkbook(apiDir);
  const apiUpdates = [];
  const apiStatus = await applyDriverResult({
    supabase: makeQb(apiUpdates), post: { id: 'p2', run_id: 'r1', post_date: '2026-10-17' }, result: exit3,
    env: { GBP_POSTER: 'api', GBP_WORKBOOK_PATH: apiBook, GBP_ARCHIVE_FOLDER: path.join(apiDir, 'archive') }, log: async () => {},
  });
  assert.equal(apiStatus, 'needs_verification', 'exit 3 stays needs_verification for the operator');
  assert.equal(readPosted(apiBook), true, 'API mode: workbook Posted=TRUE for a created-but-unconfirmed post');

  const pwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-runner-pw-'));
  const pwBook = makeWorkbook(pwDir);
  await applyDriverResult({
    supabase: makeQb([]), post: { id: 'p2', run_id: 'r1', post_date: '2026-10-17' }, result: exit3,
    env: { GBP_POSTER: 'playwright', GBP_WORKBOOK_PATH: pwBook, GBP_ARCHIVE_FOLDER: path.join(pwDir, 'archive') }, log: async () => {},
  });
  assert.notEqual(readPosted(pwBook), true, 'playwright mode: exit 3 leaves the Posted gate open (unchanged)');

  const errDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-runner-err-'));
  const errBook = makeWorkbook(errDir);
  await applyDriverResult({
    supabase: makeQb([]), post: { id: 'p2', run_id: 'r1', post_date: '2026-10-17' },
    result: { ok: false, exitCode: 5, stdout: '{"result":"policy_violation","error":"image_missing"}', stderr: '' },
    env: { GBP_POSTER: 'api', GBP_WORKBOOK_PATH: errBook, GBP_ARCHIVE_FOLDER: path.join(errDir, 'archive') }, log: async () => {},
  });
  assert.notEqual(readPosted(errBook), true, 'API mode: a refused post never closes the gate');
  for (const d of [apiDir, pwDir, errDir]) fs.rmSync(d, { recursive: true, force: true });
}

// --- Daily tick publishes a `scheduled` row exactly once: the row leaves the
// scheduled set on the first tick, so a second tick (worker restart, next
// poll) runs the poster zero more times. ---
{
  const rows = [{ id: 'p2', run_id: 'r1', post_date: '2026-10-17', photo_file: '', status: 'scheduled' }];
  const makeQb = () => {
    const qb = {
      from: () => qb,
      select: () => qb,
      eq: () => qb,
      in: (_col, statuses) => { qb._statuses = statuses; return qb; },
      order: () => Promise.resolve({ data: rows.filter(r => (qb._statuses || []).includes(r.status)) }),
      update: (vals) => ({ eq: (_c, id) => { Object.assign(rows.find(r => r.id === id), vals); return Promise.resolve({ data: null, error: null }); } }),
    };
    return qb;
  };
  let posterRuns = 0;
  const runPhase = async () => {
    posterRuns += 1;
    return { ok: true, exitCode: 0, stdout: '{"result":"posted","verified":true,"postUrl":"accounts/1/locations/2/localPosts/day2"}', stderr: '' };
  };
  const tick = () => runDailyGbp({
    supabase: makeQb(), runPhase, log: async () => {}, env: { GBP_POSTER: 'api' },
    todayDate: '2026-10-17', gbpPosterPath: 'C:/fake/gbp-api-poster.mjs', projectRoot: process.cwd(), gbpMode: 'api',
  });
  await tick();
  assert.equal(posterRuns, 1, 'first tick posts the scheduled row');
  assert.equal(rows[0].status, 'posted');
  await tick();
  await tick();
  assert.equal(posterRuns, 1, 'later ticks on the same day post nothing (row is no longer scheduled)');
}

console.log('ok gbp-runner G1 api-mode scheduling');
