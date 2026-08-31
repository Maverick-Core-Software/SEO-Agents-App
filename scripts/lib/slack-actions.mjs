// scripts/lib/slack-actions.mjs
// The SINGLE implementation of SEO action mutations (approve/dismiss/retry).
// Both the MCC HTTP routes in mav-bridge.mjs and the signed Slack interaction
// endpoint dispatch here, so the two paths can never diverge into duplicate
// mutations. Response shapes mirror the historical MCC API exactly.
// Each fn returns { ok, type, id, ... } or { notFound: true }; DB failures throw
// (callers map them to a 500).

export const RETRIABLE_POST = ['error', 'needs_verification', 'skipped', 'posting'];
export const RETRIABLE_TASK = ['error', 'needs_verification', 'skipped', 'executing'];
export const RETRIABLE_RUN = ['error', 'executing', 'done'];
export const DISMISSIBLE = ['pending_approval', 'error', 'needs_verification'];

// Approve a pending_approval seo_run (cascades its weekly_posts), else a
// website_task. Matches the historical /seo/actions/approve semantics.
export async function approveAction({ supabase, alertStore, actionId }) {
  const { data: run, error: runErr } = await supabase.from('seo_runs')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', actionId).eq('status', 'pending_approval')
    .select().maybeSingle();
  if (runErr) throw runErr;
  if (run) {
    await supabase.from('weekly_posts')
      .update({ status: 'approved' })
      .eq('run_id', run.id)
      .eq('status', 'pending_approval');
    // So a re-pending run (after retry) raises a fresh Slack card again.
    alertStore.clearFault(run.id, run.id, 'pending');
    return { ok: true, type: 'seo_run', id: run.id };
  }

  const { data: task, error: taskErr } = await supabase.from('website_tasks')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('status', 'pending_approval')
    .select().maybeSingle();
  if (taskErr) throw taskErr;
  if (task) return { ok: true, type: 'website_task', id: task.id };

  return { notFound: true };
}

// Skip a website_task or weekly_post that is pending/failed/needs_verification.
export async function dismissAction({ supabase, alertStore, actionId }) {
  const { data: task, error: taskErr } = await supabase.from('website_tasks')
    .update({ status: 'skipped', error: null })
    .eq('id', actionId).in('status', DISMISSIBLE)
    .select().maybeSingle();
  if (taskErr) throw taskErr;
  if (task) {
    alertStore.clearFault(task.run_id || task.id, task.id, 'failed');
    alertStore.clearFault(task.run_id || task.id, task.id, 'stuck');
    return { ok: true, type: 'website_task', id: task.id, message: 'Task skipped.' };
  }

  const { data: post, error: postErr } = await supabase.from('weekly_posts')
    .update({ status: 'skipped', error: null })
    .eq('id', actionId).in('status', DISMISSIBLE)
    .select().maybeSingle();
  if (postErr) throw postErr;
  if (post) {
    alertStore.clearFault(post.run_id || post.id, post.id, 'failed');
    alertStore.clearFault(post.run_id || post.id, post.id, 'stuck');
    return { ok: true, type: 'weekly_post', id: post.id, message: 'Post skipped.' };
  }

  return { notFound: true };
}

// Re-queue a failed/stuck action so the bridge poll picks it up again.
// scope: 'action' (default) | 'run_fb_only' | 'run_all' (run-level only).
export async function retryAction({ supabase, alertStore, actionId, scope = 'action' }) {
  // website_task — no run nudge needed (the poll-loop orphan sweep executes
  // approved website tasks even when the parent run is 'done'/'error').
  {
    const { data: task, error: taskErr } = await supabase.from('website_tasks')
      .update({ status: 'approved', error: null, updated_at: new Date().toISOString() })
      .eq('id', actionId).in('status', RETRIABLE_TASK)
      .select().maybeSingle();
    if (taskErr) throw taskErr;
    if (task) {
      alertStore.clearFault(task.run_id || task.id, task.id, 'failed');
      alertStore.clearFault(task.run_id || task.id, task.id, 'stuck');
      return { ok: true, type: 'website_task', id: task.id, new_status: 'approved', message: 'Task re-queued for execution.' };
    }
  }

  // weekly_post — FB → approved (poster re-runs); GBP → scheduled (daily cron).
  {
    const { data: existing, error: existingErr } = await supabase.from('weekly_posts')
      .select('id,run_id,platform,status')
      .eq('id', actionId)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing && RETRIABLE_POST.includes(existing.status)) {
      const nextStatus = existing.platform === 'gbp' ? 'scheduled' : 'approved';
      const { data: post, error: postErr } = await supabase.from('weekly_posts')
        .update({ status: nextStatus, error: null, updated_at: new Date().toISOString() })
        .eq('id', actionId)
        .select().maybeSingle();
      if (postErr) throw postErr;
      if (post) {
        alertStore.clearFault(post.run_id || post.id, post.id, 'failed');
        alertStore.clearFault(post.run_id || post.id, post.id, 'stuck');
        // Nudge parent run out of error so liveRunStatus can recover.
        if (post.run_id) {
          await supabase.from('seo_runs')
            .update({ status: 'approved', error: null, updated_at: new Date().toISOString() })
            .eq('id', post.run_id)
            .in('status', ['error', 'done']);
        }
        return { ok: true, type: 'weekly_post', id: post.id, new_status: nextStatus, message: `Post re-queued as ${nextStatus}.` };
      }
    }
  }

  // seo_run — re-approve run + cascade errored posts.
  {
    const { data: run, error: runErr } = await supabase.from('seo_runs')
      .select('id,status')
      .eq('id', actionId)
      .maybeSingle();
    if (runErr) throw runErr;
    if (run && (RETRIABLE_RUN.includes(run.status) || run.status === 'pending_approval' || run.status === 'approved')) {
      await supabase.from('seo_runs')
        .update({ status: 'approved', error: null, updated_at: new Date().toISOString() })
        .eq('id', run.id);

      let postFilter = supabase.from('weekly_posts')
        .update({ status: 'approved', error: null, updated_at: new Date().toISOString() })
        .eq('run_id', run.id)
        .in('status', RETRIABLE_POST);
      if (scope === 'run_fb_only') {
        postFilter = postFilter.eq('platform', 'facebook');
      }
      const { data: cascaded, error: casErr } = await postFilter.select('id,platform,status');
      if (casErr) throw casErr;

      alertStore.clearFault(run.id, run.id, 'failed');
      alertStore.clearFault(run.id, run.id, 'stuck');
      for (const p of (cascaded || [])) {
        alertStore.clearFault(run.id, p.id, 'failed');
        alertStore.clearFault(run.id, p.id, 'stuck');
      }

      // GBP posts that were errored should go to scheduled, not approved.
      if (scope !== 'run_fb_only') {
        await supabase.from('weekly_posts')
          .update({ status: 'scheduled', error: null, updated_at: new Date().toISOString() })
          .eq('run_id', run.id)
          .eq('platform', 'gbp')
          .eq('status', 'approved')
          .in('id', (cascaded || []).filter(p => p.platform === 'gbp').map(p => p.id));
      }

      return {
        ok: true, type: 'seo_run', id: run.id, new_status: 'approved',
        cascaded: (cascaded || []).map(p => p.id),
        message: `Run re-queued; ${(cascaded || []).length} post(s) reset.`,
      };
    }
  }

  return { notFound: true };
}
