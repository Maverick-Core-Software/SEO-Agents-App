# Next session — create Grizzly Local Grok Bot (public listing verify)

**Date:** 2026-08-30 close
**Branch:** `barnscarter-ops/cockle` (engine committed; live Active worker still needs a land — see open thread 1)
**Canonical inbox:** `C:\Workspace\Active\brain\inbox\2026-08-30-grizzly-local-grok-bot.md`
**Bot pack:** `D:\Workspace\Active\brain\projects\grok-bot\`

Create **Grizzly Local** in the Grok Bot app. Do not redo Marketing Control UI. Do not re-post GBP. Do not log into Google/Facebook on the Agent Computer.

## Do this

1. Read `projects/grok-bot/handoff.md`, `bots/grizzly-local.md`, `skills/public-listing-verify.md`.
2. Settings still: local computer **Never**; no Google plugins; Chicago TZ; Auto-review from `auto-review.md`.
3. Create the Bot from `bots/grizzly-local.md`. Helm delegates; pin Helm only.
4. One **watched Test**: public GBP listing for today's caption (8/31 Generator Interlock if that is the day). Result block only. No Post click.
5. Enable `routines/public-listing-verify.md` (09:20 America/Chicago Mon–Sat) only after that Test is green.

## Operator truth (locked)

- Facebook **post** = Graph. Facebook **verify** (optional) = public Page via Grizzly Local. Graph id stays canonical.
- GBP **post** = Playwright `gbp-worker` 9:00. GBP **verify** = Grizzly Local on the **public** listing (no login).
- GBP live in Supabase = `posted` **and** a `platform_post_id`. Bot `found` can later map to `verified-public`; `not_found` = `needs_verification`. Never `error` from a miss. Never re-post.

## Open threads (do not expand unless needed)

1. **Live 9am worker** still runs `C:\Workspace\Active\SEO-Agents-App\scripts\gbp-worker.mjs` (old `scheduled_native` skip). Cockle has the fix. Land/copy this branch onto Active and restart `Grizzly SEO GBP Worker` before 8/31 09:00 CT if that has not happened. Do not edit Active unless Carter says so in that tab.
2. 8/29 Recessed Lighting is `needs_verification` — listing miss after scroll. Do not re-post.
3. Website: Fix `/contact/` 404 still pending. 52 prior-week pending already skipped in cockle.
4. Dual surfaces: Marketing Control `:5188` read-only; MCC `:3000` writes. Do not `tailscale serve reset`.

## Dashboard (leave running)

- Local: `http://127.0.0.1:5188/`
- Tailscale: `https://cmb-workbench.tailf72e3f.ts.net:5188/`
- MCC: `http://127.0.0.1:3000/`
