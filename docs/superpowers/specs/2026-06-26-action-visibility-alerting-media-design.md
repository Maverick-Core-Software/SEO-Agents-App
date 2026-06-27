# Design: Actionable Status, Non-Silent Alerting & Media-Pipeline Fix

**Date:** 2026-06-26
**Status:** Approved design — pending implementation plan
**Repos touched:** `SEO-Agents-App` (mav-bridge + media scripts), `MCC` (dashboard pages + seo route), `grizzly-hcp` (new send-only iMessage helper)

---

## 1. Problem

Two intertwined deficiencies, sharing one root field (`weekly_posts.photo_file`):

### 1a. The dashboard hides what's happening
The MCC homepage "Upcoming Actions" card and the SEO Pipeline page show almost nothing —
typically just "needs approval". They give no task description, no priority, no agent, and no
real status. Anything that is executing, failed, or stuck is invisible.

**Root cause:** the `/seo/actions` endpoint in `scripts/mav-bridge.mjs` (the data source for both
pages) throws away the rich data that already exists in Supabase. It hardcodes
`status: 'needs_approval'`, drops `description`/`priority`, derives no agent, and only queries
`pending_approval` rows — so active and failed work never appears.

### 1b. Media silently drops from social posts (LIVE BUG)
GBP posts are supposed to carry a curated photo every day; Facebook posts are supposed to carry a
Gemini/Veo video on days 1, 4, and 7. Confirmed from the run executing 2026-06-26 and the prior
completed run:

- **Facebook went out as plain text — all 7 days, no photo, no video.** Two stacked bugs:
  1. **Gemini prepay credits depleted** → every video day (1/4/7) logs
     `GEMINI CREDITS DEPLETED — will post without video`, falls back to photo, but FB video days
     carry **no fallback photo** (`PHOTO_FILE: *(blank)*`) → text-only.
  2. **Backtick contamination** → the content agent writes `` **PHOTO_FILE:** `name.JPG` `` with
     markdown code-ticks. The FB schedule parser's `stripMd` strips `**` but not backticks, so it
     looks for a file literally named `` `name.JPG` `` → not found → text. The real files **exist**
     in `C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos` (verified); backticks are the
     only reason photo days failed.
- **GBP partially works** — the current run uses the correct new picker (`gbp-photo-pick.mjs`); an
  older run still hit the dead `photo-matcher.mjs`/`photo-scanner.mjs` and threw
  `Post image not found`, failing whole posts.
- **`weekly_posts.photo_file` records garbage** — `"VIDEO_PROMPT: …"` text, backticked names,
  `"*(blank)"`. This is exactly the field the action card needs, so even successful media can't be
  shown and missing media can't be detected.

### Requirements (from the user)
- Each action shows: description, priority, assigned agent, and a status of **Pending / In Process /
  Completed / Failed**.
- Any **failed** or **stuck too long** action triggers an alert — never silent. Delivery =
  in-dashboard **banner** + **Photon iMessage** (the SDK already present in `grizzly-hcp`).
- Same info on the SEO Pipeline page, **no double alerts** (single deduped alert shown on both).
- The SEO Pipeline page needs a real **description**, not a cryptic title ("claim google business"
  was meaningless to the owner).
- Card scope: **active + recent failures** (hide completed, or collapse under a count).
- Stuck threshold is **per action type** — there is no single standard time.
- GBP/Facebook posts must carry their media; media drops must be caught, not silent.

---

## 2. Architecture overview

```
Supabase (seo_runs, weekly_posts, website_tasks, run_logs)
   │
   ▼
mav-bridge.mjs  ──/seo/actions──►  MCC routes/seo.mjs ──►  HomePage.jsx + SEOApprovalPage.jsx
   │  (enriched payload: status bucket, description,            (render badges, media indicator,
   │   priority, agent, media_status, alerts[])                  single shared banner from alerts[])
   │
   ├─ poll() loop: detect failed + stuck (per-type thresholds) ─► alerts[]  +  iMessage
   │                                                                          │
   └─ media scripts (gbp-photo-pick, facebook-poster, gemini-video) ─────────┘
                                                                      spawn
                                          grizzly-hcp/scripts/notify-imessage.ts (Spectrum send-only)
```

The bridge is the single enrichment + detection point. Both UI pages are pure consumers. The
iMessage notifier is a thin spawn into grizzly-hcp so Photon creds live in exactly one repo.

---

## 3. Enriched `/seo/actions` payload

**File:** `scripts/mav-bridge.mjs`, `GET /seo/actions` handler (currently ~lines 802–843).

Broaden the queries from `pending_approval`-only to **active + recent failures**:

- `seo_runs`: statuses in `pending_approval, approved, awaiting_prompt, research_running,
  execute_running, executing, error` plus `done` within the last 48h.
- `weekly_posts`: statuses in `pending_approval, approved, scheduled, posting, error,
  needs_verification` plus `posted` within the last 48h.
- `website_tasks`: statuses in `pending_approval, approved, executing, error` plus `done` within
  the last 48h.

Each action object returns:

