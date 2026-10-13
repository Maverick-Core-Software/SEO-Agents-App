// scripts/weekly/test/reconcile-health.test.mjs
// V3: scripts/weekly/reconcile.mjs writes outputs/reconcile-health.json on
// BOTH the success and the failure path (and on a missing configuration),
// advancing last_success_at only on a clean pass and carrying it forward with
// last_error otherwise. The watchdog's RECONCILE STALE rule reads nothing else.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEALTH_FILE, parseArgs, runReconcile, writeHealth } from '../reconcile.mjs';

const tmpDirs = [];
function tmp(label = 'reconcile') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weekly-${label}-`));
  tmpDirs.push(dir);
  return dir;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network reachable from the reconcile health test'); };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A thenable query fake: every table answers `responses[table]` (a value or a function of the op chain). */
function fakeSupabase(responses = {}) {
  const calls = [];
  function builder(table) {
    const chain = { table, ops: [] };
    const api = {};
    for (const op of ['insert', 'upsert', 'select', 'update', 'delete', 'eq', 'in', 'not', 'order', 'limit', 'gte', 'lte']) {
      api[op] = (...args) => { chain.ops.push([op, ...args]); return api; };
    }
    const finish = () => {
      calls.push(chain);
      const r = responses[table];
      return Promise.resolve(typeof r === 'function' ? r(chain) : (r || { data: [], error: null }));
    };
    api.single = finish;
    api.maybeSingle = finish;
    api.then = (resolve, reject) => finish().then(resolve, reject);
    return api;
  }
  return { calls, from: (t) => builder(t) };
}

const NOW = new Date('2026-10-13T12:00:00.000Z');
const quiet = { log: () => {}, warn: () => {} };

describe('reconcile health file', () => {
  it('a clean pass writes status ok and advances last_success_at (no Facebook client, empty Search Console)', async () => {
    const healthFile = path.join(tmp(), 'reconcile-health.json');
    const supabase = fakeSupabase();
    const out = await runReconcile({
      supabase, env: {}, now: NOW, healthFile, facebookClient: null, searchConsolePages: async () => ({ rows: [], note: 'test' }), ...quiet,
    });
    assert.equal(out.status, 'ok');
    const health = readJson(healthFile);
    assert.equal(health.status, 'ok');
    assert.equal(health.last_success_at, health.last_attempt_at);
    assert.equal(health.last_error, null);
    assert.equal(health.error, null);
    assert.equal(health.counts.plan_items_updated, 0);
    assert.equal(health.counts.facebook, null);
    assert.deepEqual(health.counts.search_console.map((w) => w.window_days), [7, 28]);
    assert.ok(Number.isInteger(health.duration_ms) && health.duration_ms >= 0);
    assert.deepEqual(out.health, health);
  });

  it('a failing pass writes status failed with last_error, carries the previous last_success_at forward, and rethrows', async () => {
    const healthFile = path.join(tmp(), 'reconcile-health.json');
    fs.writeFileSync(healthFile, JSON.stringify({ status: 'ok', last_success_at: '2026-10-12T12:00:00.000Z', last_attempt_at: '2026-10-12T12:00:00.000Z' }));
    const supabase = fakeSupabase({ plan_items: { data: null, error: { message: 'relation plan_items is unreachable' } } });
    const err = await runReconcile({
      supabase, env: {}, now: NOW, healthFile, facebookClient: null, searchConsolePages: async () => ({ rows: [], note: 'test' }), ...quiet,
    }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /plan_items select: relation plan_items is unreachable/);
    const health = readJson(healthFile);
    assert.equal(health.status, 'failed');
    assert.equal(health.last_success_at, '2026-10-12T12:00:00.000Z', 'only a clean pass advances the freshness the watchdog reads');
    assert.match(health.last_error, /plan_items is unreachable/);
    assert.equal(health.error, health.last_error);
    assert.ok(Date.parse(health.last_attempt_at) > Date.parse('2026-10-12T12:00:00.000Z'));
    assert.deepEqual(err.health, health);
  });

  it('a missing Supabase configuration is a failed pass, written before the throw', async () => {
    const healthFile = path.join(tmp(), 'reconcile-health.json');
    const err = await runReconcile({ supabase: null, env: {}, now: NOW, healthFile, ...quiet }).catch((e) => e);
    assert.match(err.message, /SUPABASE_URL \/ SUPABASE_SERVICE_KEY missing/);
    const health = readJson(healthFile);
    assert.equal(health.status, 'failed');
    assert.equal(health.last_success_at, null);
    assert.match(health.last_error, /SUPABASE_URL/);
  });

  it('a dry run reads only and writes no health', async () => {
    const healthFile = path.join(tmp(), 'reconcile-health.json');
    const supabase = fakeSupabase({ weekly_posts: { data: [{ id: 'a' }], error: null } });
    const out = await runReconcile({ supabase, env: {}, now: NOW, healthFile, dryRun: true, ...quiet });
    assert.equal(out.status, 'dry-run');
    assert.equal(fs.existsSync(healthFile), false);
    assert.equal(supabase.calls.length, 1);
  });

  it('writeHealth survives an unreadable previous file and an unwritable target; parseArgs reads the flags', () => {
    const dir = tmp();
    const healthFile = path.join(dir, 'reconcile-health.json');
    fs.writeFileSync(healthFile, 'not json');
    const ok = writeHealth({ status: 'ok', healthFile, startedAt: NOW, now: new Date(NOW.getTime() + 1500) });
    assert.equal(ok.last_success_at, '2026-10-13T12:00:01.500Z');
    assert.equal(ok.duration_ms, 1500);
    assert.equal(readJson(healthFile).status, 'ok');
    const warnings = [];
    const unwritable = writeHealth({ status: 'failed', error: 'x', healthFile: path.join(healthFile, 'nested', 'h.json'), now: NOW, warn: (m) => warnings.push(m) });
    assert.equal(unwritable.status, 'failed');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not write health/);
    assert.ok(HEALTH_FILE.endsWith(path.join('outputs', 'reconcile-health.json')));
    assert.deepEqual(parseArgs(['--dry-run', '--lookback-days', '14', '--retry-unavailable']), { dryRun: true, retryAfterDays: 0, lookbackDays: 14 });
    assert.deepEqual(parseArgs([]), { dryRun: false, retryAfterDays: undefined, lookbackDays: 42 });
  });
});
