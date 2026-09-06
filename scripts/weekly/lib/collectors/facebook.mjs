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
import { findCity, policyCities, readPolicy } from './search-console.mjs';

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

/** One summarizePost() result → one observation. */
export function postToObservation(post, { attemptId, retrievedAt, period, cities }) {
  const id = String(post.id);
  const insights = post.insights || {};
  const unavailable = Object.keys(post.unavailable_metrics || {}).sort();
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
      reactions: count(post.reactions),
      comments: count(post.comments),
      shares: count(post.shares),
      clicks: count(post.clicks),
      media_views: count(post.media_views),
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
 * for the shared client, `policy` (parsed weekly-policy; read from disk when
 * absent), `timeoutMs` for the whole read, `limit` feed size (≤ 25).
 * Zero posts inside the window is a successful empty result, not unavailable.
 */
export async function collectFacebook({
  attemptId,
  days = DEFAULT_DAYS,
  now = new Date(),
  client,
  env = process.env,
  fetchImpl,
  policy,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = FEED_LIMIT,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const retrievedAt = nowDate.toISOString();
  const window = windowFor(days, nowDate);
  const period = { start: window.start, end: window.end };
  const secrets = [env.FB_PAGE_ACCESS_TOKEN, env.FB_ACCESS_TOKEN].filter(Boolean);
  try {
    const cities = policyCities(policy ?? readPolicy());
    const fb = client || createFacebookClient({
      pageId: env.FB_PAGE_ID,
      accessToken: env.FB_PAGE_ACCESS_TOKEN || env.FB_ACCESS_TOKEN,
      apiVersion: env.FB_GRAPH_API_VERSION || 'v22.0',
      fetchImpl,
    });
    const result = await withTimeout(fb.topPosts({ limit }), timeoutMs, 'Facebook insights read');
    const posts = (result && Array.isArray(result.posts)) ? result.posts : [];
    return posts
      .filter((post) => post && post.id != null && inWindow(post, window.since))
      .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time) || String(a.id).localeCompare(String(b.id)))
      .map((post) => postToObservation(post, { attemptId, retrievedAt, period, cities }));
  } catch (err) {
    return [unavailableObservation({ attemptId, retrievedAt, period, note: scrubSecrets(messageOf(err), secrets) })];
  }
}
