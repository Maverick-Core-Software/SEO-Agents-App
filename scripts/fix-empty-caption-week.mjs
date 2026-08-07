#!/usr/bin/env node
// scripts/fix-empty-caption-week.mjs
//
// One-shot remediation for the 2026-08-07 empty-caption incident (run
// 85b2df56, week_of 2026-08-10).
//
// What happened: the crew's new schedule format puts a `---` separator INSIDE
// each day block, so supabase-sync and facebook-poster (which both split
// blocks on `---`) parsed every FB post with empty hook/body. The run was
// approved at 15:27 UTC and executed at 15:29 UTC — day 1 published a video
// with an EMPTY caption, days 3/5/6 were scheduled on FB with empty captions.
// A re-sync with the fixed parser then re-inserted 4 FB + 7 GBP rows as
// pending_approval duplicates and flipped the run back to pending_approval.
//
// Update 8/07 ~16:00 UTC: TWO videos hit the page today — last week's day-5
// (correctly scheduled for 8/07) plus this run's captionless day-1. Carter
// hand-edited the captionless day-1 video as damage control; the original
// Graph id 1590941259226139 is no longer API-accessible (FB re-created the
// object on edit), so day 1 is SKIPPED on the FB side — his edit stands.
// Its DB row still gets its content restored for the dashboard record.
//
// This script:
//   1. Writes the real captions onto the surviving FB objects in place:
//        day 3  photo 1029019496584612  (scheduled)  -> name
//        day 5  video 1024220060519599  (scheduled)  -> description
//        day 6  photo 1029019729917922  (scheduled)  -> name
//   2. Copies the real hook/body/cta/hashtags/photo_file onto the executed
//      weekly_posts rows so the MCC dashboard shows real content.
//   3. Deletes the 11 duplicate pending_approval rows (4 FB + 7 GBP) created
//      by the 15:37 UTC re-sync. DO NOT approve these in MCC — approving them
//      would double-post the week.
//   4. Restores seo_runs.status to 'done' (the bridge set it at 15:29; the
//      re-sync upsert flipped it back to pending_approval).
//
// Run:  node scripts/fix-empty-caption-week.mjs
// Everything is verified by re-reading after each write.

import { readFileSync } from 'fs';
import { parseScheduleText, buildCaption } from './facebook-poster.mjs';

const RUN = '85b2df56-77bd-4ddc-bf8a-167df5b132dd';
// Day 1's video was manually removed from FB by Carter — no FB edit for it.
const FB_IDS = { 3: '1029019496584612', 5: '1024220060519599', 6: '1029019729917922' };
// Videos take `description`, photos take `name` — same field the caption
// would have been created with.
const CAPTION_FIELD = { 3: 'name', 5: 'description', 6: 'name' };
const CAPTION_READ = { description: 'description', name: 'name' };

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
);
const SB = env.SUPABASE_URL;
const SB_H = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const FB_TOKEN = env.FB_PAGE_ACCESS_TOKEN;

const schedulePath = new URL('../outputs/facebook_posting_schedule.md', import.meta.url);
const posts = parseScheduleText(readFileSync(schedulePath, 'utf8'));
if (posts.length !== 4 || posts.some(p => !p.hook || !p.body)) {
  console.error('Refusing to run: parsed schedule does not have 4 posts with full content.');
  process.exit(1);
}

let failures = 0;

// ── 1. Fix captions on Facebook, in place ────────────────────────────
for (const p of posts) {
  if (!FB_IDS[p.day]) { console.log(`day ${p.day}: skipped on FB (Carter hand-edited this post — leaving it alone)`); continue; }
  const id = FB_IDS[p.day];
  const field = CAPTION_FIELD[p.day];
  const caption = buildCaption(p);
  const res = await fetch(`https://graph.facebook.com/v21.0/${id}`, {
    method: 'POST',
    body: new URLSearchParams({ [field]: caption, access_token: FB_TOKEN }),
  });
  const j = await res.json();
  if (j.error) {
    failures++;
    console.error(`day ${p.day}: FB edit FAILED — ${j.error.message} (code ${j.error.code})`);
    continue;
  }
  // Verify by reading the caption back.
  const check = await (await fetch(`https://graph.facebook.com/v21.0/${id}?fields=${CAPTION_READ[field]}&access_token=${FB_TOKEN}`)).json();
  const now = (check[field] || '').slice(0, 60);
  const ok = (check[field] || '').startsWith(p.hook.slice(0, 30));
  if (!ok) failures++;
  console.log(`day ${p.day}: FB caption ${ok ? 'FIXED' : 'MISMATCH after edit'} — "${now}..."`);
}

// ── 2. Restore real content onto the executed weekly_posts rows ──────
for (const p of posts) {
  const patch = {
    hook: p.hook, body: p.body, cta: p.cta,
    hashtags: p.hashtags || null,
    photo_file: p.photo_file || null,
    video_prompt: p.video_prompt || null,
  };
  const r = await fetch(`${SB}/rest/v1/weekly_posts?run_id=eq.${RUN}&platform=eq.facebook&day=eq.${p.day}&status=neq.pending_approval`, {
    method: 'PATCH', headers: { ...SB_H, Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== 1) { failures++; console.error(`day ${p.day}: DB content restore hit ${Array.isArray(rows) ? rows.length : 0} rows (expected 1)`); }
  else console.log(`day ${p.day}: DB row content restored (status=${rows[0].status}, hook_len=${(rows[0].hook || '').length})`);
}

// ── 3. Delete the duplicate pending rows from the re-sync ────────────
const del = await fetch(`${SB}/rest/v1/weekly_posts?run_id=eq.${RUN}&status=eq.pending_approval`, {
  method: 'DELETE', headers: { ...SB_H, Prefer: 'return=representation' },
});
const deleted = await del.json();
console.log(`deleted ${Array.isArray(deleted) ? deleted.length : 0} duplicate pending rows: ${Array.isArray(deleted) ? deleted.map(d => `${d.platform}:${d.day}`).join(', ') : deleted?.message}`);
if (!Array.isArray(deleted) || deleted.length !== 11) console.warn('  (expected 11 — 4 FB + 7 GBP — verify in MCC)');

// ── 4. Restore run status ────────────────────────────────────────────
const rr = await fetch(`${SB}/rest/v1/seo_runs?id=eq.${RUN}`, {
  method: 'PATCH', headers: { ...SB_H, Prefer: 'return=representation' }, body: JSON.stringify({ status: 'done' }),
});
const run = await rr.json();
console.log(`run status: ${run[0]?.status} (done_at ${run[0]?.done_at})`);

console.log(failures ? `\nDONE WITH ${failures} FAILURE(S) — review above.` : '\nAll clean.');
process.exit(failures ? 1 : 0);
