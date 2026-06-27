# Action Visibility, Alerting & Media-Pipeline Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every SEO action show description/priority/agent/status on both dashboards, alert (banner + iMessage) on failure or stall instead of failing silently, and fix the media pipeline so GBP posts carry photos and Facebook posts carry video (or a real photo fallback) instead of going out as plain text.

**Architecture:** The `mav-bridge.mjs` `/seo/actions` endpoint becomes the single enrichment + fault-detection point; both MCC pages are pure consumers of its enriched payload + shared `alerts[]`. Pure logic (field normalization, status bucketing, media-status, alert dedup) lives in small testable `scripts/lib/*.mjs` modules. iMessage delivery is a thin send-only script in `grizzly-hcp` that the bridge spawns, so Photon creds stay in one repo.

**Tech Stack:** Node.js (ESM `.mjs`), `@supabase/supabase-js`, React (JSX), `spectrum-ts` (Photon iMessage), Supabase Postgres. No test framework — checks are `node`-runnable `assert`-based `*.test.mjs` files (per repo convention; `package.json` has no scripts).

**Reference spec:** [docs/superpowers/specs/2026-06-26-action-visibility-alerting-media-design.md](../specs/2026-06-26-action-visibility-alerting-media-design.md)

---

## File Structure

**New files:**
- `scripts/lib/schedule-text.mjs` — `normalizePhotoFile()`, `cleanField()`. One source of truth for stripping `**`/backticks/`*(blank)*` out of schedule fields.
- `scripts/lib/schedule-text.test.mjs` — assert-based self-check.
- `scripts/lib/action-enrich.mjs` — `bucketStatus()`, `STUCK_THRESHOLDS`, `isStuck()`, `describeAction()`, `agentFor()`, `mediaStatusFor()`.
- `scripts/lib/action-enrich.test.mjs` — assert-based self-check.
- `scripts/lib/alert-store.mjs` — `shouldFire()`, `clearFault()` over `state/alerted.json`.
- `scripts/lib/alert-store.test.mjs` — assert-based self-check.
- `C:\Workspace\Active\grizzly-hcp\scripts\notify-imessage.ts` — send-only Photon helper.

**Modified files:**
- `scripts/supabase-sync.mjs` — use `normalizePhotoFile` when writing `photo_file`.
- `scripts/facebook-poster.mjs` — `normalizePhotoFile` in parse, video-day photo fallback, `graphDispatch` returns media used, `runWeek` reports `media` per result.
- `scripts/gbp-photo-pick.mjs` — `normalizePhotoFile` in parse.
- `scripts/mav-bridge.mjs` — enriched `/seo/actions`, stuck/failed detection + alerting in `poll()`, `media_status` writeback in FB phase.
- `supabase/schema.sql` — add `media_status` column (+ a migration applied to the live DB).
- `C:\Workspace\Active\MCC\src\pages\HomePage.jsx` — enriched action row, media indicator, 4-state badge, completed collapse, shared alerts banner.
- `C:\Workspace\Active\MCC\src\SEOApprovalPage.jsx` — same enriched row + shared alerts.
- `C:\Workspace\Active\grizzly-hcp\.env` — add `CARTER_PHONE`.

---

## Conventions for every task

- Run node checks with: `node scripts/lib/<name>.test.mjs` from `C:\Workspace\Active\SEO-Agents-App`. Exit 0 + printed `ok` = pass; any thrown assert = fail.
- Commit after each task. Keep commits scoped to the task's files.
- Do NOT restart PM2 services mid-plan unless a task says so. The final task covers restart + live verification.

---

# GROUP A — Media pipeline fixes

### Task 1: Shared schedule-field normalizer

**Files:**
- Create: `scripts/lib/schedule-text.mjs`
- Test: `scripts/lib/schedule-text.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/lib/schedule-text.test.mjs
import assert from 'node:assert/strict';
import { normalizePhotoFile, cleanField } from './schedule-text.mjs';

// backticks stripped
assert.equal(normalizePhotoFile('`2026-06-26-panel.JPG`'), '2026-06-26-panel.JPG');
// bold + backticks stripped
assert.equal(normalizePhotoFile('**`a.JPG`**'), 'a.JPG');
// blank sentinels => empty
assert.equal(normalizePhotoFile('*(blank)*'), '');
assert.equal(normalizePhotoFile('(blank)'), '');
assert.equal(normalizePhotoFile(''), '');
assert.equal(normalizePhotoFile(null), '');
// a stray VIDEO_PROMPT leak is not a filename => empty (no image extension)
assert.equal(normalizePhotoFile('VIDEO_PROMPT: a cinematic shot of sparks'), '');
// plain filename passes through
assert.equal(normalizePhotoFile('photo.png'), 'photo.png');
// absolute windows path preserved
assert.equal(normalizePhotoFile('`E:\\Media\\Grizzly\\Curated\\x.jpg`'), 'E:\\Media\\Grizzly\\Curated\\x.jpg');
// cleanField strips bold + backticks but keeps prose
assert.equal(cleanField('**Panel Upgrade**'), 'Panel Upgrade');
assert.equal(cleanField('`code`'), 'code');

console.log('ok schedule-text');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/schedule-text.test.mjs`
Expected: FAIL — `Cannot find module './schedule-text.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/schedule-text.mjs
// Single source of truth for cleaning schedule-block field values.
// The content agent emits markdown: **bold** and `code-ticks`. Older parsers
// only stripped ** which left literal backticks in photo_file, so posters looked
// for a file named `` `name.JPG` `` and silently fell back to text. Strip both.

const BLANK_RE = /^\*?\(?\s*blank\s*\)?\*?$/i; // matches (blank), *(blank)*, blank
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

export function cleanField(str) {
  return (str || '')
    .replace(/\*\*/g, '')   // bold
    .replace(/`/g, '')      // code ticks
    .trim();
}

