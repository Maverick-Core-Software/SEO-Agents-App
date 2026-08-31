/**
 * Node test for gbp-worker's verify-queue seeding policy.
 * The GBP no-repost rule: an unverified public listing becomes needs_verification
 * (never error) and that status is terminal for the automated queue — a
 * needs_verification row must never be re-seeded, or the worker re-runs the
 * verifier against the listing forever.
 * Run: node --test scripts/gbp-worker.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldQueueGbpVerification } from './gbp-worker.mjs';

describe('shouldQueueGbpVerification (GBP no-repost verify-queue policy)', () => {
  it('queues a posted row with no platform_post_id', () => {
    assert.equal(shouldQueueGbpVerification({ id: 'p1', status: 'posted', platform_post_id: null }), true);
  });

  it('never re-queues needs_verification — terminal, so the verify loop cannot run forever', () => {
    assert.equal(shouldQueueGbpVerification({ id: 'p2', status: 'needs_verification', platform_post_id: null }), false);
  });

  it('skips posted rows that already have a platform_post_id (already verified)', () => {
    assert.equal(shouldQueueGbpVerification({ id: 'p3', status: 'posted', platform_post_id: 'abc' }), false);
  });

  it('skips error and other non-posted statuses', () => {
    assert.equal(shouldQueueGbpVerification({ id: 'p4', status: 'error', platform_post_id: null }), false);
    assert.equal(shouldQueueGbpVerification({ id: 'p5', status: 'posting', platform_post_id: null }), false);
    assert.equal(shouldQueueGbpVerification({ id: 'p6', status: 'scheduled_native', platform_post_id: null }), false);
    assert.equal(shouldQueueGbpVerification({ id: 'p7', status: 'pending_approval', platform_post_id: null }), false);
  });

  it('is false for missing rows', () => {
    assert.equal(shouldQueueGbpVerification(null), false);
    assert.equal(shouldQueueGbpVerification(undefined), false);
    assert.equal(shouldQueueGbpVerification({}), false);
  });
});
