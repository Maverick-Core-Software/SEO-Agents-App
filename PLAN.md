# PLAN — GBP Native Scheduling (post Day 1, schedule Days 2–7)

**Date:** 2026-07-11
**Planner:** Claude Fable (frontier) · **Executor:** Qwen (qwen3.6-35b-a3b via qwen-executor) · **Orchestrator:** Opus/Sonnet
**Repo:** SEO-Agents-App · `C:/Workspace/Active/SEO-Agents-App` · **Branch:** `feat/gbp-native-schedule` (create from `main`)

**Goal:** On an approved weekly run, the GBP worker posts Day 1 immediately (unchanged) and then uses Google Business Profile's **native "Schedule this post" toggle** to schedule Days 2–7 inside the same approved-run handling — one Playwright burst on Day 1 instead of a live posting run every morning. The daily 9am pass becomes **verification-only** for natively scheduled days. Google's servers publish the posts; our reliability no longer depends on the worker being alive at 9am.

**Also in scope:** every post (Day 1 and scheduled) gets a native **"Learn more" CTA button** linking to the topically matching service page on grizzlyelectricaltx.com (config-driven map, homepage fallback).

**Locked decisions (do not revisit):**
0. CTA type is always **Learn more**; URL resolution is config-only (no workbook/Supabase/pipeline changes). A CTA failure must never block the post — degrade to posting without the button.
1. Scheduled publish time is **9:00 AM** (business-local/Central) for every scheduled day.
2. If natively scheduling a given day fails, that day falls back to the **old daily-post path** (status `scheduled`) — the fallback code already exists and stays.
3. New Supabase status **`scheduled_native`** = "Google owns publishing this post; we only verify."
4. Photo archiving + Excel `Posted=TRUE` for natively scheduled days happen when the **daily verification confirms** the post is live — not at schedule time.
5. Current in-flight week finishes on the old path. New behavior starts with the next approved run. No migration of existing rows.

---

## How to Read This Plan (blueprint mode)

This plan is a **specification, not a code dump**. You (Qwen) write the actual JS.

- **CONTRACT blocks** must be reproduced verbatim: locator expressions, status strings, JSON result shapes, commit messages, verification commands.
- **Anchors** are verbatim strings from the current files — find them with grep; line numbers are approximate.
- Match the existing style of each file (JSDoc-ish comments explaining *why*, `logStep` for driver progress, `await log(...)` in runner/worker).
- Every task ends with verification commands + expected output. Run them. If output doesn't match: one focused fix attempt, then STOP and report.

---

## Codebase Primer

### The pipeline today

`gbp-worker.mjs` (Windows Scheduled Task, user session, polls Supabase every 30s) has three duties per poll:
1. **Approved-run path** — claims `weekly_posts` rows (`platform='gbp'`, `status='approved'`) via CAS to `posting`, then calls `runGbpForApprovedRun` (in `scripts/lib/gbp-runner.mjs`): photo curation → Excel sync → `mark-gbp-approved` for all 7 dates → **posts Day 1 via driver** → bulk-updates Days 2–7 to `status='scheduled'`.
2. **Daily path** — once per day at ≥9am Central (`centralDateHour`), calls `runDailyGbp`: posts each row with `status='scheduled'` and `post_date=today` via the driver.
3. **Verify sweep** — seeds `verifyQueue` from rows in `['posted','needs_verification']` with null `platform_post_id` (last 24h), waits 10 min, retries every 15 min ×4 via `verify-gbp-posts.mjs`, marks `error` if never confirmed. On success, `verify-gbp-posts.mjs` itself writes `platform_post_id` + `posted_at` to Supabase.

`scripts/gbp-poster/driver.mjs` is the Playwright driver (one invocation = one date). Exit codes: `0` posted+verified, `3` submitted-but-unverified, `4` approval gate not stamped, `1` failed. It prints step logs to **stderr** and exactly one JSON result line to **stdout** (`emitResult`). `parseArgs` handles `--dry-run --auth --headless --date --config`. `composeAndSubmit` opens the composer, fills description, attaches image, clicks Post; the `submitted` flag guarantees **no retry after the Post click** (duplicate guard). `getComposerCtx` resolves the composer context: dialog → iframe (`iframe[src*="promote/updates/add"]`) → page. **On this account the composer lives in the iframe** (verified 2026-07-11); all new locators must go through `ctx`, never `page`.

