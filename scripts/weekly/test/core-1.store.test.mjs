// scripts/weekly/test/core-1.store.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStore, DEFAULT_LEASE_TTL_MS } from '../lib/store.mjs';
import { AttemptSchema, RevisionSchema, PlanItemSchema } from '../lib/schemas.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-09-04T21:00:00.000Z');
const ISO = NOW.toISOString();

function sampleAttempt(overrides = {}) {
  return {
    id: 'att-1', week_of: '2026-09-07', mode: 'shadow', git_sha: 'abc123',
    versions: { schema: '2026-09-06.1', prompt: 'p1', policy: '2026-09-06.1' },
    models: { generate: 'deepseek-chat', fallback: null },
    started_at: ISO, finished_at: null, stages: {}, lease_until: null,
    budget_usd: 20, spent_usd: 0, status: 'running', error: null,
    ...overrides,
  };
}

function sampleObservation(overrides = {}) {
  return {
    id: 'obs-1', attempt_id: 'att-1', source: 'serpapi', scope: 'electrician rowlett tx', geography: 'Rowlett',
    period: null, status: 'ok', metric: 'serp', value: { organic: [] }, raw_ref: null, retrieved_at: ISO, note: null,
    ...overrides,
  };
}

const candidate = {
  service_key: 'panel_upgrade', service_label: 'Electrical Panel Upgrade / Replacement', city: 'Rowlett',
  query_family: ['electrical panel upgrade rowlett'],
  scores: { priority: 1, demand: 0.5, opportunity: 0.6, recency: 1, season: 0.5, performance: 0.5 },
  total: 0.7, reasons: ['priority 5'],
};

function sampleRevision(overrides = {}) {
  return {
    id: 'rev-1', attempt_id: 'att-1', week_of: '2026-09-07', revision: 1,
    topic: { service_key: 'panel_upgrade', service_label: 'Electrical Panel Upgrade / Replacement', city: 'Rowlett', query_family: [] },
    selection: { winner: candidate, ranked: [candidate], excluded: [], rationale: 'top score', degraded: false },
    validation: { ok: true, errors: [], warnings: [] },
    exported_at: null, projected_at: null,
    ...overrides,
  };
}

function sampleItem(overrides = {}) {
  return {
    id: 'item-1', revision_id: 'rev-1', platform: 'gbp', slot_date: '2026-09-04', item_type: 'gbp_post',
    content: { service: 'Panel upgrade', headline: 'h' }, media_ref: null, idempotency_key: 'k1', projected_ref: null, publish_status: null,
    ...overrides,
  };
}

const tmpFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.tmp')) : [];

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-core1-store-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });
const fresh = (name) => createFileStore(path.join(root, name));

describe('createFileStore basics', () => {
  it('requires a dir', () => {
    assert.throws(() => createFileStore(''), TypeError);
    assert.throws(() => createFileStore(), TypeError);
  });

  it('creates subdirectories lazily on first write', async () => {
    const store = fresh('lazy');
    assert.equal(fs.existsSync(path.join(store.dir, 'attempts')), false);
    assert.equal(await store.getAttempt('nope'), null);
    await store.createAttempt(sampleAttempt());
    assert.equal(fs.existsSync(path.join(store.dir, 'attempts', 'att-1.json')), true);
  });
});

