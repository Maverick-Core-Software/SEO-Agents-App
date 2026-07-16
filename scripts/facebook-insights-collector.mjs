#!/usr/bin/env node
/**
 * facebook-insights-collector.mjs
 * Collects engagement data for recent Facebook posts and writes a structured
 * report consumed by crew.py's research phase.
 *
 * Usage:
 *   node scripts/facebook-insights-collector.mjs --days 7 --output outputs/facebook_engagement_report.md
 *   node scripts/facebook-insights-collector.mjs --post-id <id>  # single post
 *   node scripts/facebook-insights-collector.mjs --days 7 --dry-run
 *
 * Required env (or .env):
 *   FB_PAGE_ID            — numeric Facebook Page ID
 *   FB_PAGE_ACCESS_TOKEN  — long-lived Page Access Token
 *   FB_GRAPH_API_VERSION  — Graph API version (default v22.0)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env loader — same pattern as facebook-poster.mjs
// ---------------------------------------------------------------------------
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');

// ---------------------------------------------------------------------------
// Structured logging (stderr — stdout reserved for machine-readable output)
// ---------------------------------------------------------------------------
function hopLog(hop, level, message, extra) {
  const rec = { ts: new Date().toISOString(), source: 'facebook-insights-collector', hop, level, message, ...extra };
  console.error(`[facebook-insights-collector][${hop}][${level}] ${message}`);
  if (level === 'error') console.error(`  ↳ ${JSON.stringify(rec)}`);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { days: 7, output: null, dryRun: false, postId: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--days':
        args.days = parseInt(argv[++i], 10) || 7;
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--post-id':
        args.postId = argv[++i];
        break;
      default:
        break;
    }
  }
  if (!args.output) {
    args.output = path.join(PROJECT_ROOT, 'outputs', 'facebook_engagement_report.md');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Schedule parser — compatible with facebook-poster.mjs parseScheduleText()
// Also extracts POST_GOAL and CONTACT for forward compatibility (Sessions 1/2)
// ---------------------------------------------------------------------------
function stripMd(str) {
  return (str || '').replace(/\*\*/g, '').trim();
}

