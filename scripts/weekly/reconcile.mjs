#!/usr/bin/env node
/**
 * reconcile.mjs — daily memory pass for the weekly pipeline.
 *
 *   node scripts/weekly/reconcile.mjs [--dry-run] [--lookback-days 42] [--retry-unavailable]
 *
 * Records 7- and 28-day Facebook metrics per published post, page-level Search
 * Console metrics for the last 7 and 28 days, and copies publish status back to
 * projected plan items. Writes only performance_observations and
 * plan_items.publish_status. Safe to run any time; idempotent per window.
 * Intended for the daily watchdog slot (see FRIDAY-RUNBOOK.md).
 *
 * Also writes outputs/reconcile-health.json on EVERY non-dry path — success,
 * a thrown pass, and a missing Supabase configuration: `status` +
 * `last_attempt_at` for the pass just run, `last_error` for a failure, and
 * `last_success_at`, which only a clean pass advances. The watchdog reads
 * freshness from `last_success_at`, never from table rows. A dry run writes
 * nothing.
 *
 * `runReconcile(deps)` is the library entry (tests inject the Supabase client,
 * the Facebook client and the Search Console reader); `main()` only runs when
 * this file is the entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';
import { copyPublishStatus, reconcilePerformance, recordPageMetrics } from './lib/reconcile.mjs';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HEALTH_FILE = path.join(PROJECT_ROOT, 'outputs', 'reconcile-health.json');

const noop = () => {};
const errorText = (e) => (e instanceof Error ? e.message || String(e) : String(e));

/** Parse the CLI flags (exported for tests). */
export function parseArgs(argv = []) {
  const lb = argv.indexOf('--lookback-days');
  return {
    dryRun: argv.includes('--dry-run'),
    // --retry-unavailable: re-attempt post-windows recorded as unavailable now
    // instead of waiting the usual week (e.g. after a client fix).
    retryAfterDays: argv.includes('--retry-unavailable') ? 0 : undefined,
    lookbackDays: lb !== -1 ? parseInt(argv[lb + 1], 10) || 42 : 42,
  };
}

async function defaultFacebookClient(env) {
  const pageId = env.FB_PAGE_ID;
  const accessToken = env.FB_PAGE_ACCESS_TOKEN || env.FB_ACCESS_TOKEN;
  if (!pageId || !accessToken) return null;
  const { createFacebookClient } = await import('../lib/facebook-insights.mjs');
  return createFacebookClient({ pageId, accessToken, apiVersion: env.FB_GRAPH_API_VERSION || 'v22.0' });
}

/**
 * Reels/videos reject the post field set and video_insights needs read_insights
 * (missing on the page token), but the plain `views` field is readable.
 */
function makeVideoFallback(env) {
  return async function videoFallback({ postId }) {
    const token = env.FB_PAGE_ACCESS_TOKEN || env.FB_ACCESS_TOKEN;
    const v = env.FB_GRAPH_API_VERSION || 'v22.0';
    const u = new URL(`https://graph.facebook.com/${v}/${postId}`);
    u.searchParams.set('fields', 'id,views,created_time');
    u.searchParams.set('access_token', token);
    const res = await fetch(u);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`video fields failed (${res.status}): ${json.error?.message || 'unknown'}`);
    const views = Number(json.views);
    return { media_views: Number.isFinite(views) ? views : undefined };
  };
}

function makeSearchConsolePages(env, now) {
  return async function searchConsolePages(days) {
    try {
      process.env.GBP_TOKEN_FILE = env.SEARCH_CONSOLE_TOKEN_FILE
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
  };
}

/**
 * Record what this pass did. `last_success_at` is the freshness the watchdog
 * reads, so a failed pass moves `last_attempt_at`/`status`/`last_error` and
 * carries the previous success timestamp forward instead of clearing it.
 * Returns the payload written (or built, when the write itself failed).
 */
export function writeHealth({ status, error = null, counts = null, healthFile = HEALTH_FILE, startedAt, now = new Date(), warn = noop }) {
  const finishedAt = new Date(now).toISOString();
  const began = startedAt ? new Date(startedAt).toISOString() : finishedAt;
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(healthFile, 'utf8')); } catch { previous = {}; }
  if (!previous || typeof previous !== 'object') previous = {};
  const payload = {
    status,
    last_attempt_at: finishedAt,
    last_success_at: status === 'ok' ? finishedAt : (previous.last_success_at || null),
    last_error: status === 'ok' ? null : (error || 'unknown error'),
    started_at: began,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(began)),
    counts,
    error: error || null,
  };
  try {
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });
    fs.writeFileSync(healthFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (e) {
    warn(`could not write health (${healthFile}): ${errorText(e)}`);
  }
  return payload;
}

