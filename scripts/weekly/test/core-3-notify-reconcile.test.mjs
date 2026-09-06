import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAttemptMessage, notifyAttempt } from '../lib/notify.mjs';
import { copyPublishStatus, metricRowsForPost, reconcilePerformance, recordPageMetrics, windowMatured } from '../lib/reconcile.mjs';

const NOW = new Date('2026-09-20T14:00:00Z');

function fakeSupabase(responses = {}) {
  const calls = [];
  function builder(table) {
    const chain = { table, ops: [] };
    const api = {};
    for (const op of ['insert', 'select', 'update', 'eq', 'gte', 'in', 'not', 'order', 'limit']) {
      api[op] = (...args) => { chain.ops.push([op, ...args]); return api; };
    }
    const finish = () => {
      calls.push(chain);
      const r = responses[table];
      return Promise.resolve(typeof r === 'function' ? r(chain) : (r || { data: [], error: null }));
    };
    api.then = (resolve, reject) => finish().then(resolve, reject);
    return api;
  }
  return { calls, from: (t) => builder(t) };
}

describe('notify', () => {
  const attempt = { id: 'att-12345678-x', week_of: '2026-09-14', mode: 'shadow', stages: {}, spent_usd: 0.1234 };

  it('formats a compact message with topic, counts, and the shadow notice', () => {
    const msg = formatAttemptMessage({ attempt, event: 'succeeded', plan: { topic: { service_label: 'Panel', city: 'Frisco' }, gbp: new Array(7), facebook: new Array(4), website_actions: [], notes: {} } });
    assert.match(msg, /SEO weekly plan ready \[shadow\]/);
    assert.match(msg, /Week of 2026-09-14/);
    assert.match(msg, /Topic: Panel — Frisco/);
    assert.match(msg, /GBP posts: 7 \| Facebook posts: 4/);
    assert.match(msg, /nothing was published/);
  });

  it('sends via hermes then smtp and records a receipt on the attempt', async () => {
    const updates = [];
    const store = { updateAttempt: async (id, patch) => { updates.push({ id, patch }); } };
    const a = { ...attempt, stages: {} };
    const r = await notifyAttempt({ store, attempt: a, event: 'succeeded', hermes: async () => ({ ok: true }), smtp: async () => ({ ok: true }), now: NOW });
    assert.deepEqual(r, { sent: true, channel: 'hermes+smtp', reason: '' });
    assert.equal(updates[0].id, 'att-12345678-x');
    assert.equal(updates[0].patch.stages['notify:succeeded'].status, 'ok');
    assert.equal(updates[0].patch.stages['notify:succeeded'].error, 'via hermes+smtp');
  });

  it('falls back to smtp when hermes throws and reports failure when both fail', async () => {
    const store = { updateAttempt: async () => {} };
    const r1 = await notifyAttempt({ store, attempt: { ...attempt, stages: {} }, event: 'failed', hermes: async () => { throw new Error('cli missing'); }, smtp: async () => ({ ok: true }), now: NOW });
    assert.equal(r1.channel, 'smtp');
    const r2 = await notifyAttempt({ store, attempt: { ...attempt, stages: {} }, event: 'failed', hermes: async () => { throw new Error('cli missing'); }, smtp: async () => ({ ok: false, reason: 'smtp not configured' }), now: NOW });
    assert.equal(r2.sent, false);
    assert.match(r2.reason, /hermes: cli missing/);
  });

  it('does not re-send when a receipt already says ok', async () => {
    let sends = 0;
    const a = { ...attempt, stages: { 'notify:succeeded': { started_at: 'x', finished_at: 'y', status: 'ok', error: 'via hermes' } } };
    const r = await notifyAttempt({ store: null, attempt: a, event: 'succeeded', hermes: async () => { sends += 1; return { ok: true }; }, smtp: async () => ({ ok: false }), now: NOW });
    assert.equal(sends, 0);
    assert.equal(r.skipped, true);
  });
});

