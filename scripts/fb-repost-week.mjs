#!/usr/bin/env node
/**
 * fb-repost-week.mjs
 *
 * Replace a week's already-scheduled Facebook posts with freshly-picked photos.
 *
 * Use when posts are scheduled but wrong (bad photo match) and have NOT yet
 * published. Unpublished scheduled posts can be deleted and recreated; published
 * ones cannot, so this refuses to touch anything already live.
 *
 * Order of operations:
 *   1. Read the run's facebook rows from Supabase.
 *   2. Verify each post is still unpublished on Facebook. Abort on any that are
 *      published or already past their scheduled time.
 *   3. DELETE each scheduled post via the Graph API.
 *   4. Clear platform_post_id and set status back to 'approved'.
 *   5. Run facebook-poster.mjs --schedule-all, which reads the (already
 *      photo-corrected) schedule file and creates new scheduled posts.
 *   6. Reconcile the new post ids back into Supabase, same mapping mav-bridge uses.
 *
 * This does NOT touch the run status, so mav-bridge will not re-run GBP or the
 * website tasks.
 *
 * USAGE
 *   node scripts/fb-repost-week.mjs --run-id <uuid> --dry-run   Inspect only.
 *   node scripts/fb-repost-week.mjs --run-id <uuid> --confirm   Actually do it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

for (const line of fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : null;
}
const runId = argValue('--run-id');
const dryRun = process.argv.includes('--dry-run');
const confirmed = process.argv.includes('--confirm');
const postTime = argValue('--time') || '09:00';

if (!runId) { console.error('usage: fb-repost-week.mjs --run-id <uuid> [--dry-run|--confirm]'); process.exit(2); }
if (!dryRun && !confirmed) { console.error('Refusing to run: pass --dry-run to inspect or --confirm to proceed.'); process.exit(2); }

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
if (!TOKEN) { console.error('FB_PAGE_ACCESS_TOKEN missing'); process.exit(1); }

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// facebook-poster stores a bare photo id for single-photo/slideshow days, but the
// addressable scheduled post is <page_id>_<photo_id>. Normalize before any read or
// delete, otherwise Graph reports "nonexisting field" on a perfectly valid post.
const PAGE_ID = process.env.FB_PAGE_ID;
function fullPostId(id) {
  return String(id).includes('_') ? String(id) : `${PAGE_ID}_${id}`;
}

async function graph(id, params = '') {
  const r = await fetch(`${GRAPH}/${id}?access_token=${encodeURIComponent(TOKEN)}${params}`);
  return r.json();
}

async function main() {
  const { data: posts, error } = await supabase
    .from('weekly_posts').select('*')
    .eq('run_id', runId).eq('platform', 'facebook').order('day');
  if (error) { console.error('Supabase:', error.message); process.exit(1); }
  if (!posts?.length) { console.error('No facebook rows for that run.'); process.exit(1); }

  console.log(`=== FB repost${dryRun ? ' (dry run)' : ''} — run ${runId.slice(0, 8)} ===\n`);

  const nowUnix = Math.floor(Date.now() / 1000);
  const targets = [];
  let blocked = 0;

  for (const p of posts) {
    if (!p.platform_post_id) { console.log(`  day ${p.day}: no platform_post_id — nothing to delete`); continue; }
    const postId = fullPostId(p.platform_post_id);
    const info = await graph(postId, '&fields=id,created_time,scheduled_publish_time');
    if (info.error) {
      console.log(`  day ${p.day}: ${postId} — Graph error: ${info.error.message.slice(0, 70)}`);
      blocked++;
      continue;
    }
    const sched = info.scheduled_publish_time;
    if (sched && sched < nowUnix) {
      console.log(`  day ${p.day}: scheduled time already passed — LIVE, refusing to touch`);
      blocked++;
      continue;
    }
    const when = sched ? new Date(sched * 1000).toISOString() : '(no scheduled time reported)';
    console.log(`  day ${p.day}: ${postId} — scheduled ${when} — will replace`);
    targets.push({ ...p, fullId: postId });
  }

  if (blocked) {
    console.error(`\n${blocked} post(s) could not be safely replaced. Aborting so nothing is half-done.`);
    process.exit(1);
  }
  if (!targets.length) { console.log('\nNothing to replace.'); return; }

  if (dryRun) {
    console.log(`\n(dry run) would delete ${targets.length} scheduled post(s), then re-run facebook-poster --schedule-all --time ${postTime}.`);
    return;
  }

  for (const p of targets) {
    const r = await fetch(`${GRAPH}/${p.fullId}?access_token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.error) { console.error(`  day ${p.day}: DELETE failed — ${j.error.message}`); process.exit(1); }
    console.log(`  day ${p.day}: deleted ${p.fullId}`);
    await supabase.from('weekly_posts')
      .update({ status: 'approved', platform_post_id: null, posted_at: null, error: null })
      .eq('id', p.id);
  }

  console.log('\nRe-running facebook-poster...');
  const { stdout } = await execFileAsync('node',
    [path.join(PROJECT_ROOT, 'scripts', 'facebook-poster.mjs'), '--schedule-all', '--time', postTime],
    { cwd: PROJECT_ROOT, timeout: 45 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });

  let parsed;
  try { parsed = JSON.parse(stdout.trim()); } catch {
    console.error('Could not parse facebook-poster output. Rows left at approved — inspect before retrying.');
    console.error(stdout.slice(-1500));
    process.exit(1);
  }

  const dayMap = new Map((parsed.results || []).map((r) => [r.day, r]));
  for (const p of targets) {
    const r = dayMap.get(p.day);
    if (!r) { console.log(`  day ${p.day}: no result reported`); continue; }
    const status = r.status === 'posted' ? 'posted' : r.status === 'scheduled' ? 'scheduled' : 'error';
    await supabase.from('weekly_posts').update({
      status,
      platform_post_id: r.id || null,
      posted_at: new Date().toISOString(),
      error: r.status === 'error' ? (r.message || 'Unknown error') : null,
    }).eq('id', p.id);
    console.log(`  day ${p.day}: ${status} ${r.id || ''}`);
  }
  console.log('\nDone.');
}

await main();
