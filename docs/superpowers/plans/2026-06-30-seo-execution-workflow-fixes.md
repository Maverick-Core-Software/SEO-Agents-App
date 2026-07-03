# SEO Execution Workflow Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the posting, scheduling, photo matching, video generation, and WordPress integration issues in the SEO Agents App execution pipeline.

**Architecture:** The execution pipeline flows: Supabase approval → mav-bridge polls → spawns facebook-poster/gbp-worker/wordpress-adapter. Fixes target idempotency, pre-flight checks, better fallback visibility, and robustness at each boundary.

**Tech Stack:** Node.js (ESM), Supabase, Facebook Graph API, Gemini Veo 3, FFmpeg, Playwright, WordPress REST API

---

### Task 1: Add Idempotency Guards to Facebook Posting

**Files:**
- Modify: `scripts/facebook-poster.mjs:460-487` (generateAllVideos + main posting loop)
- Modify: `scripts/mav-bridge.mjs:280-332` (executeApprovedRun facebook section)

- [ ] **Step 1: Add platform_post_id dedup check in mav-bridge before spawning facebook-poster**

In `scripts/mav-bridge.mjs`, before the `runPhase` call for facebook, add a guard that skips rows already carrying a `platform_post_id`:

```javascript
// After line 278 (the fbPosts query), filter out already-posted rows
if (fbPosts?.length) {
  const unposted = fbPosts.filter(p => !p.platform_post_id);
  if (!unposted.length) {
    await log(runId, 'facebook', 'info', 'All Facebook posts already have platform_post_id — skipping re-post');
  } else {
    await log(runId, 'facebook', 'info', `Posting ${unposted.length} Facebook posts (${fbPosts.length - unposted.length} already posted)`);
```

- [ ] **Step 2: Add stuck-state TTL recovery for `posting` rows**

In `scripts/mav-bridge.mjs`, in the fault detection section (around line 464), add recovery for rows stuck in `posting` status for >30 minutes:

```javascript
// After the faultPosts query (line 473), add stuck-posting recovery
const POSTING_TTL_MS = 30 * 60 * 1000;
const { data: stuckPosting } = await supabase.from('weekly_posts')
  .select('id, run_id, platform, updated_at')
  .eq('status', 'posting')
  .lt('updated_at', new Date(Date.now() - POSTING_TTL_MS).toISOString());
for (const row of stuckPosting || []) {
  await supabase.from('weekly_posts')
    .update({ status: 'error', error: 'Stuck in posting state >30min — auto-reset' })
    .eq('id', row.id);
  console.log(`[mav-bridge][stuck-recovery] Reset ${row.platform} post ${row.id} from posting → error`);
}
```

- [ ] **Step 3: Test by checking existing stuck rows**

Run: `node -e "const { createClient } = require('@supabase/supabase-js'); /* check for stuck posting rows */"`
Expected: No crash; any existing stuck rows would be identified.

- [ ] **Step 4: Commit**

```bash
git add scripts/mav-bridge.mjs
git commit -m "fix(bridge): add idempotency guard + stuck-posting recovery"
```

---

### Task 2: Pre-flight Gemini Credit Check

**Files:**
- Modify: `scripts/facebook-poster.mjs:458-487` (generateAllVideos function)

- [ ] **Step 1: Add Gemini credit pre-check before video generation loop**

In `scripts/facebook-poster.mjs`, add a lightweight pre-flight check at the top of `generateAllVideos()`:

```javascript
async function generateAllVideos(posts) {
  const videoPosts = posts.filter(p => p.type === 'video');
  if (!videoPosts.length) return;

  // Pre-flight: test Gemini availability with a tiny request before committing
  // to the full generation loop. If credits are depleted, skip all videos upfront
  // instead of failing each one individually.
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (GEMINI_API_KEY) {
    try {
      const checkRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`
      );
      const checkJson = await checkRes.json();
      if (checkJson.error?.status === 'RESOURCE_EXHAUSTED' || checkJson.error?.code === 429) {
        hopLog('facebook-poster→gemini', 'warn', 'GEMINI PRE-FLIGHT: Credits depleted — skipping all video generation');
        geminiCreditsDepletedFlag = true;
        return;
      }
    } catch (e) {
      hopLog('facebook-poster→gemini', 'warn', `Gemini pre-flight check failed (${e.message}) — will attempt videos anyway`);
    }
  }

  hopLog('facebook-poster', 'info', `Generating ${videoPosts.length} videos upfront...`);
  // ... rest of existing loop
