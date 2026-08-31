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

  // Active execution failure outranks verify-needed: error/failed means the bridge
  // must act, needs_verification means only a listing check (do not re-post).
  const hasHardError = runPosts.some((p) =>
    ['error', 'failed'].includes(String(p.status || '')),
  );
  if (hasHardError) return 'error';
  if (runPosts.some((p) => String(p.status || '') === 'needs_verification')) {
    return 'needs_verification';
  }

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
  if (ls === 'needs_verification') return 'verify';
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

  const statusCounts = { complete: 0, partial: 0, blocked: 0, incomplete: 0, verify: 0 };
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
  needs_verification: '#f59e0b',
  error: '#ef4444',
  waiting_on_owner: '#f59e0b',
  failed: '#ef4444',
  rejected: '#4b5563',
};

export const POST_STATUS_LABEL = {
  posted: 'POSTED',
  done: 'POSTED',
  scheduled: 'SCHEDULED',
  scheduled_native: '9AM TICK',
  approved: 'QUEUED',
  pending_approval: 'PENDING',
  posting: 'POSTING…',
  skipped: 'SKIPPED',
  needs_verification: 'NEEDS VERIFY',
  error: 'ERROR',
};

// scheduled_native is "queued for the 9am Playwright tick", not a Google-side
// queue — the tick publishes, so the chip says 9AM TICK, not "AUTO 9AM".

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

/**
 * True when the post is live on the platform Graph (scheduled or published).
 * Corrected GBP semantics: GBP scheduled/scheduled_native is queued for the 9am
 * Playwright tick — not on the listing yet. Live GBP = posted + platform_post_id.
 * Facebook Graph API scheduling is genuinely on the graph; unknown platforms keep
 * the old behavior as fallback.
 */
export function isOnGraph(post) {
  const s = String(post?.status || '');
  if (!post?.platform_post_id || !['scheduled', 'posted', 'done'].includes(s)) return false;
  if (String(post?.platform || '').toLowerCase() === 'gbp') {
    return s === 'posted' || s === 'done';
  }
  return true;
}

/** Attention classes for the dashboard recovery zone. */
export const RECOVERY_CLASS = {
  execution: 'execution',
  verification: 'verification',
  owner: 'owner',
  historical: 'historical',
};

/**
 * Classify one item for the dashboard attention view.
 * - execution: active execution failure (error/failed/stuck posting, or a past
 *   fallback `scheduled` day the 9am live-post path never published)
 * - verification: needs_verification, or a past `scheduled_native` day queued for
 *   the 9am Playwright tick that never went live (check listing, do not re-post)
 * - owner: waiting_on_owner — a human must act
 * - historical: prior-run backlog or skipped items — never primary attention
 * - null: nothing to do
 */
export function recoveryClass(item, { today, currentRunId } = {}) {
  if (!item) return null;
  const status = String(item.status || '');
  if (status === 'skipped') return RECOVERY_CLASS.historical;
  if (currentRunId && item.run_id && item.run_id !== currentRunId) {
    return RECOVERY_CLASS.historical;
  }
  if (status === 'waiting_on_owner') return RECOVERY_CLASS.owner;
  if (status === 'error' || status === 'failed') return RECOVERY_CLASS.execution;
  if (status === 'needs_verification') return RECOVERY_CLASS.verification;
  if (status === 'posting' && !item.posted_at) return RECOVERY_CLASS.execution;
  if (status === 'scheduled' || status === 'scheduled_native') {
    const date = String(item.post_date || '');
    const isPast = today && date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < String(today);
    if (isPast && !item.posted_at && !item.platform_post_id) {
      return status === 'scheduled_native' ? RECOVERY_CLASS.verification : RECOVERY_CLASS.execution;
    }
  }
  return null;
}

/** True when the item belongs in the primary attention view (not historical/skipped). */
export function isAttentionItem(item, options = {}) {
  const cls = recoveryClass(item, options);
  return Boolean(cls) && cls !== RECOVERY_CLASS.historical;
}

/** Compact age for a recovery item: today, 1d, 3d, 2w, 5w+. Falls back to the caller's today. */
export function ageLabel(item, today = new Date().toISOString().slice(0, 10)) {
  const raw = item?.post_date || item?.due_date || item?.week_of || item?.created_at || item?.updated_at;
  if (!raw || !today) return null;
  const date = String(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const days = Math.round((Date.parse(String(today)) - Date.parse(date)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d';
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** Who must act to resolve the item. */
export function ownerFor(item) {
  const status = String(item?.status || '');
  if (status === 'waiting_on_owner') return 'Owner';
  if (status === 'needs_verification') return 'Verification';
  if (status === 'scheduled_native' || status === 'scheduled') return '9am tick';
  if (status === 'posting' || status === 'error' || status === 'failed') return 'Bridge worker';
  return '—';
}

/** Expected healer / next action copy for the item. */
export function nextActionFor(item) {
  const status = String(item?.status || '');
  if (status === 'waiting_on_owner') return 'Owner approves or provides input';
  if (status === 'needs_verification') return 'Verify listing — do not re-post';
  if (status === 'scheduled_native') return '9am Playwright tick publishes; verify if still queued';
  if (status === 'scheduled') return '9am live-post path publishes (fallback)';
  if (status === 'posting') return 'Stuck-post reset after TTL; retry via bridge';
  if (status === 'error' || status === 'failed') return 'Retry via bridge or dismiss';
  if (status === 'skipped') return 'Skipped — backlog, no action';
  return '—';
}

export const RUN_STATUS_LABEL = {
  done: 'DONE',
  error: 'ERROR',
  pending_approval: 'PENDING',
  approved: 'APPROVED',
  executing: 'EXECUTING',
  posting: 'POSTING…',
  needs_verification: 'NEEDS VERIFY',
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
  needs_verification: 'NEEDS VERIFY',
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