`scripts/lib/gbp-runner.mjs` maps driver exits to row updates (`gbpDailyStatusForExit`), applies them (`applyDriverResult`), owns Excel/photo archiving (`markGbpPostedAndArchive`), and hosts `runGbpForApprovedRun` / `runDailyGbp`.

Tests: `node scripts/lib/gbp-runner.test.mjs` — plain-assert script with chainable Supabase stubs; mirrors its patterns for new tests.

### Schedule-UI contract (CONTRACT — recon-verified live 2026-07-11, nothing guessed)

Inside the composer context `ctx` (iframe), after description + image are set:

| Control | Locator (verbatim) | Behavior |
|---|---|---|
| Toggle | `ctx.getByRole('switch', { name: 'Schedule post' })` | Click once. Assert `aria-checked` becomes `'true'`. Reveals Date + Time fields. |
| Date | `ctx.getByRole('combobox', { name: /Date/i }).first()` | Click, select-all (`Control+A`), `page.keyboard.insertText('MM/DD/YYYY')`, press `Tab`. Read back with `.inputValue()` — must equal the typed string exactly (verified: typing `07/15/2026` reads back `07/15/2026`). |
| Time | `ctx.getByRole('combobox', { name: 'Time' }).first()` | Click to open the options list, then click `ctx.getByRole('option', { name: /^9:00[\s ]*AM$/ }).first()`. Google renders `9:00 AM` with **U+202F narrow no-break space** before AM — any read-back/match must tolerate `[\s ]`. |
| Submit | unchanged — existing `clickComposerPost` | The button is still named exactly `Post` when scheduling. Composer closing = accepted. |

Date format is `MM/DD/YYYY` (US locale, zero-padded). Convert from ISO `yyyy-mm-dd` post_date.

**ASSUMPTION to confirm on first real run:** GBP schedules in the business's local timezone (Central). Expected: Day-2 post goes live at 9:00 AM CT.

### CTA-UI contract (CONTRACT — recon-verified live 2026-07-11, nothing guessed)

Inside the same composer context `ctx`, under "Add more details":

| Step | Locator (verbatim) | Behavior |
|---|---|---|
| Reveal | `ctx.locator('button[aria-label="Add link fields"]').first()` | Visible text is "Button". Click reveals heading `Add a button (optional)` + a type button named `None`. |
| Type menu | `ctx.getByRole('button', { name: 'None' }).first()` | Click opens a **frame-scoped** menu of `role=menuitem`: None, Book, Order online, Buy, Learn more, Sign up, Call now. |
| Pick type | `ctx.getByRole('menuitem', { name: 'Learn more' }).first()` | Click. The type button's accessible name changes from `None` to `Learn more` and a URL field appears. |
| URL | `ctx.getByRole('textbox', { name: /Link for your button/ }).first()` | An `input[type="url"]`. Click, `page.keyboard.insertText(url)`. Read back with `.inputValue()` — must equal the typed URL exactly (verified with `https://www.grizzlyelectricaltx.com/`). |

CTA is set **before** the schedule toggle and before `submitted = true` — it is pre-submit and therefore safe to fail/retry.

### CTA URL resolution (CONTRACT)