```jsonc
{
  "id": "…",
  "type": "seo_run | weekly_post | website_task",
  "title": "…",                 // human title
  "description": "…",           // §4 — DB description, else type-fallback
  "priority": "critical|high|medium|low",
  "status": "pending|in_process|completed|failed",   // §5 bucket
  "status_detail": "error|needs_verification|stuck|posting|…", // raw, for tooltip
  "assigned_agent": "…",        // §4 — derived from type/platform
  "platform": "gbp|facebook|website_cms|…",
  "media_status": "video|photo|downgraded|none|n/a",  // §6
  "error": "…|null",
  "executing_since": "ISO|null",
  "updated_at": "ISO"
}
```

Plus a top-level `alerts[]` (see §7) and the existing `summary`.

### 3a. Status taxonomy (4 buckets)

| Bucket          | DB statuses |
|-----------------|-------------|
| **pending**     | `pending_approval`, `approved`, `awaiting_prompt`, `scheduled` |
| **in_process**  | `executing`, `posting`, `research_running`, `execute_running` |
| **completed**   | `done`, `posted` |
| **failed**      | `error`, `needs_verification`, **+ computed `stuck`** |

A single `bucketStatus(dbStatus, executingSince, type)` helper in the bridge. `stuck` is computed
(§5) and surfaces as `status: "failed", status_detail: "stuck"`.

---

## 4. Descriptions & agent derivation

The bare titles are meaningless to the owner. A `description` is filled from the DB column when
present, else a **type fallback** so nothing is ever just a cryptic title. Agent names reuse the
existing taxonomy in `src/seo_agents/actions.py` (`_platform_for_action`, executor names).

| type / platform          | Fallback description                                                              | assigned_agent |
|--------------------------|----------------------------------------------------------------------------------|----------------|
| `seo_run`                | "Full weekly SEO run: research + content generation for the next 7 days."         | SEO Crew |
| `gbp_profile_update`     | "Update Grizzly's Google Business Profile (hours, services, info) — not a re-claim." | GBP Profile Agent |
| `publish_gbp_post`       | "Publish a scheduled Google Business post for {date}."                             | Grizzly GBP Poster Agent |
| `publish_facebook_post`  | "Publish a Facebook post for {date} ({media_status})."                             | Facebook Poster Agent |
| `website_technical_change` | "Technical SEO change on grizzlyheating.com."                                    | Website Agent |
| `website_content_publish`/`website_blog_post` | "Publish website content / blog post."                       | Website Content Agent |
| `review_management`      | "Request or respond to customer reviews."                                          | Review Agent |

Fallback map lives in the bridge (single source for the payload). DB `description` always wins.

---

## 5. Stuck detection (per action type)

In the `poll()` loop (`scripts/mav-bridge.mjs` ~line 556). For each row still `in_process`,
`stuck = now − executing_since > STUCK_THRESHOLDS[type]`.

```js
const STUCK_THRESHOLDS = {
  website_task:        15 * 60 * 1000,  // quick CMS edits
  weekly_post_gbp:     20 * 60 * 1000,  // photo pick + browser post
  weekly_post_facebook:60 * 60 * 1000,  // up to 3 Veo renders (~13 min each)
  seo_run:             90 * 60 * 1000,  // whole crew pipeline
};
```

`executing_since` source: prefer an existing timestamp column; if none reliably tracks the
transition into an executing state, set it when the bridge flips a row to `executing`/`posting`.
(Plan step will confirm which column to use or add.)

ponytail: static map, not per-row config — ceiling is one-size-per-type; upgrade path is a DB column
if tuning per action is ever needed.

---

## 6. Media-pipeline fixes

### 6a. Strip backticks + `*(blank)*` in schedule parsers
- `scripts/facebook-poster.mjs` — `stripMd()` (line ~122) and/or the `PHOTO_FILE` read in
  `parseScheduleText()` (line ~130): strip surrounding backticks and treat `*(blank)*`/empty as
  "no file".
- `scripts/gbp-photo-pick.mjs` `parseSchedule()` and the GBP driver path: same normalization, so a
  bare `` `name.JPG` `` resolves to `name.JPG`.
- **One small shared helper** `normalizePhotoFile(raw)` to avoid divergence.

