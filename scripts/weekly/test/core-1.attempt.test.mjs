// scripts/weekly/test/core-1.attempt.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAttempt, stageStart, stageEnd, finishAttempt, makeAttemptId, readGitSha, errorText, DEFAULT_TTL_MS,
} from '../lib/attempt.mjs';
import { createFileStore } from '../lib/store.mjs';
import { LeaseHeld } from '../lib/errors.mjs';
import { AttemptSchema, SCHEMA_VERSION } from '../lib/schemas.mjs';
import { PROJECT_ROOT } from '../lib/paths.mjs';

const NOW = new Date('2026-09-04T21:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const WEEK = '2026-09-07';
const TTL = 10 * 60 * 1000;

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-core1-attempt-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });
const fresh = (name) => createFileStore(path.join(root, name));

const baseArgs = (store, overrides = {}) => ({
  store, week_of: WEEK, mode: 'shadow', now: NOW, gitSha: 'deadbeef',
  versions: { schema: SCHEMA_VERSION, prompt: 'plan.system.md@1', policy: '2026-09-06.1' },
  models: { generate: 'deepseek-chat', fallback: null }, budgetUsd: 20, ttlMs: TTL,
  ...overrides,
});

describe('createAttempt', () => {
  it('records a running attempt and takes the week lease', async () => {
    const store = fresh('create');
    const attempt = await createAttempt(baseArgs(store));
    assert.match(attempt.id, /^2026-09-07-20260904T210000Z-[0-9a-f]{6}$/);
    assert.ok(AttemptSchema.safeParse(attempt).success);
    assert.equal(attempt.status, 'running');
    assert.equal(attempt.started_at, NOW.toISOString());
    assert.equal(attempt.finished_at, null);
    assert.equal(attempt.lease_until, at(TTL).toISOString());
    assert.equal(attempt.git_sha, 'deadbeef');
    assert.equal(attempt.budget_usd, 20);
    assert.equal(attempt.spent_usd, 0);
    assert.deepEqual(attempt.stages, {});
    assert.deepEqual(await store.getAttempt(attempt.id), attempt, 'persisted record equals the returned object');
    const lease = await store.getLease(WEEK);
    assert.equal(lease.attempt_id, attempt.id);
    assert.equal(lease.lease_until, attempt.lease_until);
  });

  it('fills defaults: schema version, unknown prompt/policy/model/git sha, zero budget, default ttl', async () => {
    const store = fresh('create-defaults');
    const attempt = await createAttempt({ store, week_of: WEEK, mode: 'offline', now: NOW });
    assert.deepEqual(attempt.versions, { schema: SCHEMA_VERSION, prompt: 'unknown', policy: 'unknown' });
    assert.deepEqual(attempt.models, { generate: 'unknown', fallback: null });
    assert.equal(attempt.git_sha, 'unknown');
    assert.equal(attempt.budget_usd, 0);
    assert.equal(attempt.lease_until, at(DEFAULT_TTL_MS).toISOString());
  });

  it('honours an explicit id', async () => {
    const store = fresh('create-id');
    const attempt = await createAttempt(baseArgs(store, { id: 'fixed-id' }));
    assert.equal(attempt.id, 'fixed-id');
    assert.equal((await store.getLease(WEEK)).attempt_id, 'fixed-id');
  });

  it('throws LeaseHeld while another attempt holds the week, and records the refusal as a failed attempt', async () => {
    const store = fresh('create-held');
    const first = await createAttempt(baseArgs(store));
    let caught;
    try {
      await createAttempt(baseArgs(store, { id: 'second', now: at(60_000) }));
    } catch (e) { caught = e; }
    assert.ok(caught instanceof LeaseHeld, 'LeaseHeld thrown');
    assert.equal(caught.holder, first.id);
    assert.equal(caught.lease_until, first.lease_until);
    assert.equal(caught.week_of, WEEK);
    assert.equal(caught.attempt_id, 'second');
    assert.match(caught.message, new RegExp(`held by ${first.id} until ${first.lease_until}`));
    const refused = await store.getAttempt('second');
    assert.equal(refused.status, 'failed');
    assert.match(refused.error, /^LeaseHeld: week 2026-09-07 lease held by/);
    assert.equal(refused.finished_at, at(60_000).toISOString());
    assert.equal(refused.lease_until, null);
    assert.equal((await store.getLease(WEEK)).attempt_id, first.id, 'holder unchanged');
    assert.deepEqual(await store.getAttempt(first.id), first, 'first attempt untouched');
  });

  it('a different week is not blocked', async () => {
    const store = fresh('create-other-week');
    await createAttempt(baseArgs(store));
    const other = await createAttempt(baseArgs(store, { week_of: '2026-09-14' }));
    assert.equal(other.week_of, '2026-09-14');
  });

  it('an expired lease is taken over', async () => {
    const store = fresh('create-expired');
    const first = await createAttempt(baseArgs(store));
    const second = await createAttempt(baseArgs(store, { now: at(TTL + 1) }));
    assert.notEqual(second.id, first.id);
    assert.equal((await store.getLease(WEEK)).attempt_id, second.id);
  });

  it('validates its inputs before touching the lease', async () => {
    const store = fresh('create-invalid');
    await assert.rejects(createAttempt({ week_of: WEEK, mode: 'shadow', now: NOW }), /store is required/);
    await assert.rejects(createAttempt({ store, mode: 'shadow', now: NOW }), /week_of is required/);
    await assert.rejects(createAttempt({ store, week_of: WEEK, now: NOW }), /mode is required/);
    await assert.rejects(createAttempt(baseArgs(store, { mode: 'yolo' })), (e) => e instanceof TypeError && /mode/.test(e.message));
    await assert.rejects(createAttempt(baseArgs(store, { week_of: '2026/09/07' })), /week_of/);
    assert.equal(await store.getLease(WEEK), null, 'no lease taken for a rejected attempt');
  });

  it('releases the lease and rethrows when the store cannot persist the record', async () => {
    const store = fresh('create-store-fails');
    const failing = { ...store, createAttempt: async () => { throw new Error('disk full'); } };
    await assert.rejects(createAttempt(baseArgs(failing)), /disk full/);
    assert.equal(await store.getLease(WEEK), null);
    const ok = await createAttempt(baseArgs(store));
    assert.equal(ok.status, 'running');
  });
});

