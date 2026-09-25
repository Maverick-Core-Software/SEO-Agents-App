/**
 * reconcile.mjs — the memory half of the pipeline.
 *
 * 1. reconcilePerformance: for every published Facebook post in the lookback
 *    window, record per-post metrics at 7 and 28 days (only once a window has
 *    matured) into performance_observations. Idempotent per (stored
 *    platform_post_id, metric, window_days) — the row key is the id stored on
 *    weekly_posts, even when a bare id is page-scoped for the Graph call, so a
 *    retry of a window recorded as unavailable replaces those rows in place,
 *    it never inserts a second copy. Reads weekly_posts read-only.
 * 2. recordPageMetrics: page-level Search Console rows into
 *    performance_observations, keyed by page_url + metric + window + day.
 *    Source is part of every key, so a Facebook retry can never collide with a
 *    Search Console row and the SC daily history stays intact.
 * 3. copyPublishStatus: plan_items with a projected_ref get publish_status and
 *    media/platform ids copied back from weekly_posts.
 *
 * Nothing here writes to weekly_posts or website_tasks.
 */
import { normalizePostId } from '../../lib/facebook-insights.mjs';

const DAY_MS = 86400000;
const FB_METRICS = ['reactions', 'comments', 'shares', 'clicks', 'media_views', 'interactions'];

function must(result, what) {
  if (result && result.error) throw new Error(`${what}: ${result.error.message || String(result.error)}`);
  return result ? result.data : null;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A window is mature when post_date + window_days is on or before today. */
export function windowMatured(postDate, windowDays, now) {
  const post = Date.parse(`${postDate}T00:00:00Z`);
  return post + windowDays * DAY_MS <= Date.parse(`${isoDate(now.getTime())}T00:00:00Z`);
}

export function metricRowsForPost({ post, perf, windowDays, now, planItemId = null, postId = null }) {
  const measuredAt = now.toISOString();
  const rows = [];
  for (const metric of FB_METRICS) {
    const v = perf ? perf[metric] : undefined;
    rows.push({
      plan_item_id: planItemId,
      platform_post_id: postId || post.platform_post_id,
      page_url: null,
      metric: `fb_${metric}`,
      window_days: windowDays,
      source: 'facebook',
      value: typeof v === 'number' && Number.isFinite(v) ? v : null,
      availability: typeof v === 'number' && Number.isFinite(v) ? 'ok' : 'unavailable',
      paid: false,
      measured_at: measuredAt,
    });
  }
  return rows;
}

export const RETRY_UNAVAILABLE_AFTER_DAYS = 7;

/**
 * Identity of one observation row, split by source:
 *   facebook       → (platform_post_id, metric, window) — one lifetime value, retried in place
 *   search_console → (page_url, metric, window, day)     — a daily history, never collapsed
 * The source prefix keeps the two namespaces apart, so an FB retry can neither
 * collide with nor replace an SC row that happens to share a metric name.
 */
function observationKey(row) {
  const source = row.source || 'facebook';
  if (source === 'search_console') {
    return `sc|${row.page_url || ''}|${row.metric}|${row.window_days}|${String(row.measured_at || '').slice(0, 10)}`;
  }
  return `${source}|${row.platform_post_id || ''}|${row.metric}|${row.window_days}`;
}

/** True when this post/window already carries a value (or a fresh unavailable row). */
const FB_WINDOW_PROBES = ['fb_interactions', 'fb_media_views'];

function windowRecorded(done, postId, windowDays) {
  return FB_WINDOW_PROBES.some((metric) => done.has(observationKey({ platform_post_id: postId, metric, window_days: windowDays })));
}

/**
 * Keys already recorded (values, or `unavailable` younger than retryAfterDays),
 * plus the row ids of stale `unavailable` rows for those same keys — those are
 * the ones a retry must replace instead of duplicating.
 */
async function existingObservations(supabase, { since, now = new Date(), retryAfterDays = RETRY_UNAVAILABLE_AFTER_DAYS }) {
  const data = must(await supabase.from('performance_observations')
    .select('id, source, platform_post_id, page_url, metric, window_days, availability, measured_at')
    .gte('measured_at', since)
    .limit(5000), 'performance_observations select');
  const cutoff = now.getTime() - retryAfterDays * DAY_MS;
  const done = new Set();
  const retry = new Map();
  for (const r of data || []) {
    const key = observationKey(r);
    if (r.availability !== 'unavailable') { done.add(key); continue; }
    const at = Date.parse(r.measured_at || '');
    if (Number.isFinite(at) && at > cutoff) { done.add(key); continue; }
    if (r.id) retry.set(key, r.id);
  }
  return { done, retry };
}

const VIDEO_NODE_RE = /nonexisting field \(message\)|Unsupported get request|does not exist, cannot be loaded/i;

/** True when a Graph error means "this id is a video/Reel node, not a post". */
export function looksLikeVideoNode(err) {
  return VIDEO_NODE_RE.test(String((err && err.message) || err || ''));
}

async function insertRows(supabase, rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    must(await supabase.from('performance_observations').insert(part), 'performance_observations insert');
    n += part.length;
  }
  return n;
}

