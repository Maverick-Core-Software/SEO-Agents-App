# SEO Agents App — Handoff State

**Last updated:** 2026-09-04 close
**Branch:** `main` @ `c87205c` + docs commit (pushed)
**This close:** Friday run recovered after four failure modes (missing anthropic SDK after `uv sync`, stranded run lock, fallback not covering construction, website agent exhausting its iteration cap on 24 completed-task scrapes). Run succeeded 15:33Z; 7 GBP + 4 FB posts auto-approved for week of 2026-09-07. Pickup `docs/NEXT-SESSION.md` and `brain/inbox/2026-09-04-friday-seo-recovery.md`.

**Next session, in order:** GBP poster reliability (no photos on live posts, session expiry, worker task 0x800710E0) → homepage stat counters (needs Carter's three numbers) → `/contact/` 404 → blog pricing presented to Carter for approval → then scope a full website audit.

**Config changes at close:** `.env` gained `CREWAI_RESEARCH_MAX_TOKENS=8192` (backup `.env.bak-research-maxtokens-*`). Completed tasks now reach the website agent as `outputs/completed-work-brief.md`, not a scrape list. All previously "unrelated dirty files" are now committed (c87205c) per Carter.

---

# SEO Agents App — Handoff State (2026-09-01 archive)

**Last updated:** 2026-09-01 close
**Branch:** `main` @ `75a227c` (pushed)
**This close:** 1-day FB boost duration pad + Day 1 $25 boost applied. Pickup `brain/inbox/2026-09-01-fb-boost-1day-duration.md`.

**Next ops tick:** Wed 2026-09-02 9:00 CT mav-bridge should boost Day 3 EV charger ($25 × 1 day) with the 25h pad. No PM2/mav-bridge restart.

Day 1 reel live: https://www.facebook.com/reel/1414714420575070/ — boost ad `6914478004679`. Ledger week `2026-08-31`: $25 spent, $25 remaining.

Still true: Graph publishes Facebook; Playwright posts GBP; Bot verifies public listings only. Do not redo UI. Do not re-post 8/29. Do not touch the unrelated dirty files (`classify-electrical.mjs`, `vision-benchmark.mjs`, `dump-gbp-dates.mjs`, uncommitted `fb-boost-ledger.mjs` week-header regex).

Older Facebook-media notes below are historical (2026-08-17).

---

# SEO Agents App — Handoff State (2026-08-17 archive)

**Last updated:** 2026-08-17 (Meta Ads API path implemented; live spend gated)  
**Branch:** `main`  
**Latest relevant commit:** (pending) Meta Marketing API boost via mav-bridge  
**Prior:** `c0e13c8` slideshow polish; `fb879f4`…`045edfe` real media stack

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

### Boost automation (implemented, spend gated)
- **Primary:** `scripts/fb-boost-api.mjs` + `scripts/lib/fb-boost-marketing.mjs`
- **Orchestration:** mav-bridge daily tick (after FB reconcile, ≥9am CT)
- **Money gate:** `fb-boost-ledger.mjs` eligible → reserve → publish|fail
- **Live spend off until:** `FB_BOOST_API=1` + `FB_AD_ACCOUNT_ID` + ads token
- **Rollback:** Playwright UI steps still in `FB-BOOST-RUNBOOK.md`

### NEXT — credentials + first live boost
1. Add `FB_AD_ACCOUNT_ID=act_…` and `FB_ADS_ACCESS_TOKEN` (ads_management) to `.env`
2. Set `FB_BOOST_API=1`
3. `node scripts/fb-boost-api.mjs status` then `run --dry-run` then `run`
4. Week of 2026-08-17: Day 1 still eligible ($50) if not boosted via UI yet
5. Confirm reel `object_story_id` accepted by Marketing API on first live create
6. Restart mav-bridge after env change so PM2 picks up keys

---

## Key commands

```powershell
cd C:\Workspace\Active\SEO-Agents-App
node scripts/facebook-poster.mjs --schedule-all --time 09:00 --dry-run
node scripts/facebook-poster.mjs --backfill-comments
node scripts/fb-boost-ledger.mjs eligible
node scripts/fb-boost-ledger.mjs status
node scripts/fb-boost-api.mjs status
node scripts/fb-boost-api.mjs run --dry-run
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
3. **Day 1 boost for week of 8/17** still needs application once ad credentials are set (`fb-boost-api.mjs run`).
4. Unrelated dirty tree: knowledge baseline archive files — leave alone.
5. AI video only if `FB_MEDIA_MODE=ai` (opt-in).
6. Page token alone **cannot** list ad accounts — need ads_management token / system user.

---

## Session note pointer

Code path for Marketing API boosts is in-tree. Next chat: wire credentials and run first live boost (or dry-run verify).
