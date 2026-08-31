/**
 * Node test for status.js (port of scripts/lib/seo-run-status.test.mjs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  liveRunStatus,
  bucketStatusCount,
  countRunStatuses,
  STATUS_COUNTS_WINDOW_MS,
  isRecoveryItem,
  isPendingApproval,
  isWaitingOnOwner,
  statusLabelFor,
  statusColorFor,
  isOnGraph,
  recoveryClass,
  isAttentionItem,
  ageLabel,
  ownerFor,
  nextActionFor,
} from './status.js';

describe('liveRunStatus', () => {
  it('maps frozen rejected to rejected (not executing)', () => {
    const ls = liveRunStatus(
      { id: 'r1', status: 'rejected' },
      Array.from({ length: 11 }, () => ({ status: 'rejected' })),
    );
    assert.equal(ls, 'rejected');
    assert.equal(bucketStatusCount(ls), 'incomplete');
  });

  it('treats skipped posts as finished so mostly-posted runs are done', () => {
    const ls = liveRunStatus(
      { id: 'r2', status: 'done' },
      [
        ...Array.from({ length: 10 }, () => ({ status: 'posted' })),
        { status: 'skipped' },
      ],
    );
    assert.equal(ls, 'done');
    assert.equal(bucketStatusCount(ls), 'complete');
  });

  it('treats scheduled_native GBP rows as finished (not partial)', () => {
    const ls = liveRunStatus(
      { id: 'r2b', status: 'done' },
      [{ status: 'posted' }, ...Array.from({ length: 6 }, () => ({ status: 'scheduled_native' }))],
    );
    assert.equal(ls, 'done');
    assert.equal(bucketStatusCount(ls), 'complete');
  });

  it('does not call partial for dismissed/cancelled posts', () => {
    assert.equal(
      liveRunStatus({ id: 'r3', status: 'done' }, [{ status: 'dismissed' }]),
      'dismissed',
    );
    assert.equal(
      bucketStatusCount(liveRunStatus({ id: 'r3', status: 'done' }, [{ status: 'dismissed' }])),
      'incomplete',
    );
  });

  it('keeps real in-flight work as executing/partial', () => {
    const ls = liveRunStatus(
      { id: 'r4', status: 'done' },
      [{ status: 'posted' }, { status: 'pending_approval' }],
    );
    assert.equal(ls, 'executing');
    assert.equal(bucketStatusCount(ls), 'partial');
  });

  it('flags current post errors as error/blocked', () => {
    const ls = liveRunStatus(
      { id: 'r5', status: 'done' },
      [{ status: 'posted' }, { status: 'error' }],
    );
    assert.equal(ls, 'error');
    assert.equal(bucketStatusCount(ls), 'blocked');
  });

  it('maps needs_verification to its own live status, not error', () => {
    const ls = liveRunStatus({ id: 'r6', status: 'done' }, [{ status: 'needs_verification' }]);
    assert.equal(ls, 'needs_verification');
    assert.equal(bucketStatusCount(ls), 'verify');
    assert.equal(ls === 'error', false);
  });

  it('error outranks needs_verification when both exist', () => {
    const ls = liveRunStatus(
      { id: 'r7', status: 'done' },
      [{ status: 'error' }, { status: 'needs_verification' }],
    );
    assert.equal(ls, 'error');
  });
});

describe('isRecoveryItem', () => {
  it('true for error, needs_verification, failed, waiting_on_owner', () => {
    for (const status of ['error', 'needs_verification', 'failed', 'waiting_on_owner']) {
      assert.equal(isRecoveryItem({ status }), true, status);
    }
  });

  it('true for posting without posted_at', () => {
    assert.equal(isRecoveryItem({ status: 'posting' }), true);
    assert.equal(isRecoveryItem({ status: 'posting', posted_at: '2026-08-30T12:00:00Z' }), false);
  });

  it('false for posted, scheduled, pending_approval', () => {
    for (const status of ['posted', 'scheduled', 'pending_approval', 'done', 'skipped']) {
      assert.equal(isRecoveryItem({ status }), false, status);
    }
  });
});

describe('status helpers', () => {
  it('isPendingApproval / isWaitingOnOwner', () => {
    assert.equal(isPendingApproval('pending_approval'), true);
    assert.equal(isPendingApproval('needs_approval'), true);
    assert.equal(isPendingApproval('posted'), false);
    assert.equal(isWaitingOnOwner('waiting_on_owner'), true);
    assert.equal(isWaitingOnOwner('WAITING_ON_OWNER'), true);
    assert.equal(isWaitingOnOwner('pending_approval'), false);
  });

  it('statusLabelFor by kind', () => {
    assert.equal(statusLabelFor('done', 'run'), 'DONE');
    assert.equal(statusLabelFor('done', 'task'), 'DONE');
    assert.equal(statusLabelFor('done', 'post'), 'POSTED');
    assert.equal(statusLabelFor('waiting_on_owner', 'task'), 'WAITING ON OWNER');
  });

  it('statusColorFor run/task done is green', () => {
    assert.equal(statusColorFor('done', 'run'), '#10b981');
    assert.equal(statusColorFor('done', 'task'), '#10b981');
    assert.equal(statusColorFor('waiting_on_owner', 'task'), '#f59e0b');
  });

  it('isOnGraph requires a platform_post_id and live-ish status', () => {
    assert.equal(isOnGraph({ status: 'scheduled', platform_post_id: '1' }), true);
    assert.equal(isOnGraph({ status: 'scheduled', platform_post_id: null }), false);
    assert.equal(isOnGraph({ status: 'posted', platform_post_id: '1' }), true);
    assert.equal(isOnGraph({ status: 'pending_approval', platform_post_id: '1' }), false);
  });

  it('GBP scheduled/scheduled_native are not on the graph (corrected semantics)', () => {
    assert.equal(isOnGraph({ platform: 'gbp', status: 'scheduled', platform_post_id: '1' }), false);
    assert.equal(isOnGraph({ platform: 'gbp', status: 'scheduled_native', platform_post_id: '1' }), false);
    assert.equal(isOnGraph({ platform: 'gbp', status: 'posted', platform_post_id: '1' }), true);
    assert.equal(isOnGraph({ platform: 'gbp', status: 'posted', platform_post_id: null }), false);
    // Facebook Graph scheduling stays on-graph; unknown platforms keep old fallback.
    assert.equal(isOnGraph({ platform: 'facebook', status: 'scheduled', platform_post_id: '1' }), true);
    assert.equal(isOnGraph({ platform: 'gbp', status: 'posted', platform_post_id: '1' }), true);
  });

  it('scheduled_native label reads 9AM TICK, not AUTO 9AM', () => {
    assert.equal(statusLabelFor('scheduled_native', 'post'), '9AM TICK');
    assert.equal(statusLabelFor('needs_verification', 'run'), 'NEEDS VERIFY');
    assert.equal(statusLabelFor('needs_verification', 'task'), 'NEEDS VERIFY');
  });
});

describe('recoveryClass', () => {
  const today = '2026-08-30';

  it('execution for error/failed/stuck posting', () => {
    assert.equal(recoveryClass({ status: 'error' }, { today }), 'execution');
    assert.equal(recoveryClass({ status: 'failed' }, { today }), 'execution');
    assert.equal(recoveryClass({ status: 'posting', posted_at: null }, { today }), 'execution');
    assert.equal(recoveryClass({ status: 'posting', posted_at: '2026-08-30T12:00:00Z' }, { today }), null);
  });

  it('verification for needs_verification and past queued days never published', () => {
    assert.equal(recoveryClass({ status: 'needs_verification' }, { today }), 'verification');
    assert.equal(
      recoveryClass({ status: 'scheduled_native', post_date: '2026-08-25', posted_at: null }, { today }),
      'verification',
    );
  });

  it('past fallback scheduled day that never published is an execution miss', () => {
    assert.equal(
      recoveryClass({ status: 'scheduled', post_date: '2026-08-26', posted_at: null }, { today }),
      'execution',
    );
  });

  it('future scheduled days are not attention items', () => {
    assert.equal(recoveryClass({ status: 'scheduled_native', post_date: '2026-08-31' }, { today }), null);
    assert.equal(recoveryClass({ status: 'scheduled', post_date: '2026-09-01' }, { today }), null);
  });

  it('owner for waiting_on_owner', () => {
    assert.equal(recoveryClass({ status: 'waiting_on_owner' }, { today }), 'owner');
  });

  it('historical for skipped and other-run items', () => {
    assert.equal(recoveryClass({ status: 'skipped' }, { today }), 'historical');
    assert.equal(
      recoveryClass({ status: 'error', run_id: 'old' }, { today, currentRunId: 'new' }),
      'historical',
    );
    assert.equal(isAttentionItem({ status: 'skipped' }, { today }), false);
    assert.equal(isAttentionItem({ status: 'error' }, { today }), true);
  });

  it('null for clean statuses', () => {
    assert.equal(recoveryClass({ status: 'posted' }, { today }), null);
    assert.equal(recoveryClass({ status: 'pending_approval' }, { today }), null);
    assert.equal(recoveryClass(null, { today }), null);
  });
});

describe('actionability metadata', () => {
  it('ageLabel renders compact age', () => {
    assert.equal(ageLabel({ post_date: '2026-08-30' }, '2026-08-30'), 'today');
    assert.equal(ageLabel({ post_date: '2026-08-29' }, '2026-08-30'), '1d');
    assert.equal(ageLabel({ post_date: '2026-08-27' }, '2026-08-30'), '3d');
    assert.equal(ageLabel({ post_date: '2026-08-16' }, '2026-08-30'), '2w');
    assert.equal(ageLabel({}, '2026-08-30'), null);
  });

  it('ownerFor maps statuses to acting party', () => {
    assert.equal(ownerFor({ status: 'error' }), 'Bridge worker');
    assert.equal(ownerFor({ status: 'posting' }), 'Bridge worker');
    assert.equal(ownerFor({ status: 'needs_verification' }), 'Verification');
    assert.equal(ownerFor({ status: 'waiting_on_owner' }), 'Owner');
    assert.equal(ownerFor({ status: 'scheduled_native' }), '9am tick');
    assert.equal(ownerFor({ status: 'skipped' }), '—');
  });

  it('nextActionFor gives healer copy', () => {
    assert.equal(nextActionFor({ status: 'needs_verification' }), 'Verify listing — do not re-post');
    assert.equal(nextActionFor({ status: 'waiting_on_owner' }), 'Owner approves or provides input');
    assert.equal(nextActionFor({ status: 'skipped' }), 'Skipped — backlog, no action');
    assert.match(nextActionFor({ status: 'scheduled_native' }), /9am/);
    assert.match(nextActionFor({ status: 'scheduled' }), /fallback/);
    assert.match(nextActionFor({ status: 'error' }), /bridge/i);
  });
});

describe('countRunStatuses window', () => {
  const now = Date.parse('2026-08-14T15:00:00Z');

  it('windows out old runs and classifies terminal histories correctly', () => {
    const runs = [
      { id: 'new', week_of: '2026-08-10', status: 'done', created_at: '2026-08-07T14:00:00Z' },
      { id: 'rej', week_of: '2026-08-04', status: 'rejected', created_at: '2026-07-29T03:00:00Z' },
      { id: 'old', week_of: '2026-07-06', status: 'done', created_at: '2026-07-03T15:00:00Z' },
    ];
    const postsByRun = {
      new: Array.from({ length: 11 }, () => ({ status: 'posted' })),
      rej: Array.from({ length: 11 }, () => ({ status: 'rejected' })),
      old: [{ status: 'posted' }, { status: 'skipped' }],
    };
    const { statusCounts, windowed } = countRunStatuses(runs, postsByRun, {
      now,
      windowMs: STATUS_COUNTS_WINDOW_MS,
    });
    assert.equal(windowed.some((r) => r.id === 'old'), false, 'Jul 6 should fall outside 28d window');
    assert.deepEqual(statusCounts, {
      complete: 1,
      partial: 0,
      blocked: 0,
      incomplete: 1,
      verify: 0,
    });
  });
});
