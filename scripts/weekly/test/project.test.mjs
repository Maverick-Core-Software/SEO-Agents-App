import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fbItemToPostRow, gbpItemToPostRow, planToRows, projectPlan, websiteActionToTaskRow } from '../lib/project.mjs';
import { copyPublishStatus } from '../lib/reconcile.mjs';

function fakeSupabase(responses = {}) {
  const calls = [];
  function builder(table) {
    const chain = { table, ops: [] };
    const api = {};
    for (const op of ['insert', 'upsert', 'select', 'update', 'delete', 'eq', 'in', 'not', 'order', 'limit']) {
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

const GBP = { day: 1, date: '2026-09-11', service: 'Panel Upgrade', topic: 't', trend_tie: 'x', headline: 'H', body: 'B', caption: 'c', photo_file: null, cta: 'Call', hashtags: ['#a', '#b', '#c'], status: 'Needs approval' };
const FB = { day: 1, date: '2026-09-14', type: 'slideshow', service: 'Panel Upgrade', post_goal: 'education', format: 'f', hook: 'Hook', body: 'Body', cta: 'Save this', hashtags: ['#x'], contact: 'Text us', photo_file: 'a.jpg', video_prompt: '', on_screen_text: 'beats', boost: { decision: 'YES', daily_usd: 25, days: 2 }, boost_targeting: '15mi Rowlett' };
const ACTION = { type: 'website_blog_post', title: 'Panel upgrade cost in Frisco', target: 'panel-upgrade-cost-frisco', priority: 'high', description: 'Write it', owner_gate: true, draft: null, source_ids: ['o1'] };
const PLAN = { attempt_id: 'att', week_of: '2026-09-14', topic: { service_key: 'panel_upgrade', service_label: 'Panel Upgrade', city: 'Frisco', query_family: [] }, gbp: [GBP], facebook: [FB], website_actions: [ACTION], notes: { trend_signals: [], photo_gaps: [], degraded: false, degraded_reason: null } };

describe('row mappers', () => {
  it('gbp rows mirror parseGbpSchedule', () => {
    const r = gbpItemToPostRow(GBP, 'run-1');
    assert.equal(r.platform, 'gbp');
    assert.equal(r.type, 'photo');
    assert.equal(r.hook, 'H');
    assert.equal(r.hashtags, null);
    assert.equal(r.status, 'pending_approval');
    assert.equal(r.post_date, '2026-09-11');
  });
  it('facebook rows mirror parseFacebookSchedule and join hashtags', () => {
    const r = fbItemToPostRow(FB, 'run-1');
    assert.equal(r.platform, 'facebook');
    assert.equal(r.type, 'slideshow');
    assert.equal(r.hashtags, '#x');
    assert.equal(r.photo_file, 'a.jpg');
    assert.equal(r.video_prompt, null);
  });
  it('website actions map to legacy task types and owner gate sets waiting_on_owner', () => {
    const r = websiteActionToTaskRow(ACTION, 'run-1', { revisionId: 'rev-1', taskId: 'W001' });
    assert.equal(r.type, 'blog_post');
    assert.equal(r.status, 'waiting_on_owner');
    assert.equal(r.details.website_action_type, 'website_blog_post');
    assert.equal(r.details.task_id, 'W001');
    const open = websiteActionToTaskRow({ ...ACTION, type: 'website_copy_update', owner_gate: false }, 'run-1');
    assert.equal(open.type, 'seo_fix');
    assert.equal(open.status, 'pending_approval');
  });
  it('planToRows counts', () => {
    const { posts, tasks } = planToRows(PLAN, 'run-1');
    assert.equal(posts.length, 2);
    assert.equal(tasks.length, 1);
  });
});

describe('projectPlan', () => {
  it('refuses without allowLive and touches nothing', async () => {
    const supabase = fakeSupabase();
    await assert.rejects(() => projectPlan({ supabase, plan: PLAN }), /refused/);
    assert.equal(supabase.calls.length, 0);
  });

  it('upserts the run, replaces pending rows, inserts, links items, and can auto-approve', async () => {
    const supabase = fakeSupabase({
      seo_runs: { data: { id: 'run-9' }, error: null },
      weekly_posts: (chain) => (chain.ops[0][0] === 'insert'
        ? { data: [{ id: 'wp-g', platform: 'gbp', post_date: '2026-09-11' }, { id: 'wp-f', platform: 'facebook', post_date: '2026-09-14' }], error: null }
        : { data: null, error: null }),
      website_tasks: (chain) => (chain.ops[0][0] === 'insert' ? { data: [{ id: 'wt-1', title: 'x' }], error: null } : { data: null, error: null }),
      plan_items: { data: null, error: null },
      plan_revisions: { data: null, error: null },
    });
    const items = [
      { id: 'pi-1', platform: 'gbp', slot_date: '2026-09-11' },
      { id: 'pi-2', platform: 'facebook', slot_date: '2026-09-14' },
      { id: 'pi-3', platform: 'website', slot_date: null },
    ];
    const approvals = [];
    const out = await projectPlan({
      supabase, plan: PLAN, revisionId: 'rev-1', items, allowLive: true, autoApprove: true,
      autoApproveImpl: async (runId) => { approvals.push(runId); return { ok: true, count: 2 }; },
      now: new Date('2026-09-11T14:00:00Z'),
    });
    assert.deepEqual(out, { runId: 'run-9', posts: 2, tasks: 1, linked: 3, approved: { ok: true, count: 2 } });
    assert.deepEqual(approvals, ['run-9']);
    const upsert = supabase.calls.find((c) => c.table === 'seo_runs');
    assert.deepEqual(upsert.ops[0][2], { onConflict: 'week_of' });
    assert.equal(upsert.ops[0][1].status, 'pending_approval');
    const deletes = supabase.calls.filter((c) => c.ops[0][0] === 'delete');
    assert.equal(deletes.length, 2);
    assert.ok(deletes.every((c) => c.ops.some((o) => o[0] === 'eq' && o[1] === 'status' && o[2] === 'pending_approval')));
    const links = supabase.calls.filter((c) => c.table === 'plan_items' && c.ops[0][0] === 'update');
    assert.equal(links.length, 3);
    assert.deepEqual(links[0].ops[0][1], { projected_ref: 'wp-g' });
    const rev = supabase.calls.find((c) => c.table === 'plan_revisions');
    assert.equal(rev.ops[0][1].projected_at, '2026-09-11T14:00:00.000Z');
  });

  it('surfaces insert errors with the table name', async () => {
    const supabase = fakeSupabase({
      seo_runs: { data: { id: 'run-9' }, error: null },
      weekly_posts: (chain) => (chain.ops[0][0] === 'insert' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }),
    });
    await assert.rejects(() => projectPlan({ supabase, plan: PLAN, allowLive: true }), /weekly_posts insert: boom/);
  });
});

describe('projectPlan (T19/T20: row-id links, website join, conditional metrics)', () => {
  const DRAFT_PLAN = { ...PLAN, website_actions: [{ ...ACTION, draft: { title: 'Draft', meta_description: 'm', html: '<p>x</p>' } }] };

  /** A fake that answers the inserts, records the plan_items links, and can then serve copyPublishStatus. */
  function fixtureSupabase(refs) {
    return fakeSupabase({
      seo_runs: { data: { id: 'run-9' }, error: null },
      weekly_posts: (chain) => (chain.ops[0][0] === 'insert'
        ? { data: [{ id: 'wp-g', platform: 'gbp', post_date: '2026-09-11' }, { id: 'wp-f', platform: 'facebook', post_date: '2026-09-14' }], error: null }
        // copyPublishStatus reads the inserted rows back by id and finds the platform id there.
        : { data: [{ id: 'wp-g', status: 'posted', platform_post_id: 'gbp-1' }, { id: 'wp-f', status: 'scheduled', platform_post_id: null }], error: null }),
      website_tasks: (chain) => (chain.ops[0][0] === 'insert' ? { data: [{ id: 'wt-1', title: ACTION.title }], error: null } : { data: null, error: null }),
      plan_revisions: { data: null, error: null },
      plan_items: (chain) => {
        const [op, patch] = chain.ops[0];
        if (op === 'update' && patch && 'projected_ref' in patch) refs.set(chain.ops[1][2], patch.projected_ref);
        if (op === 'update') return { data: null, error: null };
        return { data: [...refs].map(([id, projected_ref]) => ({ id, projected_ref, publish_status: null })), error: null };
      },
    });
  }

  it('links by the inserted weekly_posts row id, keeps the platform id separate, and joins website items to their task', async () => {
    const refs = new Map();
    const supabase = fixtureSupabase(refs);
    const items = [
      { id: 'pi-1', platform: 'gbp', slot_date: '2026-09-11' },
      { id: 'pi-2', platform: 'facebook', slot_date: '2026-09-14' },
      { id: 'pi-3', platform: 'website', slot_date: null },
    ];
    const out = await projectPlan({ supabase, plan: DRAFT_PLAN, revisionId: 'rev-1', items, allowLive: true });
    assert.deepEqual(out, { runId: 'run-9', posts: 2, tasks: 1, linked: 3, approved: null });
    assert.deepEqual([...refs], [['pi-1', 'wp-g'], ['pi-2', 'wp-f'], ['pi-3', 'wt-1']]);

    // The link survives reconcile: it is the weekly_posts.id that copyPublishStatus
    // joins on, and the platform id comes from weekly_posts itself, never from
    // projected_ref. The website ref is not a weekly_posts row, so it is skipped.
    const reconciled = await copyPublishStatus({ supabase });
    assert.equal(reconciled.updated, 2);
    const statusWrites = supabase.calls
      .filter((c) => c.table === 'plan_items' && c.ops[0][0] === 'update' && 'publish_status' in c.ops[0][1])
      .map((c) => [c.ops[1][2], c.ops[0][1].publish_status]);
    assert.deepEqual(statusWrites, [['pi-1', 'posted:gbp-1'], ['pi-2', 'scheduled']]);
  });

  it('projects website items as title + description only and writes no metrics', async () => {
    const refs = new Map();
    const supabase = fixtureSupabase(refs);
    await projectPlan({ supabase, plan: DRAFT_PLAN, revisionId: 'rev-1', items: [], allowLive: true });

    const taskRow = supabase.calls.find((c) => c.table === 'website_tasks' && c.ops[0][0] === 'insert').ops[0][1][0];
    assert.equal(taskRow.title, ACTION.title);
    assert.equal(taskRow.description, ACTION.description);
    assert.equal('draft' in taskRow.details, false, 'the html draft is deferred as a known gap (decision 10)');

    const postRows = supabase.calls.find((c) => c.table === 'weekly_posts' && c.ops[0][0] === 'insert').ops[0][1];
    for (const row of postRows) {
      for (const metric of ['impressions', 'reach', 'metrics']) assert.equal(metric in row, false, `${metric} must be absent, not zero-filled`);
    }
    assert.ok(!supabase.calls.some((c) => c.table === 'performance_observations'), 'GBP metrics stay absent until a real measurement exists');
  });
});
