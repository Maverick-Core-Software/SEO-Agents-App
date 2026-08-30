# Next session — weekly SEO harden (not dashboard chrome)

**Date:** 2026-08-30
**Branch:** `barnscarter-ops/cockle`
**Repo:** `C:\Users\carte\orca\workspaces\SEO-Agents-App\cockle`
**Canonical inbox:** `C:\Workspace\Active\brain\inbox\2026-08-30-marketing-control-weekly-harden.md`

Carter’s instruction for this pickup: the read-only dashboard is better, but the **reason for the audit** is weekly operational rot — failures, stale statuses from prior weeks, website tasks that never finish. Take the audit and this time to **harden and simplify** so a Friday run closes cleanly every week instead of leaving leftovers.

## Do not redo

- Marketing Control Phase 1 UI (Today run-anchored, pending split, owner-wait, DONE labels, live detail, Tailscale Serve). That slice is shipped and verified.
- Do not edit `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC` unless Carter says the live trees are in scope.
- Do not `pm2` from an unelevated shell. Do not Funnel the dashboard. Do not re-post GBP days that already went live.
- Do not treat Playwright/API `error` as a live miss until the listing is checked (`verify-gbp` crash after a live post is a known false failure).

## Start here

1. Read `marketing-control/docs/AUDIT-FINDINGS.md` and `artifacts/audit-20260830/research/{flow,data,adapters,tests,mcc,ux,secops}.md`.
2. Read this file + the brain inbox note.
3. Probe live: latest `seo_runs`, `weekly_posts` errors (especially GBP `needs_verification` vs `error` with `posted_at` set), `website_tasks` by status (`pending_approval` ~53, `waiting_on_owner` ~8, `error`/`failed`).
4. Propose a **small harden plan** (stale-status policy, website-task drain, GBP verify truth) before editing the worker.

## Dashboard URLs (operator surface, not the engine)

- Local: `http://127.0.0.1:5188/`
- Tailscale (tailnet only): `https://cmb-workbench.tailf72e3f.ts.net:5188/`
- Old MCC SEO Pipeline still at `http://127.0.0.1:3000/` (unchanged)

If 5188 is down: `cd marketing-control && npm run preview -- --host 127.0.0.1 --port 5188`. Serve rule: `tailscale serve --https=5188` → `127.0.0.1:5188`. Do not `tailscale serve reset` (wipes `:18920`).