export function normalizePhotoFile(raw) {
  const v = cleanField(raw);
  if (!v) return '';
  if (BLANK_RE.test(v)) return '';
  // Defensive: a leaked prompt or label is not a filename. Only accept values
  // that look like an image file (have a known image extension).
  if (!IMAGE_EXT_RE.test(v)) return '';
  return v;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/schedule-text.test.mjs`
Expected: PASS — prints `ok schedule-text`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/schedule-text.mjs scripts/lib/schedule-text.test.mjs
git commit -m "feat(media): shared schedule-field normalizer (strips backticks/blank)"
```

---

### Task 2: Use normalizer when writing photo_file to Supabase

This is the fix for garbage `photo_file` rows (Bug 3) — `supabase-sync.mjs` is what writes the column.

**Files:**
- Modify: `scripts/supabase-sync.mjs:60-119`

- [ ] **Step 1: Import the helper**

At the top of `scripts/supabase-sync.mjs`, after the existing imports, add:

```js
import { normalizePhotoFile } from './lib/schedule-text.mjs';
```

- [ ] **Step 2: Apply it in the Facebook parser**

In `parseFacebookSchedule`, change line 86 from:

```js
      photo_file: get('PHOTO_FILE') || null,
```

to:

```js
      photo_file: normalizePhotoFile(get('PHOTO_FILE')) || null,
```

- [ ] **Step 3: Apply it in the GBP parser**

In `parseGbpSchedule`, change line 115 from:

```js
      photo_file: get('PHOTO_FILE') || null,
```

to:

```js
      photo_file: normalizePhotoFile(get('PHOTO_FILE')) || null,
```

- [ ] **Step 4: Verify the module still parses**

Run: `node --check scripts/supabase-sync.mjs`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/supabase-sync.mjs
git commit -m "fix(media): normalize photo_file before writing to weekly_posts"
```

---

### Task 3: Use normalizer in the Facebook poster's schedule parse

**Files:**
- Modify: `scripts/facebook-poster.mjs:122-161`

- [ ] **Step 1: Import the helper**

Near the top of `scripts/facebook-poster.mjs` (with the other imports), add:

```js
import { normalizePhotoFile } from './lib/schedule-text.mjs';
```

- [ ] **Step 2: Normalize photo_file in `parseScheduleText`**

Change line 146 from:

```js
      photo_file: get('PHOTO_FILE'),
```

to:

```js
      photo_file: normalizePhotoFile(get('PHOTO_FILE')),
```

- [ ] **Step 3: Verify the module still parses**

Run: `node --check scripts/facebook-poster.mjs`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/facebook-poster.mjs
git commit -m "fix(media): normalize photo_file in facebook-poster parse"
```

---

### Task 4: Use normalizer in the GBP photo picker's schedule parse

**Files:**
- Modify: `scripts/gbp-photo-pick.mjs:79-100`

- [ ] **Step 1: Import the helper**

Near the top of `scripts/gbp-photo-pick.mjs` (with the other imports), add:

```js
import { normalizePhotoFile } from './lib/schedule-text.mjs';
```

- [ ] **Step 2: Normalize photo_file in `parseSchedule`**

Change line 99 from:

```js
      photo_file: get('PHOTO_FILE'),
```

to:

```js
      photo_file: normalizePhotoFile(get('PHOTO_FILE')),
```

- [ ] **Step 3: Verify the module still parses**

Run: `node --check scripts/gbp-photo-pick.mjs`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/gbp-photo-pick.mjs
git commit -m "fix(media): normalize photo_file in gbp-photo-pick parse"
```

---

### Task 5: Facebook video-day photo fallback (curated pool by date)

When a video day's Veo render fails (credits/error), the post must fall back to its
matched photo, not text. The GBP picker copies winners to the curated folder named
`${date}-${serviceSlug}.<ext>`, so the FB poster can resolve a same-date photo from
there. (Spec §6b, option b — no schedule-format change.)

**Files:**
- Modify: `scripts/facebook-poster.mjs:153-161` (`resolvePhotoPath`)

- [ ] **Step 1: Confirm the curated folder env name**

Run: `node -e "import('./scripts/facebook-poster.mjs').catch(()=>{}); console.log(process.env.GBP_CURATED_FOLDER, process.env.GBP_PHOTO_PATH)"`
Expected: prints whatever is set (may be `undefined undefined` in a bare shell — that's fine; the real values come from `.env` at runtime). The goal is to confirm the variable names. `gbp-photo-pick.mjs` writes to `GBP_CURATED_FOLDER` (default `E:\Media\Grizzly\Curated`).

- [ ] **Step 2: Add a curated-by-date fallback to `resolvePhotoPath`**

Replace the body of `resolvePhotoPath` (lines 153-161) with:

```js
const GBP_CURATED_FOLDER = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';

function curatedPhotoForDate(date) {
  // gbp-photo-pick copies winners as `${date}-${slug}.<ext>`. For a FB video day
  // whose video failed, reuse that same-day curated photo so we post an image,
  // not text. ponytail: first match by date prefix wins; ceiling = if multiple
  // services share a date the choice is arbitrary. Upgrade: match on service slug.
  if (!date) return null;
  try {
    const hit = fs.readdirSync(GBP_CURATED_FOLDER)
      .filter(f => f.startsWith(`${date}-`) && /\.(jpe?g|png|webp)$/i.test(f))
      .sort()[0];
    return hit ? path.join(GBP_CURATED_FOLDER, hit) : null;
  } catch { return null; }
}

function resolvePhotoPath(post) {
  const photoFile = post.photo_file || '';
  if (photoFile) {
    if (path.isAbsolute(photoFile)) { if (fs.existsSync(photoFile)) return photoFile; }
    else {
      const fromGbp = path.join(GBP_PHOTO_PATH, photoFile);
      if (fs.existsSync(fromGbp)) return fromGbp;
      const fromOutputs = path.join(PROJECT_ROOT, 'outputs', photoFile);
      if (fs.existsSync(fromOutputs)) return fromOutputs;
    }
  }
  // No usable explicit photo — try the same-date curated winner (video-day fallback).
  return curatedPhotoForDate(post.date);
}
```

- [ ] **Step 3: Verify the module still parses**

Run: `node --check scripts/facebook-poster.mjs`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/facebook-poster.mjs
git commit -m "fix(media): FB video-day falls back to same-date curated photo"
```

---

### Task 6: Report which media each Facebook post actually used

So the bridge can write a truthful `media_status`, `graphDispatch` returns what it
attached, and `runWeek` records it per result.

**Files:**
- Modify: `scripts/facebook-poster.mjs:337-353` (`graphDispatch`), `:845-863` (`runWeek` graph loop)

- [ ] **Step 1: Make `graphDispatch` return `{ id, media }`**

Replace `graphDispatch` (lines 338-353) with:

```js
// Dispatch one post over the Graph API, with token-expiry retry around the whole op.
// Returns { id, media } where media is 'video' | 'photo' | 'text' — what actually went out.
async function graphDispatch(post, caption, videoPath, scheduleUnix) {
  return withTokenRetry(`day ${post.day ?? '?'} (${post.type})`, async () => {
    if (post.type === 'video' && videoPath && fs.existsSync(videoPath)) {
      hopLog('facebook-poster→graph', 'info', `Uploading video (${(fs.statSync(videoPath).size / 1e6).toFixed(1)} MB)`);
      return { id: await graphPostVideo(videoPath, caption, scheduleUnix), media: 'video' };
    }
    const fullPhotoPath = resolvePhotoPath(post);
    if (fullPhotoPath) {
      if (post.type === 'video') hopLog('facebook-poster→graph', 'info', `Video unavailable — falling back to photo: ${path.basename(fullPhotoPath)}`);
      else hopLog('facebook-poster→graph', 'info', `Uploading photo: ${path.basename(fullPhotoPath)}`);
      return { id: await graphPostPhoto(fullPhotoPath, caption, scheduleUnix), media: 'photo' };
    }
    if (post.photo_file) hopLog('facebook-poster→graph', 'warn', `Photo not found: ${post.photo_file} — posting as text`);
    return { id: await graphPostText(caption, scheduleUnix), media: 'text' };
  });
}
```

- [ ] **Step 2: Record `media` in the `runWeek` graph loop**

In `runWeek` (the `else` Graph branch), replace lines 850-862 with:

```js
      try {
        const { id, media } = await graphDispatch(post, caption, post._videoPath || null, scheduleUnix);
        if (isLive) {
          results.push({ day: post.day, date: post.date, status: 'posted', type: post.type, media, id });
          hopLog('facebook-poster→graph', 'info', `Day ${post.day} posted live (id: ${id}, media: ${media})`);
        } else {
          results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type, media, id });
          hopLog('facebook-poster→graph', 'info', `Day ${post.day} scheduled for ${post.date} ${args.postTime} (id: ${id}, media: ${media})`);
        }
      } catch (e) {
        results.push({ day: post.day, date: post.date, status: 'error', message: e.message });
        hopLog('facebook-poster→graph', 'error', `Day ${post.day} failed: ${e.message}`);
      }
```

> Note: the Playwright branch (lines 814-839) is not the live path (`FB_USE_PLAYWRIGHT` is unset in prod). Leave it; its results simply omit `media`, which the bridge treats as unknown (Task 8 maps missing media to `none` only when also no photo). No change required there.

- [ ] **Step 3: Verify the module still parses**

Run: `node --check scripts/facebook-poster.mjs`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/facebook-poster.mjs
git commit -m "feat(media): facebook poster reports media used per post"
```

---

### Task 7: Add `media_status` column to weekly_posts

**Files:**
- Modify: `supabase/schema.sql:38-40`
- Apply: live migration via Supabase

- [ ] **Step 1: Add the column to schema.sql**

After line 39 (`video_prompt   text,`) insert:

```sql
  media_status   text,           -- 'video' | 'photo' | 'downgraded' | 'none'
```

- [ ] **Step 2: Apply the migration to the live DB**

Use the Supabase MCP `apply_migration` tool (project ref `tbvsycqfpkkxitdbgfsj`), name `add_media_status_to_weekly_posts`, with SQL:

```sql
alter table weekly_posts add column if not exists media_status text;
```

Expected: success. If MCP `apply_migration` returns a permission error (as `execute_sql` did previously), fall back to the PostgREST admin path is NOT available for DDL — instead run the SQL in the Supabase dashboard SQL editor and note it in the commit body.

- [ ] **Step 3: Verify the column exists**

Use Supabase MCP `list_tables` (schema `public`) and confirm `weekly_posts` lists a `media_status` column.
Expected: column present.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat(media): add media_status column to weekly_posts"
```

---

### Task 8: Write `media_status` from the bridge's Facebook phase

**Files:**
- Create (extend): `scripts/lib/action-enrich.mjs` — add `mediaStatusFor()` (full module written in Task 9; this task adds only this function + its test first so it exists when the bridge imports it)
- Modify: `scripts/mav-bridge.mjs:388-403`

> If Task 9 runs before this task, `action-enrich.mjs` already exists — just ensure `mediaStatusFor` is present and add its test cases. The function and tests below are the canonical version.

- [ ] **Step 1: Add `mediaStatusFor` test cases**

Append to `scripts/lib/action-enrich.test.mjs` (created in Task 9; if not yet created, create it with these lines plus the imports):

```js
import { mediaStatusFor } from './action-enrich.mjs';
// video day, video attached => video
assert.equal(mediaStatusFor('video', 'video'), 'video');
// video day, photo attached (Veo failed) => downgraded
assert.equal(mediaStatusFor('video', 'photo'), 'downgraded');
// video day, nothing attached => none
assert.equal(mediaStatusFor('video', 'text'), 'none');
assert.equal(mediaStatusFor('video', undefined), 'none');
// photo/text day, photo attached => photo
assert.equal(mediaStatusFor('photo', 'photo'), 'photo');
assert.equal(mediaStatusFor('text', 'photo'), 'photo');
// photo/text day, no media => none
assert.equal(mediaStatusFor('text', 'text'), 'none');
console.log('ok mediaStatusFor');
```

- [ ] **Step 2: Implement `mediaStatusFor` in `scripts/lib/action-enrich.mjs`**

```js
// Map (scheduled type, media actually attached) -> truthful media_status.
export function mediaStatusFor(scheduledType, attached) {
  if (attached === 'video') return 'video';
  if (attached === 'photo') return scheduledType === 'video' ? 'downgraded' : 'photo';
  return 'none';
}
```

- [ ] **Step 3: Run the test**

Run: `node scripts/lib/action-enrich.test.mjs`
Expected: PASS — prints `ok mediaStatusFor` (and the Task 9 checks if present).

- [ ] **Step 4: Import and write media_status in the bridge FB phase**

In `scripts/mav-bridge.mjs`, add near the top imports:

```js
import { mediaStatusFor } from './lib/action-enrich.mjs';
```

Then in the FB result loop (lines 388-403), replace the per-post update block with:

```js
        for (const fbPost of fbPosts) {
          const r = dayMap.get(fbPost.day);
          if (r) {
            const postStatus = r.status === 'posted' ? 'posted'
              : r.status === 'scheduled' ? 'scheduled'
              : 'error';
            await supabase.from('weekly_posts')
              .update({
                status: postStatus,
                media_status: mediaStatusFor(fbPost.type, r.media),
                error: r.status === 'error' ? (r.message || 'Unknown error') : null,
                posted_at: new Date().toISOString(),
                platform_post_id: r.id || null,
              })
              .eq('id', fbPost.id);
          }
        }
```

- [ ] **Step 5: Verify the module still parses**

Run: `node --check scripts/mav-bridge.mjs`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/action-enrich.mjs scripts/lib/action-enrich.test.mjs scripts/mav-bridge.mjs
git commit -m "feat(media): write truthful media_status from FB phase"
```

---

# GROUP B — Bridge enrichment & status taxonomy

### Task 9: Action-enrichment pure helpers

**Files:**
- Create/extend: `scripts/lib/action-enrich.mjs`
- Test: `scripts/lib/action-enrich.test.mjs`

- [ ] **Step 1: Write the failing test** (full file; merges Task 8's `mediaStatusFor` cases)

```js
// scripts/lib/action-enrich.test.mjs
import assert from 'node:assert/strict';
import {
  bucketStatus, isStuck, STUCK_THRESHOLDS, describeAction, agentFor, mediaStatusFor,
} from './action-enrich.mjs';

// bucketStatus
assert.equal(bucketStatus('pending_approval'), 'pending');
assert.equal(bucketStatus('approved'), 'pending');
assert.equal(bucketStatus('scheduled'), 'pending');
assert.equal(bucketStatus('awaiting_prompt'), 'pending');
assert.equal(bucketStatus('executing'), 'in_process');
assert.equal(bucketStatus('posting'), 'in_process');
assert.equal(bucketStatus('research_running'), 'in_process');
assert.equal(bucketStatus('done'), 'completed');
assert.equal(bucketStatus('posted'), 'completed');
assert.equal(bucketStatus('error'), 'failed');
assert.equal(bucketStatus('needs_verification'), 'failed');
assert.equal(bucketStatus('weird_unknown'), 'pending'); // safe default

// isStuck — only meaningful for in_process rows
const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const fresh = new Date(Date.now() - 60 * 1000).toISOString();        // 1m ago
assert.equal(isStuck('website_task', old), true);   // 2h > 15m
assert.equal(isStuck('website_task', fresh), false);
assert.equal(isStuck('seo_run', old), false);       // 2h < 90m
assert.equal(isStuck('weekly_post_facebook', old), true); // 2h > 60m
assert.equal(isStuck('weekly_post_gbp', fresh), false);
assert.equal(isStuck('website_task', null), false); // no timestamp => not stuck

// thresholds present for every type
for (const k of ['website_task','weekly_post_gbp','weekly_post_facebook','seo_run']) {
  assert.ok(STUCK_THRESHOLDS[k] > 0, `threshold for ${k}`);
}

// describeAction — DB description wins, else type fallback, never empty
assert.equal(describeAction({ type: 'seo_run' }, ''), describeAction({ type: 'seo_run' }, ''));
assert.ok(describeAction({ type: 'seo_run' }).length > 0);
assert.equal(describeAction({ type: 'website_task', description: 'Custom thing' }), 'Custom thing');
assert.ok(describeAction({ type: 'weekly_post', platform: 'gbp', post_date: '2026-06-26' }).includes('2026-06-26'));

// agentFor
assert.equal(agentFor({ type: 'seo_run' }), 'SEO Crew');
assert.equal(agentFor({ type: 'weekly_post', platform: 'gbp' }), 'Grizzly GBP Poster Agent');
assert.equal(agentFor({ type: 'weekly_post', platform: 'facebook' }), 'Grizzly Facebook Poster Agent');
assert.ok(agentFor({ type: 'website_task' }).length > 0);

// mediaStatusFor
assert.equal(mediaStatusFor('video', 'video'), 'video');
assert.equal(mediaStatusFor('video', 'photo'), 'downgraded');
assert.equal(mediaStatusFor('video', 'text'), 'none');
assert.equal(mediaStatusFor('video', undefined), 'none');
assert.equal(mediaStatusFor('photo', 'photo'), 'photo');
assert.equal(mediaStatusFor('text', 'text'), 'none');

console.log('ok action-enrich');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/action-enrich.test.mjs`
Expected: FAIL — missing export(s) / module not found.

- [ ] **Step 3: Write the implementation**

```js
// scripts/lib/action-enrich.mjs
// Pure helpers for enriching /seo/actions payloads. No I/O — unit-testable.

const BUCKET = {
  pending_approval: 'pending', approved: 'pending', awaiting_prompt: 'pending', scheduled: 'pending',
  executing: 'in_process', posting: 'in_process', research_running: 'in_process', execute_running: 'in_process',
  done: 'completed', posted: 'completed',
  error: 'failed', needs_verification: 'failed',
};

export function bucketStatus(dbStatus) {
  return BUCKET[String(dbStatus || '').toLowerCase()] || 'pending';
}

// Per-action-type stuck thresholds (ms). See spec §5.
export const STUCK_THRESHOLDS = {
  website_task:          15 * 60 * 1000,
  weekly_post_gbp:       20 * 60 * 1000,
  weekly_post_facebook:  60 * 60 * 1000,
  seo_run:               90 * 60 * 1000,
};

// `since` is the ISO time the row entered an in_process state (we use updated_at,
// which the DB trigger refreshes on the status flip). null/absent => not stuck.
export function isStuck(thresholdKey, since) {
  const limit = STUCK_THRESHOLDS[thresholdKey];
  if (!limit || !since) return false;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) > limit;
}

