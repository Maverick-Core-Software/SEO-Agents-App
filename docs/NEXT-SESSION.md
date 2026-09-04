# Next session — GBP poster reliability, then the three website fixes

**Date:** 2026-09-04 close (Friday run recovered and published)
**Branch:** `main` (everything committed and pushed at close)
**Canonical inbox:** `C:\Workspace\Active\brain\inbox\2026-09-04-friday-seo-recovery.md`
**Runbook:** `FRIDAY-RUNBOOK.md` (two new triage rows for the 09-04 failure modes)

**The 2026-09-04 Friday run succeeded at 15:33Z** (topic: circuit breaker repair and replacement DFW). 7 GBP + 4 FB posts synced for week of 2026-09-07, auto-approved, Hermes notified. Do not re-run it. Do not re-post.

## Do this, in order

1. **Diagnose, fix, and harden the GBP poster.** Known facts at close:
   - Posts ARE landing live for 09-02, 09-03, 09-04 (Carter confirmed on GBP) but **with no photos**. Find where the image drops out: `state/photo-selection-manifest.json`, `state/photo-cache.json`, `scripts/gbp-poster/driver.mjs` upload step.
   - `logs/gbp-worker.log` 09-03 14:00Z: `session_expired` — "logged-out Business Profile marketing page shown". Re-auth is interactive: `node scripts/gbp-poster/driver.mjs --auth` (Carter must be present; never log in on the Agent Computer).
   - Scheduled task `Grizzly SEO GBP Worker` LastTaskResult `2147946720` (0x800710E0) on 09-04 08:00, while a `gbp-worker.mjs` process from 09-02 23:34 was still running. Check for the double-launch / stale-process pattern and make the worker self-heal (session check before posting, alert on expiry, no silent photo drop).
   - Goal: a week of unattended 9:00 posts with photos, verified by Grizzly Local on the public listing.

2. **Fix the homepage stat counters.** Live site shows `0 + Years Experience`, `0 + Services Offered`, `0 % Licensed & Insured` (confirmed by three executor scrapes on 09-04). The executor is blocked on owner values. **Ask Carter for the three numbers first**, then apply through the Website Manager adapter (`seo-agents website "..."`; site is static on Vercel, no CMS). Verify live and screenshot.

3. **Repair the `/contact/` link.** Primary-nav "Contact" → `/contact/` returns 404; `/#contact` is live and works. Either redirect `/contact/` → `/#contact` or create the page. Verify nav click lands on a working form; submit one Formspree test.

4. **Present suggested blog pricing to Carter for approval.** The circuit-breaker blog draft carries `[PRICING: Owner to confirm]` — see `outputs/content_completion.json` and `outputs/grizzly_execution_queue.md`. Research DFW price ranges, present a short table to Carter, get an explicit approve, then publish via `seo-agents blog-post` and confirm the sitemap `lastmod`.

5. **After 1–4 are complete:** write a fresh `docs/NEXT-SESSION.md` + brain inbox note scoping a **full website audit** (structure, service pages, technical, conversion, content gaps, measurement), so the following session can run it end to end.

## Also open (do not expand unless needed)

- Completed-work brief (`outputs/completed-work-brief.md`) gives the website agent a timeline but no traffic data. Carter wants a source wired in so "did last week's change help" is measurable. Not started.
- `website_tasks` in Supabase has one row with a garbage title (`/EXCERPT:/TAGS:` headers...) from 08-14. Data hygiene, low priority.
- 8/29 Recessed Lighting GBP is `needs_verification`. Do not re-post.

## Operator truth (locked)

- Facebook **post** = Graph. Facebook **verify** (optional) = public Page via Grizzly Local. Graph id stays canonical.
- GBP **post** = Playwright `gbp-worker` 9:00. GBP **verify** = Grizzly Local on the **public** listing (no login).
- GBP live in Supabase = `posted` **and** a `platform_post_id`. Never `error` from a miss. Never re-post.
- `SEO_AUTO_APPROVE=1`: posts publish without Carter. Only website tasks are approval-gated.
- Dual surfaces: Marketing Control `:5188` read-only; MCC `:3000` writes. Do not `tailscale serve reset`.

## Dashboard (leave running)

- Local: `http://127.0.0.1:5188/`
- Tailscale: `https://cmb-workbench.tailf72e3f.ts.net:5188/`
- MCC: `http://127.0.0.1:3000/`
