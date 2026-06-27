# Split GBP Worker — Design

**Date:** 2026-06-27
**Status:** Approved (pending implementation plan)
**Author:** Carter Barns + Claude

## Problem

The daily GBP poster lives in `scripts/mav-bridge.mjs`, which runs under the Windows
service **"PM2 (Maverick stack)"** as **LocalSystem**. GBP posting cannot work under
LocalSystem:

1. The GBP Playwright driver (`C:\Users\carte\.claude\skills\gbp-poster\driver.mjs`)
   stores its Google login via `launchPersistentContext(USER_DATA_DIR)` where
   `USER_DATA_DIR = path.join(os.homedir(), '.claude', 'gbp-session')` (driver.mjs:11).
   Under LocalSystem `os.homedir()` resolves to
   `C:\Windows\System32\config\systemprofile\`, **not** `C:\Users\carte\`, so the saved
   login is invisible.
2. The driver uses `headless: false` (driver.mjs:393,469) and needs a visible
   interactive desktop.
3. GBP photo curation (`scripts/gbp-photo-pick.mjs`) reads `H:\My Drive\GBP Photos`, a
   per-user Google Drive mount invisible to LocalSystem.

Facebook works under LocalSystem because it is a pure Graph API token (no browser, no
per-user mount). Because curation already reads `H:\`, **curation has also been silently
failing under LocalSystem** — `mav-bridge` wraps it in a soft-fail
(`if (!matchResult.ok) log.warn('continuing')`), so the FB curated-photo fallback has
been non-functional all along. Moving curation to the worker therefore *fixes* it rather
than regressing anything.

## Goal

Split the pipeline by platform: **Facebook + website + orchestration stay on the
LocalSystem `mav-bridge` service. GBP curation + posting move to a new worker that runs
in Carter's interactive user session** (`carte`), so `os.homedir()` → `C:\Users\carte`,
the saved Google session is available, `H:\` is mounted, and a visible browser can
launch.

## Approved decisions

- **Coordination:** Independent Supabase poller. The worker polls Supabase itself for
  `gbp` rows; the service stops touching `gbp` entirely. Supabase is the only queue — no
  new IPC. Disjoint platform ownership means the two processes physically cannot
  double-post.
- **Registration:** Windows Scheduled Task, trigger *At log on of carte*, *Run only when
  user is logged on*, restart-on-failure. Native, documented, guarantees the
  user-session environment the driver needs.

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │  Supabase (weekly_posts, seo_runs)        │
                  │  + Excel workbook (…\GBP Schedule.xlsx)   │
                  └───────────────┬──────────────┬────────────┘
        polls facebook/website    │              │  polls gbp rows
                                  │              │
   ┌──────────────────────────────┴──┐      ┌────┴───────────────────────────┐
   │ mav-bridge.mjs (LocalSystem svc) │      │ gbp-worker.mjs (Scheduled Task,│
   │  • FB posting + reconcile        │      │   runs as carte, logged on)    │
   │  • website, prompt approval      │      │  • gbp-photo-pick (H:→E:)       │
   │  • alerting / fault detection    │      │  • sync-gbp-schedule (Excel)    │
   │  • run lifecycle (FB+web only)   │      │  • driver.mjs --date (headful)  │
   │  • NO gbp, NO curation           │      │  • mark-approved / mark-posted  │
   └──────────────────────────────────┘      │  • daily Days 2–7 poster loop   │
                                             └────────────────────────────────┘
```

Each process owns disjoint `weekly_posts` rows by `platform`.

## Components

### 1. `scripts/lib/gbp-runner.mjs` (new shared module)

Extract the GBP helpers currently inline in `mav-bridge.mjs` into one module so there is a
single source of truth (no copy-paste):

- `excelDateToIso(value)`
- `parseDriverJson(stdout)`
- `gbpNeedsVerificationMessage(parsed)`
- `markGbpPostedAndArchive(opts)` — Excel `Posted=TRUE` + photo archive on exit 0
- `runGbpForApprovedRun(...)` — the curate → sync → Day-1 post → mark Days 2–7
  scheduled+approved sequence (lifted from `executeApprovedRun` section 0 + section 2)
- `runDailyGbp(...)` — the ≥9am-Central daily poster loop (lifted from the `poll()` daily
  GBP block), including the DST-aware Central date/hour derivation

The module takes its dependencies (supabase client, `runPhase`, paths, env) as parameters
or imports them, so both files *could* import it; in practice only the worker calls the
run/daily functions.

### 2. `scripts/gbp-worker.mjs` (new entry point, runs as `carte`)

A focused poller mirroring `mav-bridge`'s structure:

- Same `.env` loader, Supabase client construction, and `runPhase` (shared or duplicated
  minimally — `runPhase` may move to a small shared util too).