### 6b. FB video-day photo fallback
When Veo generation fails (credits or error), the video day must fall back to its **matched photo**,
not text. Requires the FB schedule to carry a real `PHOTO_FILE` for video days (today it's blank).
Options to resolve in the plan: (a) have the FB schedule generator assign a photo to video days too,
or (b) have the poster pull a same-service photo from the GBP curated/photos folder as fallback.
Recommended: (b) reuse the curated pool so no schedule-format change is needed.

### 6c. Truthful `media_status` + clean `photo_file`
The poster/bridge write a normalized `photo_file` (no backticks, no prompt text) and a new
`media_status` per `weekly_posts` row:
- `video` — video attached
- `photo` — photo attached (text/photo day)
- `downgraded` — was a video day, posted with photo (Veo failed)
- `none` — posted as text, no media (a fault → alert)

`media_status` drives the card's media indicator and the "media dropped" alert. Add the column via
a Supabase migration (`alter table weekly_posts add column media_status text`).

### 6d. Verify GBP picker migration
After the current run completes, confirm `photo-matcher.mjs`/`photo-scanner.mjs` are no longer
referenced by any live path (only `gbp-photo-pick.mjs` should run). Remove dead callers if found.

### 6e. Gemini credits (owner action)
Top up prepay at https://aistudio.google.com/. Out of code scope. Code guarantees graceful photo
fallback (6b) + a loud alert (§7), not a video.

---

## 7. Alerting (banner + iMessage, deduped)

### 7a. Single source, no double alerts
The bridge computes `alerts[]` once and returns it in the `/seo/actions` payload. Each alert:

```jsonc
{ "id": "<action_id>:<fault_type>", "severity": "error|warn",
  "title": "…", "detail": "…", "action_id": "…", "fault_type": "failed|stuck|media_none|media_downgraded|token|credits" }
```

Both HomePage and SEOApprovalPage render the **same** `alerts[]` into the existing
`faults`/`runHealthAlert` banner surface (`MCC/src/pages/HomePage.jsx` ~lines 281–299). Because both
pages read the one array, the alert shows on both with no duplication.

### 7b. iMessage delivery (Photon, via grizzly-hcp)
**Decision:** spawn a send-only helper in grizzly-hcp; reuse its existing Spectrum client + creds.

- New file: `grizzly-hcp/scripts/notify-imessage.ts`
  - Reads `PROJECT_ID`, `PROJECT_SECRET`, `CARTER_PHONE` from grizzly-hcp `.env`.
  - `const app = await Spectrum({ projectId, projectSecret, providers:[imessage.config()] })`
  - `await imessage(app).space.create(CARTER_PHONE).send(text)` (the proactive-send path).
  - CLI: `tsx scripts/notify-imessage.ts "<message>"`; exits non-zero on failure.
- mav-bridge fires it from `poll()` when a new fault appears, via `execFile('npx', ['tsx',
  'scripts/notify-imessage.ts', msg], { cwd: GRIZZLY_HCP_DIR })` (cwd = grizzly-hcp so its `.env`
  and `node_modules` load). Wrapped so a send failure only logs — never blocks the loop.

ponytail: cold-start a Spectrum client per alert (~seconds). Ceiling: not for high-frequency alerts;
upgrade path is a long-running send service under PM2 if volume ever grows.

### 7c. Dedup / no spam
A `notified` set persisted to `state/alerted.json`, keyed `(<run_id>:<action_id>:<fault_type>)`.
An alert fires (banner is always live; iMessage once) only the first time a fault is seen. Cleared
when the action leaves the failed/stuck state. Survives reboot and repeated polls.

### 7d. Config needed from owner
`CARTER_PHONE` in `grizzly-hcp/.env` is currently empty — owner provides the destination
number/handle. Until set, the helper no-ops with a logged warning (banner still works).

---

## 8. UI changes (both pages)

Both pages converge on the enriched payload and a shared row component:

- **Fields shown:** title, description, priority chip (color by level), assigned agent, 4-state
  status badge (pending=grey, in_process=blue, completed=green, failed=red), media indicator
  (✅ photo / 🎬 video / ⚠️ downgraded / ⛔ none / —).
- **Scope:** active + recent failures; completed items collapsed under a "N completed" toggle.
- **Banner:** shared `alerts[]` at top of each page (§7a).
- **Field-name convergence:** HomePage currently reads `title/assigned_agent/risk`; SEOApprovalPage
  reads `label/type`. Both move to the new payload field names. A single `ActionRow` component
  shared (or duplicated minimally) so the two pages stay consistent.

**Files:** `MCC/src/pages/HomePage.jsx`, `MCC/src/SEOApprovalPage.jsx`,
`MCC/routes/seo.mjs` (pass-through stays; no mapping needed since the bridge now enriches).

---

## 9. Out of scope / explicit non-goals

- Topping up Gemini credits (owner action).
- A long-running Photon send service under PM2 (deferred; on-demand spawn is enough now).
- Per-row configurable stuck thresholds (static map for now).
- Reworking the FB schedule markdown format (fallback uses the curated photo pool instead).
- The elevated on-machine task / PM2-boot setup (tracked separately — reboot-resilience).

---

## 10. Verification (one runnable check per non-trivial unit)

- **Parser normalization:** a self-check asserting `normalizePhotoFile("`a.JPG`") === "a.JPG"`,
  `normalizePhotoFile("*(blank)*") === ""`, and that `parseScheduleText` yields a resolvable path
  for a backticked fixture block.
- **Status bucketing:** assert `bucketStatus()` maps each DB status to the right bucket and that an
  old `executing_since` yields `stuck` for the right per-type threshold.
- **Alert dedup:** assert the same `(run,action,fault)` does not produce a second iMessage spawn.
- **Payload smoke:** hit `/seo/actions` against the live bridge and assert every action has
  non-empty `description`, a valid `status` bucket, and an `assigned_agent`.
- **iMessage helper:** `tsx notify-imessage.ts "test"` with a real `CARTER_PHONE` delivers (manual,
  owner-confirmed once).
