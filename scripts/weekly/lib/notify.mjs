/**
 * notify.mjs — attempt-bound alerts with delivery receipts.
 *
 * Same two transports the legacy pipeline uses (Hermes CLI first, Gmail SMTP
 * second, both best-effort), but every send is keyed by attempt and event and
 * the receipt is written to the attempt's stages as `notify:<event>` so a
 * re-run never re-sends and the watchdog can see what was delivered.
 */
import { sendHermesAlert } from '../../lib/hermes-alert.mjs';

function short(id) {
  return String(id || '').slice(0, 8);
}

export function formatAttemptMessage({ attempt, event, plan = null, summary = {} } = {}) {
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
  if (plan?.notes?.degraded && plan.notes.degraded_reason) lines.push(`Degraded: ${plan.notes.degraded_reason}`);
  if (typeof attempt?.spent_usd === 'number') lines.push(`Spend: $${attempt.spent_usd.toFixed(4)}`);
  if (attempt?.error && event === 'failed') lines.push(`Error: ${String(attempt.error).slice(0, 300)}`);
  if (summary.path) lines.push(`Summary: ${summary.path}`);
  if (attempt?.mode === 'shadow') lines.push('Shadow mode: nothing was published.');
  return lines.join('\n');
}

async function defaultSmtp(message) {
  const pass = process.env.SMTP_APP_PASSWORD || '';
  if (!pass) return { ok: false, reason: 'smtp not configured' };
  const from = process.env.SMTP_FROM || process.env.SMTP_FROM_EMAIL || 'barnscarter@gmail.com';
  const to = process.env.SMTP_TO || process.env.SMTP_TO_EMAIL || 'barnscarter@gmail.com';
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({ service: 'gmail', auth: { user: from, pass } });
  await transport.sendMail({ from, to, subject: message.split('\n')[0].slice(0, 80), text: message });
  return { ok: true };
}

async function defaultHermes(message) {
  await sendHermesAlert(message);
  return { ok: true };
}

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

  let channel = '';
  let reason = '';
  try {
    const r = await hermes(text);
    if (r && r.ok !== false) channel = 'hermes';
    else reason = (r && r.reason) || 'hermes refused';
  } catch (e) {
    reason = `hermes: ${e.message || e}`;
  }
  try {
    const r = await smtp(text);
    if (r && r.ok !== false) channel = channel ? `${channel}+smtp` : 'smtp';
    else if (!reason) reason = (r && r.reason) || 'smtp refused';
  } catch (e) {
    if (!reason) reason = `smtp: ${e.message || e}`;
  }

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
