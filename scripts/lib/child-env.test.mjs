// scripts/lib/child-env.test.mjs
// F1 (rc1 review): a Python child spawned from a Node service on Windows must
// never inherit TZ; on posix it must keep it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pythonChildEnv } from './child-env.mjs';

describe('pythonChildEnv', () => {
  it('strips TZ on win32 and leaves everything else alone', () => {
    const env = pythonChildEnv({ TZ: 'America/Chicago', PATH: 'x', SEO_PIPELINE: 'legacy' }, 'win32');
    assert.equal('TZ' in env, false);
    assert.equal(env.PATH, 'x');
    assert.equal(env.SEO_PIPELINE, 'legacy');
  });

  it('keeps TZ on posix (AIWA pins America/Chicago through it)', () => {
    const env = pythonChildEnv({ TZ: 'America/Chicago', PATH: 'x' }, 'linux');
    assert.equal(env.TZ, 'America/Chicago');
  });

  it('never mutates the source env', () => {
    const src = { TZ: 'America/Chicago' };
    pythonChildEnv(src, 'win32');
    assert.equal(src.TZ, 'America/Chicago');
  });
});