/**
 * One reconcile pass. Resolves with `{ status: 'ok', counts, health }`; on any
 * failure the health file is written with `status: 'failed'` and `last_error`
 * BEFORE the error is rethrown, so a crash never leaves the previous pass's
 * health on disk as if it were current. A dry run reads only and writes no
 * health. `deps`: { supabase (required unless dryRun with a client), env, now,
 * dryRun, lookbackDays, retryAfterDays, healthFile, log, warn, facebookClient,
 * videoFallback, searchConsolePages, startedAt }.
 */
export async function runReconcile({
  supabase, env = process.env, now = new Date(), dryRun = false, lookbackDays = 42, retryAfterDays,
  healthFile = HEALTH_FILE, log = noop, warn = noop, facebookClient, videoFallback, searchConsolePages, startedAt,
} = {}) {
  const began = startedAt || now;
  if (!supabase) {
    const error = 'SUPABASE_URL / SUPABASE_SERVICE_KEY missing';
    const health = writeHealth({ status: 'failed', error, healthFile, startedAt: began, now, warn });
    const e = new Error(error);
    e.health = health;
    throw e;
  }
  if (dryRun) {
    log('dry run: reading only');
    const posts = await supabase.from('weekly_posts').select('id, post_date, platform_post_id').eq('platform', 'facebook').not('platform_post_id', 'is', null).limit(50);
    log(`published facebook posts visible: ${(posts.data || []).length}`);
    return { status: 'dry-run', counts: null, health: null };
  }
  try {
    const fb = facebookClient !== undefined ? facebookClient : await defaultFacebookClient(env);
    const counts = { facebook: null, search_console: [], plan_items_updated: 0 };
    if (fb) {
      const r = await reconcilePerformance({
        supabase, fbClient: fb, now, lookbackDays, videoFallback: videoFallback || makeVideoFallback(env), retryAfterDays,
        pageId: env.FB_PAGE_ID || null, log,
      });
      counts.facebook = { posts: r.posts, inserted: r.inserted, replaced: r.replaced, skipped: r.skipped, unavailable: r.unavailable, videos: r.videos };
      log(`facebook: posts=${r.posts} inserted=${r.inserted} replaced=${r.replaced} skipped=${r.skipped} unavailable=${r.unavailable} videos=${r.videos}`);
      for (const reason of r.reasons || []) log(`unavailable reason: ${reason.reason}`);
    } else {
      log('facebook: FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN missing, skipped');
    }
    const scPages = searchConsolePages || makeSearchConsolePages(env, now);
    for (const days of [7, 28]) {
      const sc = await scPages(days);
      const r = await recordPageMetrics({ supabase, rows: sc.rows, windowDays: days, now });
      counts.search_console.push({ window_days: days, pages: sc.rows.length, inserted: r.inserted, skipped: r.skipped, note: sc.note });
      log(`search console ${days}d (${sc.note}): pages=${sc.rows.length} inserted=${r.inserted} skipped=${r.skipped}`);
    }
    const c = await copyPublishStatus({ supabase });
    counts.plan_items_updated = c.updated;
    log(`publish status copied to ${c.updated} plan item(s)`);
    const health = writeHealth({ status: 'ok', counts, healthFile, startedAt: began, now: new Date(), warn });
    return { status: 'ok', counts, health };
  } catch (e) {
    const health = writeHealth({ status: 'failed', error: errorText(e), healthFile, startedAt: began, now: new Date(), warn });
    if (e && typeof e === 'object') e.health = health;
    throw e;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = new Date();
  loadEnv();
  const args = parseArgs(argv);
  const log = (m) => console.log(`[reconcile] ${m}`);
  const warn = (m) => console.error(`[reconcile] WARNING: ${m}`);
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  const supabase = url && key ? createClient(url, key) : null;
  try {
    await runReconcile({ supabase, env: process.env, now: new Date(), startedAt, log, warn, ...args });
    return 0;
  } catch (e) {
    console.error(`[reconcile] failed: ${errorText(e)}`);
    return 1;
  }
}

// realpath both sides: the scheduler launches this via the C:\Workspace junction while Node
// resolves the module to D:\Workspace, and a plain path compare silently skips main().
const invokedDirectly = process.argv[1]
  && fs.realpathSync.native(fileURLToPath(import.meta.url))
    === fs.realpathSync.native(path.resolve(process.argv[1]));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; });
}
