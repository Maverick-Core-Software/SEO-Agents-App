/**
 * notify.mjs — attempt-bound alerts with delivery receipts.
 *
 * Transports: the primary hop (Hermes CLI, then Slack direct) and Gmail SMTP as a
 * second best-effort hop; both are attempted, and the receipt names what delivered.
 * Every send is keyed by attempt and event and
 * the receipt is written to the attempt's stages as `notify:<event>` so a
 * re-run never re-sends and the watchdog can see what was delivered. The
 * message carries the topic, the item counts, the validation result, the
 * runtime, the spend and the summary path (T1).
 */
import { deliverPrimary, sendSmtpAlert } from '../../lib/hermes-alert.mjs';

function short(id) {
  return String(id || '').slice(0, 8);
}

/** Wall-clock runtime of a finished attempt as "42s" / "3m 4s"; null when it did not finish. */
export function attemptRuntime(attempt) {
  const start = Date.parse(attempt && attempt.started_at);
  const end = Date.parse(attempt && attempt.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatAttemptMessage({ attempt, event, plan = null, validation = null, summary = {}, projection = null } = {}) {
  const lines = [];
  const mode = attempt?.mode ? `[${attempt.mode}]` : '';
  const head = {
    succeeded: 'SEO weekly plan ready',
    degraded: 'SEO weekly plan ready (degraded inputs)',
    failed: 'SEO weekly pipeline FAILED',
    started: 'SEO weekly pipeline started',
  }[event] || `SEO weekly: ${event}`;
  lines.push(`${head} ${mode}`.trim());
  if (attempt?.week_of) lines.push(`Week of ${attempt.week_of}`);
  if (attempt?.id) lines.push(`Attempt ${short(attempt.id)}`);
  if (plan?.topic) lines.push(`Topic: ${plan.topic.service_label} — ${plan.topic.city}`);
  if (plan) lines.push(`GBP posts: ${plan.gbp?.length ?? 0} | Facebook posts: ${plan.facebook?.length ?? 0} | Website actions: ${plan.website_actions?.length ?? 0}`);
  // T1: the alert is the review surface, so the validation result and the
  // runtime are stated rather than left to the reader's inference.
  if (validation) lines.push(`Validation: ${validation.ok ? 'ok' : 'FAILED'} — ${(validation.errors || []).length} error(s), ${(validation.warnings || []).length} warning(s)`);
  const runtime = attemptRuntime(attempt);
  if (runtime) lines.push(`Runtime: ${runtime}`);
  if (plan?.notes?.degraded && plan.notes.degraded_reason) lines.push(`Degraded: ${plan.notes.degraded_reason}`);
  if (attempt?.llm?.fallback_used) lines.push(`LLM fallback used: ${attempt.llm.fallback} (${attempt.llm.reason})`);
  if (typeof attempt?.spent_usd === 'number') lines.push(`Spend: $${attempt.spent_usd.toFixed(4)}`);
  if (attempt?.error && event === 'failed') lines.push(`Error: ${String(attempt.error).slice(0, 300)}`);
  if (summary.path) lines.push(`Summary: ${summary.path}`);
  if (attempt?.mode === 'shadow') lines.push('Shadow mode: nothing was published.');
  if (attempt?.mode === 'new') {
    // Live mode: the alert is the owner's cue that rows now sit at the MCC gate
    // (or were auto-approved), so the projection outcome is stated explicitly.
    if (projection && projection.runId) {
      const approved = projection.approved;
      const verdict = projection.auto_approve
        ? (approved && approved.ok ? `auto-approved (${approved.count ?? '?'} post(s))` : `auto-approve refused: ${(approved && approved.reason) || 'unknown'} — still pending approval`)
        : 'pending approval in MCC';
      lines.push(`Projected: ${projection.posts ?? '?'} post(s) + ${projection.tasks ?? '?'} task(s) → seo_runs ${short(projection.runId)}, ${verdict}`);
    } else {
      lines.push('Live mode: nothing was projected into weekly_posts / website_tasks.');
    }
  }
  return lines.join('\n');
}

// Primary hop = Hermes CLI, then Slack direct (resolves { ok, channel } or { ok: false, reason }).
// SMTP is its own best-effort hop after it, so a delivered alert reads `via hermes+smtp`.
const defaultHermes = (message) => deliverPrimary(message);
const defaultSmtp = (message) => sendSmtpAlert(message);

/**
 * Send one alert for (attempt, event). Idempotent per attempt+event: an
 * existing `notify:<event>` stage with status ok short-circuits.
 *
 * @returns {Promise<{ sent: boolean, channel: string, reason: string, skipped?: boolean }>}
 */
export async function notifyAttempt({
  store, attempt, event, message, hermes = defaultHermes, smtp = defaultSmtp, now = new Date(),
}) {
  if (!attempt || !event) throw new Error('notifyAttempt: attempt and event are required');
  const key = `notify:${event}`;
  const prior = attempt.stages?.[key];
  if (prior && prior.status === 'ok') {
    return { sent: true, channel: prior.error ? String(prior.error).replace(/^via /, '') : 'prior', reason: 'already_notified', skipped: true };
  }
  const startedAt = now.toISOString();
  const text = message || formatAttemptMessage({ attempt, event });

  // The primary hop reports the channel that delivered ('hermes' or 'slack'); a bare
  // `{ ok: true }` from an injected seam is taken as 'hermes'. Every failed hop's reason
  // is kept, so a total failure names all of them.
  let channel = '';
  const reasons = [];
  try {
    const r = await hermes(text);
    if (r && r.ok !== false) channel = r.channel || 'hermes';
    else reasons.push((r && r.reason) || 'hermes refused');
  } catch (e) {
    reasons.push(`hermes: ${e.message || e}`);
  }
  try {
    const r = await smtp(text);
    if (r && r.ok !== false) channel = channel ? `${channel}+smtp` : 'smtp';
    else reasons.push((r && r.reason) || 'smtp refused');
  } catch (e) {
    reasons.push(`smtp: ${e.message || e}`);
  }
  const reason = reasons.join('; ');

  const sent = Boolean(channel);
  const receipt = {
    started_at: startedAt,
    finished_at: new Date(now.getTime() + 1).toISOString(),
    status: sent ? 'ok' : 'failed',
    // The receipt's error field carries the delivery channel on success so the
    // stages map alone tells the story: `via hermes+smtp`.
    error: sent ? `via ${channel}` : (reason || 'all channels failed'),
  };
  if (store && typeof store.updateAttempt === 'function') {
    const stages = { ...(attempt.stages || {}), [key]: receipt };
    await store.updateAttempt(attempt.id, { stages });
    attempt.stages = stages;
  }
  return { sent, channel: channel || 'none', reason: sent ? '' : (reason || 'all_channels_failed') };
}