describe('stages', () => {
  it('stageStart records a running stage and keeps the in-memory attempt in sync with the store', async () => {
    const store = fresh('stage-start');
    const attempt = await createAttempt(baseArgs(store));
    const returned = await stageStart(store, attempt, 'collect', at(1000));
    assert.equal(returned, attempt, 'same object reference');
    assert.deepEqual(attempt.stages.collect, { started_at: at(1000).toISOString(), finished_at: null, status: 'running', error: null });
    assert.deepEqual((await store.getAttempt(attempt.id)).stages, attempt.stages);
  });

  it('stageEnd defaults to ok without an error and to failed with one; Error objects become "Name: message"', async () => {
    const store = fresh('stage-end');
    const attempt = await createAttempt(baseArgs(store));
    await stageStart(store, attempt, 'collect', at(1000));
    await stageEnd(store, attempt, 'collect', {}, at(2000));
    assert.deepEqual(attempt.stages.collect, { started_at: at(1000).toISOString(), finished_at: at(2000).toISOString(), status: 'ok', error: null });

    await stageStart(store, attempt, 'generate', at(3000));
    await stageEnd(store, attempt, 'generate', { error: new RangeError('boom') }, at(4000));
    assert.equal(attempt.stages.generate.status, 'failed');
    assert.equal(attempt.stages.generate.error, 'RangeError: boom');
    assert.equal(attempt.stages.collect.status, 'ok', 'earlier stages preserved');

    await stageEnd(store, attempt, 'compare', { status: 'skipped', error: 'no legacy outputs' }, at(5000));
    assert.deepEqual(attempt.stages.compare, { started_at: at(5000).toISOString(), finished_at: at(5000).toISOString(), status: 'skipped', error: 'no legacy outputs' });

    const stored = await store.getAttempt(attempt.id);
    assert.deepEqual(stored.stages, attempt.stages);
    assert.ok(AttemptSchema.safeParse(stored).success);
  });

  it('restarting a stage overwrites its previous record; an invalid status is refused', async () => {
    const store = fresh('stage-restart');
    const attempt = await createAttempt(baseArgs(store));
    await stageStart(store, attempt, 'generate', at(1000));
    await stageEnd(store, attempt, 'generate', { error: 'invalid plan' }, at(2000));
    await stageStart(store, attempt, 'generate', at(3000));
    assert.deepEqual(attempt.stages.generate, { started_at: at(3000).toISOString(), finished_at: null, status: 'running', error: null });
    await assert.rejects(stageEnd(store, attempt, 'generate', { status: 'meh' }, at(4000)), /stages/);
    assert.equal((await store.getAttempt(attempt.id)).stages.generate.status, 'running', 'store unchanged after refusal');
  });

  it('long error text is truncated', async () => {
    const store = fresh('stage-long');
    const attempt = await createAttempt(baseArgs(store));
    await stageEnd(store, attempt, 'x', { error: 'e'.repeat(5000) }, at(1));
    assert.ok(attempt.stages.x.error.length <= 2001);
    assert.ok(attempt.stages.x.error.endsWith('…'));
  });
});

