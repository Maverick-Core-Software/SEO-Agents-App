# GBP Worker Runbook

The GBP worker (`scripts/gbp-worker.mjs`) posts Google Business Profile updates from
Carter's interactive `carte` session. It exists because the LocalSystem `mav-bridge`
service cannot post GBP: under LocalSystem `os.homedir()` is the system profile (so the
saved Google login at `C:\Users\carte\.claude\gbp-session` is invisible), the `H:\`
Drive photo mount is absent, and Playwright needs a visible desktop.

**Ownership split:** the worker owns `weekly_posts` rows where `platform='gbp'`.
`mav-bridge` owns `facebook` + website + run orchestration + alerting. They share
Supabase; ownership is disjoint, so they cannot double-post.

## Install the Scheduled Task

From an elevated PowerShell:

    schtasks /create /tn "Grizzly SEO GBP Worker" /xml "C:\Workspace\Active\SEO-Agents-App\ops\gbp-worker-task.xml" /ru CARTERSPC\carte

Start it now without re-logging-in:

    schtasks /run /tn "Grizzly SEO GBP Worker"

Verify it's registered and running:

    schtasks /query /tn "Grizzly SEO GBP Worker" /v /fo LIST

The task is also triggered automatically at each logon of `carte` and daily at 8:00 AM
(the daily trigger restarts it if it died; IgnoreNew makes it a no-op while running).
It is a long-running daemon (its own poll loop); "Restart on failure" covers crashes.

The task launches node **hidden** via `ops\gbp-worker-launch.vbs` (wscript, window
style 0) — there is no console window to accidentally close (that killed the worker
on 2026-07-10 with exit 0xC000013A). Node's stdout/stderr goes to
`logs\gbp-worker.log`; check there first when diagnosing a silent death. The
Playwright browser window still appears during actual posts — that's expected.

## Restart the worker (e.g. after a code change)

`schtasks /end` kills only the wscript wrapper and orphans the node process, and an
immediate `/run` gets swallowed by IgnoreNew while the scheduler is tearing down. Do it
in three steps:

    schtasks /end /tn "Grizzly SEO GBP Worker"
    # kill the orphaned node (verify the command line first!):
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*gbp-worker.mjs*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    schtasks /run /tn "Grizzly SEO GBP Worker"

The worker imports its code at startup — a merged fix does nothing until restart.

## Verify it's working

    node C:\Workspace\Active\SEO-Agents-App\scripts\gbp-worker.mjs --once

A clean exit with `[gbp-worker] --once complete` and no stack trace means the wiring is
healthy. Real posting only happens when there are approved/scheduled `gbp` rows.

## Re-authenticate the Google session

When a GBP post fails with authentication errors (e.g. `invalid_grant`), re-auth via OAuth:

    node scripts/authorize-gbp.mjs

Log into the Google Business Profile owner account (`carterbarns@grizzlyelectrical.net`) in the browser tab that opens to refresh `C:\Users\carte\gmail-multi\tokens\grizzly-gbp.json`.

## Rollback (put GBP back on the service)

Only if the worker is broken and you need GBP posting restored on `mav-bridge`:

1. **Stop the worker first** (prevents double-posting):
   `schtasks /end /tn "Grizzly SEO GBP Worker"` and disable it:
   `schtasks /change /tn "Grizzly SEO GBP Worker" /disable`
2. Set `MAV_BRIDGE_GBP=on` in `C:\Workspace\Active\SEO-Agents-App\.env`.
3. Restart mav-bridge: `pm2 restart mav-bridge` (or restart the PM2 service).

Note: the service still runs under LocalSystem, so GBP will only actually work there if
the service itself has been moved to a user session — otherwise this rollback restores
the *old broken* behavior. Prefer fixing the worker.

## Daily 9am post (Playwright is the publisher) + CTA button

GBP `scheduled` / `scheduled_native` on the dashboard is **not** a Google-side
queue you can trust. Friday `--schedule` may create Google "Scheduled" cards for
some days and miss others. Live GBP = `status=posted` **and** a `platform_post_id`.
`posted_at` alone is a worker stamp.

On an approved weekly run the worker still posts **Day 1 immediately**, then
invokes the driver with `--schedule` for Days 2–7 (status `scheduled_native`).
The 9am tick is what actually publishes.

Status flow:

    approved ─claim→ posting ─┬ day 1:  driver --date D1            → posted / needs_verification / error
                              └ days 2-7: driver --date Dn --schedule
                                            exit 0 → scheduled_native
                                            exit 3 → scheduled_native  (+ error note "schedule unconfirmed")
                                            exit 4 → pending_approval
                                            else   → scheduled         (old daily path posts it — fallback)

    daily ≥9am Central:
      status in (scheduled, scheduled_native) & post_date=today
        → always run driver --date today (Playwright). Never skip on scheduled_native.
        → driver listing-checks the All posts modal (scrolls past scheduled cards):
            already live     → posted + id, do not compose
            queued today     → posted + posted_at, no id (verify confirms after Google publishes)
            missing          → compose and live-post
        → workbook Posted=TRUE is the hard double-post lock
    verify success → markGbpPostedAndArchive (Excel Posted=TRUE + photo → archive)
    verify last-miss (no id) → needs_verification ("check listing, do not re-post")
    session-expired / marketing page → crash, not a miss

**Verify queue is one-shot per post.** The worker seeds the queue only from rows
that are `posted` with no `platform_post_id` (last 24h). A post that survives the
4-attempt cycle lands in `needs_verification` and is **never re-seeded** —
re-seeding would re-run the verifier against the listing forever. Re-checks of
`needs_verification` rows are on-demand only: run `verify-gbp-posts.mjs` (no
`--date` = last 14 days) or check the listing by hand. `needs_verification` is
never an error and never auto-reposts.

Rules to know:

- **`scheduled_native`** means "queued for the 9am Playwright tick", not "Google will publish."
- **Duplicate guard:** driver exit 3 in schedule mode (error *after* the Post click)
  stays `scheduled_native` — it must never fall back to `scheduled`. The 9am listing
  check refuses to compose if today's caption is already live or queued on the listing.
- **Fallback:** any pre-submit scheduling failure marks that day `scheduled`, and the
  9am live-post path handles it — one bad day never blocks the rest of the week.
- Excel `Posted=TRUE` + photo archiving happen after a verified live post, not at
  schedule time.
- **CTA button:** every post gets a "Learn more" button. The URL comes from
  `cta_url_map` in `config/gbp-poster.config.json` (topic matched before caption,
  first key wins) with `default_cta_url` (homepage) as fallback. A CTA failure never
  blocks a post — the driver logs it and posts without the button.
- **Timezone assumption to confirm on the first real run:** GBP schedules in the
  business's local time (Central). Expected: a Day-2 post goes live at 9:00 AM CT.

## Photo Ingestion

Job-site photos must land in the pipeline's source folder before the picker can score
and match them to weekly GBP posts. The full ingestion chain is:

    iPhone → (iOS Shortcut) → Google Drive "GBP Photos" (cloud)
                                         ↓  08:25 Fri sync-photos-from-drive.mjs
    C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos (local cache)
                                         ↓  gbp-photo-pick.mjs
    E:\Media\Grizzly\Curated (picked winners, ready for posting)

### How to upload from your phone

Use the **"Log Job Photos"** iOS Shortcut. Build it following the guide at
`docs/ingestion/ios-photo-shortcut.md`. After each job, tap the shortcut, select your
photos, and they upload to Drive with unique timestamp-prefixed filenames. The Friday
08:25 scheduled sync pulls them into the local cache automatically.

If the originals are already in Google Photos and not on the phone's share sheet,
use `docs/ingestion/google-photos-picker.md` and run
`node scripts/google-photos-picker-import.mjs`. Google requires a user selection
through the Picker API; an unattended full-library album scan is no longer supported.

### Prerequisite: Drive for Desktop

The `sync-photos-from-drive.mjs` step reads from `H:\My Drive\GBP Photos`, which is the
Drive-for-Desktop mount. If Drive for Desktop is not running at 08:25, the sync sees an
empty `H:` and uses whatever was in the cache from the last successful sync. This is
non-fatal (the cache is persistent and additive), but new photos uploaded since the
last sync won't appear until you manually run:

    node scripts/sync-photos-from-drive.mjs

**Check Drive status:** open File Explorer and confirm `H:\My Drive` is accessible.
If it shows as disconnected, open the Drive for Desktop app and wait for it to remount.

### Quick health check

    node scripts/verify-photo-ingestion.mjs

This read-only script reports photo counts in Drive vs cache, lists the 5 most recent
cache files, and checks HEIC scoring readiness. No writes, no network — safe to run
anytime.
