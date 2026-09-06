import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore, attemptToRow, rowToAttempt, observationToRow } from '../lib/store-supabase.mjs';

// A minimal fake of the supabase-js query builder: records every call and
// resolves canned responses keyed by table or rpc name.
function fakeClient(responses = {}) {
  const calls = [];
  function builder(table) {
    const chain = { table, ops: [] };
    const api = {};
    for (const op of ['insert', 'select', 'update', 'eq', 'gte', 'order', 'limit']) {
      api[op] = (...args) => { chain.ops.push([op, ...args]); return api; };
    }
    const finish = (kind) => () => {
      chain.ops.push([kind]);
      calls.push(chain);
      const r = responses[table];
      return Promise.resolve(typeof r === 'function' ? r(chain) : (r || { data: null, error: null }));
    };
    api.single = finish('single');
    api.maybeSingle = finish('maybeSingle');
    // awaiting the builder itself (no single/maybeSingle) resolves the same way
    api.then = (resolve, reject) => finish('await')().then(resolve, reject);
    return api;
  }
  return {
    calls,
    from: (table) => builder(table),
    rpc: (name, params) => {
      calls.push({ rpc: name, params });
      const r = responses[`rpc:${name}`];
      return Promise.resolve(typeof r === 'function' ? r(params) : (r || { data: null, error: null }));
    },
  };
}

const ATTEMPT = {
  id: 'att-1', week_of: '2026-09-14', mode: 'shadow', git_sha: 'abc',
  versions: { schema: '1', prompt: '1', policy: '1' }, models: { generate: 'deepseek-chat', fallback: null },
  started_at: '2026-09-06T06:00:00.000Z', finished_at: null, stages: {}, lease_until: null,
  budget_usd: 20, spent_usd: 0, status: 'running', error: null,
};

describe('mappers', () => {
  it('attempt round-trips through row mapping', () => {
    const row = attemptToRow(ATTEMPT);
    assert.equal(row.week_of, '2026-09-14');
    const back = rowToAttempt({ ...row, budget_usd: '20.0000', spent_usd: '0.0000' });
    assert.equal(back.budget_usd, 20);
    assert.equal(back.status, 'running');
  });
  it('observation period splits into start/end columns', () => {
    const row = observationToRow({ id: 'o', attempt_id: 'a', source: 'serpapi', scope: 'q', geography: null,
      period: { start: '2026-08-01', end: '2026-08-28' }, status: 'ok', metric: 'serp', value: { x: 1 },
      raw_ref: null, retrieved_at: '2026-09-06T06:00:00.000Z', note: null });
    assert.equal(row.period_start, '2026-08-01');
    assert.equal(row.period_end, '2026-08-28');
    assert.deepEqual(row.value, { x: 1 });
  });
});