describe('reconcile', () => {
  it('windowMatured gates on post_date + window', () => {
    assert.equal(windowMatured('2026-09-13', 7, NOW), true);
    assert.equal(windowMatured('2026-09-14', 7, NOW), false);
    assert.equal(windowMatured('2026-08-23', 28, NOW), true);
  });

  it('metricRowsForPost marks missing metrics unavailable', () => {
    const rows = metricRowsForPost({ post: { platform_post_id: '108_1' }, perf: { reactions: 3, comments: 1 }, windowDays: 7, now: NOW });
    assert.equal(rows.length, 6);
    const reactions = rows.find((r) => r.metric === 'fb_reactions');
    assert.equal(reactions.value, 3);
    assert.equal(reactions.availability, 'ok');
    const shares = rows.find((r) => r.metric === 'fb_shares');
    assert.equal(shares.value, null);
    assert.equal(shares.availability, 'unavailable');
  });

  it('reconcilePerformance records only matured, unseen windows and never writes weekly_posts', async () => {
    const supabase = fakeSupabase({
      weekly_posts: { data: [
        { id: 'wp1', platform: 'facebook', post_date: '2026-09-07', status: 'scheduled', platform_post_id: '108_a' }, // 7d matured, 28d not
        { id: 'wp2', platform: 'facebook', post_date: '2026-08-10', status: 'posted', platform_post_id: '108_b' },    // both matured
        { id: 'wp3', platform: 'facebook', post_date: '2026-09-18', status: 'scheduled', platform_post_id: null },    // unpublished
      ], error: null },
      plan_items: { data: [{ id: 'item-9', projected_ref: 'wp2' }], error: null },
      performance_observations: (chain) => (chain.ops[0][0] === 'select'
        ? { data: [
          { platform_post_id: '108_b', page_url: null, metric: 'fb_interactions', window_days: 7, availability: 'ok' },          // 108_b@7d already recorded
          { platform_post_id: '108_a', page_url: null, metric: 'fb_interactions', window_days: 7, availability: 'unavailable' }, // must NOT block a retry
        ], error: null }
        : { data: null, error: null }),
    });
    const perfCalls = [];
    const fbClient = { postPerformance: async ({ postId }) => { perfCalls.push(postId); return { reactions: 2, comments: 0, shares: 1, clicks: 4, media_views: 10, interactions: 7 }; } };
    const r = await reconcilePerformance({ supabase, fbClient, now: NOW, windows: [7, 28], lookbackDays: 42 });
    // 108_a@7d (new) + 108_b@28d (new); 108_a@28d immature, 108_b@7d seen
    assert.deepEqual(perfCalls, ['108_a', '108_b']);
    assert.equal(r.inserted, 12);
    assert.equal(r.skipped, 2);
    const inserts = supabase.calls.filter((c) => c.table === 'performance_observations' && c.ops[0][0] === 'insert');
    assert.equal(inserts.length, 1);
    const rows = inserts[0].ops[0][1];
    const linked = rows.find((x) => x.platform_post_id === '108_b');
    assert.equal(linked.plan_item_id, 'item-9');
    assert.ok(!supabase.calls.some((c) => c.table === 'weekly_posts' && c.ops.some((o) => o[0] === 'insert' || o[0] === 'update')));
  });

  it('reconcilePerformance keeps going when insights are unavailable', async () => {
    const supabase = fakeSupabase({
      weekly_posts: { data: [{ id: 'wp1', platform: 'facebook', post_date: '2026-08-01', status: 'posted', platform_post_id: '108_z' }], error: null },
    });
    const fbClient = { postPerformance: async () => { throw new Error('(#100) insights denied'); } };
    const r = await reconcilePerformance({ supabase, fbClient, now: NOW, windows: [7], log: () => {} });
    assert.equal(r.unavailable, 1);
    assert.equal(r.inserted, 6);
  });

  it('recordPageMetrics writes four metrics per page and skips seen ones', async () => {
    const supabase = fakeSupabase({
      performance_observations: (chain) => (chain.ops[0][0] === 'select'
        ? { data: [{ platform_post_id: null, page_url: 'https://x/a', metric: 'sc_clicks', window_days: 7 }], error: null }
        : { data: null, error: null }),
    });
    const r = await recordPageMetrics({ supabase, rows: [{ page: 'https://x/a', clicks: 1, impressions: 20, ctr: 0.05, position: 7.1 }], windowDays: 7, now: NOW });
    assert.equal(r.inserted, 3);
    assert.equal(r.skipped, 1);
  });

  it('copyPublishStatus updates only changed items', async () => {
    const supabase = fakeSupabase({
      plan_items: (chain) => (chain.ops[0][0] === 'select'
        ? { data: [{ id: 'i1', projected_ref: 'wp1', publish_status: 'scheduled' }, { id: 'i2', projected_ref: 'wp2', publish_status: 'posted:108_b' }], error: null }
        : { data: null, error: null }),
      weekly_posts: { data: [{ id: 'wp1', status: 'posted', platform_post_id: '108_a' }, { id: 'wp2', status: 'posted', platform_post_id: '108_b' }], error: null },
    });
    const r = await copyPublishStatus({ supabase });
    assert.equal(r.updated, 1);
    const upd = supabase.calls.find((c) => c.table === 'plan_items' && c.ops[0][0] === 'update');
    assert.deepEqual(upd.ops[0][1], { publish_status: 'posted:108_a' });
  });
});
