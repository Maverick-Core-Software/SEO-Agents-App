# Next session — GBP 9am always posts (engine, not dashboard)

**Date:** 2026-08-30 close
**Branch:** `barnscarter-ops/cockle`
**Repo:** `C:\Users\carte\orca\workspaces\SEO-Agents-App\cockle`
**Canonical inbox:** `C:\Workspace\Active\brain\inbox\2026-08-30-gbp-9am-always-post.md`

Probe is done. Carter corrected GBP vs Facebook. **Implement the 9am path.** Do not redo Marketing Control UI. Do not re-post any GBP day.

## Operator truth (locked this session)

- **Facebook `scheduled` + Graph id** = actually scheduled on Facebook; it will publish. `posted` + time + id = live.
- **GBP is not natively scheduled.** The Playwright worker posts each morning at 9am Central. Dashboard `scheduled` / `scheduled_native` / `AUTO 9AM` is **not** a Google-side queue you can trust.
- **GBP live** = `status=posted` **and** a `platform_post_id`. `posted_at` alone is a worker stamp, not live.

## The bug to fix first

`scripts/lib/gbp-runner.mjs` `runDailyGbp`: if today's row is `scheduled_native`, **Playwright does not run**. It only writes `posted` + `posted_at` + `platform_post_id=null`, then verify tries to confirm a post that was never made. After 4 misses the worker writes `error` and leaves `posted_at` sitting there.

That is the 6 GBP `posted_at`+`error` rows (Aug 15, 16, 17, 19, 20, 29 Recessed Lighting). Five of six stamped ~9:00am Central. They are **unconfirmed**, not “probably live.”

This week still `scheduled_native` (will skip Playwright at 9am unless fixed): **2026-08-31, 09-01, 09-02, 09-03**. Day-1 8/28 and 8/30 already `posted` with ids. 8/29 Recessed Lighting is the error row — **do not re-post**.

## Do not redo

- Marketing Control Phase 1 UI. Dashboard URLs stay as-is.
- Do not edit `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC` unless Carter says so.
- Do not `pm2` from an unelevated shell. Do not Funnel. Do not `tailscale serve reset`.
- Do not re-run Friday `--schedule` / weekly GBP claim to “fix” one day.
- Do not treat `posted_at` without an id as live.

## Implement (small, this order)

1. **9am always posts.** `runDailyGbp`: for `scheduled` **and** `scheduled_native`, run Playwright `--date today`. Keep the workbook Posted gate so a real already-posted day cannot double-post. `scheduled_native` must not skip the driver.
2. **Verify truth.** Last-miss: no id → `needs_verification` (“check listing, do not re-post”), never `error` just because `posted_at` was stamped. Listing-found / id wins. Session-expired / marketing page = crash, not miss. Scroll the All posts modal past scheduled cards (8/29 verify sat on five scheduled items and never scrolled).
3. **Stale rows.** The 6 `posted_at`+`error` GBP rows: one scrolled listing check each. Found → write id + `posted`. Not found → `needs_verification`. No retry post.
4. **Website drain** (after 1–3): skip `pending_approval` whose `run_id` is not the latest run (~52 of 53). Topic-fingerprint so GBP-claim / homepage-stats / weekly-blog / 24/7 do not duplicate. Auto-approve stays **posts-only**. This week’s real executable task is **Fix `/contact/` 404**.

Tests: extend `scripts/lib/gbp-runner.test.mjs` for the 9am no-skip path and `posted_at`-without-id disposition. Do not start with watchdog chrome.

## Live snapshot (probed 2026-08-30 ~23:05 UTC)

- Latest run `week_of=2026-08-31`, frozen `done`, posts 2026-08-28–2026-09-05.
- Facebook: 4/4 `scheduled` with Graph ids (this **is** Graph schedule).
- GBP this run: 8/28 posted+id, 8/29 error + posted_at no id, 8/30 posted+id, 8/31–9/03 `scheduled_native`.
- Website: 53 `pending_approval` (1 this week + July/Aug backlog), 8 `waiting_on_owner`, 3 `error` (ENOENT `seo-agents.exe` on research-gap tasks that should not have executed).
- `run_logs` empty.

Probes (read-only, anon key): `artifacts/audit-20260830/probe-weekly-harden.mjs`, `probe-website-titles.mjs`.

## Dashboard (leave running)

- Local: `http://127.0.0.1:5188/`
- Tailscale: `https://cmb-workbench.tailf72e3f.ts.net:5188/`
- MCC write UI: `http://127.0.0.1:3000/`

If 5188 is down: `cd marketing-control && npm run preview -- --host 127.0.0.1 --port 5188`. Serve: `tailscale serve --https=5188` → `127.0.0.1:5188`. Do not `serve reset`.