function parseScheduleText(text) {
  const blocks = text.split(/\n\s*---\s*\n/).filter(b => b.includes('DAY:'));
  return blocks.map(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\s*(.*?)\\s*$`, 'm'));
      return m ? stripMd(m[1]) : '';
    };
    return {
      day: parseInt(get('DAY')) || 0,
      date: get('DATE'),
      type: get('TYPE').toLowerCase(),
      service: get('SERVICE'),
      postGoal: get('POST_GOAL') || get('POST_GOAL'), // forward compat
      hook: get('HOOK'),
      body: get('BODY'),
      cta: get('CTA'),
      contact: get('CONTACT'),
      hashtags: get('HASHTAGS'),
      status: get('STATUS'),
    };
  }).filter(p => p.day > 0).sort((a, b) => a.day - b.day);
}

function readSchedule() {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    hopLog('schedule', 'warn', `Schedule file not found: ${SCHEDULE_FILE}`);
    return [];
  }
  try {
    return parseScheduleText(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (e) {
    hopLog('schedule', 'error', `Failed to parse schedule: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// CTA classification
// ---------------------------------------------------------------------------
function classifyCta(ctaText) {
  if (!ctaText) return 'none';
  const lower = ctaText.toLowerCase();
  if (/\b(save|bookmark)\b/i.test(lower)) return 'save';
  if (/\b(tag|@)\b/i.test(lower)) return 'tag';
  if (/\b(share|send this|forward)\b/i.test(lower)) return 'share';
  if (/\b(vote|poll|this or that|which would you|👇|👍)\b/i.test(lower)) return 'vote';
  if (/\b(comment|tell us|drop a|what.*you|weirdest|ask us)\b/i.test(lower)) return 'comment';
  if (/\b(call|phone|\(\d{3}\)|dm us)\b/i.test(lower)) return 'call';
  if (/\b(dm|message)\b/i.test(lower) && !/\b(call|phone)\b/i.test(lower)) return 'dm';
  return 'other';
}

function describeCta(ctaType) {
  const labels = {
    save: 'Save',
    tag: 'Tag',
    share: 'Share',
    vote: 'Vote/Poll',
    comment: 'Comment',
    call: 'Phone CTA',
    dm: 'DM',
    none: 'None',
    other: 'Other',
  };
  return labels[ctaType] || 'Other';
}

// ---------------------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------------------
async function graphGet(node, params = {}) {
  const url = new URL(`${GRAPH_BASE}/${String(node).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries({ ...params, access_token: FB_PAGE_ACCESS_TOKEN })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const err = payload.error || {};
    throw new Error(`Graph API /${node} failed${err.code ? ` (#${err.code})` : ''}: ${err.message || response.statusText}`);
  }
  return payload;
}

function daysAgoISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function insightNumeric(insights, metricName) {
  const entry = (insights || []).find(e => e.name === metricName);
  if (!entry || !entry.values || !entry.values.length) return 0;
  const val = entry.values[0].value;
  if (typeof val === 'number') return val;
  // Some metrics return objects like {like: 5, love: 2, ...}
  if (val && typeof val === 'object') {
    return Object.values(val).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Fetch post insights — one metric per call (proven pattern from lib/facebook-insights.mjs)
// Combining metrics in a comma-separated query can trigger "valid insights metric" errors.
// ---------------------------------------------------------------------------
// Metrics proven to work at the post level (matching lib/facebook-insights.mjs).
// Page-level metrics like post_impressions/post_engaged_users are NOT available
// on the /{post-id}/insights endpoint — they're only available at the page level.
const INSIGHT_METRICS = [
  'post_activity_by_action_type',
  'post_clicks',
  'post_clicks_by_type',
  'post_impressions',          // best-effort: requires page data threshold
  'post_media_view',
  'post_reactions_by_type_total',
  'post_video_views',
];

async function fetchPostInsights(postId) {
  const results = await Promise.all(INSIGHT_METRICS.map(async (metric) => {
    try {
      const data = await graphGet(`${postId}/insights`, { metric, period: 'lifetime' });
      return (data.data || []).map(e => ({ ...e, _metric: metric }));
    } catch (e) {
      hopLog('graph', 'debug', `Metric ${metric} unavailable for post ${postId}: ${e.message}`);
      return [{ name: metric, values: [], unavailable: e.message }];
    }
  }));
  return results.flat();
}

// ---------------------------------------------------------------------------
// Fetch page posts and their insights
// ---------------------------------------------------------------------------
async function fetchPagePosts(days) {
  const since = daysAgoISO(days);
  hopLog('graph', 'info', `Fetching page posts since ${since} (${days} days)`);

  const feed = await graphGet(`${FB_PAGE_ID}/posts`, {
    fields: 'id,message,created_time,permalink_url,attachments{media_type,type},comments.limit(0).summary(true),reactions.limit(0).summary(true),shares',
    limit: 25,
  });

  const posts = [];
  for (const post of feed.data || []) {
    // Filter by date window
    if (post.created_time && post.created_time < since) continue;

    // Fetch insights for this post (one metric per call)
    const insights = await fetchPostInsights(post.id);

    const attachment = post.attachments?.data?.[0] || {};
    const mediaType = attachment.media_type || attachment.type || 'text';
    const comments = Number(post.comments?.summary?.total_count || 0);
    const reactions = insightNumeric(insights, 'post_reactions_by_type_total');
    const clicks = insightNumeric(insights, 'post_clicks');
    const impressions = insightNumeric(insights, 'post_impressions');
    const mediaViews = insightNumeric(insights, 'post_media_view');
    const videoViews = insightNumeric(insights, 'post_video_views');
    const shares = Number(post.shares?.count || 0);

    const engagement = reactions + comments + shares;
    const engagementRate = impressions > 0 ? Number(((engagement / impressions) * 100).toFixed(2)) : null;

    posts.push({
      id: post.id,
      created_time: post.created_time,
      permalink_url: post.permalink_url || null,
      message: post.message || '',
      type: mediaType,
      impressions,
      reactions,
      comments,
      shares,
      clicks,
      mediaViews,
      videoViews,
      engagement,
      engagementRate,
      hasImpressions: impressions > 0,
      insights,
      postUrl: post.permalink_url || null,
    });
  }

  hopLog('graph', 'info', `Fetched ${posts.length} posts in date window`);
  return posts;
}

// ---------------------------------------------------------------------------
// Cross-reference posts with schedule
// ---------------------------------------------------------------------------
function matchPostToSchedule(post, schedule) {
  // Try exact date match first
  const postDate = post.created_time ? post.created_time.slice(0, 10) : '';
  const byDate = schedule.find(s => s.date === postDate);
  if (byDate) return byDate;

  // Fallback: match by service keywords in post message
  for (const s of schedule) {
    if (!s.service) continue;
    const svcLower = s.service.toLowerCase();
    const keywords = svcLower.split(/[\s/]+/).filter(k => k.length > 2);
    if (keywords.some(k => post.message.toLowerCase().includes(k))) return s;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
function generateReport(posts, schedule, dryRun) {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = daysAgoISO(Math.max(7, posts.length ? 7 : 7));
  const lines = [];

  lines.push(`# Facebook Engagement Report — Week of ${today}`);
  lines.push('');

  // Fresh start / no data fallback
  if (!posts.length && !dryRun) {
    lines.push('**Status:** No engagement data available yet — this is expected for the first week of the new strategy.');
    lines.push('Recommendations below are based on research best practices, not live data.');
    lines.push('');
    lines.push('## Recommendations for Next Week');
    lines.push('- Double down on: educational and before/after content (highest organic reach potential)');
    lines.push('- Drop: uniform phone-number CTA format (suppressed by Facebook algorithm)');
    lines.push('- Test: engagement CTAs — "Save this", "Tag a friend", "Drop a 👍"');
    return lines.join('\n');
  }

  if (dryRun) {
    lines.push('**Status:** Dry run — no live data fetched. This report uses mock data for pipeline validation.');
    lines.push('');
    // Generate mock data for dry-run validation
    posts = generateMockPosts(schedule);
  }

  // Enrich posts with schedule data (goal, cta type)
  const enriched = posts.map(post => {
    const scheduled = matchPostToSchedule(post, schedule);
    const ctaType = scheduled ? classifyCta(scheduled.cta) : 'unknown';
    const goal = scheduled?.postGoal || scheduled?.service || 'unknown';
    return { ...post, ctaType, goal, scheduleMatch: scheduled };
  });

  // Sort by engagement rate descending
  enriched.sort((a, b) => b.engagementRate - a.engagementRate);

  // ── Top Performing Posts ──
  lines.push('## Top Performing Posts');
  lines.push('');
  lines.push('| Rank | Day | Type | Goal | CTA | Impressions | Engagement | Rate |');
  lines.push('|------|-----|------|------|-----|-------------|------------|------|');

  enriched.forEach((p, i) => {
    const day = p.scheduleMatch?.day || '-';
    const type = p.type || 'unknown';
    const goal = p.goal || 'unknown';
    const cta = describeCta(p.ctaType);
    const impDisplay = p.hasImpressions ? p.impressions.toLocaleString() : '—';
    const rateDisplay = p.engagementRate !== null ? `${p.engagementRate}%` : '—';
    lines.push(`| ${i + 1} | ${day} | ${type} | ${goal} | ${cta} | ${impDisplay} | ${p.engagement.toLocaleString()} | ${rateDisplay} |`);
  });
  lines.push('');

  // ── Content Type Performance ──
  lines.push('## Content Type Performance');
  lines.push('');

  const byType = new Map();
  for (const p of enriched) {
    const key = p.type || 'unknown';
    if (!byType.has(key)) byType.set(key, { posts: 0, totalRate: 0, rates: 0, bestDay: null, bestRate: -1 });
    const bucket = byType.get(key);
    bucket.posts++;
    if (p.engagementRate !== null) {
      bucket.totalRate += p.engagementRate;
      bucket.rates++;
    }
    if (p.engagementRate !== null && p.engagementRate > bucket.bestRate) {
      bucket.bestRate = p.engagementRate;
      bucket.bestDay = p.scheduleMatch?.day || null;
    }
  }

  lines.push('| Type | Avg Engagement Rate | Best Day | Posts |');
  lines.push('|------|---------------------|----------|-------|');
  for (const [type, stats] of [...byType.entries()].sort((a, b) => {
    const aAvg = a[1].rates > 0 ? a[1].totalRate / a[1].rates : -1;
    const bAvg = b[1].rates > 0 ? b[1].totalRate / b[1].rates : -1;
    return bAvg - aAvg;
  })) {
    const avg = stats.rates > 0 ? (stats.totalRate / stats.rates).toFixed(2) : '—';
    lines.push(`| ${type} | ${avg === '—' ? '—' : avg + '%'} | Day ${stats.bestDay || '-'} | ${stats.posts} |`);
  }
  lines.push('');

  // ── CTA Performance ──
  lines.push('## CTA Performance');
  lines.push('');

  const byCta = new Map();
  for (const p of enriched) {
    const key = p.ctaType || 'unknown';
    if (!byCta.has(key)) byCta.set(key, { posts: 0, totalComments: 0, totalShares: 0 });
    const bucket = byCta.get(key);
    bucket.posts++;
    bucket.totalComments += p.comments;
    bucket.totalShares += p.shares;
  }

  lines.push('| CTA Type | Avg Comments | Avg Shares | Posts |');
  lines.push('|----------|-------------|------------|-------|');
  for (const [cta, stats] of [...byCta.entries()].sort((a, b) => b[1].totalComments + b[1].totalShares - (a[1].totalComments + a[1].totalShares))) {
    const avgComments = stats.posts > 0 ? (stats.totalComments / stats.posts).toFixed(1) : '0.0';
    const avgShares = stats.posts > 0 ? (stats.totalShares / stats.posts).toFixed(1) : '0.0';
    lines.push(`| ${describeCta(cta)} | ${avgComments} | ${avgShares} | ${stats.posts} |`);
  }
  lines.push('');

  // ── Recommendations ──
  lines.push('## Recommendations for Next Week');
  lines.push('');

  // Find best content type
  let bestType = null;
  let bestTypeRate = -1;
  let worstType = null;
  let worstTypeRate = Infinity;
  for (const [type, stats] of byType) {
    const avg = stats.rates > 0 ? stats.totalRate / stats.rates : -1;
    if (avg > bestTypeRate) { bestTypeRate = avg; bestType = type; }
    if (stats.rates > 0 && avg < worstTypeRate && avg >= 0) { worstTypeRate = avg; worstType = type; }
  }

  // Find best CTA
  let bestCta = null;
  let bestCtaScore = 0;
  let worstCta = null;
  let worstCtaScore = Infinity;
  for (const [cta, stats] of byCta) {
    const score = stats.posts > 0 ? (stats.totalComments + stats.totalShares) / stats.posts : 0;
    if (score > bestCtaScore) { bestCtaScore = score; bestCta = cta; }
    if (score < worstCtaScore) { worstCtaScore = score; worstCta = cta; }
  }

  if (bestType) {
    lines.push(`- **Double down on:** ${bestType} posts (avg ${bestTypeRate.toFixed(2)}% engagement rate)`);
  }
  if (worstType && worstType !== bestType) {
    lines.push(`- **Drop:** ${worstType} format — lowest engagement at ${worstTypeRate.toFixed(2)}%`);
  }
  if (bestCta && bestCta !== 'unknown') {
    lines.push(`- **Best CTA:** ${describeCta(bestCta)} drove the most comments and shares`);
  }
  if (bestType === 'video') {
    lines.push('- **Test:** Shorter Reels (15-25s) with text overlays for sound-off viewers');
  } else {
    lines.push('- **Test:** Try a video Reel format — Facebook algorithm currently favors video content');
  }
  lines.push('- **Test:** Interactive post format — poll or "this or that" to drive comments');
  lines.push(`- **Review:** Match post timing to audience peak (check Page Insights for optimal posting hours)`);

  return lines.join('\n');
}

function generateMockPosts(schedule) {
  // Generate plausible mock data when --dry-run is used
  const mockPosts = [];
  const types = ['video', 'photo', 'text', 'photo', 'video', 'text', 'video'];
  for (const s of schedule) {
    const type = types[(s.day - 1) % types.length] || 'text';
    const impressions = Math.floor(Math.random() * 500) + 50;
    const reactions = Math.floor(impressions * (Math.random() * 0.05 + 0.01));
    const comments = Math.floor(Math.random() * 5);
    const shares = Math.floor(Math.random() * 3);
    const engagement = reactions + comments + shares;
    mockPosts.push({
      id: `mock_${s.day}_${Date.now()}`,
      created_time: s.date ? `${s.date}T12:00:00+0000` : new Date().toISOString(),
      permalink_url: `https://facebook.com/mock/${s.day}`,
      message: s.hook ? `${s.hook}\n\n${s.body || ''}`.slice(0, 200) : `Mock post day ${s.day}`,
      type,
      impressions,
      reactions,
      comments,
      shares,
      clicks: Math.floor(impressions * 0.03),
      mediaViews: Math.floor(impressions * 0.5),
      videoViews: type === 'video' ? Math.floor(impressions * 0.3) : 0,
      engagement,
      engagementRate: Number(((engagement / impressions) * 100).toFixed(2)),
      hasImpressions: true,
      insights: [],
      postUrl: `https://facebook.com/mock/${s.day}`,
    });
  }
  return mockPosts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  hopLog('startup', 'info', `facebook-insights-collector starting`, {
    days: args.days,
    output: args.output,
    dryRun: args.dryRun,
    postId: args.postId,
  });

  // Read schedule for cross-referencing
  const schedule = readSchedule();
  hopLog('schedule', 'info', `Parsed ${schedule.length} posts from schedule`);

  // Single post mode
  if (args.postId) {
    hopLog('graph', 'info', `Fetching single post: ${args.postId}`);
    try {
      const post = await graphGet(args.postId, {
        fields: 'id,message,created_time,permalink_url,attachments{media_type,type},comments.limit(0).summary(true),reactions.limit(0).summary(true),shares',
      });
      const insights = await fetchPostInsights(args.postId);
      const attachment = post.attachments?.data?.[0] || {};
      const comments = Number(post.comments?.summary?.total_count || 0);
      const reactions = insightNumeric(insights, 'post_reactions_by_type_total');
      const clicks = insightNumeric(insights, 'post_clicks');
      const impressions = insightNumeric(insights, 'post_impressions');
      const mediaViews = insightNumeric(insights, 'post_media_view');
      console.log(JSON.stringify({
        id: post.id,
        created_time: post.created_time,
        type: attachment.media_type || attachment.type || 'text',
        impressions: impressions || null,
        reactions,
        comments,
        shares: Number(post.shares?.count || 0),
        clicks,
        mediaViews,
        engagement: reactions + comments + Number(post.shares?.count || 0),
      }, null, 2));
      return;
    } catch (e) {
      hopLog('graph', 'error', `Single post fetch failed: ${e.message}`);
      process.exit(1);
    }
  }

  // Dry run — skip Graph API, generate mock report
  if (args.dryRun) {
    hopLog('startup', 'info', 'Dry-run mode — generating mock report (no API calls)');
    const report = generateReport([], schedule, true);
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, 'utf8');
    hopLog('output', 'info', `Report written to ${outPath} (${report.length} chars)`);
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', output: outPath, posts: schedule.length }));
    return;
  }

  // Validate credentials
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    hopLog('startup', 'warn', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN not set — generating fallback report');
    const report = generateReport([], schedule, false);
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, 'utf8');
    hopLog('output', 'info', `Fallback report written to ${outPath} (${report.length} chars)`);
    console.log(JSON.stringify({ ok: true, mode: 'fallback', output: outPath, reason: 'missing credentials' }));
    return;
  }

  // Live mode — fetch from Graph API
  let posts = [];
  try {
    posts = await fetchPagePosts(args.days);
  } catch (e) {
    hopLog('graph', 'error', `Failed to fetch page posts: ${e.message}`);
    // Produce fallback report on API failure
    const report = generateReport([], schedule, false);
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, 'utf8');
    hopLog('output', 'info', `Fallback report written to ${outPath} after API error`);
    console.log(JSON.stringify({ ok: false, mode: 'fallback', output: outPath, error: e.message }));
    return;
  }

  // Generate report
  const report = generateReport(posts, schedule, false);
  const outPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report, 'utf8');
  hopLog('output', 'info', `Report written to ${outPath} (${report.length} chars, ${posts.length} posts analyzed)`);
  console.log(JSON.stringify({ ok: true, mode: 'live', output: outPath, postsAnalyzed: posts.length }));
}

main().catch(e => {
  hopLog('fatal', 'error', `Unhandled error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