describe('attempts', () => {
  it('createAttempt writes pretty JSON at attempts/<id>.json and round-trips through getAttempt', async () => {
    const store = fresh('attempts');
    const attempt = sampleAttempt();
    const created = await store.createAttempt(attempt);
    assert.deepEqual(created, attempt);
    const text = fs.readFileSync(path.join(store.dir, 'attempts', 'att-1.json'), 'utf8');
    assert.ok(text.startsWith('{\n  "id": "att-1"'), 'pretty-printed');
    assert.deepEqual(await store.getAttempt('att-1'), attempt);
    assert.deepEqual(tmpFiles(store.dir), [], 'no leftover tmp files');
  });

  it('getAttempt returns null for an unknown id', async () => {
    assert.equal(await fresh('attempts-missing').getAttempt('ghost'), null);
  });

  it('createAttempt refuses a duplicate id', async () => {
    const store = fresh('attempts-dup');
    await store.createAttempt(sampleAttempt());
    await assert.rejects(store.createAttempt(sampleAttempt({ mode: 'new' })), /already exists/);
    assert.equal((await store.getAttempt('att-1')).mode, 'shadow', 'original untouched');
  });

  it('createAttempt refuses a schema-invalid record and writes nothing', async () => {
    const store = fresh('attempts-invalid');
    await assert.rejects(store.createAttempt(sampleAttempt({ status: 'bogus' })), (e) => e instanceof TypeError && /status/.test(e.message));
    await assert.rejects(store.createAttempt(sampleAttempt({ week_of: '9/7/2026' })), /week_of/);
    assert.equal(fs.existsSync(path.join(store.dir, 'attempts')), false);
  });

  it('refuses ids that are not safe file names', async () => {
    const store = fresh('attempts-unsafe');
    for (const id of ['../escape', 'a/b', '.hidden', '', 'sp ace']) {
      await assert.rejects(store.createAttempt(sampleAttempt({ id })), TypeError, id);
      await assert.rejects(store.getAttempt(id), TypeError, id);
    }
  });

  it('updateAttempt merges a patch, validates, persists and returns the merged record', async () => {
    const store = fresh('attempts-update');
    await store.createAttempt(sampleAttempt());
    const stages = { collect: { started_at: ISO, finished_at: null, status: 'running', error: null } };
    const updated = await store.updateAttempt('att-1', { stages, spent_usd: 0.25, id: 'cannot-change' });
    assert.equal(updated.id, 'att-1', 'id is immutable');
    assert.equal(updated.spent_usd, 0.25);
    assert.deepEqual(updated.stages, stages);
    assert.equal(updated.mode, 'shadow', 'untouched fields survive');
    assert.deepEqual(await store.getAttempt('att-1'), updated);
    assert.ok(AttemptSchema.safeParse(updated).success);
  });

  it('updateAttempt rejects unknown ids and invalid patches without touching the file', async () => {
    const store = fresh('attempts-update-bad');
    await assert.rejects(store.updateAttempt('ghost', { status: 'failed' }), /not found/);
    await store.createAttempt(sampleAttempt());
    await assert.rejects(store.updateAttempt('att-1', { status: 'done' }), /status/);
    await assert.rejects(store.updateAttempt('att-1', { stages: { x: { status: 'ok' } } }), /stages/);
    assert.equal((await store.getAttempt('att-1')).status, 'running');
  });
});