const DESCRIPTIONS = {
  seo_run: () => 'Full weekly SEO run: research + content generation for the next 7 days.',
  gbp_profile_update: () => "Update Grizzly's Google Business Profile (hours, services, info) — not a re-claim.",
  publish_gbp_post: (a) => `Publish a scheduled Google Business post for ${a.post_date || 'this week'}.`,
  publish_facebook_post: (a) => `Publish a Facebook post for ${a.post_date || 'this week'} (${a.media_status || 'media TBD'}).`,
  weekly_post_gbp: (a) => `Publish a scheduled Google Business post for ${a.post_date || 'this week'}.`,
  weekly_post_facebook: (a) => `Publish a Facebook post for ${a.post_date || 'this week'} (${a.media_status || 'media TBD'}).`,
  website_technical_change: () => 'Technical SEO change on grizzlyheating.com.',
  website_content_publish: () => 'Publish website content / blog post.',
  website_blog_post: () => 'Publish website content / blog post.',
  website_task: () => 'Website SEO task on grizzlyheating.com.',
  review_management: () => 'Request or respond to customer reviews.',
};

function descKey(a) {
  if (a.type === 'weekly_post') return a.platform === 'facebook' ? 'weekly_post_facebook' : 'weekly_post_gbp';
  return a.type;
}

