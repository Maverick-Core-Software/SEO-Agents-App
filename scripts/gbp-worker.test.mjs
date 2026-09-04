/**
 * Node test for gbp-worker's Grok-verdict decision policy.
 * The Grok bot writes one verdict file per post-date (state/gbp-grok/<date>.json);
 * the worker applies each verdict to weekly_posts. The no-repost rule: a not_found
 * verdict triggers exactly one retry, then needs_verification (never an infinite
 * retry loop, never 'error' just because a live post wasn't found).
 * Run: node --test scripts/gbp-worker.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { grokVerdictDecision } from './gbp-worker.mjs';

describe('grokVerdictDecision (Grok-verdict reconciliation policy)', () => {
  it('confirms a live verdict', () => {
    assert.equal(grokVerdictDecision({ verdict: 'live', alreadyRetried: false }), 'confirm');
    assert.equal(grokVerdictDecision({ verdict: 'live', alreadyRetried: true }), 'confirm');
    assert.equal(grokVerdictDecision({ verdict: 'LIVE', alreadyRetried: false }), 'confirm');
  });

  it('retries once on the first not_found', () => {
    assert.equal(grokVerdictDecision({ verdict: 'not_found', alreadyRetried: false }), 'retry');
  });

  it('gives up (needs_verification) on a second not_found after retry', () => {
    assert.equal(grokVerdictDecision({ verdict: 'not_found', alreadyRetried: true }), 'give_up');
  });

  it('ignores unrecognized verdicts', () => {
    assert.equal(grokVerdictDecision({ verdict: 'scheduled', alreadyRetried: false }), 'ignore');
    assert.equal(grokVerdictDecision({ verdict: '', alreadyRetried: false }), 'ignore');
  });
});