describe('leases', () => {
  const week = '2026-09-07';
  const ttl = 10 * 60 * 1000;

  it('acquire succeeds when no lease exists and writes leases/<week_of>.json', async () => {
    const store = fresh('lease-absent');
    const res = await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW });
    assert.deepEqual(res, { ok: true, lease_until: new Date(NOW.getTime() + ttl).toISOString() });
    const file = JSON.parse(fs.readFileSync(path.join(store.dir, 'leases', `${week}.json`), 'utf8'));
    assert.equal(file.attempt_id, 'att-1');
    assert.equal(file.lease_until, res.lease_until);
    assert.deepEqual(await store.getLease(week), file);
  });

  it('acquire fails while another attempt holds a live lease (and leaves it untouched)', async () => {
    const store = fresh('lease-held');
    const first = await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW });
    const later = new Date(NOW.getTime() + ttl - 1);
    const res = await store.acquireLease({ week_of: week, attempt_id: 'att-2', ttlMs: ttl, now: later });
    assert.deepEqual(res, { ok: false, holder: 'att-1', lease_until: first.lease_until });
    assert.equal((await store.getLease(week)).attempt_id, 'att-1');
  });

  it('a lease whose lease_until equals now is still held (expiry is strictly lease_until < now)', async () => {
    const store = fresh('lease-boundary');
    const first = await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW });
    const atExpiry = new Date(first.lease_until);
    const res = await store.acquireLease({ week_of: week, attempt_id: 'att-2', ttlMs: ttl, now: atExpiry });
    assert.equal(res.ok, false);
    const justAfter = new Date(atExpiry.getTime() + 1);
    assert.equal((await store.acquireLease({ week_of: week, attempt_id: 'att-2', ttlMs: ttl, now: justAfter })).ok, true);
  });

  it('the same attempt can re-acquire (renew) and the expiry moves forward', async () => {
    const store = fresh('lease-renew');
    await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW });
    const later = new Date(NOW.getTime() + 5 * 60 * 1000);
    const res = await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: later });
    assert.equal(res.ok, true);
    assert.equal(res.lease_until, new Date(later.getTime() + ttl).toISOString());
    assert.equal((await store.getLease(week)).lease_until, res.lease_until);
  });

  it('an expired lease is taken over by a new attempt', async () => {
    const store = fresh('lease-expired');
    await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW });
    const later = new Date(NOW.getTime() + ttl + 1);
    const res = await store.acquireLease({ week_of: week, attempt_id: 'att-2', ttlMs: ttl, now: later });
    assert.equal(res.ok, true);
    assert.equal((await store.getLease(week)).attempt_id, 'att-2');
  });

  it('a corrupt lease file or an invalid lease_until never blocks forever', async () => {
    const store = fresh('lease-corrupt');
    fs.mkdirSync(path.join(store.dir, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'leases', `${week}.json`), '{not json');
    assert.equal((await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW })).ok, true);
    fs.writeFileSync(path.join(store.dir, 'leases', `${week}.json`), JSON.stringify({ attempt_id: 'att-9', lease_until: 'whenever' }));
    assert.equal((await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW })).ok, true);
    fs.writeFileSync(path.join(store.dir, 'leases', `${week}.json`), JSON.stringify({ attempt_id: 'att-9' }));
    assert.equal((await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW })).ok, true);
    assert.equal((await store.getLease(week)).attempt_id, 'att-1');
  });

  it('defaults: ttlMs falls back to DEFAULT_LEASE_TTL_MS', async () => {
    const store = fresh('lease-defaults');
    const res = await store.acquireLease({ week_of: week, attempt_id: 'att-1', now: NOW });
    assert.equal(res.lease_until, new Date(NOW.getTime() + DEFAULT_LEASE_TTL_MS).toISOString());
  });

  it('release removes the file only for the holder; releasing a missing lease is ok', async () => {
    const store = fresh('lease-release');
    const file = path.join(store.dir, 'leases', `${week}.json`);
    assert.deepEqual(await store.releaseLease({ week_of: week, attempt_id: 'att-1' }), { ok: true });
    const first = await store.acquireLease({ week_of: week, attempt_id: 'att-1', ttlMs: ttl, now: NOW });
    const other = await store.releaseLease({ week_of: week, attempt_id: 'att-2' });
    assert.deepEqual(other, { ok: false, holder: 'att-1', lease_until: first.lease_until });
    assert.equal(fs.existsSync(file), true, 'non-holder cannot release');
    assert.deepEqual(await store.releaseLease({ week_of: week, attempt_id: 'att-1' }), { ok: true });
    assert.equal(fs.existsSync(file), false);
    assert.equal((await store.acquireLease({ week_of: week, attempt_id: 'att-2', ttlMs: ttl, now: NOW })).ok, true);
  });

  it('rejects unsafe week_of / attempt_id values', async () => {
    const store = fresh('lease-unsafe');
    await assert.rejects(store.acquireLease({ week_of: '../x', attempt_id: 'att-1', now: NOW }), TypeError);
    await assert.rejects(store.acquireLease({ week_of: week, attempt_id: 'a/b', now: NOW }), TypeError);
  });

  it('concurrent acquires for one week admit exactly one attempt', async () => {
    const store = fresh('lease-race');
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => store.acquireLease({ week_of: week, attempt_id: id, ttlMs: ttl, now: NOW })),
    );
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results[0].ok, true, 'first in wins');
  });
});

describe('observations', () => {
  it('validates every row, groups by attempt_id, appends across calls, reads back in order', async () => {
    const store = fresh('obs');
    await assert.rejects(store.putObservations([sampleObservation({ source: 'tarot' })]), /observation\[0\].*source/);
    await assert.rejects(store.putObservations([sampleObservation(), sampleObservation({ id: '' })]), /observation\[1\]/);
    assert.equal(fs.existsSync(path.join(store.dir, 'observations')), false, 'nothing written when any row is invalid');

    assert.deepEqual(await store.putObservations([sampleObservation({ id: 'o1' }), sampleObservation({ id: 'o2', attempt_id: 'att-2' })]), { count: 2 });
    await store.putObservations([sampleObservation({ id: 'o3', status: 'unavailable', note: 'cap reached', value: null })]);
    const rows = await store.listObservations('att-1');
    assert.deepEqual(rows.map((r) => r.id), ['o1', 'o3']);
    assert.deepEqual((await store.listObservations('att-2')).map((r) => r.id), ['o2']);
    assert.deepEqual(await store.listObservations('att-none'), []);
    const text = fs.readFileSync(path.join(store.dir, 'observations', 'att-1.jsonl'), 'utf8');
    assert.equal(text.split('\n').filter(Boolean).length, 2, 'one JSON object per line');
    assert.ok(text.endsWith('\n'));
  });

  it('parallel puts for the same attempt lose nothing (collectors run with Promise.allSettled)', async () => {
    const store = fresh('obs-parallel');
    const batches = Array.from({ length: 8 }, (_, b) =>
      Array.from({ length: 5 }, (_, i) => sampleObservation({ id: `b${b}-${i}` })));
    await Promise.all(batches.map((batch) => store.putObservations(batch)));
    const rows = await store.listObservations('att-1');
    assert.equal(rows.length, 40);
    assert.equal(new Set(rows.map((r) => r.id)).size, 40);
    assert.deepEqual(tmpFiles(store.dir), []);
  });
});