describe('finishAttempt', () => {
  it('success: status succeeded, finished_at, spent_usd, lease released', async () => {
    const store = fresh('finish-ok');
    const attempt = await createAttempt(baseArgs(store));
    await stageStart(store, attempt, 'collect', at(1000));
    await stageEnd(store, attempt, 'collect', {}, at(2000));
    const done = await finishAttempt(store, attempt, { spentUsd: 0.42 }, at(3000));
    assert.equal(done, attempt);
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.error, null);
    assert.equal(attempt.finished_at, at(3000).toISOString());
    assert.equal(attempt.spent_usd, 0.42);
    assert.equal(attempt.lease_until, null);
    assert.equal(await store.getLease(WEEK), null, 'lease released');
    assert.deepEqual(await store.getAttempt(attempt.id), attempt);
    const next = await createAttempt(baseArgs(store, { now: at(4000) }));
    assert.equal(next.status, 'running', 'the week can be attempted again after finish');
  });

  it('failure: status failed, error text, running stages closed as failed, spent_usd kept when not given', async () => {
    const store = fresh('finish-fail');
    const attempt = await createAttempt(baseArgs(store));
    await store.updateAttempt(attempt.id, { spent_usd: 0.1 });
    Object.assign(attempt, await store.getAttempt(attempt.id));
    await stageStart(store, attempt, 'collect', at(1000));
    await stageEnd(store, attempt, 'collect', {}, at(2000));
    await stageStart(store, attempt, 'generate', at(3000));
    await finishAttempt(store, attempt, { error: new Error('model down') }, at(4000));
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error, 'Error: model down');
    assert.equal(attempt.spent_usd, 0.1);
    assert.equal(attempt.stages.collect.status, 'ok');
    assert.equal(attempt.stages.generate.status, 'failed');
    assert.equal(attempt.stages.generate.finished_at, at(4000).toISOString());
    assert.match(attempt.stages.generate.error, /attempt finished \(failed\) while stage was running/);
    assert.equal(await store.getLease(WEEK), null);
    assert.ok(AttemptSchema.safeParse(await store.getAttempt(attempt.id)).success);
  });

  it('explicit degraded status with no error', async () => {
    const store = fresh('finish-degraded');
    const attempt = await createAttempt(baseArgs(store));
    await finishAttempt(store, attempt, { status: 'degraded', spentUsd: 0 }, at(1000));
    assert.equal(attempt.status, 'degraded');
    assert.equal(attempt.error, null);
  });

  it('refuses an invalid status and leaves the attempt running with its lease', async () => {
    const store = fresh('finish-invalid');
    const attempt = await createAttempt(baseArgs(store));
    await assert.rejects(finishAttempt(store, attempt, { status: 'done' }, at(1000)), /status/);
    assert.equal((await store.getAttempt(attempt.id)).status, 'running');
    assert.equal((await store.getLease(WEEK)).attempt_id, attempt.id);
  });
});