describe('createSupabaseStore', () => {
  it('createAttempt validates and inserts into seo_attempts', async () => {
    const client = fakeClient({ seo_attempts: { data: attemptToRow(ATTEMPT), error: null } });
    const store = createSupabaseStore(client);
    const a = await store.createAttempt(ATTEMPT);
    assert.equal(a.id, 'att-1');
    assert.equal(client.calls[0].table, 'seo_attempts');
    assert.equal(client.calls[0].ops[0][0], 'insert');
  });

  it('createAttempt rejects an invalid attempt before touching the client', async () => {
    const client = fakeClient();
    const store = createSupabaseStore(client);
    await assert.rejects(() => store.createAttempt({ ...ATTEMPT, mode: 'bogus' }), /createAttempt: invalid/);
    assert.equal(client.calls.length, 0);
  });

  it('acquireLease maps the RPC row to ok / holder', async () => {
    const client = fakeClient({
      'rpc:acquire_week_lease': (p) => ({ data: [{ ok: p.p_attempt_id === 'att-1', holder: 'att-1', lease_until: '2026-09-06T07:00:00Z' }], error: null }),
    });
    const store = createSupabaseStore(client);
    assert.deepEqual(await store.acquireLease({ week_of: '2026-09-14', attempt_id: 'att-1', ttlMs: 90 * 60000 }), { ok: true });
    const refused = await store.acquireLease({ week_of: '2026-09-14', attempt_id: 'att-2', ttlMs: 90 * 60000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.holder, 'att-1');
    assert.equal(client.calls[0].params.p_ttl_seconds, 5400);
  });

  it('surfaces database errors with the operation name', async () => {
    const client = fakeClient({ 'rpc:release_week_lease': { data: null, error: { message: 'boom' } } });
    const store = createSupabaseStore(client);
    await assert.rejects(() => store.releaseLease({ week_of: '2026-09-14', attempt_id: 'att-1' }), /release_week_lease: boom/);
  });

  it('putObservations chunks inserts by 500', async () => {
    const client = fakeClient({ research_observations: { data: null, error: null } });
    const store = createSupabaseStore(client);
    const obs = Array.from({ length: 1201 }, (_, i) => ({
      id: `o${i}`, attempt_id: 'att-1', source: 'history', scope: `s${i}`, geography: null, period: null,
      status: 'ok', metric: null, value: null, raw_ref: null, retrieved_at: '2026-09-06T06:00:00.000Z', note: null,
    }));
    assert.equal(await store.putObservations(obs), 1201);
    assert.equal(client.calls.filter((c) => c.table === 'research_observations').length, 3);
  });

  it('stageRevision sends revision and items to one RPC and stamps revision_id', async () => {
    const client = fakeClient({ 'rpc:stage_plan_revision': { data: 'rev-1', error: null } });
    const store = createSupabaseStore(client);
    const revision = {
      id: 'rev-1', attempt_id: 'att-1', week_of: '2026-09-14', revision: 1,
      topic: { service_key: 'panel_upgrade', service_label: 'Panel', city: 'Frisco', query_family: [] },
      selection: { winner: null, ranked: [], excluded: [], rationale: '', degraded: false },
      validation: { ok: true, errors: [], warnings: [] }, exported_at: null, projected_at: null,
    };
    // selection.winner must be a Candidate; use a minimal valid one
    revision.selection.winner = { service_key: 'panel_upgrade', service_label: 'Panel', city: 'Frisco', query_family: [],
      scores: { priority: 1, demand: 0.5, opportunity: 1, recency: 1, season: 0.5, performance: 0.5 }, total: 0.8, reasons: [] };
    const items = [{ id: 'i1', revision_id: 'x', platform: 'gbp', slot_date: '2026-09-11', item_type: 'post', content: { a: 1 },
      media_ref: null, idempotency_key: 'k1', projected_ref: null, publish_status: null }];
    const out = await store.stageRevision({ revision, items });
    assert.deepEqual(out, { revision_id: 'rev-1', items: 1 });
    const call = client.calls.find((c) => c.rpc === 'stage_plan_revision');
    assert.equal(call.params.p_items[0].revision_id, 'rev-1');
    assert.equal(call.params.p_revision.week_of, '2026-09-14');
  });

  it('listPublishedHistory reads weekly_posts read-only with a since filter', async () => {
    const client = fakeClient({ weekly_posts: { data: [{ platform: 'gbp', post_date: '2026-09-04', service: 'EV', hook: null, status: 'error', platform_post_id: null, photo_file: null }], error: null } });
    const store = createSupabaseStore(client, { now: () => new Date('2026-09-06T06:00:00Z') });
    const rows = await store.listPublishedHistory({ weeks: 8 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hook, '');
    const c = client.calls.find((x) => x.table === 'weekly_posts');
    const gte = c.ops.find((o) => o[0] === 'gte');
    assert.deepEqual(gte, ['gte', 'post_date', '2026-07-12']);
    assert.ok(!c.ops.some((o) => o[0] === 'insert' || o[0] === 'update'));
  });
});