describe('revisions and items', () => {
  it('putRevision validates, overwrites by id, and listRevisions filters by week and sorts by revision', async () => {
    const store = fresh('rev');
    assert.deepEqual(await store.listRevisions('2026-09-07'), []);
    await assert.rejects(store.putRevision(sampleRevision({ revision: 0 })), /revision/);
    await store.putRevision(sampleRevision({ id: 'rev-2', revision: 2 }));
    await store.putRevision(sampleRevision({ id: 'rev-1', revision: 1 }));
    await store.putRevision(sampleRevision({ id: 'rev-other', revision: 1, week_of: '2026-09-14' }));
    await store.putRevision(sampleRevision({ id: 'rev-1', revision: 1, exported_at: ISO }));
    const list = await store.listRevisions('2026-09-07');
    assert.deepEqual(list.map((r) => r.id), ['rev-1', 'rev-2']);
    assert.equal(list[0].exported_at, ISO, 'same id overwrites');
    assert.ok(list.every((r) => RevisionSchema.safeParse(r).success));
    assert.equal((await store.getRevision('rev-other')).week_of, '2026-09-14');
    assert.equal(await store.getRevision('nope'), null);
  });

  it('putItems validates, groups by revision and upserts by id', async () => {
    const store = fresh('items');
    await assert.rejects(store.putItems([sampleItem({ platform: 'tiktok' })]), /item\[0\].*platform/);
    await store.putItems([
      sampleItem({ id: 'i1' }),
      sampleItem({ id: 'i2', platform: 'facebook', item_type: 'fb_post' }),
      sampleItem({ id: 'i3', revision_id: 'rev-2', platform: 'website', slot_date: null, item_type: 'website_blog_post' }),
    ]);
    await store.putItems([sampleItem({ id: 'i1', publish_status: 'projected', projected_ref: 'wp-9' })]);
    const items = await store.listItems('rev-1');
    assert.deepEqual(items.map((i) => i.id), ['i1', 'i2']);
    assert.equal(items[0].publish_status, 'projected', 'upsert replaced i1 in place');
    assert.deepEqual((await store.listItems('rev-2')).map((i) => i.id), ['i3']);
    assert.deepEqual(await store.listItems('rev-none'), []);
    assert.ok(items.every((i) => PlanItemSchema.safeParse(i).success));
  });
});

describe('listPublishedHistory', () => {
  const fixture = path.join(here, 'fixtures', 'core-1.history.json');

  it('returns [] when history.json is absent', async () => {
    assert.deepEqual(await fresh('hist-none').listPublishedHistory({ weeks: 8 }), []);
  });

  it('returns the array in history.json; filters by weeks when now is given; keeps undated rows', async () => {
    const store = fresh('hist');
    fs.mkdirSync(store.dir, { recursive: true });
    fs.copyFileSync(fixture, path.join(store.dir, 'history.json'));
    const all = await store.listPublishedHistory({ weeks: 8 });
    assert.equal(all.length, 4);
    const recent = await store.listPublishedHistory({ weeks: 8, now: NOW });
    assert.deepEqual(recent.map((p) => p.platform_post_id), ['gbp-1', 'fb-1', null]);
  });

  it('accepts an object with a posts array', async () => {
    const store = fresh('hist-obj');
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'history.json'), JSON.stringify({ posts: [{ platform: 'gbp', post_date: '2026-08-01' }] }));
    assert.equal((await store.listPublishedHistory({})).length, 1);
    assert.equal((await store.listPublishedHistory()).length, 1);
  });
});