/**
 * Write rows: a row whose key already exists as a stale `unavailable` row is
 * updated in place (one atomic per-row update, no duplicate), everything else is
 * inserted. Returns { inserted, replaced }.
 */
async function writeRows(supabase, rows, retry = new Map()) {
  const inserts = [];
  let replaced = 0;
  for (const row of rows) {
    const id = retry.get(observationKey(row));
    if (!id) { inserts.push(row); continue; }
    // ponytail: one sequential update per stale row (6 per post-window, and only on
    // the rare retry path); batch them if a retrofitted week ever gets slow.
    must(await supabase.from('performance_observations').update(row).eq('id', id), 'performance_observations retry update');
    replaced += 1;
  }
  return { inserted: inserts.length ? await insertRows(supabase, inserts) : 0, replaced };
}

/**
 * @param {object} opts
 * @param {object} opts.supabase   service-role client
 * @param {object} opts.fbClient   { postPerformance({ postId }) } from scripts/lib/facebook-insights.mjs
 * @param {Date}   [opts.now]
 * @param {number[]} [opts.windows=[7, 28]]
 * @param {number} [opts.lookbackDays=42]
 * @param {function} [opts.videoFallback]  async ({ postId }) => ({ media_views }) for Reels/videos,
 *   whose nodes reject the post field set (video_insights needs read_insights, which the
 *   page token lacks as of 2026-09-06, but the plain `views` field works)
 * @param {string} [opts.pageId]  FB page id, used only to page-scope a bare stored post id
 */
export async function reconcilePerformance({ supabase, fbClient, now = new Date(), windows = [7, 28], lookbackDays = 42, videoFallback = null, retryAfterDays = RETRY_UNAVAILABLE_AFTER_DAYS, pageId = null, log = () => {} }) {
  const since = isoDate(now.getTime() - lookbackDays * DAY_MS);
  const posts = must(await supabase.from('weekly_posts')
    .select('id, platform, post_date, status, platform_post_id')
    .eq('platform', 'facebook')
    .gte('post_date', since)
    .order('post_date', { ascending: false })
    .limit(200), 'weekly_posts select') || [];
  const published = posts.filter((p) => p.platform_post_id);

  const items = must(await supabase.from('plan_items')
    .select('id, projected_ref')
    .not('projected_ref', 'is', null)
    .limit(2000), 'plan_items select') || [];
  const itemByRef = new Map(items.map((i) => [i.projected_ref, i.id]));

  const { done, retry } = await existingObservations(supabase, { since: `${since}T00:00:00Z`, now, retryAfterDays });
  const rows = [];
  const reasons = [];
  let unavailable = 0;
  let skipped = 0;
  let videos = 0;
  for (const post of published) {
    // The stored id may be bare ("12345") or page-scoped ("108_12345"); call Graph
    // with the canonical form. Nothing is invented here — whether the node exists
    // is decided by Graph, and a rejected id is recorded unavailable below.
    const graphId = normalizePostId(post.platform_post_id, pageId);
    const storedId = String(post.platform_post_id);
    for (const windowDays of windows) {
      if (!windowMatured(post.post_date, windowDays, now)) { skipped += 1; continue; }
      // A post-window is done when any of its metrics carried a value (Reels
      // only ever carry media_views) or an unavailable row is still fresh.
      if (windowRecorded(done, storedId, windowDays)) { skipped += 1; continue; }
      let perf = null;
      try {
        perf = await fbClient.postPerformance({ postId: graphId });
      } catch (e) {
        if (videoFallback && looksLikeVideoNode(e)) {
          try {
            perf = await videoFallback({ postId: graphId });
            videos += 1;
          } catch (e2) {
            unavailable += 1;
            reasons.push({ platform_post_id: storedId, window_days: windowDays, reason: `video fallback failed for ${graphId}: ${e2.message || e2}` });
            log(reasons[reasons.length - 1].reason);
          }
        } else {
          unavailable += 1;
          reasons.push({ platform_post_id: storedId, window_days: windowDays, reason: `facebook insights unavailable for ${graphId}: ${e.message || e}` });
          log(reasons[reasons.length - 1].reason);
        }
      }
      // Graph echoes the node id it actually resolved; a mismatch is logged for the
      // operator. The stored id stays the row key so the next run recognizes its own
      // rows (and their retry targets) instead of duplicating them.
      const verified = perf && typeof perf.id === 'string' && perf.id.trim() ? perf.id.trim() : null;
      if (verified && verified !== graphId) log(`graph id mismatch: requested ${graphId}, Graph returned ${verified}`);
      rows.push(...metricRowsForPost({ post, perf, windowDays, now, planItemId: itemByRef.get(post.id) || null, postId: storedId }));
    }
  }
  const written = rows.length ? await writeRows(supabase, rows, retry) : { inserted: 0, replaced: 0 };
  return { posts: published.length, inserted: written.inserted, replaced: written.replaced, skipped, unavailable, videos, reasons };
}

