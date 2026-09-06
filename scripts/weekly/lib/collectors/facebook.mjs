/**
 * collectors/facebook.mjs
 * Read-only Facebook Page insights collector for the weekly pipeline.
 *
 * Uses createFacebookClient() from scripts/lib/facebook-insights.mjs (or an
 * injected client with the same `topPosts` method) to read the latest page
 * posts with their lifetime insights, keeps the ones created inside the
 * window (default 28 days) and emits one `facebook` observation per post:
 * scope = platform post id, value = { impressions, reach, engaged, reactions,
 * comments, shares, created_time, message_excerpt, ... }. Metrics the Graph
 * API did not return are null, never zero ("unavailable, never as zero").
 *
 * Never throws: any failure becomes a single `unavailable` observation. The
 * page access token is scrubbed from every note. Tests inject `client` (or
 * `fetchImpl` plus env credentials) and never reach the network.
 */
import process from 'node:process';
import { createFacebookClient } from '../../../lib/facebook-insights.mjs';
import { POLICY_PATH } from '../paths.mjs';
import { citiesForTagging, findCity, resolveNow } from './search-console.mjs';

export const SOURCE = 'facebook';
export const METRIC = 'post_engagement';
export const DEFAULT_DAYS = 28;
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Graph feed page size; the shared client caps it at 25. */
export const FEED_LIMIT = 25;
export const EXCERPT_CHARS = 160;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Collection window ending at `now` (UTC dates, like the shared client). */
export function windowFor(days, now) {
  const end = now instanceof Date ? now : new Date(now);
  const n = Number(days);
  const span = Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
  const since = new Date(end.getTime() - span * DAY_MS);
  return { since, start: since.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** True when the post has a parseable created_time at or after `since`. */
export function inWindow(post, since) {
  const t = Date.parse(post && post.created_time);
  return Number.isFinite(t) && t >= since.getTime();
}

/** Whitespace-collapsed opening of the message, ellipsised past `max` chars. */
export function excerpt(message, max = EXCERPT_CHARS) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Remove token values and access_token query params from free text. */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/(access_token=)[^&\s"']+/gi, '$1[redacted]');
}

function metricOrNull(insights, name) {
  const v = insights && insights[name] && insights[name][0] && insights[name][0].numeric_value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function count(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * A summarizePost() count, or null when the Graph API refused the insight
 * metric behind it. summarizePost() writes 0 in that case, which would read
 * downstream as "nobody clicked" rather than "unknown".
 */
function countOrNull(n, unavailableMetrics, metric) {
  return Object.hasOwn(unavailableMetrics, metric) ? null : count(n);
}

/** One summarizePost() result → one observation. */
export function postToObservation(post, { attemptId, retrievedAt, period, cities }) {
  const id = String(post.id);
  const insights = post.insights || {};
  const unavailableMetrics = post.unavailable_metrics && typeof post.unavailable_metrics === 'object'
    ? post.unavailable_metrics
    : {};
  const unavailable = Object.keys(unavailableMetrics).sort();
  return {
    id: `fb:${id}`,
    attempt_id: attemptId,
    source: SOURCE,
    scope: id,
    geography: findCity(post.message, cities),
    period,
    status: 'ok',
    metric: METRIC,
    value: {
      impressions: metricOrNull(insights, 'post_impressions'),
      reach: metricOrNull(insights, 'post_impressions_unique'),
      engaged: metricOrNull(insights, 'post_engaged_users'),
      reactions: countOrNull(post.reactions, unavailableMetrics, 'post_reactions_by_type_total'),
      comments: count(post.comments),
      shares: count(post.shares),
      clicks: countOrNull(post.clicks, unavailableMetrics, 'post_clicks'),
      media_views: countOrNull(post.media_views, unavailableMetrics, 'post_media_view'),
      interactions: count(post.interactions),
      media_type: post.media_type || 'text',
      created_time: post.created_time || null,
      permalink_url: post.permalink_url || null,
      message_excerpt: excerpt(post.message),
    },
    raw_ref: post.permalink_url || `graph:${id}`,
    retrieved_at: retrievedAt,
    note: unavailable.length ? `unavailable metrics: ${unavailable.join(', ')}` : null,
  };
}

export function unavailableObservation({ attemptId, retrievedAt, note, period = null }) {
  return {
    id: 'fb:unavailable',
    attempt_id: attemptId,
    source: SOURCE,
    scope: 'page',
    geography: null,
    period,
    status: 'unavailable',
    metric: METRIC,
    value: null,
    raw_ref: null,
    retrieved_at: retrievedAt,
    note,
  };
}

/**
 * Marker emitted when the feed page was full and its oldest post still sits
 * inside the window: the shared client reads at most 25 posts and does not
 * paginate, so older in-window posts were not read. `status: 'ok'` (the read
 * succeeded) under its own metric, so post consumers keyed on post ids or
 * on `post_engagement` skip it.
 */
export function feedTruncatedObservation({ attemptId, retrievedAt, period, limit, oldestCreatedTime }) {
  return {
    id: 'fb:feed-truncated',
    attempt_id: attemptId,
    source: SOURCE,
    scope: 'page',
    geography: null,
    period,
    status: 'ok',
    metric: 'feed_truncated',
    value: { limit, oldest_created_time: oldestCreatedTime },
    raw_ref: null,
    retrieved_at: retrievedAt,
    note: `feed returned ${limit} posts and the oldest is still inside the window; older in-window posts were not read`,
  };
}

function withTimeout(promise, ms, label) {
  if (!(Number.isFinite(ms) && ms > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function messageOf(err) {
  return err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
}

// ── I/O entry point ────────────────────────────────────────────────────────

/**
 * collectFacebook({ attemptId, days = 28, now, client }) → Observation[]
 *
 * Extra optional inputs: `env` (FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN or
 * FB_ACCESS_TOKEN, FB_GRAPH_API_VERSION; defaults to process.env), `fetchImpl`
 * for the shared client, `policy` (parsed weekly-policy; read from
 * `policyPath` when absent; unreadable → posts come back untagged),
 * `timeoutMs` for the whole read, `limit` feed size (≤ 25). Zero posts inside
 * the window is a successful empty result, not unavailable. A full feed page
 * whose oldest post is still inside the window adds one `feed_truncated`
 * marker. An unparseable `now` throws a TypeError (caller bug); every other
 * failure is returned as an `unavailable` observation.
 */
export async function collectFacebook({
  attemptId,
  days = DEFAULT_DAYS,
  now,
  client,
  env = process.env,
  fetchImpl,
  policy,
  policyPath = POLICY_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = FEED_LIMIT,
} = {}) {
  const nowDate = resolveNow(now, 'collectFacebook');
  const retrievedAt = nowDate.toISOString();
  const window = windowFor(days, nowDate);
  const period = { start: window.start, end: window.end };
  const vars = env && typeof env === 'object' ? env : {};
  const secrets = [vars.FB_PAGE_ACCESS_TOKEN, vars.FB_ACCESS_TOKEN].filter(Boolean);
  const cities = citiesForTagging(policy, policyPath);
  const wanted = Math.floor(Number(limit));
  const feedLimit = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, FEED_LIMIT) : FEED_LIMIT;
  try {
    const fb = client || createFacebookClient({
      pageId: vars.FB_PAGE_ID,
      accessToken: vars.FB_PAGE_ACCESS_TOKEN || vars.FB_ACCESS_TOKEN,
      apiVersion: vars.FB_GRAPH_API_VERSION || 'v22.0',
      fetchImpl,
    });
    const result = await withTimeout(fb.topPosts({ limit: feedLimit }), timeoutMs, 'Facebook insights read');
    const posts = (result && Array.isArray(result.posts)) ? result.posts : [];
    const dated = posts.filter((post) => post && post.id != null && Number.isFinite(Date.parse(post.created_time)));
    const inside = dated
      .filter((post) => inWindow(post, window.since))
      .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time) || String(a.id).localeCompare(String(b.id)));
    const observations = inside.map((post) => postToObservation(post, { attemptId, retrievedAt, period, cities }));
    if (posts.length >= feedLimit && inside.length > 0 && inside.length === dated.length) {
      observations.push(feedTruncatedObservation({
        attemptId, retrievedAt, period, limit: feedLimit, oldestCreatedTime: inside[inside.length - 1].created_time,
      }));
    }
    return observations;
  } catch (err) {
    return [unavailableObservation({ attemptId, retrievedAt, period, note: scrubSecrets(messageOf(err), secrets) })];
  }
}
