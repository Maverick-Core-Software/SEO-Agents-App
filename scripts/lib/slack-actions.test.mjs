// scripts/lib/slack-actions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeAlertStore } from './alert-store.mjs';
import { approveAction, dismissAction, retryAction, RETRIABLE_POST, RETRIABLE_TASK, RETRIABLE_RUN } from './slack-actions.mjs';

// Minimal in-memory stand-in for the supabase-js query builder used by the
// action ops: from().update().eq().in().select().maybeSingle() + thenable
// fire-and-forget updates. Mutates rows in place so chained queries see them.
function makeSupabase(seed) {
  const tables = new Map(Object.entries(seed).map(([t, rows]) => [t, rows.map(r => ({ ...r }))]));
  const matches = (row, filters) => filters.every(([op, k, v]) =>
    op === 'eq' ? row[k] === v
      : op === 'in' ? (Array.isArray(v) && v.includes(row[k]))
        : true);

  function makeChain(table) {
    const filters = [];
    let patch = null;
    let isUpdate = false;
    const exec = (single) => {
      const rows = tables.get(table) || [];
      const matched = rows.filter(r => matches(r, filters));
      if (isUpdate) for (const r of matched) Object.assign(r, patch);
      return Promise.resolve(single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null });
    };
    const chain = {
      update(p) { isUpdate = true; patch = p; return chain; },
      select() { return chain; },
      eq(k, v) { filters.push(['eq', k, v]); return chain; },
      in(k, v) { filters.push(['in', k, v]); return chain; },
      maybeSingle() { return exec(true); },
      then(res, rej) { return exec(false).then(res, rej); },
    };
    return chain;
  }
  return {
    from(t) { return makeChain(t); },
    tables,
  };
}

const RUN = '11111111-1111-1111-1111-111111111111';
const RUN2 = '22222222-2222-2222-2222-222222222222';
const TASK = '33333333-3333-3333-3333-333333333333';
const FB = '44444444-4444-4444-4444-444444444444';
const GBP = '55555555-5555-5555-5555-555555555555';

const tmpStore = path.join(os.tmpdir(), `alerted-actions-${Date.now()}.json`);
try { fs.rmSync(tmpStore, { force: true }); } catch {}
const alertStore = makeAlertStore(tmpStore);

// ── approveAction ──
{
  const sb = makeSupabase({
    seo_runs: [{ id: RUN, status: 'pending_approval', week_of: '2026-09-07' }],
    weekly_posts: [
      { id: FB, run_id: RUN, platform: 'facebook', status: 'pending_approval' },
      { id: GBP, run_id: RUN, platform: 'gbp', status: 'pending_approval' },
    ],
  });
  assert.equal(alertStore.shouldFire(RUN, RUN, 'pending'), true); // a pending card fired
  const out = await approveAction({ supabase: sb, alertStore, actionId: RUN });
  assert.deepEqual(out, { ok: true, type: 'seo_run', id: RUN });
  assert.equal(sb.tables.get('seo_runs')[0].status, 'approved');
  assert.equal(sb.tables.get('seo_runs')[0].approved_at !== undefined, true);
  // cascade: both posts approved
  assert.deepEqual(sb.tables.get('weekly_posts').map(p => p.status), ['approved', 'approved']);
  // pending dedup key cleared so a re-pending run re-cards
  assert.equal(alertStore.shouldFire(RUN, RUN, 'pending'), true);
}

// approve on a non-pending run falls through to website_task
{
  const sb = makeSupabase({
    seo_runs: [{ id: RUN, status: 'done' }],
    website_tasks: [{ id: TASK, run_id: RUN, status: 'pending_approval', title: 'Fix meta' }],
  });
  const out = await approveAction({ supabase: sb, alertStore, actionId: TASK });
  assert.deepEqual(out, { ok: true, type: 'website_task', id: TASK });
  assert.equal(sb.tables.get('website_tasks')[0].status, 'approved');
  // already-approved run is not found (eq status pending_approval)
  const out2 = await approveAction({ supabase: sb, alertStore, actionId: RUN });
  assert.equal(out2.notFound, true);
}

// A stale Slack card must never override an owner gate or retry state.
{
  const sb = makeSupabase({
    website_tasks: [{ id: TASK, run_id: RUN, status: 'waiting_on_owner', title: 'Needs owner input' }],
  });
  const out = await approveAction({ supabase: sb, alertStore, actionId: TASK });
  assert.equal(out.notFound, true);
  assert.equal(sb.tables.get('website_tasks')[0].status, 'waiting_on_owner');
}

// ── dismissAction ──
{
  const sb = makeSupabase({
    website_tasks: [{ id: TASK, run_id: RUN, status: 'error', title: 'Fix meta' }],
    weekly_posts: [{ id: FB, run_id: RUN, platform: 'facebook', status: 'pending_approval' }],
    seo_runs: [{ id: RUN2, status: 'error' }],
  });
  assert.equal(alertStore.shouldFire(RUN, TASK, 'failed'), true);
  const out = await dismissAction({ supabase: sb, alertStore, actionId: TASK });
  assert.deepEqual(out, { ok: true, type: 'website_task', id: TASK, message: 'Task skipped.' });
  assert.equal(sb.tables.get('website_tasks')[0].status, 'skipped');
  assert.equal(sb.tables.get('website_tasks')[0].error, null);
  // dismiss cleared the fault keys
  assert.equal(alertStore.shouldFire(RUN, TASK, 'failed'), true);

  const out2 = await dismissAction({ supabase: sb, alertStore, actionId: FB });
  assert.deepEqual(out2, { ok: true, type: 'weekly_post', id: FB, message: 'Post skipped.' });
  assert.equal(sb.tables.get('weekly_posts')[0].status, 'skipped');

  // runs are not dismissible
  const out3 = await dismissAction({ supabase: sb, alertStore, actionId: RUN2 });
  assert.equal(out3.notFound, true);
  assert.equal(sb.tables.get('seo_runs')[0].status, 'error');
}

