/**
 * Pure helpers for SEO run live-status and dashboard statusCounts.
 * Port of scripts/lib/seo-run-status.mjs — copy+adapt, not a cross-repo import.
 */

/** Rolling window for statusCounts so historical audit noise does not dominate. */
export const STATUS_COUNTS_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

/** Posts that finished successfully (including intentional skips / native schedule). */
export const TERMINAL_SUCCESS = new Set([
  'posted',
  'done',
  'scheduled',
  'scheduled_native',
  'skipped',
]);

/** All closed post statuses — nothing left for the bridge to do. */
export const TERMINAL_CLOSED = new Set([
  'posted',
  'done',
  'scheduled',
  'scheduled_native',
  'skipped',
  'rejected',
  'dismissed',
  'cancelled',
]);

/** Frozen run statuses that are closed (not in-flight). */
export const FROZEN_CLOSED = new Set(['rejected', 'dismissed', 'cancelled']);

/** In-flight run statuses — trust the run row until posts settle. */
export const FROZEN_IN_FLIGHT = new Set(['pending_approval', 'executing', 'awaiting_prompt', 'posting']);

/**
 * Derive live status for one seo_run from its weekly_posts rows.
 *
 * Terminal post statuses (skipped/rejected/dismissed/cancelled) count as finished.
 * Fully rejected/dismissed/cancelled runs map to those closed statuses (incomplete
 * bucket), never to executing/partial.
 */
export function liveRunStatus(run, runPosts = []) {
  const frozen = String(run?.status || '');
  if (FROZEN_CLOSED.has(frozen)) return frozen;

  // In-flight states with no posts yet: trust the run record.
  if (FROZEN_IN_FLIGHT.has(frozen) && (!runPosts || runPosts.length === 0)) {
    return frozen === 'posting' ? 'executing' : frozen;
  }

  if (!runPosts || runPosts.length === 0) return frozen || 'idle';

  const hasCurrentError = runPosts.some((p) =>
    ['error', 'needs_verification'].includes(String(p.status || '')),
  );
  if (hasCurrentError) return 'error';

  const statuses = runPosts.map((p) => String(p.status || ''));
  const allTerminal = statuses.every((s) => TERMINAL_CLOSED.has(s));
  if (!allTerminal) {
    // Still has open work — if frozen says in-flight, keep that signal.
    if (FROZEN_IN_FLIGHT.has(frozen)) {
      return frozen === 'posting' ? 'executing' : frozen;
    }
    return 'executing';
  }

  // All posts closed. Prefer success when any post actually published/scheduled/skipped.
  const anySuccess = statuses.some((s) => TERMINAL_SUCCESS.has(s));
  if (anySuccess) return 'done';

  // All closed-bad (rejected/dismissed/cancelled only).
  if (statuses.every((s) => s === 'rejected')) return 'rejected';
  if (statuses.every((s) => s === 'dismissed')) return 'dismissed';
  if (statuses.every((s) => s === 'cancelled')) return 'cancelled';
  return 'rejected';
}

/** Map live status → dashboard statusCounts bucket. */
export function bucketStatusCount(liveStatus) {
  const ls = String(liveStatus || '');
  if (ls === 'done') return 'complete';
  if (ls === 'posting' || ls === 'executing') return 'partial';
  if (ls === 'error') return 'blocked';
  return 'incomplete';
}

/**
 * Count runs into complete/partial/blocked/incomplete within a recency window.
 * Falls back to the newest two runs when the window is empty so the panel is not blank.
 */
export function countRunStatuses(runs, postsByRun, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? STATUS_COUNTS_WINDOW_MS;
  const cutoff = now - windowMs;

  let windowed = (runs || []).filter((r) => {
    const t = new Date(r.created_at || r.done_at || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  if (!windowed.length && runs?.length) {
    windowed = runs.slice(0, 2);
  }

  const statusCounts = { complete: 0, partial: 0, blocked: 0, incomplete: 0 };
  const details = [];
  for (const r of windowed) {
    const ls = liveRunStatus(r, postsByRun?.[r.id] || []);
    const bucket = bucketStatusCount(ls);
    statusCounts[bucket] += 1;
    details.push({ id: r.id, week_of: r.week_of, frozen: r.status, live: ls, bucket });
  }
  return { statusCounts, windowed, details };
}

export const POST_STATUS_COLOR = {
  posted: '#10b981',
  done: '#10b981',
  scheduled: '#06b6d4',
  scheduled_native: '#06b6d4',
  approved: '#6366f1',
  pending_approval: '#f59e0b',
  posting: '#8b5cf6',
  skipped: '#4b5563',
  needs_verification: '#ef4444',
  error: '#ef4444',
  waiting_on_owner: '#f59e0b',
  failed: '#ef4444',
  rejected: '#4b5563',
};

export const POST_STATUS_LABEL = {
  posted: 'POSTED',
  done: 'POSTED',
  scheduled: 'SCHEDULED',
  scheduled_native: 'AUTO 9AM',
  approved: 'QUEUED',
  pending_approval: 'PENDING',
  posting: 'POSTING…',
  skipped: 'SKIPPED',
  needs_verification: 'NEEDS VERIFY',
  error: 'ERROR',
};

/** True when the item still needs a human or bridge action. */
export function isRecoveryItem(item) {
  const status = String(item?.status || '');
  if (status === 'error' || status === 'needs_verification' || status === 'failed') return true;
  if (status === 'waiting_on_owner') return true;
  return status === 'posting' && !item?.posted_at;
}

export function isPendingApproval(status) {
  const s = String(status || '').toLowerCase();
  return s === 'pending_approval' || s === 'needs_approval';
}

export function isWaitingOnOwner(status) {
  return String(status || '').toLowerCase() === 'waiting_on_owner';
}

/** True when the post is live on the platform Graph (scheduled or published). */
export function isOnGraph(post) {
  const s = String(post?.status || '');
  return Boolean(post?.platform_post_id) && (s === 'scheduled' || s === 'posted' || s === 'done');
}

export const RUN_STATUS_LABEL = {
  done: 'DONE',
  error: 'ERROR',
  pending_approval: 'PENDING',
  approved: 'APPROVED',
  executing: 'EXECUTING',
  posting: 'POSTING…',
  rejected: 'REJECTED',
  dismissed: 'DISMISSED',
  cancelled: 'CANCELLED',
};

export const TASK_STATUS_LABEL = {
  done: 'DONE',
  failed: 'FAILED',
  error: 'ERROR',
  pending_approval: 'PENDING',
  waiting_on_owner: 'WAITING ON OWNER',
  skipped: 'SKIPPED',
  executing: 'EXECUTING',
};

export function statusLabelFor(status, kind = 'post') {
  const s = String(status || '');
  if (kind === 'run') return RUN_STATUS_LABEL[s] || (s ? s.replace(/_/g, ' ').toUpperCase() : '—');
  if (kind === 'task') return TASK_STATUS_LABEL[s] || (s ? s.replace(/_/g, ' ').toUpperCase() : '—');
  return POST_STATUS_LABEL[s] || (s ? s.replace(/_/g, ' ').toUpperCase() : '—');
}

export function statusColorFor(status, kind = 'post') {
  const s = String(status || '');
  if (POST_STATUS_COLOR[s]) return POST_STATUS_COLOR[s];
  if (s === 'waiting_on_owner') return '#f59e0b';
  if (s === 'failed' || s === 'rejected') return s === 'rejected' ? '#4b5563' : '#ef4444';
  if (kind === 'run' && s === 'done') return '#10b981';
  if (kind === 'task' && s === 'done') return '#10b981';
  return '#4b5563';
}
