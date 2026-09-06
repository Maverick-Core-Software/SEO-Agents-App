/**
 * reconcile.mjs — the memory half of the pipeline.
 *
 * 1. reconcilePerformance: for every published Facebook post in the lookback
 *    window, record per-post metrics at 7 and 28 days (only once a window has
 *    matured) into performance_observations. Idempotent per
 *    (platform_post_id, metric, window_days). Reads weekly_posts read-only.
 * 2. recordPageMetrics: page-level Search Console rows into
 *    performance_observations, keyed by page_url + metric + window.
 * 3. copyPublishStatus: plan_items with a projected_ref get publish_status and
 *    media/platform ids copied back from weekly_posts.
 *
 * Nothing here writes to weekly_posts or website_tasks.
 */

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

export function metricRowsForPost({ post, perf, windowDays, now, planItemId = null }) {
  const measuredAt = now.toISOString();
  const rows = [];
  for (const metric of FB_METRICS) {
    const v = perf ? perf[metric] : undefined;
    rows.push({
      plan_item_id: planItemId,
      platform_post_id: post.platform_post_id,
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

async function existingKeys(supabase, { since, now = new Date(), retryAfterDays = RETRY_UNAVAILABLE_AFTER_DAYS }) {
  const data = must(await supabase.from('performance_observations')
    .select('platform_post_id, page_url, metric, window_days, availability, measured_at')
    .gte('measured_at', since)
    .limit(5000), 'performance_observations select');
  // A key is "done" when a row carried a value, or when an `unavailable` row is
  // younger than retryAfterDays. Older unavailable rows are retried so a fixed
  // client can backfill, without re-inserting an unavailable row every day.
  const cutoff = now.getTime() - retryAfterDays * DAY_MS;
  const done = new Set();
  for (const r of data || []) {
    const key = `${r.platform_post_id || ''}|${r.page_url || ''}|${r.metric}|${r.window_days}`;
    if (r.availability !== 'unavailable') { done.add(key); continue; }
    const at = Date.parse(r.measured_at || '');
    if (Number.isFinite(at) && at > cutoff) done.add(key);
  }
  return done;
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
 * @param {object} opts
 * @param {object} opts.supabase   service-role client
 * @param {object} opts.fbClient   { postPerformance({ postId }) } from scripts/lib/facebook-insights.mjs
 * @param {Date}   [opts.now]
 * @param {number[]} [opts.windows=[7, 28]]
 * @param {number} [opts.lookbackDays=42]
 * @param {function} [opts.videoFallback]  async ({ postId }) => ({ media_views }) for Reels/videos,
 *   whose nodes reject the post field set (video_insights needs read_insights, which the
 *   page token lacks as of 2026-09-06, but the plain `views` field works)
 */
export async function reconcilePerformance({ supabase, fbClient, now = new Date(), windows = [7, 28], lookbackDays = 42, videoFallback = null, retryAfterDays = RETRY_UNAVAILABLE_AFTER_DAYS, log = () => {} }) {
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

  const seen = await existingKeys(supabase, { since: `${since}T00:00:00Z`, now, retryAfterDays });
  const rows = [];
  let unavailable = 0;
  let skipped = 0;
  let videos = 0;
  for (const post of published) {
    for (const windowDays of windows) {
      if (!windowMatured(post.post_date, windowDays, now)) { skipped += 1; continue; }
      // A post-window is done when any of its metrics carried a value (Reels
      // only ever carry media_views) or an unavailable row is still fresh.
      if (seen.has(`${post.platform_post_id}||fb_interactions|${windowDays}`)
        || seen.has(`${post.platform_post_id}||fb_media_views|${windowDays}`)) { skipped += 1; continue; }
      let perf = null;
      try {
        perf = await fbClient.postPerformance({ postId: post.platform_post_id });
      } catch (e) {
        if (videoFallback && looksLikeVideoNode(e)) {
          try {
            perf = await videoFallback({ postId: post.platform_post_id });
            videos += 1;
          } catch (e2) {
            unavailable += 1;
            log(`video fallback failed for ${post.platform_post_id}: ${e2.message || e2}`);
          }
        } else {
          unavailable += 1;
          log(`facebook insights unavailable for ${post.platform_post_id}: ${e.message || e}`);
        }
      }
      rows.push(...metricRowsForPost({ post, perf, windowDays, now, planItemId: itemByRef.get(post.id) || null }));
    }
  }
  const inserted = rows.length ? await insertRows(supabase, rows) : 0;
  return { posts: published.length, inserted, skipped, unavailable, videos };
}

/**
 * Page-level Search Console rows. `rows` come from the search-console collector
 * (or the probe helper): [{ page, clicks, impressions, ctr, position }].
 */
export async function recordPageMetrics({ supabase, rows, windowDays, now = new Date() }) {
  if (!rows || !rows.length) return { inserted: 0, skipped: 0 };
  // Page metrics are a daily time series: at most one row per page, metric,
  // and window per calendar day.
  const since = isoDate(now.getTime());
  const seen = await existingKeys(supabase, { since: `${since}T00:00:00Z`, now });
  const measuredAt = now.toISOString();
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    for (const [metric, value] of [['sc_clicks', r.clicks], ['sc_impressions', r.impressions], ['sc_ctr', r.ctr], ['sc_position', r.position]]) {
      if (seen.has(`|${r.page}|${metric}|${windowDays}`)) { skipped += 1; continue; }
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
