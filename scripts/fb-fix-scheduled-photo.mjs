#!/usr/bin/env node
/**
 * fb-fix-scheduled-photo.mjs
 * One-off recovery: replace the photo on an already-scheduled Facebook post.
 *
 * WHY
 *   The Graph API has no "swap photo" operation on an existing post. The only
 *   way to fix a scheduled FB photo post with the wrong image is delete + re-
 *   create. This script does that while preserving the original
 *   scheduled_publish_time and caption, so the post still goes out at the same
 *   moment, just with the corrected photo.
 *
 * SAFETY
 *   Order is CREATE-new → DELETE-old, never the reverse. If creation fails the
 *   original scheduled post is untouched (no gap). If deletion fails after a
 *   successful create you get a visible duplicate — easily fixed manually.
 *
 * USAGE
 *   node scripts/fb-fix-scheduled-photo.mjs --day 5 --day 6            # live
 *   node scripts/fb-fix-scheduled-photo.mjs --day 5 --day 6 --dry-run  # preview only
 *
 *   Looks up each day's date, caption, and corrected PHOTO_FILE in
 *   outputs/facebook_posting_schedule.md (run gbp-photo-pick + fb-photo-rewrite
 *   first), reads the old platform_post_id from Supabase weekly_posts, fetches
 *   its scheduled_publish_time, then creates a replacement and deletes the old.
 *
 *   To target a post not in Supabase, pass --id <fb_post_id> --photo <path>
 *   --caption <text> [--schedule-unix <unix>] directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScheduleText, buildCaption } from './facebook-poster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// .env loader — same pattern as facebook-poster.mjs.
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const days = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--day') days.push(parseInt(args[++i]));
}

function hopLog(level, message, extra) {
  const rec = { ts: new Date().toISOString(), source: 'fb-fix-scheduled-photo', level, message, ...extra };
  console.error(`[fb-fix-scheduled-photo][${level}] ${message}`);
  if (Object.keys(extra || {}).length) console.error(`  ↳ ${JSON.stringify(extra)}`);
}

// ── Graph primitives (subset of facebook-poster.mjs, no token retry needed) ──

async function graphGet(postId, fields) {
  const fullId = postId.includes('_') ? postId : `${FB_PAGE_ID}_${postId}`;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fullId}`
    + `?fields=${fields}&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Graph GET ${postId}: ${json.error.message}`);
  return json;
}

async function graphDelete(postId) {
  const fullId = postId.includes('_') ? postId : `${FB_PAGE_ID}_${postId}`;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fullId}?access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url, { method: 'DELETE' });
  const json = await res.json();
  if (json.error) throw new Error(`Graph DELETE ${postId}: ${json.error.message}`);
  return json.success === true;
}

async function graphCreateScheduledPhoto(photoPath, caption, scheduleUnix) {
  const form = new FormData();
  form.append('caption', caption);
  form.append('access_token', FB_PAGE_ACCESS_TOKEN);
  form.append('source', new Blob([fs.readFileSync(photoPath)]), path.basename(photoPath));
  form.append('published', 'false');
  form.append('scheduled_publish_time', String(scheduleUnix));
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/photos`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(`Graph POST photo: ${json.error.message}`);
  if (!json.id) throw new Error(`Photo post returned no id: ${JSON.stringify(json)}`);
  return json.id;
}

// ── Supabase lookup (post_id for a given day) ───────────────────────────────

async function lookupSupabasePostId(day) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/weekly_posts?select=platform_post_id,post_date`
    + `&platform=eq.facebook&status=in.(posted,scheduled)&day=eq.${day}&post_date=gte.2026-07-01`
    + `&order=created_at.desc&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) { hopLog('warn', `Supabase lookup for day ${day} returned ${res.status}`); return null; }
    const rows = await res.json();
    const pid = rows?.[0]?.platform_post_id;
    return pid || null;
  } catch (e) {
    hopLog('warn', `Supabase lookup failed for day ${day}: ${e.message}`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function fixDay(day) {
  // 1. Read schedule to get date, service, photo_file, caption
  const scheduleText = fs.readFileSync(SCHEDULE_FILE, 'utf8');
  const posts = parseScheduleText(scheduleText);
  const post = posts.find(p => p.day === day);
  if (!post) throw new Error(`Day ${day} not found in ${SCHEDULE_FILE}`);
  if (post.type !== 'photo') throw new Error(`Day ${day} is type=${post.type}, expected photo`);
  if (!post.photo_file) throw new Error(`Day ${day} has no PHOTO_FILE — run fb-photo-rewrite first`);

  const photoPath = path.isAbsolute(post.photo_file) ? post.photo_file : null;
  if (!photoPath || !fs.existsSync(photoPath)) {
    throw new Error(`Day ${day} photo not found: ${post.photo_file}`);
  }

  const caption = buildCaption(post);

  // 2. Look up the old FB post id
  const oldPostId = await lookupSupabasePostId(day);
  if (!oldPostId) throw new Error(`Day ${day}: no platform_post_id in Supabase — pass --id to target manually`);

  // 3. Fetch the old post's scheduled_publish_time
  const oldPost = await graphGet(oldPostId, 'id,scheduled_publish_time,is_published');
  if (oldPost.is_published) {
    throw new Error(`Day ${day}: post ${oldPostId} is already published — cannot swap photo, aborting`);
  }
  const scheduleUnix = oldPost.scheduled_publish_time;
  if (!scheduleUnix) throw new Error(`Day ${day}: post ${oldPostId} has no scheduled_publish_time`);
  const scheduleUTC = new Date(scheduleUnix * 1000).toISOString();

  hopLog('info', `Day ${day} [${post.service}]`, {
    oldPostId,
    scheduleUTC,
    photo: path.basename(photoPath),
    captionPreview: caption.slice(0, 60) + '...',
  });

  if (dryRun) {
    console.log(`  DRY RUN: would create new photo post → then delete ${oldPostId}`);
    return { day, status: 'dry_run', oldPostId, scheduleUTC, photo: photoPath };
  }

  // 4. CREATE new (so a creation failure leaves the original intact)
  const newId = await graphCreateScheduledPhoto(photoPath, caption, scheduleUnix);
  hopLog('info', `Day ${day}: created replacement post ${newId}`);

  // 5. DELETE old
  const deleted = await graphDelete(oldPostId);
  hopLog(deleted ? 'info' : 'warn', `Day ${day}: delete old ${oldPostId} → ${deleted ? 'success' : 'FAILED (manual cleanup needed — duplicate scheduled post)'}`);

  return { day, status: 'fixed', oldPostId, newPostId: newId, scheduleUTC, photo: photoPath, deleted };
}

async function main() {
  if (!days.length) {
    console.error('Usage: node scripts/fb-fix-scheduled-photo.mjs --day 5 [--day 6] [--dry-run]');
    process.exit(1);
  }
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    console.error('FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN must be set in .env');
    process.exit(1);
  }

  console.log(`\n=== FB Scheduled Photo Fix ${dryRun ? '(DRY RUN)' : ''} ===`);
  const results = [];
  for (const day of days) {
    try { results.push(await fixDay(day)); }
    catch (e) {
      hopLog('error', `Day ${day} failed: ${e.message}`);
      results.push({ day, status: 'error', error: e.message });
    }
  }

  console.log('\n=== Result ===');
  console.log(JSON.stringify(results, null, 2));

  // Print new IDs clearly for the Supabase update step
  const fixed = results.filter(r => r.status === 'fixed');
  if (fixed.length) {
    console.log('\nNew post IDs (update Supabase weekly_posts.platform_post_id):');
    for (const r of fixed) console.log(`  Day ${r.day}: ${r.newPostId} (was ${r.oldPostId})`);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
