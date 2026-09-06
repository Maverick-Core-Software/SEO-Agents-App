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
import { grokVerdictDecision, acquireGbpWorkerLock, gbpWorkerProcessExists } from './gbp-worker.mjs';

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

describe('acquireGbpWorkerLock (single-instance)', () => {
  it('takes over a stale pidfile when the previous process is dead', () => {
    const files = { '/tmp/gbp-worker.pid': '4321' };
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 99,
      isAlive: () => false,
      readFile: (p) => files[p],
      writeFile: (p, c) => { files[p] = c; },
    });
    assert.equal(lock.ok, true);
    assert.equal(files['/tmp/gbp-worker.pid'], '99');
  });

  it('refuses to start when another gbp-worker pid is still alive', () => {
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 99,
      isAlive: (pid) => pid === 4321,
      readFile: () => '4321',
      writeFile: () => { throw new Error('must not overwrite a live lock'); },
    });
    assert.equal(lock.ok, false);
    assert.equal(lock.existingPid, 4321);
  });

  it('treats the current pid as the owner', () => {
    const files = {};
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 7,
      isAlive: () => true,
      readFile: () => '7',
      writeFile: (p, c) => { files[p] = c; },
    });
    assert.equal(lock.ok, true);
    assert.equal(files['/tmp/gbp-worker.pid'], '7');
  });
});

describe('gbpWorkerProcessExists', () => {
  it('returns true for this process', () => {
    assert.equal(gbpWorkerProcessExists(process.pid), true);
  });
  it('returns false for pid 0 / garbage', () => {
    assert.equal(gbpWorkerProcessExists(0), false);
    assert.equal(gbpWorkerProcessExists('nope'), false);
  });
});
