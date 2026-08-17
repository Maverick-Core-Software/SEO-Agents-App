# SEO Agents App — Handoff State

**Last updated:** 2026-08-17  
**Branch:** `main` (pushed)  
**Latest relevant commit:** `c0e13c8` — slideshow 2.7s beats, gentler 1.10x zoom; ship bed audio  
**Prior FB media stack:** `fb879f4` … `045edfe` (real photos, carousel Graph, first-comment queue, boost week parse)

**Repo:** `C:\Workspace\Active\SEO-Agents-App`  
**Remote:** `Maverick-Core-Software/SEO-Agents-App`  
**Page:** Grizzly Electrical Solutions · `FB_PAGE_ID=108252941997164`

---

## Current state (Facebook media + ops)

### Media policy (live in code)
- **`FB_MEDIA_MODE=real` (default)** — no AI video. Ken Burns **slideshow** Reels from curated job photos + stills/carousels.
- Crew (`build_facebook_crew`): Day 1 **slideshow**, Days 3/5 **photo|carousel**, Day 6 **photo|text**.
- Poster: `prepareMotionMedia()` builds slideshows; Graph multi-photo **carousel** via unpublished photos + `attached_media`.
- Slideshow polish:
  - Caption band: full-width dark plate + gold accent + amber text
  - **Beat default 2.7s** (`FB_SLIDESHOW_BEAT_SEC`), segment floor 3.0s
  - Ken Burns max zoom **1.10** (`zoom+0.0012`)
  - Audio muxed from `assets/audio/upbeat-1.mp3` (default); alts: upbeat-2, calm-1, drive-1
- Facebook in-app music library is **not** available on Graph upload — audio must be baked into the MP4.

### First comment (phone / text line)
- Live posts: poster stamps first comment immediately after Graph create.
- Scheduled posts: Graph rejects comments until live → **local queue**  
  `state/fb-pending-first-comments.json`  
  Drain: `node scripts/facebook-poster.mjs --backfill-comments`  
  Also drained from **mav-bridge** poll via `drainPendingFirstComments`.
- Fixed copy: `FB_FIRST_COMMENT` / default text-us line `(469) 896-3862`.

### Week of 2026-08-17 schedule (on Graph)
| Day | Date | Media | Status (as of handoff) |
|-----|------|--------|-------------------------|
| 1 | Mon 8/17 | Slideshow reel (re-posted polished) | **Live** — inspect `https://www.facebook.com/reel/1669177451365862/` (id may evolve; check published_posts) |
| 3 | Wed 8/19 09:00 CT | Carousel (FPE/Zinsco) | Scheduled |
| 5 | Fri 8/21 09:00 CT | Photo (whole-home generator) | Scheduled |
| 6 | Sat 8/22 09:00 CT | Photo (troubleshooting) | Scheduled |

Schedule file: `outputs/facebook_posting_schedule.md` (**gitignored**).  
Boost plan: **$50 on Day 1 only** ($25×2d). Ledger eligible after week-header parse fix; **boost was not auto-applied** for this week via Ads UI yet.

### Boost today (problem to replace next session)
- **Current path:** Claude/cron + Playwright **Boost UI** runbook (`FB-BOOST-RUNBOOK.md` + `fb-boost-ledger.mjs` $50 cap). Fragile.
- **Desired path (NEXT SESSION):** Meta **Marketing API** boosts driven from **mav-bridge**, still gated by ledger.

---

## NEXT SESSION — Meta Ads API automation (primary goal)

### Objective
Replace Claude UI boost cron with programmatic boosts via Marketing API, orchestrated from **mav-bridge**, keeping `fb-boost-ledger.mjs` as the money gate.

### Suggested design
1. **Inputs:** schedule BOOST summary + live `platform_post_id` (Graph) + week ledger.
2. **API shape (typical):**  
   - Ad creative from organic post: `object_story_id` = `{page_id}_{post_id}` (or effective object story id for reels — verify for video/reel objects).  
   - Campaign (or reuse standing campaign) → Ad set (budget, schedule, geo **Dallas + 15 mi**, ages/interests from schedule) → Ad.  
3. **Wire into mav-bridge:** after FB reconcile marks post live (or daily eligible check), if `fb-boost-ledger eligible` → Marketing API create → `ledger reserve` → on success `ledger publish` + SMS notify.  
4. **Hard rules (preserve):** never spend without ledger reserve; $50/week cap; one boost per eligible pick; no double-boost; fail closed on ambiguous summary.

### Prerequisites to gather next session
- [ ] Meta ad account id (`act_…`)
- [ ] Token/app with `ads_management` (+ pages as needed); long-lived system user preferred
- [ ] Confirm reel/video posts are boostable via `object_story_id` vs need `video_id` creative path
- [ ] Payment method on ad account; prepaid balance behavior
- [ ] Env keys (proposed): `FB_AD_ACCOUNT_ID`, `FB_ADS_ACCESS_TOKEN` (or scoped from existing page token if capable), optional `FB_BOOST_CAMPAIGN_ID`

### Files to touch (expected)
- **New:** `scripts/fb-boost-api.mjs` (or `scripts/lib/fb-boost-marketing.mjs`)
- **Update:** `scripts/mav-bridge.mjs` — call after reconcile / daily
- **Update:** `scripts/fb-boost-ledger.mjs` — keep as gate; maybe `eligible` already fixed for `## Week of …`
- **Update:** `FB-BOOST-RUNBOOK.md` — API path primary; Playwright Claude path rollback only
- **Env:** `.env.example` document new keys (never commit secrets)

### Out of scope for next session unless asked
- Replacing organic post pipeline
- Changing $50 weekly policy
- Instagram dual placement (optional later)

### Rollback
- Keep Playwright runbook as manual/Claude fallback
- Ledger refuse = no spend

---

## Key commands

```powershell
cd C:\Workspace\Active\SEO-Agents-App
node scripts/facebook-poster.mjs --schedule-all --time 09:00 --dry-run
node scripts/facebook-poster.mjs --backfill-comments
node scripts/fb-boost-ledger.mjs eligible
node scripts/fb-boost-ledger.mjs status
# Slideshow only:
node scripts/slideshow-reel.mjs --day 1 --dry-run
```

---

## Recent commit spine (FB media)

| Commit | Note |
|--------|------|
| `fb879f4` | Real photos + slideshow; crew rules |
| `14db1df` | ISO DATE normalize |
| `f75afa2` | Curated PHOTO_FILE resolve |
| `045edfe` | First-comment queue, polish+audio, boost week parse |
| `c0e13c8` | **2.7s beats, 1.10 zoom, ship audio library** (pushed) |

---

## Known issues / watchouts

1. **Manual schedule-all** without Supabase still works for first comments only if queue/drain runs.
2. **Photo selection manifest** soft-warns on explicit curated files (allowed).
3. **Day 1 boost for week of 8/17** still needs application (API next session or one-shot UI).
4. Unrelated dirty tree: knowledge baseline archive files — leave alone.
5. AI video only if `FB_MEDIA_MODE=ai` (opt-in).

---

## Session note pointer

Brain vault session + project brief updated 2026-08-17 for this handoff. Start next chat with:  
**“Implement Meta Ads API boost via mav-bridge; follow SEO-Agents-App memory/HANDOFF.md NEXT SESSION.”**
