/**
 * project.mjs — cutover projection (session 7). Maps a staged plan into the
 * exact weekly_posts / website_tasks / seo_runs rows that mav-bridge, gbp-worker,
 * and the dashboards already consume, so the publishers need no changes.
 *
 * SAFETY: projectPlan() refuses to run unless { allowLive: true } is passed.
 * run.mjs passes it only in --mode new. Shadow and offline modes never call
 * this. Row shapes mirror parseGbpSchedule / parseFacebookSchedule and
 * parseWebsiteTasks in scripts/supabase-sync.mjs and scripts/lib/parse-website-tasks.mjs.
 */

const WEBSITE_TYPE_MAP = {
  website_blog_post: 'blog_post',
  website_service_page_update: 'service_update',
  website_faq_update: 'seo_fix',
  website_hours_update: 'alert',
  website_contact_form_update: 'alert',
  website_gallery_update: 'service_update',
  website_layout_update: 'seo_fix',
  website_copy_update: 'seo_fix',
};

function must(result, what) {
  if (result && result.error) throw new Error(`${what}: ${result.error.message || String(result.error)}`);
  return result ? result.data : null;
}

export function gbpItemToPostRow(item, runId) {
  return {
    run_id: runId,
    platform: 'gbp',
    day: item.day,
    post_date: item.date,
    type: 'photo',
    service: item.service,
    hook: item.headline,
    body: item.body,
    cta: item.cta,
    hashtags: null,
    photo_file: item.photo_file || null,
    video_prompt: null,
    status: 'pending_approval',
  };
}

export function fbItemToPostRow(item, runId) {
  return {
    run_id: runId,
    platform: 'facebook',
    day: item.day,
    post_date: item.date,
    type: item.type,
    service: item.service,
    hook: item.hook,
    body: item.body,
    cta: item.cta,
    hashtags: item.hashtags && item.hashtags.length ? item.hashtags.join(' ') : null,
    photo_file: item.photo_file || null,
    video_prompt: null,
    status: 'pending_approval',
  };
}

export function websiteActionToTaskRow(action, runId, { revisionId = null, taskId = null } = {}) {
  return {
    run_id: runId,
    type: WEBSITE_TYPE_MAP[action.type] || 'seo_fix',
    priority: action.priority,
    title: action.title,
    description: action.description,
    details: {
      platform: 'website',
      website_action_type: action.type,
      target: action.target,
      source: 'weekly',
      revision_id: revisionId,
      task_id: taskId,
      draft: action.draft || null,
      source_ids: action.source_ids || [],
    },
    status: action.owner_gate ? 'waiting_on_owner' : 'pending_approval',
  };
}

export function planToRows(plan, runId, { revisionId = null } = {}) {
  const posts = [
    ...plan.gbp.map((i) => gbpItemToPostRow(i, runId)),
    ...plan.facebook.map((i) => fbItemToPostRow(i, runId)),
  ];
  const tasks = plan.website_actions.map((a, idx) => websiteActionToTaskRow(a, runId, { revisionId, taskId: `W${String(idx + 1).padStart(3, '0')}` }));
  return { posts, tasks };
}

/**
 * Project a validated plan into the legacy tables. Same transition as
 * supabase-sync.mjs: upsert seo_runs(week_of) to pending_approval, replace this
 * run's pending rows, insert the new ones, then optionally auto-approve through
 * the existing autoApproveRun (compare-and-set with rollback).
 *
 * @returns {Promise<{ runId, posts, tasks, approved }>}
 */
export async function projectPlan({ supabase, plan, revisionId = null, items = [], now = new Date(), allowLive = false, autoApprove = false, autoApproveImpl = null, log = () => {} }) {
  if (!allowLive) throw new Error('projectPlan: refused (allowLive is false); only --mode new may project into weekly_posts / website_tasks');
  if (!supabase || !plan) throw new Error('projectPlan: supabase client and plan are required');

  const run = must(await supabase.from('seo_runs')
    .upsert({ week_of: plan.week_of, status: 'pending_approval', execute_completed_at: now.toISOString() }, { onConflict: 'week_of' })
    .select().single(), 'seo_runs upsert');
  const runId = run.id;
  log(`seo_runs ${runId} week_of ${plan.week_of}`);

  must(await supabase.from('weekly_posts').delete().eq('run_id', runId).eq('status', 'pending_approval'), 'weekly_posts delete pending');
  must(await supabase.from('website_tasks').delete().eq('run_id', runId).eq('status', 'pending_approval'), 'website_tasks delete pending');

  const { posts, tasks } = planToRows(plan, runId, { revisionId });
  const insertedPosts = must(await supabase.from('weekly_posts').insert(posts).select('id, platform, post_date'), 'weekly_posts insert') || [];
  const insertedTasks = tasks.length
    ? (must(await supabase.from('website_tasks').insert(tasks).select('id, title'), 'website_tasks insert') || [])
    : [];

  // Link plan items to the projected rows so reconcile can copy status back.
  const byKey = new Map(insertedPosts.map((r) => [`${r.platform}|${String(r.post_date).slice(0, 10)}`, r.id]));
  let linked = 0;
  for (const item of items) {
    if (item.platform === 'website' || !item.slot_date) continue;
    const ref = byKey.get(`${item.platform}|${item.slot_date}`);
    if (!ref) continue;
    must(await supabase.from('plan_items').update({ projected_ref: ref }).eq('id', item.id), 'plan_items link');
    linked += 1;
  }
  if (revisionId) {
    must(await supabase.from('plan_revisions').update({ projected_at: now.toISOString() }).eq('id', revisionId), 'plan_revisions projected_at');
  }

  let approved = null;
  if (autoApprove) {
    const impl = autoApproveImpl || (await import('../../supabase-sync.mjs')).autoApproveRun;
    approved = await impl(runId, supabase);
    log(`auto-approve: ${JSON.stringify(approved)}`);
  }

  return { runId, posts: insertedPosts.length, tasks: insertedTasks.length, linked, approved };
}
