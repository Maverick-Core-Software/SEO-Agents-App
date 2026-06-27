// scripts/lib/gbp-runner.test.mjs
import assert from 'node:assert/strict';
import {
  excelDateToIso,
  parseDriverJson,
  gbpNeedsVerificationMessage,
  gbpDailyStatusForExit,
  centralDateHour,
  runDailyGbp,
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

console.log('ok gbp-runner orchestration');