export function describeAction(a, dbDescription) {
  const fromDb = (dbDescription ?? a.description ?? '').toString().trim();
  if (fromDb) return fromDb;
  const fn = DESCRIPTIONS[descKey(a)];
  return fn ? fn(a) : 'SEO action.';
}

const AGENTS = {
  seo_run: 'SEO Crew',
  gbp_profile_update: 'GBP Profile Agent',
  weekly_post_gbp: 'Grizzly GBP Poster Agent',
  weekly_post_facebook: 'Grizzly Facebook Poster Agent',
  website_task: 'Website Agent',
  website_content_publish: 'Website Content Agent',
  review_management: 'Review Agent',
};

export function agentFor(a) {
  return AGENTS[descKey(a)] || 'SEO Crew';
}

// Map (scheduled type, media actually attached) -> truthful media_status.
export function mediaStatusFor(scheduledType, attached) {
  if (attached === 'video') return 'video';
  if (attached === 'photo') return scheduledType === 'video' ? 'downgraded' : 'photo';
  return 'none';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/action-enrich.test.mjs`
Expected: PASS — prints `ok action-enrich`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/action-enrich.mjs scripts/lib/action-enrich.test.mjs
git commit -m "feat(actions): pure enrichment helpers (bucket/stuck/describe/agent)"
```

---

### Task 10: Rewrite `GET /seo/actions` to return the enriched payload

**Files:**
- Modify: `scripts/mav-bridge.mjs:802-843`

- [ ] **Step 1: Ensure imports**

Confirm these are imported at the top of `mav-bridge.mjs` (add any missing):

```js
import { bucketStatus, isStuck, describeAction, agentFor } from './lib/action-enrich.mjs';
```

(`mediaStatusFor` was added in Task 8; combine into one import line.)

- [ ] **Step 2: Replace the handler body**

Replace lines 803-843 (the whole `if (method === 'GET' && url.pathname === '/seo/actions')` block) with:

```js
  // ── GET /seo/actions ────────────────────────
  if (method === 'GET' && url.pathname === '/seo/actions') {
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const [runsRes, postsRes, tasksRes] = await Promise.all([
      supabase.from('seo_runs').select('*')
        .or(`status.in.(pending_approval,approved,awaiting_prompt,research_running,execute_running,executing,error),and(status.eq.done,done_at.gte.${since48h})`)
        .order('created_at', { ascending: false }).limit(20),
      supabase.from('weekly_posts').select('*')
        .or(`status.in.(pending_approval,approved,scheduled,posting,error,needs_verification),and(status.eq.posted,posted_at.gte.${since48h})`)
        .order('post_date', { ascending: true }).limit(60),
      supabase.from('website_tasks').select('*')
        .in('status', ['pending_approval', 'approved', 'executing', 'error'])
        .order('priority').limit(20),
    ]);

    const runs = runsRes.data || [];
    const posts = postsRes.data || [];
    const tasks = tasksRes.data || [];

    const enrich = (row, type) => {
      const a = { ...row, type };
      const bucket = bucketStatus(row.status);
      // Stuck only applies to rows still in-process. updated_at is the proxy for
      // when the row entered that state (DB trigger refreshes it on the flip).
      const thresholdKey = type === 'seo_run' ? 'seo_run'
        : type === 'website_task' ? 'website_task'
        : (row.platform === 'facebook' ? 'weekly_post_facebook' : 'weekly_post_gbp');
      const stuck = bucket === 'in_process' && isStuck(thresholdKey, row.updated_at);
      const status = stuck ? 'failed' : bucket;
      const status_detail = stuck ? 'stuck' : row.status;
      return {
        id: row.id,
        type,
        title: row.title || row.service || (type === 'seo_run' ? `SEO Run ${row.week_of || (row.id || '').slice(0, 8)}` : `${type} ${(row.id || '').slice(0, 8)}`),
        description: describeAction(a, row.description),
        priority: (row.priority || (type === 'seo_run' ? 'high' : 'medium')),
        status,
        status_detail,
        assigned_agent: agentFor(a),
        platform: row.platform || (type === 'website_task' ? 'website_cms' : type === 'seo_run' ? 'pipeline' : null),
        media_status: type === 'weekly_post' ? (row.media_status || (row.status === 'posted' ? 'none' : 'n/a')) : 'n/a',
        error: row.error || null,
        executing_since: bucket === 'in_process' ? (row.updated_at || null) : null,
        updated_at: row.updated_at || row.created_at || null,
        // legacy fields kept so existing approve/run buttons keep working:
        approval_required: bucket === 'pending',
        approval: null,
        live_adapter: 'mav-bridge',
        posts_count: type === 'seo_run' ? posts.filter(p => p.run_id === row.id).length : undefined,
      };
    };

    const actions = [
      ...runs.map(r => enrich(r, 'seo_run')),
      ...posts.map(p => enrich(p, 'weekly_post')),
      ...tasks.map(t => enrich(t, 'website_task')),
    ];

    // Single deduped alert list (spec §7a). Both dashboards render this same array.
    const alerts = actions
      .filter(a => a.status === 'failed')
      .map(a => ({
        id: `${a.id}:${a.status_detail === 'stuck' ? 'stuck' : 'failed'}`,
        severity: a.status_detail === 'stuck' ? 'warn' : 'error',
        title: a.status_detail === 'stuck' ? `Stuck: ${a.title}` : `Failed: ${a.title}`,
        detail: a.error || (a.status_detail === 'stuck' ? `In process longer than the ${a.type} limit.` : 'Action failed — check run logs.'),
        action_id: a.id,
        fault_type: a.status_detail === 'stuck' ? 'stuck' : 'failed',
      }));

    sendJsonHttp(res, 200, {
      actions,
      alerts,
      summary: {
        needs_approval: actions.filter(a => a.status === 'pending').length,
        in_process: actions.filter(a => a.status === 'in_process').length,
        completed: actions.filter(a => a.status === 'completed').length,
        failed: actions.filter(a => a.status === 'failed').length,
        blocked_access: actions.filter(a => a.status === 'failed').length,
      },
    });
    return;
  }
```

- [ ] **Step 3: Verify the module parses**

Run: `node --check scripts/mav-bridge.mjs`
Expected: no output, exit 0.

- [ ] **Step 4: Smoke-test against the running bridge**

Run: `node -e "fetch('http://127.0.0.1:8790/seo/actions').then(r=>r.json()).then(d=>{const a=(d.actions||[])[0]; console.log('count', d.actions?.length, 'alerts', d.alerts?.length); if(a){['id','type','title','description','priority','status','assigned_agent'].forEach(k=>{if(!a[k] && k!=='priority') throw new Error('missing '+k)}); console.log('sample', JSON.stringify(a,null,2));} console.log('ok payload');}).catch(e=>{console.error(e.message); process.exit(1)})"`

> The bridge must be restarted first to pick up the new code — if it returns the old shape, run `pm2 restart mav-bridge` then re-run. (Full restart + verify is Task 16; this is an early smoke check.)
Expected: prints counts, a sample action with non-empty `description`/`status`/`assigned_agent`, and `ok payload`. Every `status` is one of pending/in_process/completed/failed.

- [ ] **Step 5: Commit**

```bash
git add scripts/mav-bridge.mjs
git commit -m "feat(actions): enriched /seo/actions payload + deduped alerts"
```

---

# GROUP C — Stuck detection & alerting

### Task 11: Alert dedup store

**Files:**
- Create: `scripts/lib/alert-store.mjs`
- Test: `scripts/lib/alert-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/lib/alert-store.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeAlertStore } from './alert-store.mjs';

const tmp = path.join(os.tmpdir(), `alerted-${Date.now()}.json`);
try { fs.rmSync(tmp, { force: true }); } catch {}

const store = makeAlertStore(tmp);
// first time a fault is seen => fires
assert.equal(store.shouldFire('run1', 'act1', 'failed'), true);
// same fault again => does not fire
assert.equal(store.shouldFire('run1', 'act1', 'failed'), false);
// different fault type on same action => fires
assert.equal(store.shouldFire('run1', 'act1', 'stuck'), true);
// persisted across instances
const store2 = makeAlertStore(tmp);
assert.equal(store2.shouldFire('run1', 'act1', 'failed'), false);
// clearing a fault lets it fire again
store2.clearFault('run1', 'act1', 'failed');
assert.equal(store2.shouldFire('run1', 'act1', 'failed'), true);

fs.rmSync(tmp, { force: true });
console.log('ok alert-store');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/alert-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// scripts/lib/alert-store.mjs
// Persisted dedup for fired alerts so a fault alerts once, not every poll.
// Key = `${runId}:${actionId}:${faultType}`. Survives reboot via a JSON file.
import fs from 'node:fs';

export function makeAlertStore(filePath) {
  const load = () => {
    try { return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { return new Set(); }
  };
  const save = (set) => {
    try { fs.writeFileSync(filePath, JSON.stringify([...set])); } catch {}
  };
  const key = (runId, actionId, faultType) => `${runId || '-'}:${actionId}:${faultType}`;

  return {
    // Returns true exactly once per (run,action,fault) until cleared.
    shouldFire(runId, actionId, faultType) {
      const set = load();
      const k = key(runId, actionId, faultType);
      if (set.has(k)) return false;
      set.add(k);
      save(set);
      return true;
    },
    clearFault(runId, actionId, faultType) {
      const set = load();
      if (set.delete(key(runId, actionId, faultType))) save(set);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/alert-store.test.mjs`
Expected: PASS — prints `ok alert-store`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/alert-store.mjs scripts/lib/alert-store.test.mjs
git commit -m "feat(alerts): persisted alert dedup store"
```

---

### Task 12: iMessage send-only helper in grizzly-hcp

**Files:**
- Create: `C:\Workspace\Active\grizzly-hcp\scripts\notify-imessage.ts`
- Modify: `C:\Workspace\Active\grizzly-hcp\.env`

- [ ] **Step 1: Add CARTER_PHONE to grizzly-hcp .env**

Append to `C:\Workspace\Active\grizzly-hcp\.env`:

```
CARTER_PHONE=+14697169870
```

(Do not commit `.env`. Verify with `git -C C:/Workspace/Active/grizzly-hcp check-ignore .env` — expected: prints `.env`.)

- [ ] **Step 2: Write the helper**

```ts
// C:\Workspace\Active\grizzly-hcp\scripts\notify-imessage.ts
// Send-only Photon helper. Reuses grizzly-hcp's Spectrum creds to deliver a
// one-shot iMessage. Usage: tsx scripts/notify-imessage.ts "<message>"
// Exits 0 on send, non-zero on failure. No-ops (exit 0, logged) if CARTER_PHONE unset.
import 'dotenv/config';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

async function main() {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) { console.error('[notify-imessage] no message text'); process.exit(2); }

  const to = process.env.CARTER_PHONE;
  if (!to) { console.warn('[notify-imessage] CARTER_PHONE unset — skipping send'); process.exit(0); }
  if (!process.env.PROJECT_ID || !process.env.PROJECT_SECRET) {
    console.error('[notify-imessage] PROJECT_ID/PROJECT_SECRET unset'); process.exit(3);
  }

  const app = await Spectrum({
    projectId: process.env.PROJECT_ID,
    projectSecret: process.env.PROJECT_SECRET,
    providers: [imessage.config()],
  });
  const space = await imessage(app).space.create(to);
  await space.send(text);
  console.log('[notify-imessage] sent');
  process.exit(0);
}