```

- [ ] **Step 2: Verify the pre-flight doesn't block normal operation**

Run: `node scripts/facebook-poster.mjs --check-token`
Expected: Token check works independently of Gemini check.

- [ ] **Step 3: Commit**

```bash
git add scripts/facebook-poster.mjs
git commit -m "fix(facebook): pre-flight Gemini credit check before video loop"
```

---

### Task 3: Surface Video Fallback as Explicit Alert

**Files:**
- Modify: `scripts/facebook-poster.mjs:361-376` (graphDispatch function)
- Modify: `scripts/mav-bridge.mjs:291-332` (post-result processing)

- [ ] **Step 1: Track fallback events in the posting result JSON**

In `scripts/facebook-poster.mjs`, modify the `graphDispatch` function to include fallback info in the return value:

```javascript
async function graphDispatch(post, caption, videoPath, scheduleUnix) {
  return withTokenRetry(`day ${post.day ?? '?'} (${post.type})`, async () => {
    if (post.type === 'video' && videoPath && fs.existsSync(videoPath)) {
      hopLog('facebook-poster→graph', 'info', `Uploading video (${(fs.statSync(videoPath).size / 1e6).toFixed(1)} MB)`);
      return { id: await graphPostVideo(videoPath, caption, scheduleUnix), media: 'video' };
    }
    const fullPhotoPath = resolvePhotoPath(post);
    if (fullPhotoPath) {
      const fallback = post.type === 'video' ? 'video→photo' : null;
      if (fallback) hopLog('facebook-poster→graph', 'info', `Video unavailable — falling back to photo: ${path.basename(fullPhotoPath)}`);
      else hopLog('facebook-poster→graph', 'info', `Uploading photo: ${path.basename(fullPhotoPath)}`);
      return { id: await graphPostPhoto(fullPhotoPath, caption, scheduleUnix), media: 'photo', fallback };
    }
    const fallback = post.type === 'video' ? 'video→text' : post.photo_file ? 'photo→text' : null;
    if (post.photo_file) hopLog('facebook-poster→graph', 'warn', `Photo not found: ${post.photo_file} — posting as text`);
    return { id: await graphPostText(caption, scheduleUnix), media: 'text', fallback };
  });
}
```

- [ ] **Step 2: Alert on fallback events in mav-bridge**

In `scripts/mav-bridge.mjs`, in the post-result parsing section (around line 306), add fallback alerting:

```javascript
// After parsing postResults, check for fallbacks
const fallbacks = postResults.filter(r => r.fallback);
if (fallbacks.length) {
  const summary = fallbacks.map(r => `Day ${r.day}: ${r.fallback}`).join(', ');
  await log(runId, 'facebook', 'warn', `FALLBACK: ${summary}`);
  await notifyAlert({
    runId, actionId: runId, faultType: 'video_fallback',
    title: 'Facebook Video Fallback',
    detail: `${fallbacks.length} post(s) used fallback media: ${summary}`,
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/facebook-poster.mjs scripts/mav-bridge.mjs
git commit -m "fix(facebook): surface video→photo fallback as explicit alert"
```

---

### Task 4: GBP Double-Post Prevention Lock

**Files:**
- Modify: `scripts/gbp-worker.mjs:108-121` (approved post claiming)
- Modify: `scripts/mav-bridge.mjs:341-354` (GBP_ON section)

- [ ] **Step 1: Add atomic claim with `status` guard in gbp-worker**

The current code already does `update({ status: 'posting' }).eq('status', 'approved')` which is an atomic CAS on Supabase. Verify it checks the returned count to confirm the claim succeeded:

```javascript
// In gbp-worker.mjs, replace lines 113-114
const { data: claimed, error: claimErr } = await supabase.from('weekly_posts')
  .update({ status: 'posting' })
  .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved')
  .select('id');
if (claimErr || !claimed?.length) {
  await log(runId, 'gbp', 'warn', `GBP claim race: ${claimErr?.message || 'no rows claimed'} — another worker may own these`);
  continue; // Skip to next poll iteration instead of proceeding
}
await log(runId, 'gbp', 'info', `Claimed ${claimed.length} gbp post(s) for run ${String(runId).slice(0, 8)}`);
```

- [ ] **Step 2: Add the same claim-count check in mav-bridge GBP_ON path**

In `scripts/mav-bridge.mjs`, around line 347:

```javascript
if (GBP_ON) {
  const { data: gbpPosts } = await supabase
    .from('weekly_posts').select('*')
    .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved');
  if (gbpPosts?.length) {
    const { data: claimed } = await supabase.from('weekly_posts')
      .update({ status: 'posting' })
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'approved')
      .select('id');
    if (!claimed?.length) {
      await log(runId, 'gbp', 'info', 'GBP rows already claimed by gbp-worker — skipping');
    } else {
      await runGbpForApprovedRun({
        runId, gbpPosts: gbpPosts.filter(p => claimed.some(c => c.id === p.id)),
        deps: { supabase, runPhase, log, env: process.env, projectRoot: PROJECT_ROOT, paths: GBP_PATHS },
      });
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/gbp-worker.mjs scripts/mav-bridge.mjs
git commit -m "fix(gbp): atomic claim prevents double-posting between worker and bridge"
```

---

### Task 5: Fix Photo Matching — Match on Service Slug

**Files:**
- Modify: `scripts/facebook-poster.mjs:156-168` (curatedPhotoForDate function)
- Modify: `scripts/gbp-photo-pick.mjs:219-225` (serviceSlug function — already exists)

- [ ] **Step 1: Update curatedPhotoForDate to accept a service slug and prefer service-matched photos**

In `scripts/facebook-poster.mjs`, replace the `curatedPhotoForDate` function:

```javascript
function curatedPhotoForDate(date, service) {
  if (!date) return null;
  try {
    const files = fs.readdirSync(GBP_CURATED_FOLDER)
      .filter(f => f.startsWith(`${date}-`) && /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
    if (!files.length) return null;
    // Prefer a file whose slug matches the post's service type
    if (service) {
      const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const match = files.find(f => f.toLowerCase().includes(slug));
      if (match) return path.join(GBP_CURATED_FOLDER, match);
    }
    // Fallback: first file for that date (original behavior)
    return path.join(GBP_CURATED_FOLDER, files[0]);
  } catch { return null; }
}
```

- [ ] **Step 2: Pass service to curatedPhotoForDate in resolvePhotoPath**

```javascript
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
  return curatedPhotoForDate(post.date, post.service);
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/facebook-poster.mjs
git commit -m "fix(facebook): match curated photos by service slug, not just date"
```

---

### Task 6: WordPress Session Validation + Auto-Refresh

**Files:**
- Modify: `scripts/wordpress-action-adapter.mjs:244-262` (wpRest function area)

- [ ] **Step 1: Add session validation before REST API calls**

In `scripts/wordpress-action-adapter.mjs`, add a session health check function and call it before REST operations:

```javascript
async function ensureWpSession(config) {
  const auth = wpRestAuth();
  const url = normalizeBaseUrl(config.site_url) + '/wp-json/wp/v2/users/me?_fields=id,name';
  try {
    const res = await fetch(url, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`WordPress auth failed (${res.status}). Check WP_USERNAME and WP_APP_PASSWORD in .env.`);
    }
    if (!res.ok) {
      throw new Error(`WordPress REST /users/me returned ${res.status}`);
    }
    return true;
  } catch (e) {
    console.error(JSON.stringify({
      adapter: 'wordpress-action-adapter',
      status: 'auth_error',
      message: e.message,
    }));
    throw e;
  }
}
```

- [ ] **Step 2: Call ensureWpSession before wp_rest_create_post and wp_rest_update_post**

Add the call at the top of the `wpRestCreatePost` and `wpRestUpdatePost` functions (or in the main dispatch before those capabilities execute).

- [ ] **Step 3: Commit**

```bash
git add scripts/wordpress-action-adapter.mjs
git commit -m "fix(wordpress): validate REST session before post creation"
```

---

### Task 7: FFmpeg Existence Check at Startup

**Files:**
- Modify: `scripts/facebook-poster.mjs:382-411` (addBrandedEndCard function area)

- [ ] **Step 1: Add FFmpeg check near the top of the file, after config**

```javascript
// After line 94 (const VIEWPORT = ...)
let HAS_FFMPEG = false;
try {
  execFileSync('ffmpeg', ['-version'], { timeout: 5000, encoding: 'utf8', stdio: 'pipe' });
  HAS_FFMPEG = true;
} catch {
  hopLog('facebook-poster', 'warn', 'FFmpeg not found — branded end cards will be skipped for all videos this run');
}
```

- [ ] **Step 2: Use HAS_FFMPEG flag in addBrandedEndCard**

```javascript
function addBrandedEndCard(rawPath, finalPath) {
  if (!HAS_FFMPEG) {
    fs.renameSync(rawPath, finalPath);
    return;
  }
  const cardSrc = fs.existsSync(ENDCARD_PATH) ? ENDCARD_PATH : LOGO_PATH;
  // ... rest unchanged
```

- [ ] **Step 3: Commit**

```bash
git add scripts/facebook-poster.mjs
git commit -m "fix(facebook): check FFmpeg at startup, warn once instead of per-video"
```

---

### Task 8: Excel File-Lock Retry Loop for GBP

**Files:**
- Modify: `scripts/lib/gbp-runner.mjs:68-115` (markGbpPostedAndArchive)

- [ ] **Step 1: Add a retry wrapper for Excel file operations**

In `scripts/lib/gbp-runner.mjs`, add a helper before `markGbpPostedAndArchive`:

```javascript
async function withExcelRetry(filePath, fn, { maxRetries = 6, delayMs = 5000, log, runId } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLock = /EBUSY|EPERM|locked|sharing violation/i.test(e.message);
      if (!isLock || attempt === maxRetries) throw e;
      if (log) await log(runId, 'gbp', 'warn', `Excel file locked (attempt ${attempt}/${maxRetries}), retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
```

- [ ] **Step 2: Wrap the xlsx.readFile/writeFile calls in withExcelRetry**

```javascript
// Inside markGbpPostedAndArchive, wrap the try block:
await withExcelRetry(GBP_WORKBOOK_PATH, async () => {
  const workbook = xlsx.readFile(GBP_WORKBOOK_PATH);
  // ... existing logic ...
  xlsx.writeFile(workbook, GBP_WORKBOOK_PATH);
}, { log, runId });
```

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/gbp-runner.mjs
git commit -m "fix(gbp): retry Excel writes on file lock (up to 30s)"
```

---

### Task 9: Validate Topic Queue Has 7 Items

**Files:**
- Modify: `scripts/facebook-poster.mjs:127-152` (parseScheduleText)
- Modify: `scripts/gbp-photo-pick.mjs:80-104` (parseSchedule)

- [ ] **Step 1: Add validation after parsing both schedule files**

In both parsers, add a post-parse check. For `facebook-poster.mjs`:

```javascript
// At the end of the main() function, after parsing the schedule
const posts = parseSchedule(SCHEDULE_FILE);
if (posts.length < 7) {
  hopLog('facebook-poster', 'warn', `Schedule has only ${posts.length} days (expected 7) — some days may be missing`);
}
if (posts.length === 0) {
  hopLog('facebook-poster', 'error', 'No posts found in schedule — aborting');
  process.exit(1);
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/facebook-poster.mjs scripts/gbp-photo-pick.mjs
git commit -m "fix(schedule): validate topic queue has 7 items before posting"
```

---

### Task 10: Post-Hoc Facebook Verification via Graph API

**Files:**
- Modify: `scripts/mav-bridge.mjs:450-461` (Facebook reconciliation section)

- [ ] **Step 1: Add Graph API read-back before marking scheduled posts as posted**

```javascript
// Replace the optimistic reconciliation with a verified one
for (const post of pastFb || []) {
  let verified = false;
  if (post.platform_post_id && FB_PAGE_ACCESS_TOKEN) {
    try {
      const checkRes = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${post.platform_post_id}?fields=id,is_published&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`
      );
      const checkJson = await checkRes.json();
      verified = !checkJson.error && checkJson.is_published !== false;
    } catch {
      // Network error — fall back to optimistic
      verified = true;
    }
  } else {
    // No post ID to verify — trust the schedule
    verified = true;
  }
  if (verified) {
    await supabase.from('weekly_posts')
      .update({ status: 'posted', posted_at: new Date().toISOString() })
      .eq('id', post.id);
    console.log(`[mav-bridge][fb-reconcile] ${post.post_date} verified + marked posted`);
  } else {
    await supabase.from('weekly_posts')
      .update({ status: 'error', error: 'Scheduled post not found on Facebook — may have been deleted' })
      .eq('id', post.id);
    console.log(`[mav-bridge][fb-reconcile] ${post.post_date} NOT found on Facebook — marked error`);
  }
}
```

- [ ] **Step 2: Import GRAPH_API_VERSION and FB_PAGE_ACCESS_TOKEN at the top of mav-bridge**

These are already available via the imported `checkFacebookToken` — just add the version constant:

```javascript
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
```

- [ ] **Step 3: Commit**

```bash
git add scripts/mav-bridge.mjs
git commit -m "fix(bridge): verify Facebook scheduled posts via Graph API before marking posted"
```

---

### Task 11: WordPress Auto-Create Missing Tags

**Files:**
- Modify: `scripts/wordpress-action-adapter.mjs:276-294` (parseDraftFromDeliverable area)

- [ ] **Step 1: Add tag resolution/creation function**

```javascript
async function resolveOrCreateTags(baseUrl, tagNames) {
  if (!tagNames?.length) return [];
  const ids = [];
  for (const name of tagNames) {
    const existing = await wpRest(baseUrl, 'GET', `tags?search=${encodeURIComponent(name)}&_fields=id,name`);
    const match = existing.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (match) {
      ids.push(match.id);
    } else {
      try {
        const created = await wpRest(baseUrl, 'POST', 'tags', { name });
        ids.push(created.id);
      } catch (e) {
        console.error(`[wordpress-adapter] Could not create tag "${name}": ${e.message}`);
      }
    }
  }
  return ids;
}
```

- [ ] **Step 2: Use resolveOrCreateTags in the blog post creation path**

In the `wpRestCreatePost` or equivalent function, before creating the post, resolve tags:

```javascript
if (draft.tags?.length) {
  draft.tags = await resolveOrCreateTags(config.site_url, draft.tags);
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/wordpress-action-adapter.mjs
git commit -m "fix(wordpress): auto-create missing tags before post creation"
```