Config-only — no workbook/Supabase columns. Add to `config/gbp-poster.config.json` (verbatim keys/values; live slugs verified against the site's sitemap 2026-07-11):

```json
"default_cta_url": "https://www.grizzlyelectricaltx.com/",
"cta_url_map": {
  "panel": "https://www.grizzlyelectricaltx.com/panel-upgrades/",
  "breaker": "https://www.grizzlyelectricaltx.com/panel-upgrades/",
  "charger": "https://www.grizzlyelectricaltx.com/ev-charger-installation/",
  "generator": "https://www.grizzlyelectricaltx.com/generator-inlet-installation/",
  "lighting": "https://www.grizzlyelectricaltx.com/recessed-lighting/",
  "commercial": "https://www.grizzlyelectricaltx.com/commercial-electrical/",
  "troubleshoot": "https://www.grizzlyelectricaltx.com/electrical-troubleshooting/",
  "flicker": "https://www.grizzlyelectricaltx.com/electrical-troubleshooting/"
}
```

Resolution rule: search `topic + ' ' + caption` (lowercased) for each `cta_url_map` key **in insertion order — first match wins**; no match → `default_cta_url`; if both config fields are absent → `null` (no CTA; backwards compatible).

### Status flow after this change

```
approved ─claim→ posting ─┬ day 1:  driver --date D1            → posted / needs_verification / error   (unchanged)
                          └ days 2-7: driver --date Dn --schedule
                                        exit 0 → scheduled_native
                                        exit 3 → scheduled_native  (+ error note "schedule unconfirmed")
                                        exit 4 → pending_approval
                                        else   → scheduled         (old daily path posts it — fallback)

daily ≥9am Central:
  status='scheduled'        & post_date=today → driver posts it (unchanged fallback)
  status='scheduled_native' & post_date=today → flip row to status='posted', posted_at=now,
                                                platform_post_id=null  (NO driver run)
                                                → existing verify sweep picks it up 10 min later
verify sweep success → markGbpPostedAndArchive (Excel Posted=TRUE + photo → archive)  [NEW hook]
verify sweep failure ×4 → status='error' (existing; mav-bridge alerting fires)
```

Duplicate-guard rule (same spirit as `submitted` in `composeAndSubmit`): once the Post click happened in schedule mode, a failure must map to `scheduled_native`-with-note, **never** to the `scheduled` fallback — a fallback repost of an actually-scheduled day would double-post.

### Files touched

| File | Change |
|---|---|
| `scripts/gbp-poster/driver.mjs` | `--schedule` flag; `setComposerSchedule(ctx, page, isoDate)`; schedule branch in `main()` (no live verification); `resolveCtaUrl` + `setComposerCta` (all posts) |
| `config/gbp-poster.config.json` | `default_cta_url` + `cta_url_map` fields |
| `scripts/lib/gbp-runner.mjs` | `gbpScheduleStatusForExit`; per-day scheduling loop replacing the Days-2–7 bulk update; `scheduled_native` handling in `runDailyGbp` |
| `scripts/lib/gbp-runner.test.mjs` | new assertions for both |
| `scripts/gbp-worker.mjs` | verify-success → `markGbpPostedAndArchive` hook |
| `docs/runbooks/gbp-worker.md` | document the new flow |

Before starting each session:
```bash
cd /c/Workspace/Active/SEO-Agents-App && git status
```
Session 1 additionally: `git checkout -b feat/gbp-native-schedule main`. Expected: clean tree on the branch.

---

## Session 1 — Driver schedule mode + CTA button (Tasks 1–4)

### - [ ] Task 1: `--schedule` flag + `setComposerSchedule`

In `scripts/gbp-poster/driver.mjs`:

1. **parseArgs** (anchor: `const args = { dryRun: false, auth: false, headless: false, date: null, config: DEFAULT_CONFIG };`): add `schedule: false` to the defaults object and an `else if (arg === '--schedule') args.schedule = true;` branch, matching the existing style.
2. Near the other top-of-file consts (anchor: `const POST_ATTEMPTS = 2;`), add:
```js
// ponytail: schedule time is fixed at 9:00 AM business-local; make it a config
// field if a second time is ever needed.
const SCHEDULE_TIME_LABEL = /^9:00[\s ]*AM$/;
```
3. New async function `setComposerSchedule(ctx, page, isoDate)` placed between `fillComposerDescription` and `clickComposerPost`. Spec:
   - Convert `isoDate` (`yyyy-mm-dd`) to `MM/DD/YYYY`.
   - Toggle, date, and time exactly per the **Schedule-UI contract** table in the primer (locators verbatim; keyboard flow: click → `Control+A` → `insertText` → `Tab`).
   - After the toggle click, wait for the switch's `aria-checked` to be `'true'`; throw a descriptive `Error` if not (message should say the schedule toggle did not engage — it will classify as `ui_changed_or_timeout`, which is RETRYABLE and safe: this runs before the Post click).
   - After typing the date, assert read-back equals the typed string; throw with the actual value in the message otherwise.
   - After picking the time option, read the Time combobox back and assert it matches `SCHEDULE_TIME_LABEL` (tolerant regex); throw otherwise.
   - `logStep(...)` at each stage like neighboring functions.
4. **composeAndSubmit** (anchor: `async function composeAndSubmit(page, payload) {`): give it a third parameter `schedule = false`. Inside the try, after the `attachImage` block and **before** `submitted = true`, add: `if (schedule) await setComposerSchedule(ctx, page, payload.date);`. Everything else (retry loop, duplicate guard) untouched.

### - [ ] Task 2: "Learn more" CTA button on every post

1. **Config** — add the `default_cta_url` and `cta_url_map` fields to `config/gbp-poster.config.json` exactly per the **CTA URL resolution** contract in the primer (keep the file's existing fields and JSON formatting untouched).
2. **`resolveCtaUrl(payload, config)`** — new small pure function in `scripts/gbp-poster/driver.mjs`, near `buildPayload`. Implements the resolution rule from the contract: lowercase haystack of `payload.topic` + `' '` + `payload.caption` (tolerate either being missing), iterate `Object.entries(config.cta_url_map ?? {})`, first key contained in the haystack wins, else `config.default_cta_url ?? null`.
3. **`setComposerCta(ctx, page, url)`** — new async function next to `setComposerSchedule`. Follows the **CTA-UI contract** table step by step (locators verbatim; `logStep` each stage). After typing the URL, assert `.inputValue()` read-back equals `url`; throw a descriptive `Error` otherwise.
4. **composeAndSubmit wiring** — inside the try, after the `attachImage` block and **before** the schedule call / `submitted = true`:
```js
if (payload.ctaUrl) {
  try {
    await setComposerCta(ctx, page, payload.ctaUrl);
  } catch (err) {
    // ponytail: CTA is nice-to-have — never let it block the post.
    logStep(`CTA failed (${err.message}) — posting without button`);
  }
}
```
   Populate `payload.ctaUrl` via `resolveCtaUrl` where the payload is built (anchor: `buildPayload`) so both normal and schedule modes get it.
5. **Dry-run** — include `cta: payload.ctaUrl` in the existing `mode:` preview JSON, and add a `cta` field to both the `dry_run` and `schedule_dry_run` result objects.

### - [ ] Task 3: schedule branch in `main()`

1. Pass the flag through at the call site (anchor: `await composeAndSubmit(page, payload);`) → `await composeAndSubmit(page, payload, args.schedule);`.
2. Branch the post-submit handling on `args.schedule`:
   - **Schedule mode skips `verifyPosted` entirely** — the post is not live yet, the existing 5×60s live check would always fail. Composer-closed-without-error (which `composeAndSubmit` already guarantees) *is* the confirmation.
   - Success: `emitResult` (CONTRACT shape) and exit 0:
```js
{ result: 'scheduled_native', date: payload.date, scheduledTime: '9:00 AM', verified: false, postUrl: null }
```
   - The catch block, schedule mode only: if the error was thrown **after submission** (composeAndSubmit rethrows with `submitted` truth known only internally — detect via a small change: have `composeAndSubmit` attach `e.submitted = true` to errors thrown post-submit, in both modes), emit `{ result: 'schedule_unconfirmed', date: payload.date, ... }` and `process.exitCode = 3`. Pre-submit errors keep the existing `failed` result / exit 1 path.
   - Non-schedule mode behavior must be byte-for-byte unchanged.
3. Dry-run (anchor: `if (args.dryRun) {`): when `args.schedule` is also set, emit `{ result: 'schedule_dry_run', date: payload.date, scheduledTime: '9:00 AM', verified: false, postUrl: null, cta: payload.ctaUrl }` instead of the existing `dry_run` result. Also include `schedule: args.schedule` in the existing `mode:` preview JSON.

### - [ ] Task 4: Session 1 verification + commit

```bash
node --check scripts/gbp-poster/driver.mjs && echo SYNTAX-OK
node -e "JSON.parse(require('fs').readFileSync('config/gbp-poster.config.json','utf8')); console.log('CONFIG-OK')"
```
Expected: `SYNTAX-OK` then `CONFIG-OK`.

Pick any workbook date that is Approved and not yet posted for the dry-run (ask the orchestrator if unsure; `2026-07-12` should hold), then:
```bash
node scripts/gbp-poster/driver.mjs --date 2026-07-12 --schedule --dry-run
```
Expected: preview JSON with `"mode": "dry-run"`, `"schedule": true`, and a `"cta"` value starting with `https://www.grizzlyelectricaltx.com/`, then a final stdout line containing `"result":"schedule_dry_run"`, `"scheduledTime":"9:00 AM"`, and the same `"cta"` URL. Exit code 0. **No browser must open.**

```bash
grep -c "setComposerSchedule" scripts/gbp-poster/driver.mjs
grep -c "setComposerCta" scripts/gbp-poster/driver.mjs
```
Expected: `2` and `2` (definition + call site each).

Commit (message verbatim):
```
feat(gbp-driver): --schedule mode and "Learn more" CTA button
```

---

## Session 2 — Runner orchestration (Tasks 5–7)

### - [ ] Task 5: `gbpScheduleStatusForExit` + native scheduling loop

In `scripts/lib/gbp-runner.mjs`:

1. New exported helper next to `gbpDailyStatusForExit` (anchor: `export function gbpDailyStatusForExit(exitCode, parsed = {}) {`), same shape/style, per the **Status flow** table (CONTRACT):
   - `0` → `{ status: 'scheduled_native', error: null }`
   - `3` → `{ status: 'scheduled_native', error: 'GBP schedule submitted but unconfirmed (composer error after Post click) — daily verification will confirm or alert.' }`
   - `4` → `{ status: 'pending_approval', error: null }`
   - else → `{ status: 'scheduled', error: null }` (fallback to old daily posting)
   Include a comment stating the duplicate-guard rule: exit 3 must never fall back to `scheduled`.
2. In `runGbpForApprovedRun`, **replace** step 4 (anchor: the block starting `// 4. Mark Days 2-7 scheduled (approval already stamped above).` through its closing brace) with a per-day loop:
   - Iterate `gbpPosts.filter(p => p.day > 1)` sorted by `day` ascending.
   - Per post: `await log(runId, 'gbp', 'info', ...)`, then `runPhase(runId, 'gbp', 'node', [paths.gbpPoster, '--date', post.post_date, '--schedule'], projectRoot)`, map via `gbpScheduleStatusForExit(r.exitCode)`, update that row (`.eq('id', post.id)`) with `{ status, error }`, and log the outcome (`warn` level when the status is not `scheduled_native`).
   - After the loop, log a one-line summary: how many `scheduled_native` vs fallback `scheduled`.
   - A driver failure on one day must not stop the loop for remaining days.

### - [ ] Task 6: `scheduled_native` in the daily path

In `runDailyGbp` (anchor: `export async function runDailyGbp(`):
1. Change the query to `.in('status', ['scheduled', 'scheduled_native'])` (replacing `.eq('status', 'scheduled')`) and add `status` to the selected columns.
2. Branch per row:
   - `scheduled` → existing driver-post behavior, unchanged.
   - `scheduled_native` → **no driver run.** Update the row to `{ status: 'posted', posted_at: new Date().toISOString(), platform_post_id: null, error: null }` and log e.g. `Native-scheduled GBP for <date> — flipped to posted, verification sweep will confirm`. (Null `platform_post_id` + status `posted` is exactly what seeds the worker's verify queue.)

### - [ ] Task 7: tests + Session 2 verification + commit

Extend `scripts/lib/gbp-runner.test.mjs`, mirroring its existing stub patterns:
1. `gbpScheduleStatusForExit`: assert all four mappings from Task 5 (exit 0, 3, 4, 1).
2. Approved-run loop: reuse the existing `runGbpForApprovedRun` test's stub shape (its `makeQb` needs `update(...)` to capture values like the `runDailyGbp` test's does, and `.eq()` chains ending in a resolvable). Two-day fixture (`day: 1`, `day: 2`); `runPhase` returns exit 0 with stdout `'{"result":"scheduled_native"}'` for the `--schedule` invocation. Assert: the Day-2 driver call args include both `'--schedule'` and `'2026-07-11'` (its post_date), and an update with `status: 'scheduled_native'` was captured.
3. `runDailyGbp` native flip: one row with `status: 'scheduled_native'`; a `runPhase` stub that **pushes to a calls array** — assert it was never called, and an update with `status: 'posted'` and `platform_post_id: null` was captured.
4. End each block with a `console.log('ok ...')` line like the existing ones.

```bash
node --check scripts/lib/gbp-runner.mjs && node scripts/lib/gbp-runner.test.mjs
```
Expected: every existing `ok ...` line still prints, plus the new ones; exit 0.

Commit (message verbatim):
```
feat(gbp-runner): natively schedule Days 2-7 on approval; daily path verifies scheduled_native
```

---

## Session 3 — Worker hook + docs (Tasks 8–10)

### - [ ] Task 8: archive on verify success

In `scripts/gbp-worker.mjs`:
1. Extend the runner import (anchor: `import { centralDateHour, runGbpForApprovedRun, runDailyGbp } from './lib/gbp-runner.mjs';`) with `markGbpPostedAndArchive`.
2. In the verify-success branch (anchor: `await log(item.runId, 'gbp', 'info', `Verification confirmed for ${item.date}`);`), immediately **before** the `continue`, call:
```js
await markGbpPostedAndArchive({ postDate: String(item.date).slice(0, 10), exitCode: 0, runId: item.runId, env: process.env, log });
```
Add a short comment: for natively scheduled days this is the first moment we know the post is live, so Excel `Posted=TRUE` + photo archiving happen here; for driver-posted days it already ran and is a harmless no-op re-stamp (photo already moved → skipped).

### - [ ] Task 9: runbook

Update `docs/runbooks/gbp-worker.md`: add a section describing the native-scheduling flow — the Status flow diagram from this plan's primer (adapted to prose or verbatim), the `--schedule` driver flag, the `scheduled_native` status, the 9:00 AM constant in the driver, the fallback rule, the "Learn more" CTA button (config-driven `cta_url_map`, homepage fallback, never blocks a post), and the timezone assumption to confirm on the first run. Keep the existing restart-procedure content untouched.

### - [ ] Task 10: final verification + commit

```bash
node --check scripts/gbp-worker.mjs && node --check scripts/gbp-poster/driver.mjs && node --check scripts/lib/gbp-runner.mjs && node scripts/lib/gbp-runner.test.mjs
```
Expected: all `ok ...` lines, exit 0.

```bash
grep -c "markGbpPostedAndArchive" scripts/gbp-worker.mjs
```
Expected: `2` (import + call).

```bash
grep -c "scheduled_native" docs/runbooks/gbp-worker.md
```
Expected: `>= 1`.

Commit (message verbatim):
```
feat(gbp-worker): archive on verify success; document native scheduling
```

---

## Post-plan (orchestrator/Carter, not Qwen)

1. PR `feat/gbp-native-schedule` → `main`, merge.
2. Restart the GBP worker per `docs/runbooks/gbp-worker.md` — **requires Carter's explicit consent** (his hard rule; confirm no post/verification is mid-flight).
3. First real exercise: next approved SEO run. Watch Day-1 logs for the 6 `--schedule` invocations; next morning confirm the Day-2 post went live at 9:00 AM Central (timezone assumption) and that verification flipped it to verified + archived the photo. Also confirm the live posts show the "Learn more" button linking to the right service page.
4. MCC dashboard note: `scheduled_native` is a new status string — check the SEO Approval page renders it acceptably (cosmetic only).