// ── retryAction: website_task ──
{
  const sb = makeSupabase({ website_tasks: [{ id: TASK, run_id: RUN, status: 'error', title: 'Fix meta' }] });
  const out = await retryAction({ supabase: sb, alertStore, actionId: TASK });
  assert.equal(out.ok, true);
  assert.equal(out.type, 'website_task');
  assert.equal(out.new_status, 'approved');
  assert.equal(sb.tables.get('website_tasks')[0].status, 'approved');
  assert.equal(sb.tables.get('website_tasks')[0].error, null);
}

// ── retryAction: weekly_post FB → approved, parent run nudged ──
{
  const sb = makeSupabase({
    weekly_posts: [{ id: FB, run_id: RUN, platform: 'facebook', status: 'error' }],
    seo_runs: [{ id: RUN, status: 'error' }],
  });
  const out = await retryAction({ supabase: sb, alertStore, actionId: FB });
  assert.equal(out.type, 'weekly_post');
  assert.equal(out.new_status, 'approved');
  assert.equal(sb.tables.get('weekly_posts')[0].status, 'approved');
  assert.equal(sb.tables.get('seo_runs')[0].status, 'approved'); // nudge out of error
}

// ── retryAction: weekly_post GBP → scheduled (not approved) ──
{
  const sb = makeSupabase({
    weekly_posts: [{ id: GBP, run_id: RUN, platform: 'gbp', status: 'error' }],
    seo_runs: [{ id: RUN, status: 'error' }],
  });
  const out = await retryAction({ supabase: sb, alertStore, actionId: GBP });
  assert.equal(out.new_status, 'scheduled');
  assert.equal(sb.tables.get('weekly_posts')[0].status, 'scheduled');
}

// ── retryAction: seo_run cascade, FB approved / GBP scheduled, posted untouched ──
{
  const sb = makeSupabase({
    seo_runs: [{ id: RUN, status: 'error' }],
    weekly_posts: [
      { id: FB, run_id: RUN, platform: 'facebook', status: 'error' },
      { id: GBP, run_id: RUN, platform: 'gbp', status: 'needs_verification' },
      { id: '66666666-6666-6666-6666-666666666666', run_id: RUN, platform: 'facebook', status: 'posted' },
    ],
  });
  const out = await retryAction({ supabase: sb, alertStore, actionId: RUN });
  assert.equal(out.type, 'seo_run');
  assert.equal(out.new_status, 'approved');
  assert.equal(out.cascaded.length, 2);
  assert.ok(out.message.includes('2'));
  assert.equal(sb.tables.get('seo_runs')[0].status, 'approved');
  const posts = sb.tables.get('weekly_posts');
  assert.equal(posts.find(p => p.id === FB).status, 'approved');
  assert.equal(posts.find(p => p.id === GBP).status, 'scheduled'); // gbp correction
  assert.equal(posts.find(p => p.status === 'posted').status, 'posted'); // untouched
}

// ── retryAction: run_fb_only scope leaves gbp posts alone ──
{
  const sb = makeSupabase({
    seo_runs: [{ id: RUN, status: 'error' }],
    weekly_posts: [
      { id: FB, run_id: RUN, platform: 'facebook', status: 'error' },
      { id: GBP, run_id: RUN, platform: 'gbp', status: 'error' },
    ],
  });
  const out = await retryAction({ supabase: sb, alertStore, actionId: RUN, scope: 'run_fb_only' });
  assert.deepEqual(out.cascaded, [FB]);
  const posts = sb.tables.get('weekly_posts');
  assert.equal(posts.find(p => p.id === FB).status, 'approved');
  assert.equal(posts.find(p => p.id === GBP).status, 'error'); // untouched
}

// ── retryAction: not found / not retriable ──
{
  const sb = makeSupabase({
    seo_runs: [{ id: RUN, status: 'done' }],
    weekly_posts: [{ id: FB, run_id: RUN, platform: 'facebook', status: 'posted' }],
  });
  // posted post not retriable; run 'done' IS retriable via RETRIABLE_RUN
  const out1 = await retryAction({ supabase: sb, alertStore, actionId: FB });
  assert.equal(out1.notFound, true);
  const sb2 = makeSupabase({ seo_runs: [{ id: RUN, status: 'pending_approval' }] });
  const out2 = await retryAction({ supabase: sb2, alertStore, actionId: RUN });
  assert.equal(out2.ok, true); // pending_approval runs are retriable
}

// guard rails: exported status arrays are the real ones used by the ops
assert.deepEqual(RETRIABLE_POST, ['error', 'needs_verification', 'skipped', 'posting']);
assert.deepEqual(RETRIABLE_TASK, ['error', 'needs_verification', 'skipped', 'executing']);
assert.deepEqual(RETRIABLE_RUN, ['error', 'executing', 'done']);

fs.rmSync(tmpStore, { force: true });
console.log('ok slack-actions');
