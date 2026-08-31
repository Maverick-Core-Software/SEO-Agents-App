/**
 * Node test for supabase-sync auto-approve transition safety.
 * Covers: posts approved before the run (nothing publishes early), rollback of
 * posts when the run CAS fails (no side left approved alone), refusal + report
 * of a zero-post run (invalid execution condition), and the concurrent-approver
 * case. Uses a scripted fluent mock of the supabase-js builder.
 * Run: node --test scripts/supabase-sync.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoApproveRun } from './supabase-sync.mjs';

// Fluent supabase-js builder mock: every chain is thenable and resolves to the
// next scripted { data, error } for its table, in call order.
function makeClient(script = {}) {
  const queues = {
    weekly_posts: [...(script.weekly_posts || [])],
    seo_runs: [...(script.seo_runs || [])],
  };
  const calls = [];
  const from = (table) => {
    const rec = { table, ops: [] };
    calls.push(rec);
    const api = {
      update(payload) { rec.payload = payload; return api; },
      eq(field, value) { (rec.eqs ||= []).push([field, value]); return api; },
      select(cols) { rec.cols = cols; return api; },
      maybeSingle() { rec.maybeSingle = true; return api; },
      then(resolve) {
        const r = (queues[table] || []).shift() || {};
        return Promise.resolve(resolve({ data: r.data ?? null, error: r.error ?? null }));
      },
    };
    return api;
  };
  return { from, __calls: calls };
}

// The rollback call is the weekly_posts update that puts approved rows back to pending.
const rollbackCall = (c) => c.__calls.find((x) =>
  x.table === 'weekly_posts' && x.payload?.status === 'pending_approval');

describe('autoApproveRun', () => {
  it('approves posts first, then the run via CAS on pending_approval', async () => {
    const c = makeClient({
      weekly_posts: [{ data: [{ id: 'p1' }, { id: 'p2' }] }],
      seo_runs: [{ data: { id: 'r1', status: 'approved' } }],
    });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: true, count: 2 });

    const [postsCall, runCall] = c.__calls;
    assert.equal(postsCall.table, 'weekly_posts');
    assert.equal(postsCall.payload.status, 'approved');
    assert.ok(postsCall.payload.approved_at, 'posts carry approved_at');
    assert.deepEqual(postsCall.eqs, [['run_id', 'r1'], ['status', 'pending_approval']]);

    assert.equal(runCall.table, 'seo_runs');
    assert.ok(runCall.maybeSingle, 'run update is CAS-guarded');
    assert.deepEqual(runCall.eqs.slice(-2), [['id', 'r1'], ['status', 'pending_approval']]);
    assert.equal(rollbackCall(c), undefined, 'no rollback on success');
  });

  it('refuses with zero_posts when the run has no pending posts and never touches the run', async () => {
    const c = makeClient({ weekly_posts: [{ data: [] }] });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: false, reason: 'zero_posts' });
    assert.equal(c.__calls.length, 1, 'seo_runs must not be touched');
    assert.equal(c.__calls[0].table, 'weekly_posts');
  });

  it('returns posts_error and leaves the run pending when the posts update fails', async () => {
    const c = makeClient({ weekly_posts: [{ error: { message: 'network 5xx' } }] });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: false, reason: 'posts_error' });
    assert.equal(c.__calls.length, 1, 'run untouched on posts failure');
  });

  it('rolls posts back to pending_approval when the run CAS errors (no partial transition)', async () => {
    const c = makeClient({
      weekly_posts: [{ data: [{ id: 'p1' }] }, { data: [] }],
      seo_runs: [{ error: { message: 'boom' } }],
    });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: false, reason: 'run_update_error' });
    const rb = rollbackCall(c);
    assert.ok(rb, 'a rollback call happened');
    assert.deepEqual(rb.payload, { status: 'pending_approval', approved_at: null });
    assert.deepEqual(rb.eqs, [['run_id', 'r1'], ['status', 'approved']]);
  });

  it('keeps posts approved when a concurrent actor already approved the run', async () => {
    const c = makeClient({
      weekly_posts: [{ data: [{ id: 'p1' }] }],
      seo_runs: [{ data: null }, { data: { status: 'approved' } }],
    });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: true, count: 1, reason: 'already_approved' });
    assert.equal(rollbackCall(c), undefined, 'no rollback when the run is already approved');
  });

  it('rolls posts back when the run CAS loses to a non-approved state (run_not_pending)', async () => {
    const c = makeClient({
      weekly_posts: [{ data: [{ id: 'p1' }] }, { data: [] }],
      seo_runs: [{ data: null }, { data: { status: 'rejected' } }],
    });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: false, reason: 'run_not_pending' });
    const rb = rollbackCall(c);
    assert.ok(rb, 'a rollback call happened');
    assert.deepEqual(rb.payload, { status: 'pending_approval', approved_at: null });
  });

  it('reports rollback_failed when the rollback itself errors', async () => {
    const c = makeClient({
      weekly_posts: [{ data: [{ id: 'p1' }] }, { error: { message: 'also down' } }],
      seo_runs: [{ error: { message: 'boom' } }],
    });
    const out = await autoApproveRun('r1', c);
    assert.deepEqual(out, { ok: false, reason: 'rollback_failed' });
  });
});