main().catch((e) => { console.error('[notify-imessage] failed:', e?.message || e); process.exit(1); });
```

- [ ] **Step 3: Verify it type-checks / runs the no-op path**

Run: `cd C:/Workspace/Active/grizzly-hcp && npx tsx scripts/notify-imessage.ts ""`
Expected: exits 2 with `no message text` (proves the file loads and `tsx` resolves imports). A real send is verified in Task 16.

- [ ] **Step 4: Commit**

```bash
git -C C:/Workspace/Active/grizzly-hcp add scripts/notify-imessage.ts
git -C C:/Workspace/Active/grizzly-hcp commit -m "feat(alerts): send-only iMessage notifier"
```

---

### Task 13: Fire alerts from the bridge poll loop

**Files:**
- Modify: `scripts/mav-bridge.mjs` — add constants near other consts (after line 50), add `notifyAlert` near `sendBridgeAlert` (after line 102), call detection at the end of `poll()` (before the `} catch` at line 673)

- [ ] **Step 1: Add constants + alert store**

After the env constants block (around line 50), add:

```js
const GRIZZLY_HCP_DIR = process.env.GRIZZLY_HCP_DIR || 'C:\\Workspace\\Active\\grizzly-hcp';
const ALERTED_PATH = path.join(PROJECT_ROOT, 'state', 'alerted.json');
```

Add to the imports at the top:

```js
import { makeAlertStore } from './lib/alert-store.mjs';
```

After `const supabase = createClient(...)` (line 57), add:

```js
fs.mkdirSync(path.join(PROJECT_ROOT, 'state'), { recursive: true });
const alertStore = makeAlertStore(ALERTED_PATH);
```

- [ ] **Step 2: Add `notifyAlert` (iMessage + email, deduped)**

After `sendBridgeAlert` (after line 102), add:

```js
// Fire a non-silent alert exactly once per (run, action, fault). Banner data is
// served separately by /seo/actions; this handles the push channels (iMessage + email).
async function notifyAlert({ runId, actionId, faultType, title, detail }) {
  if (!alertStore.shouldFire(runId, actionId, faultType)) return;
  const msg = `⚠️ Grizzly SEO: ${title}\n${detail || ''}`.trim();
  // iMessage via grizzly-hcp send-only helper. Failure must not break the poll loop.
  try {
    await execFileAsync('npx', ['tsx', 'scripts/notify-imessage.ts', msg], {
      cwd: GRIZZLY_HCP_DIR, timeout: 60_000, windowsHide: true,
    });
  } catch (e) {
    console.error(`[mav-bridge] iMessage alert failed: ${e.message}`);
  }
  await sendBridgeAlert(`Grizzly SEO: ${title}`, detail || title);
}
```

- [ ] **Step 3: Detect failed + stuck rows at the end of `poll()`**

Inside `poll()`, just before the closing `} catch (e) {` at line 673, add:

```js
    // ── Non-silent fault detection ───────────────
    // Failed rows and rows stuck in-process past their per-type threshold both
    // alert once (deduped). Recovered rows clear their dedup key so a future
    // recurrence re-alerts.
    try {
      const { data: faultRuns } = await supabase.from('seo_runs')
        .select('id,status,updated_at,error').in('status', ['error', 'executing', 'execute_running', 'research_running']);
      const { data: faultPosts } = await supabase.from('weekly_posts')
        .select('id,run_id,platform,status,updated_at,error,post_date').in('status', ['error', 'needs_verification', 'posting']);
      const { data: faultTasks } = await supabase.from('website_tasks')
        .select('id,run_id,status,updated_at,error,title').in('status', ['error', 'executing']);

      const checkRow = async (row, type, thresholdKey, label) => {
        const b = bucketStatus(row.status);
        if (b === 'failed') {
          await notifyAlert({ runId: row.run_id || row.id, actionId: row.id, faultType: 'failed',
            title: `Failed: ${label}`, detail: row.error || 'Action failed — check run logs.' });
        } else if (b === 'in_process' && isStuck(thresholdKey, row.updated_at)) {
          await notifyAlert({ runId: row.run_id || row.id, actionId: row.id, faultType: 'stuck',
            title: `Stuck: ${label}`, detail: `In process longer than the ${thresholdKey} limit (since ${row.updated_at}).` });
        } else {
          // healthy now — clear both dedup keys so a recurrence re-alerts
          alertStore.clearFault(row.run_id || row.id, row.id, 'failed');
          alertStore.clearFault(row.run_id || row.id, row.id, 'stuck');
        }
      };

      for (const r of faultRuns || []) await checkRow(r, 'seo_run', 'seo_run', `SEO Run ${(r.id || '').slice(0, 8)}`);
      for (const p of faultPosts || []) await checkRow(p, 'weekly_post',
        p.platform === 'facebook' ? 'weekly_post_facebook' : 'weekly_post_gbp',
        `${p.platform} post ${p.post_date || ''}`.trim());
      for (const t of faultTasks || []) await checkRow(t, 'website_task', 'website_task', t.title || `Task ${(t.id || '').slice(0, 8)}`);
    } catch (e) {
      console.error(`[mav-bridge][fault-detect] ${e.message}`);
    }
```

Ensure `bucketStatus, isStuck` are in the import from `./lib/action-enrich.mjs` (merge with Task 10's import line).

- [ ] **Step 4: Verify the module parses**

Run: `node --check scripts/mav-bridge.mjs`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/mav-bridge.mjs
git commit -m "feat(alerts): detect failed/stuck actions and alert (iMessage+email)"
```

---

# GROUP D — Dashboard UI

### Task 14: HomePage — enriched action rows + shared alert banner

**Files:**
- Modify: `C:\Workspace\Active\MCC\src\pages\HomePage.jsx:31-54` (filtering/faults), `:81-123` (`renderActionRow`)

- [ ] **Step 1: Include bridge alerts in faults + adjust filtering to 4 buckets**

Replace the `upcomingActions` block (lines 31-41) with:

```js
  const STATUS_BUCKETS = ['pending', 'in_process', 'completed', 'failed'];
  const upcomingActions = actions
    .filter((action) => {
      const s = String(action.status || '').toLowerCase();
      // Active + recent failures: hide completed (collapsed separately).
      return STATUS_BUCKETS.includes(s) ? s !== 'completed' : true;
    })
    .sort((a, b) => {
      const rank = { failed: 0, in_process: 1, pending: 2, completed: 3 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    });
  const completedActions = actions.filter((a) => String(a.status).toLowerCase() === 'completed');
```

Replace the `faults` block (lines 46-50) with:

```js
  const bridgeAlerts = actionQueue?.alerts || [];
  const faults = [
    ...bridgeAlerts.map((al) => `${al.title}${al.detail ? ' — ' + al.detail : ''}`),
    ...(seoWorkflow.faults || []),
    ...(actionQueue?.error ? [actionQueue.error] : []),
    ...(orchestratorStatus.error ? [orchestratorStatus.error] : [])
  ];
```

- [ ] **Step 2: Rewrite `renderActionRow` for the enriched payload**

Replace `renderActionRow` (lines 81-123) with:

```js
  const STATUS_BADGE = {
    pending: { label: 'PENDING', color: '#f59e0b' },
    in_process: { label: 'IN PROCESS', color: '#6366f1' },
    completed: { label: 'COMPLETED', color: '#10b981' },
    failed: { label: 'FAILED', color: '#ef4444' },
  };
  const PRIORITY_COLOR = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#6b7280' };
  const MEDIA_ICON = { video: '🎬 video', photo: '✅ photo', downgraded: '⚠️ photo (no video)', none: '⛔ no media' };

  function renderActionRow(action) {
    const isBusy = actionBusyId === action.id;
    const isApproved = action.status === 'pending' && Boolean(action.approval);
    const canApprove = action.status === 'pending' && action.approval_required && !action.approval;
    const canRunLive = Boolean(action.live_adapter) && isApproved;
    const canApproveAndRun = Boolean(action.live_adapter) && canApprove;
    const badge = STATUS_BADGE[action.status] || STATUS_BADGE.pending;
    const media = action.media_status && action.media_status !== 'n/a' ? MEDIA_ICON[action.media_status] : null;

    return (
      <div className="actionRow actionQueueRow" key={action.id}>
        <div>
          <strong>{action.title}</strong>
          <span className="actionDesc">{action.description}</span>
          <span>
            <em style={{ color: badge.color }}>{badge.label}</em>
            {' · '}<em style={{ color: PRIORITY_COLOR[action.priority] || '#6b7280' }}>{(action.priority || 'medium').toUpperCase()}</em>
            {' · '}{action.assigned_agent}
            {media ? <> {' · '}{media}</> : null}
          </span>
          {action.error ? <span className="actionError" title={action.error}>{action.error}</span> : null}
        </div>
        <div className="actionButtons">
          <button type="button" disabled={isBusy} onClick={() => handleDryRunAction(action.id)}>Dry Run</button>
          <button type="button" disabled={isBusy || !canApprove} onClick={() => handleApproveAction(action.id)}>Approve</button>
          <button type="button" disabled={isBusy || !canApproveAndRun} onClick={() => handleApproveAndRunAction(action.id)}>Approve + Run</button>
          <button type="button" disabled={isBusy || !canRunLive} onClick={() => handleLiveRunAction(action.id)}>Run Live</button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 3: Show a completed count under the list**

In the actions section body, after `{visibleActions.map(renderActionRow)}` (line 333), add:

```jsx
                {completedActions.length > 0 ? (
                  <div className="completedCount">✓ {completedActions.length} completed (last 48h)</div>
                ) : null}
```

- [ ] **Step 4: Verify the dashboard builds**

Run: `cd C:/Workspace/Active/MCC && npm run build`
Expected: build succeeds (no JSX/syntax errors). If MCC uses Vite dev only, run `npx vite build` — expected success.

- [ ] **Step 5: Commit**

```bash
git -C C:/Workspace/Active/MCC add src/pages/HomePage.jsx
git -C C:/Workspace/Active/MCC commit -m "feat(dashboard): enriched action rows + shared alert banner on HomePage"
```

---

### Task 15: SEOApprovalPage — enriched cards + shared alerts, no double alert

**Files:**
- Modify: `C:\Workspace\Active\MCC\src\SEOApprovalPage.jsx:184-257` (`ActionCard`), `:306-336` (load), `:364-417` (faults/filtering)

- [ ] **Step 1: Capture bridge alerts in state**

In `SEOApprovalPage`, add state after line 297:

```js
  const [alerts, setAlerts] = useState([]);
```

In `load` (lines 306-314), after `setActions(ac.actions || []);` add:

```js
      setAlerts(ac.alerts || []);
```

- [ ] **Step 2: Update pending/other filtering to buckets**

Replace lines 364-365 with:

```js
  const pendingActions = actions.filter(a => a.status === 'pending');
  const otherActions = actions.filter(a => a.status !== 'pending' && a.status !== 'completed');
  const completedActions = actions.filter(a => a.status === 'completed');
```

- [ ] **Step 3: Render the shared alerts banner (replaces the workflow-only faults box)**

Replace the Faults block (lines 410-417) with:

```jsx
          {/* Alerts — same deduped list the HomePage banner uses (no double alert) */}
          {(alerts.length > 0 || (workflow.faults || []).length > 0) && (
            <div style={{ background: '#ef444411', border: '1px solid #ef444433', borderRadius: 8, padding: '10px 14px', marginBottom: 20 }}>
              {alerts.map((a) => (
                <div key={a.id} style={{ color: a.severity === 'warn' ? '#f59e0b' : '#ef4444', fontSize: 12, marginBottom: 4 }}>
                  ⚠ {a.title}{a.detail ? ` — ${a.detail}` : ''}
                </div>
              ))}
              {(workflow.faults || []).map((f, i) => (
                <div key={`wf-${i}`} style={{ color: '#ef4444', fontSize: 12 }}>⚠ {f}</div>
              ))}
            </div>
          )}
```

- [ ] **Step 4: Enrich `ActionCard` with description / priority / agent / status / media**

Replace the header `<div>` inside `ActionCard` (lines 221-229) with:

```jsx
  const STATUS_BADGE = {
    pending: { label: 'PENDING', color: '#f59e0b' },
    in_process: { label: 'IN PROCESS', color: '#6366f1' },
    completed: { label: 'COMPLETED', color: '#10b981' },
    failed: { label: 'FAILED', color: '#ef4444' },
  };
  const PRIORITY_COLOR = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#6b7280' };
  const MEDIA_ICON = { video: '🎬 video', photo: '✅ photo', downgraded: '⚠️ photo (no video)', none: '⛔ no media' };
  const badge = STATUS_BADGE[action.status] || STATUS_BADGE.pending;
  const media = action.media_status && action.media_status !== 'n/a' ? MEDIA_ICON[action.media_status] : null;

  return (
    <div style={{ background: '#1a1d26', border: `1px solid ${isPending ? '#f59e0b33' : '#2a2f45'}`, borderRadius: 8, padding: '14px 18px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusBadge label={TYPE_LABEL[action.type] || action.type} color="#6b7280" />
        <span style={{ color: '#f1f5f9', fontWeight: 600, flex: 1, fontSize: 14 }}>{action.title}</span>
        {action.priority && <StatusBadge label={action.priority} color={PRIORITY_COLOR[action.priority] || '#6b7280'} />}
        <StatusBadge label={badge.label} color={badge.color} />
      </div>
      <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>{action.description}</div>
      <div style={{ color: '#6b7280', fontSize: 11, marginTop: 4 }}>
        {action.assigned_agent}{media ? ` · ${media}` : ''}{action.posts_count != null ? ` · ${action.posts_count} posts` : ''}
      </div>
      {action.error && (
        <div style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }} title={action.error}>{action.error}</div>
      )}
```

Note: `isPending` (line 217) now must check the bucket — change line 217 from:

```js
  const isPending = action.status === 'needs_approval' || action.status === 'pending_approval';
```

to:

```js
  const isPending = action.status === 'pending';
```

And `color` on line 218 is no longer used by the header (the badge replaces it) — leave it or remove; the `STATE_COLOR` map is still used elsewhere. Remove the now-duplicate `return (` and old header block (old lines 220-229) so only the new block above remains.

- [ ] **Step 5: Optionally show completed count**

After the `otherActions` block (line 481), add:

```jsx
          {completedActions.length > 0 && (
            <div style={{ color: '#10b981', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', margin: '20px 0 0' }}>
              ✓ {completedActions.length} completed (last 48h)
            </div>
          )}
```

- [ ] **Step 6: Verify the dashboard builds**

Run: `cd C:/Workspace/Active/MCC && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git -C C:/Workspace/Active/MCC add src/SEOApprovalPage.jsx
git -C C:/Workspace/Active/MCC commit -m "feat(dashboard): enriched SEO cards + shared alerts (no double alert)"
```

---

# GROUP E — Integration & live verification

### Task 16: Restart services, verify end-to-end

**Files:** none (operational)

- [ ] **Step 1: Run all unit checks**

Run:
```bash
node scripts/lib/schedule-text.test.mjs && node scripts/lib/action-enrich.test.mjs && node scripts/lib/alert-store.test.mjs
```
Expected: three `ok ...` lines, exit 0.

- [ ] **Step 2: Restart the bridge**

Run: `pm2 restart mav-bridge && pm2 logs mav-bridge --lines 20 --nostream`
Expected: starts clean, no import errors, no stack traces.

- [ ] **Step 3: Verify enriched payload live**

Run the Task 10 Step 4 smoke command again.
Expected: every action has `description`, a 4-bucket `status`, `assigned_agent`; `alerts` is an array.

- [ ] **Step 4: Verify a real iMessage send**

Run: `cd C:/Workspace/Active/grizzly-hcp && npx tsx scripts/notify-imessage.ts "Grizzly SEO alerting test — please ignore"`
Expected: exits 0, prints `[notify-imessage] sent`; the message arrives at +1 469-716-9870. (Owner confirms receipt.)

- [ ] **Step 5: Rebuild + redeploy MCC dashboard**

Run: `cd C:/Workspace/Active/MCC && npm run build && pm2 restart mav-console`
Expected: build succeeds, console restarts. Open the dashboard; the HomePage "Upcoming Actions" card and the SEO Pipeline page each show description/priority/agent/status badges and a media indicator on weekly posts. A failed/stuck action shows the same banner on both pages (one alert, not two).

- [ ] **Step 6: Confirm GBP picker migration (spec §6d)**

Run: `grep -rn "photo-matcher\|photo-scanner" scripts/` (or use Grep tool).
Expected: no live caller references the old `photo-matcher.mjs`/`photo-scanner.mjs` (only `gbp-photo-pick.mjs` is invoked from `mav-bridge.mjs`). If a stale reference exists, remove it and commit.

- [ ] **Step 7: Final commit (if any cleanup)**

```bash
git add -A && git commit -m "chore: post-integration cleanup for action-visibility/media work"
```

---

## Self-Review

**Spec coverage:**
- §1/§3 enriched payload + 4-bucket taxonomy → Tasks 9, 10. ✓
- §4 descriptions + agent derivation → Task 9 (`describeAction`, `agentFor`). ✓
- §5 per-type stuck thresholds → Task 9 (`STUCK_THRESHOLDS`, `isStuck`), wired in Tasks 10 & 13. ✓
- §6a strip backticks/blank → Tasks 1–4. ✓
- §6b FB video-day photo fallback → Task 5. ✓
- §6c truthful media_status + clean photo_file → Tasks 2, 6, 7, 8. ✓
- §6d GBP picker migration check → Task 16 Step 6. ✓
- §6e Gemini credits = owner action → out of scope (existing email alert already warns; covered). ✓
- §7a single deduped alerts[] → Task 10 (payload) + Task 15 (shared render). ✓
- §7b iMessage via grizzly-hcp helper → Task 12, spawned in Task 13. ✓
- §7c dedup via state/alerted.json → Task 11, used in Task 13. ✓
- §7d CARTER_PHONE config → Task 12 Step 1. ✓
- §8 UI both pages converge → Tasks 14, 15. ✓

**Placeholder scan:** No TBD/TODO left; every code step shows full code. The one runtime-confirmed detail (curated env var) is checked in Task 5 Step 1 with a default provided.

**Type consistency:** `normalizePhotoFile`/`cleanField` (schedule-text), `bucketStatus`/`isStuck`/`STUCK_THRESHOLDS`/`describeAction`/`agentFor`/`mediaStatusFor` (action-enrich), `makeAlertStore`→`shouldFire`/`clearFault` (alert-store) are named identically across definition, tests, and call sites. `graphDispatch` now returns `{ id, media }` and every caller destructures it. Payload field names (`status`, `description`, `priority`, `assigned_agent`, `media_status`, `alerts`) match between bridge (Task 10), HomePage (Task 14), and SEOApprovalPage (Task 15).

**Ambiguity:** stuck uses `updated_at` as the in-process entry proxy (stated explicitly, avoids a schema migration for `executing_since`); media fallback picks the first same-date curated file (ceiling noted via `ponytail:` comment).
