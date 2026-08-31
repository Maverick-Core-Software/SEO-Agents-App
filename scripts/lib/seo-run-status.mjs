/**
 * Pure helpers for SEO run live-status and dashboard statusCounts.
 * Used by mav-bridge /seo/status so terminal post outcomes (skipped/rejected/…)
 * are not mislabeled as still-executing "partial" runs.
 *
 * Reliability rules (see artifacts/diag-status-autoapprove.md):
 *  - A finished run (seo_runs.status='done') is finished even when a post is
 *    faulted or still open — GBP posts finish asynchronously AFTER the run row
 *    is marked done, so one needs_verification/error post must not paint the
 *    whole closed week as error/executing forever. Post faults stay visible at
 *    the post level (mav-bridge /seo/status `faults` array).
 *  - Run-level 'error' is reserved for runs actually still in flight: a post
 *    fault during execution is a run fault; a post fault under a settled run is
 *    not.
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

  const statuses = runPosts.map((p) => String(p.status || ''));
  const allTerminal = statuses.every((s) => TERMINAL_CLOSED.has(s));

  // A finished run is finished. GBP posts finish asynchronously after the run is
  // marked done (worker-owned), so an open or faulted post must not flip the
  // closed week to error/executing forever — the fault stays visible at the post
  // level. This also covers partial-transition residue (e.g. an old auto-approve
  // failure leaving posts pending under a done run). All-terminal posts still
  // fall through to the shared mapping (all-dismissed → dismissed, not done).
  if (frozen === 'done' && !allTerminal) return 'done';

  const hasCurrentError = runPosts.some((p) =>
    ['error', 'needs_verification'].includes(String(p.status || '')),
  );
  // Run-level error is reserved for runs actually in flight: a post fault during
  // execution is a run fault; a post fault under a settled run is not.
  if (hasCurrentError && FROZEN_IN_FLIGHT.has(frozen)) return 'error';

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