describe('works against any Store implementing the DESIGN.md interface', () => {
  function memoryStore() {
    const attempts = new Map();
    const leases = new Map();
    return {
      calls: [],
      async createAttempt(a) { this.calls.push('createAttempt'); attempts.set(a.id, structuredClone(a)); },
      async getAttempt(id) { return attempts.get(id) ?? null; },
      async updateAttempt(id, patch) {
        this.calls.push('updateAttempt');
        const merged = { ...attempts.get(id), ...patch };
        attempts.set(id, structuredClone(merged));
        return merged;
      },
      async acquireLease({ week_of, attempt_id, ttlMs, now }) {
        this.calls.push('acquireLease');
        const cur = leases.get(week_of);
        if (cur && cur.attempt_id !== attempt_id && Date.parse(cur.lease_until) >= now.getTime()) {
          return { ok: false, holder: cur.attempt_id, lease_until: cur.lease_until };
        }
        const lease_until = new Date(now.getTime() + ttlMs).toISOString();
        leases.set(week_of, { attempt_id, lease_until });
        return { ok: true };
      },
      async releaseLease({ week_of, attempt_id }) {
        this.calls.push('releaseLease');
        if (leases.get(week_of)?.attempt_id === attempt_id) leases.delete(week_of);
      },
      leases,
    };
  }

  it('full lifecycle through the interface only; a bare { ok: true } lease answer is accepted', async () => {
    const store = memoryStore();
    const attempt = await createAttempt(baseArgs(store));
    assert.equal(attempt.lease_until, null, 'store did not report lease_until, so none is recorded');
    await stageStart(store, attempt, 'collect', at(1));
    await stageEnd(store, attempt, 'collect', {}, at(2));
    await finishAttempt(store, attempt, { spentUsd: 1 }, at(3));
    assert.equal(attempt.status, 'succeeded');
    assert.equal(store.leases.size, 0);
    assert.deepEqual(store.calls, ['acquireLease', 'createAttempt', 'updateAttempt', 'updateAttempt', 'updateAttempt', 'releaseLease']);
    await assert.rejects(createAttempt(baseArgs(store, { now: at(4) })).then(() => createAttempt(baseArgs(store, { now: at(5) }))), LeaseHeld);
  });
});

describe('helpers', () => {
  it('makeAttemptId embeds week_of and a compact UTC stamp; ids are unique', () => {
    const a = makeAttemptId(WEEK, NOW);
    const b = makeAttemptId(WEEK, NOW);
    assert.match(a, /^2026-09-07-20260904T210000Z-[0-9a-f]{6}$/);
    assert.notEqual(a, b);
  });

  it('errorText normalises errors, strings, objects and empties', () => {
    assert.equal(errorText(null), null);
    assert.equal(errorText(undefined), null);
    assert.equal(errorText(''), null);
    assert.equal(errorText('plain'), 'plain');
    assert.equal(errorText(new TypeError('bad')), 'TypeError: bad');
    assert.equal(errorText({ code: 7 }), '{"code":7}');
  });

  describe('readGitSha', () => {
    const sha = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const mk = (name, layout) => {
      const dir = path.join(root, 'git', name);
      for (const [rel, content] of Object.entries(layout)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      return dir;
    };

    it('follows a symbolic HEAD to a loose ref', () => {
      const dir = mk('loose', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${sha}\n` });
      assert.equal(readGitSha(dir), sha);
    });

    it('returns a detached HEAD sha directly', () => {
      assert.equal(readGitSha(mk('detached', { '.git/HEAD': `${shaB}\n` })), shaB);
    });

    it('falls back to packed-refs', () => {
      const dir = mk('packed', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${shaB} refs/heads/other\n${sha} refs/heads/main\n`,
      });
      assert.equal(readGitSha(dir), sha);
    });

    it('follows a worktree .git file and its commondir', () => {
      const dir = mk('worktree', {
        'main/.git/HEAD': 'ref: refs/heads/main\n',
        'main/.git/refs/heads/feature': `${shaB}\n`,
        'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
        'main/.git/worktrees/wt/commondir': '../..\n',
        'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
      });
      assert.equal(readGitSha(path.join(dir, 'wt')), shaB);
    });

    it('returns unknown when there is no repository or the ref is unresolvable', () => {
      assert.equal(readGitSha(mk('empty', { 'README': '' })), 'unknown');
      assert.equal(readGitSha(mk('dangling', { '.git/HEAD': 'ref: refs/heads/gone\n' })), 'unknown');
      assert.equal(readGitSha(mk('garbage', { '.git/HEAD': 'not a sha\n' })), 'unknown');
    });

    it('resolves this repository without spawning git', () => {
      assert.match(readGitSha(PROJECT_ROOT), /^[0-9a-f]{40}$/);
    });
  });
});
