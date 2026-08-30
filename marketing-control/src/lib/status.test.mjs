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
    });
  });
});