- **Poll loop** (`MAV_BRIDGE_POLL_MS`, default 30s), `busy` guard:
  1. Find approved runs that have `gbp` `weekly_posts` rows in `status='approved'`. Claim
     them by flipping `approved → posting` (mirrors how the service gates FB), then call
     `runGbpForApprovedRun`.
  2. Run `runDailyGbp` for today's `scheduled` gbp rows ≥9am Central (once per calendar
     day, tracked by `lastDailyGbpDate`).
- **Exit-code → status mapping is unchanged** from today:
  - exit 0 → `posted` + `markGbpPostedAndArchive`
  - exit 3 → `needs_verification` (+ `gbpNeedsVerificationMessage`)
  - exit 4 → `pending_approval` (daily loop only — approval gate)
  - exit 1 / other → `error`
- **No own alert channel.** The worker writes `error` / `needs_verification` to
  `weekly_posts.status` + `.error`. `mav-bridge`'s existing fault-detection already polls
  `weekly_posts` for those statuses and fires the iMessage + email, so an expired Google
  session surfaces on Carter's phone with no new alerting code.

### 3. `scripts/mav-bridge.mjs` changes — stop touching GBP

- Remove **section 0** (gbp-photo-pick curation), **section 2** (GBP sync/post/mark), and
  the **daily GBP loop** in `poll()`. Keep FB posting, FB reconciliation, website tasks,
  prompt approval, alerting, and fault-detection.
- The run-done gate (`allOk` → `seo_runs.status`) drops GBP from its inputs (it now only
  reflects FB + website). The `/seo/status` `liveRunStatus` already derives the run's true
  status from **all** posts including `gbp`, so the dashboard stays accurate while the
  worker finishes asynchronously.
- Gate the removed code behind `MAV_BRIDGE_GBP` env (default `off`) rather than hard
  deleting, so a rollback is a one-line env flip. When `off` (default) the service does no
  GBP work; the worker owns it.

### 4. `driver.mjs` session-expired detection fix

`assertLoggedIn` (driver.mjs:123-131) currently only catches the `accounts.google.com`
redirect and a visible "Sign in" button. It does **not** catch the logged-out GBP
marketing page ("Stand out on Google with a free Business Profile"), so an expired session
fails as `ui_changed_or_timeout` instead of `session_expired`.

Add a check in `assertLoggedIn`: if the page shows
`getByText(/Stand out on Google|free Business Profile|Get your free Business Profile/i)`,
throw the same session-expired message ("GBP session expired … Re-authenticate with:
`node driver.mjs --auth`"). This routes through the existing `classifyFailure` →
`session_expired` mapping (driver.mjs:25). Contained change with a self-check.

### 5. Registration — Scheduled Task

Commit a Task Scheduler definition + the documented create command to the repo:

- `ops/gbp-worker-task.xml` — the exported task XML.
- README/runbook note with the `schtasks /create /xml …` command and the manual
  equivalent.
- Trigger: *At log on of carte*. Settings: *Run only when user is logged on*, *Restart on
  failure* every 1 minute up to 999 times (effectively indefinite), *Do not stop on idle*,
  *Allow run on battery*, *Execution time limit: none* (the worker is a daemon).
- Action: `node C:\Workspace\Active\SEO-Agents-App\scripts\gbp-worker.mjs`.
- The worker is long-running (own `setInterval`), so the task launches once per login and
  stays resident.

## Error handling & data flow

- driver duplicate guard unchanged — it still never re-submits past the Post click.
- driver exit codes map to `weekly_posts.status` exactly as today.
- A missing `H:\` or empty curation no longer silently breaks the FB fallback — the
  worker, running as `carte`, restores curation.
- Re-auth remains `node driver.mjs --auth` (interactive browser login). Expired sessions
  now report clearly via `session_expired` → `weekly_posts.error` → existing alert.

## Testing

- `scripts/lib/gbp-runner.mjs` gets one runnable self-check (no framework): assert the
  exit-code → status mapping and `excelDateToIso` round-trips.
- `driver.mjs` already exposes `classifyFailure` via direct import; extend its self-check
  to assert the new marketing-page string classifies as `session_expired`.

## Acknowledged simplification (ponytail)

Worker and service poll on independent intervals; on a brand-new approved run the worker
may begin curation a few seconds after the service starts FB Day-1. Because FB's
curated-photo fallback is a *degraded* path (only on Veo render failure) and was already
non-functional under LocalSystem, this is no regression.
**Ceiling:** FB Day-1 render-failure on a fresh run may miss the same-week curated photo.
**Upgrade path:** have the service await a `curation_done` flag (Supabase column or file)
before FB Day-1.

## Out of scope

- The unresolved elevated PM2-boot setup for `mav-bridge` itself (tracked separately in
  the Reboot Resilience memory) — this design only adds the GBP worker's own Scheduled
  Task.
- No `weekly_posts` / `seo_runs` schema changes.
