#!/usr/bin/env node
/**
 * reconcile.mjs — daily memory pass for the weekly pipeline.
 *
 *   node scripts/weekly/reconcile.mjs [--dry-run] [--lookback-days 42]
 *
 * Records 7- and 28-day Facebook metrics per published post, page-level Search
 * Console metrics for the last 7 and 28 days, and copies publish status back to
 * projected plan items. Writes only performance_observations and
 * plan_items.publish_status. Safe to run any time; idempotent per window.
 * Intended for the daily watchdog slot (see FRIDAY-RUNBOOK.md).
 */
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';
import { copyPublishStatus, reconcilePerformance, recordPageMetrics } from './lib/reconcile.mjs';

loadEnv();
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
// --retry-unavailable: re-attempt post-windows recorded as unavailable now
// instead of waiting the usual week (e.g. after a client fix).
const retryAfterDays = argv.includes('--retry-unavailable') ? 0 : undefined;
const lb = argv.indexOf('--lookback-days');
const lookbackDays = lb !== -1 ? parseInt(argv[lb + 1], 10) || 42 : 42;

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_KEY || '';
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  process.exit(1);
}
const supabase = createClient(url, key);
const now = new Date();
const log = (m) => console.log(`[reconcile] ${m}`);

async function facebookClient() {
  const pageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
  if (!pageId || !accessToken) return null;
  const { createFacebookClient } = await import('../lib/facebook-insights.mjs');
  return createFacebookClient({ pageId, accessToken, apiVersion: process.env.FB_GRAPH_API_VERSION || 'v22.0' });
}

/**
 * Reels/videos reject the post field set and video_insights needs read_insights
 * (missing on the page token), but the plain `views` field is readable.
 */
async function videoFallback({ postId }) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
  const v = process.env.FB_GRAPH_API_VERSION || 'v22.0';
  const u = new URL(`https://graph.facebook.com/${v}/${postId}`);
  u.searchParams.set('fields', 'id,views,created_time');
  u.searchParams.set('access_token', token);
  const res = await fetch(u);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`video fields failed (${res.status}): ${json.error?.message || 'unknown'}`);
  const views = Number(json.views);
  return { media_views: Number.isFinite(views) ? views : undefined };
}

async function searchConsolePages(days) {
  try {
    process.env.GBP_TOKEN_FILE = process.env.SEARCH_CONSOLE_TOKEN_FILE
      || 'C:/Users/carte/gmail-multi/tokens/grizzly-search-console.json';
    const [{ gbpFetch }, { dateRange, pickGrizzlyProperty }] = await Promise.all([
      import('../lib/gbp-api-auth.mjs'),
      import('../lib/search-console.mjs'),
    ]);
    const sites = await gbpFetch('https://www.googleapis.com/webmasters/v3/sites');
    const prop = pickGrizzlyProperty(sites.siteEntry || []);
    if (!prop) return { rows: [], note: 'property not visible' };
    const { startDate, endDate } = dateRange(days, now);
    const url2 = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(prop.siteUrl)}/searchAnalytics/query`;
    const result = await gbpFetch(url2, { method: 'POST', body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit: 500 }) });
    return { rows: (result.rows || []).map((r) => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })), note: `${startDate}..${endDate}` };
  } catch (e) {
    return { rows: [], note: `search console unavailable: ${e.message || e}` };
  }
}

async function main() {
  if (dryRun) {
    log('dry run: reading only');
    const posts = await supabase.from('weekly_posts').select('id, post_date, platform_post_id').eq('platform', 'facebook').not('platform_post_id', 'is', null).limit(50);
    log(`published facebook posts visible: ${(posts.data || []).length}`);
    return;
  }
  const fb = await facebookClient();
  if (fb) {
    const r = await reconcilePerformance({ supabase, fbClient: fb, now, lookbackDays, videoFallback, retryAfterDays, log });
    log(`facebook: posts=${r.posts} inserted=${r.inserted} skipped=${r.skipped} unavailable=${r.unavailable} videos=${r.videos}`);
  } else {
    log('facebook: FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN missing, skipped');
  }
  for (const days of [7, 28]) {
    const sc = await searchConsolePages(days);
    const r = await recordPageMetrics({ supabase, rows: sc.rows, windowDays: days, now });
    log(`search console ${days}d (${sc.note}): pages=${sc.rows.length} inserted=${r.inserted} skipped=${r.skipped}`);
  }
  const c = await copyPublishStatus({ supabase });
  log(`publish status copied to ${c.updated} plan item(s)`);
}

main().catch((e) => { console.error(`[reconcile] failed: ${e.message || e}`); process.exit(1); });
