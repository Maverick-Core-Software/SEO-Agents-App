import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('ApprovalInboxPage read-only', () => {
  it('source uses ReadOnlyButton and has no mutation calls', () => {
    const src = readFileSync(join(here, 'ApprovalInboxPage.jsx'), 'utf8');
    assert.ok(src.includes('ReadOnlyButton'));
    assert.ok(src.includes('write action — read-only slice'));
    assert.ok(src.includes('disabled'));
    for (const needle of ['.insert(', '.update(', '.delete(', '.upsert(', "method: 'POST'", 'method: "POST"']) {
      assert.equal(src.includes(needle), false, `must not contain ${needle}`);
    }
  });

  it('attemptApprove / attemptSkip throw READ_ONLY without fetching', async () => {
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (...args) => {
      calls += 1;
      return orig ? orig(...args) : Promise.reject(new Error('fetch disabled'));
    };
    try {
      const { attemptApprove, attemptSkip } = await import('../fixtures/approval.js');
      assert.throws(() => attemptApprove(), { message: 'READ_ONLY' });
      assert.equal(calls, 0);
      assert.throws(() => attemptSkip(), { message: 'READ_ONLY' });
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