/**
 * Page-level Search Console rows. `rows` come from the search-console collector
 * (or the probe helper): [{ page, clicks, impressions, ctr, position }].
 */
export async function recordPageMetrics({ supabase, rows, windowDays, now = new Date() }) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0 };
  // Page metrics are a daily time series: at most one row per page, metric,
  // window and calendar day (the day is part of the key, so history accumulates).
  const since = isoDate(now.getTime());
  const { done } = await existingObservations(supabase, { since: `${since}T00:00:00Z`, now });
  const measuredAt = now.toISOString();
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    for (const [metric, value] of [['sc_clicks', r.clicks], ['sc_impressions', r.impressions], ['sc_ctr', r.ctr], ['sc_position', r.position]]) {
      if (done.has(observationKey({ source: 'search_console', page_url: r.page, metric, window_days: windowDays, measured_at: measuredAt }))) { skipped += 1; continue; }
      const num = typeof value === 'string' ? parseFloat(value) : value;
      out.push({
        plan_item_id: null,
        platform_post_id: null,
        page_url: r.page,
        metric,
        window_days: windowDays,
        source: 'search_console',
        value: Number.isFinite(num) ? num : null,
        availability: Number.isFinite(num) ? 'ok' : 'unavailable',
        paid: false,
        measured_at: measuredAt,
      });
    }
  }
  const inserted = out.length ? await insertRows(supabase, out) : 0;
  return { inserted, skipped };
}

/** Copy publish status from weekly_posts back onto projected plan items. */
export async function copyPublishStatus({ supabase }) {
  const items = must(await supabase.from('plan_items')
    .select('id, projected_ref, publish_status')
    .not('projected_ref', 'is', null)
    .limit(2000), 'plan_items select') || [];
  if (!items.length) return { updated: 0 };
  const refs = items.map((i) => i.projected_ref);
  const posts = must(await supabase.from('weekly_posts')
    .select('id, status, platform_post_id')
    .in('id', refs), 'weekly_posts select') || [];
  const byId = new Map(posts.map((p) => [p.id, p]));
  let updated = 0;
  for (const item of items) {
    const p = byId.get(item.projected_ref);
    if (!p) continue;
    const status = p.platform_post_id ? `${p.status}:${p.platform_post_id}` : p.status;
    if (status === item.publish_status) continue;
    must(await supabase.from('plan_items').update({ publish_status: status }).eq('id', item.id), 'plan_items update');
    updated += 1;
  }
  return { updated };
}
