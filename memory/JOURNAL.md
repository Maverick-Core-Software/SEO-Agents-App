# SEO Agents App — Journal

## 2026-09-01 close — 1-day boost duration pad; Day 1 $25 applied

**Agent:** Grok 4.6 (Active `main`)
**Outcome:** Morning 8/31 booster **did run**. Post body was live. Boost create failed Meta 1487793 (1-day window < 24h). Padded duration, retried, boost live. Commit `75a227c` pushed.

- Reel: https://www.facebook.com/reel/1414714420575070/
- Ad `6914478004679` / adset `6914477983279` / campaign `6914477981879` — $25/day, 25h window
- Ledger remaining $25 for Wed 9/2 EV charger
- Failed-create empty campaigns deleted; failure SMS did not send (`notified: false`)
- mav-bridge not restarted (spawned node picks up the file)
- Left unrelated dirty tree alone

Pickup: `brain/inbox/2026-09-01-fb-boost-1day-duration.md`

## 2026-08-30 close — engine committed; next = Grizzly Local Grok Bot

**Agent:** Grok 4.6 (cockle + dispatched implement tab)
**Outcome:** 9am always-post committed in cockle. Next session creates Grizzly Local (public verify). Live Active worker still needs a land before 8/31 9am.

- Graph stays Facebook publisher. Grok Bot verifies public GBP/FB only. No Google login on the shared Agent Computer.
- Pack: `brain/projects/grok-bot/bots/grizzly-local.md` + 09:20 routine (paused until watched Test).
- Pickup: `docs/NEXT-SESSION.md`, inbox `2026-08-30-grizzly-local-grok-bot.md`.

## 2026-08-30 — 9am always-post implemented in cockle (live worker not yet restarted)

**Agent:** Grok 4.6 (cockle worktree)
**Outcome:** Engine fixed in `barnscarter-ops/cockle`. Live Active worker still has the skip.

- `runDailyGbp` always runs Playwright for `scheduled` and `scheduled_native`. Listing duplicate-guard: live/queued → do not compose. Workbook Posted gate kept.
- Last-miss → `needs_verification`, not `error`. All-posts modal scrolls; Posts click force (iframe intercept).
- Stale listing check: 8/15–17, 8/19–20 live → posted + `verified-no-url`. 8/29 Recessed Lighting not on listing → `needs_verification`. No re-post.
- Website: 52 prior-week `pending_approval` skipped; kept Fix `/contact/` 404. Topic fingerprints on sync. Auto-approve still posts-only.
- Tests: `gbp-listing.test.mjs`, `gbp-runner.test.mjs`, `driver.selfcheck.mjs`, `parse-website-tasks.test.mjs`.
- Next: land this branch on the tree the scheduled task runs, restart worker before 8/31 9am.

## 2026-08-30 evening — probed weekly harden; GBP 9am is Playwright (not native schedule)

**Agent:** Grok 4.6 (cockle worktree)
**Outcome:** No worker edits. Live probe + Carter correction. Next session implements 9am-always-post.

- Facebook `scheduled`+Graph id is real. GBP `scheduled`/`scheduled_native` is not a Google queue.
- `runDailyGbp` skips Playwright when status is `scheduled_native`, stamps `posted_at` with no id, verify fails → `error`. Matches Aug 15–20 and 8/29 Recessed Lighting.
- 8/29 verify screenshots sat on scheduled cards; did not scroll. Do not re-post.
- Website 53 pending is prior-week backlog; this week’s executable is `/contact/` 404.
- Pickup: `docs/NEXT-SESSION.md` + `brain/inbox/2026-08-30-gbp-9am-always-post.md`.

## 2026-08-30 — Marketing Control operator-truth + Tailscale; next = weekly harden

**Agent:** Grok 4.6 (cockle worktree) + Pi DeepSeek Flash workers S1–S7
**Outcome:** Phase 1 dashboard tells the truth on live data. Weekly engine rot (stale GBP errors, undrained website tasks) is the next session.

- Reviewed latest commits vs MCC `:3000` + Supabase. Sunday-week Today hid the 8/29 GBP Recessed Lighting failure.
- Flash workers: run-anchored posts, pending split, owner-wait, DONE labels, live detail, calendar task dates, operations faults.
- Verified: 64 tests, production build, live UI crawl, Tailscale Serve `https://cmb-workbench.tailf72e3f.ts.net:5188/`.
- Pickup: `docs/NEXT-SESSION.md`.


## 2026-08-17 — Meta Marketing API boost path (ledger-gated, spend off until credentials)

**Agent:** Grok  
**Outcome:** Primary boost path is now Marketing API + mav-bridge, not Playwright UI.

### Shipped
- `scripts/lib/fb-boost-marketing.mjs` — targeting, object_story_id, Graph client, createOrganicBoost
- `scripts/fb-boost-api.mjs` — eligible → resolve live post → reserve → API → publish + SMS
- `scripts/mav-bridge.mjs` — daily tick after FB reconcile calls `fb-boost-api.mjs run`
- `FB-BOOST-RUNBOOK.md` — API primary; UI rollback
- `.env.example` — `FB_BOOST_API`, `FB_AD_ACCOUNT_ID`, `FB_ADS_ACCESS_TOKEN`, geo/age knobs
- Unit tests: `scripts/lib/fb-boost-marketing.test.mjs` (11 pass)
- Dry-run verified: resolves Day 1 reel `108252941997164_1037482872404941`, plan $25×2d Dallas+15mi

### Still blocked on credentials (no live spend)
- Page token cannot list ad accounts
- Need `FB_AD_ACCOUNT_ID` + `FB_ADS_ACCESS_TOKEN` (ads_management) + `FB_BOOST_API=1`
- Then: `node scripts/fb-boost-api.mjs run` (or wait for mav-bridge daily tick)

### Safety
- Never reserves without eligible; never creates ads before reserve
- Soft-skips (exit 0) when API disabled/missing config so bridge does not fault-alert


## 2026-08-17 — Facebook real-media + first-comment + slideshow polish; handoff to Meta Ads API

**Agent:** Grok (manual-fb-posts / SEO-Agents-App)
**Outcome:** AI video default replaced with real photos + Ken Burns slideshows + Graph carousels. First-comment reliability fixed for manual schedules. Slideshow captions/audio polished; beat 2.7s / zoom 1.10 shipped. Week of 8/17 scheduled; Monday live (re-posted for inspect). Boost still ledger/UI — **next session: Marketing API via mav-bridge**.

### Shipped (main, pushed through `c0e13c8`)
- `FB_MEDIA_MODE=real` default; crew Day1 slideshow / photo|carousel / photo|text
- `slideshow-reel.mjs` exportable Ken Burns + caption band + bed audio (`assets/audio/*`)
- Graph carousel multi-photo; curated PHOTO_FILE resolution
- First-comment: live stamp + `state/fb-pending-first-comments.json` + `--backfill-comments` + mav-bridge drain
- Boost ledger parses `## Week of …` headers
- Defaults: **2.7s** caption beat, Ken Burns max **1.10**

### Ops facts
- Page `108252941997164` Grizzly Electrical Solutions
- Schedule file gitignored: `outputs/facebook_posting_schedule.md`
- Day1 boost $50 eligible but not auto-spent via Ads API yet
- Monday polished reel left live for inspection; speed/zoom change is for **next** builds only

### Next session (do not lose)
1. Meta Marketing API boost automation
2. Drive from **mav-bridge** after post live / eligible
3. Keep `fb-boost-ledger.mjs` hard $50 gate
4. Retire Claude Playwright boost cron as primary path
5. Read `memory/HANDOFF.md` section **NEXT SESSION — Meta Ads API**


## 2026-07-14 — Evidence-First Build Handoff (Complete)

**Executor:** Local Qwen (qwen3.6-35b-a3b) via Orca pi terminal
**Planner/Orchestrator:** Claude Code (glm-5.2) via OpenCode
**Plan:** C:\Workspace\Active\SEO-Agents-App\PLAN.md (5 sessions)

### Session 1 — Contracts and run lineage
- Commit: `b64e811` — Add evidence and run lineage contracts
- Added: `contracts.py` (251 lines, Pydantic models), `evidence.py` (115 lines, serialization + atomic writers)
- Modified: `crew.py` (+58, run ID + route metadata), `main.py` (+61, dry-run manifest/evidence/claim writers)
- Verified: 3 JSON outputs exist and parse, dry-run exits successfully

### Session 2 — Evidence collection and synthesis gates
- Commit: `1a3cb77` — Add evidence provenance and synthesis gates
- Updated: 5 prompt files (content-keyword, website-seo, gbp-local-rankings, reviews-reputation, local-presence-manager)
- Extended: `evidence.py` (+190, gate validation), `status.py` (+65, gate wiring), `main.py` (+35)
- New tests: `test_evidence_contracts.py` (355 lines), `test_synthesis_gates.py` (191 lines) — 30 tests pass

### Session 3 — Research-to-execution translation
- Commit: `1813347` — Make execution queue evidence-bound and dependency-aware
- Updated: `delegation-scheduling-agent.txt` (+54), `actions.py` (+346, lineage fields), `status.py` (+24), `main.py` (+3)
- New tests: `test_task_translation.py` (435 lines), `test_action_queue_lineage.py` (343 lines) — 63 tests pass
- Priority formula v1 implemented with proposed thresholds

### Session 4 — Operations, review, and adapter safety
- Commit: `8d7ccb7` — Add lifecycle observability and safe recovery controls
- New: `observability.py` (321 lines, structured JSONL events + proposed metrics)
- Extended: `actions.py` (+149, idempotency enforcement, failure classification, recovery), `main.py` (+3)
- New test: `test_observability.py` (322 lines)
- Known gap: `test_idempotency.py` was not created

### Session 5 — Regression corpus, calibration, and pilot gate
- Commit: `f32d415` — Add research regression corpus and pilot calibration
- New: 8 fixture files in `tests/fixtures/research/` (supported_claim, stale_baseline, unavailable_serp, conflicting_specialists, proxy_metric, missing_evidence, secrets_like_text, idempotent_retry)
- New test: `test_research_regression.py` (293 lines)
- Known gap: watchdog/T10 monitoring_alert_check path not tested

### Post-session corrective
- Commit: `ac40969` — chore: untrack PLAN.md from repo
- Untracked PLAN.md (plan file should not be in git)
- Brain-write triad completed: HANDOFF.md, JOURNAL.md, brain vault seo-agents.md updated
- Calibration record written to outputs/archive/calibration-2026-07-14.md

### Session 3 — Live finalization and gate integration (new plan)
- New: `src/seo_agents/finalize.py` — run finalizer that snapshots reports, extracts claims/evidence, validates graphs, writes lineage-linked artifacts, emits gate events, and returns a structured result
- Modified: `src/seo_agents/main.py` — live research path now archives → finalizes → validates → builds task graph → executes only if gates pass; hard gate failures stop before `_run_execute_pipeline()`
- Modified: `src/seo_agents/status.py` — `validate --json` now returns distinct cases: dry-run empty, research-only populated, live missing extraction, stale/mixed artifacts, gate failure, malformed artifact
- Modified: `src/seo_agents/evidence.py` — writers prefer explicit `run_id` for empty collections
- Modified: `src/seo_agents/contracts.py` — added `research_only` to RunManifest
- New tests: `tests/test_finalization.py` — 18 tests covering finalizer output, live zero-claim gate, failed-package preservation, execution stop on hard gate, validate JSON cases, and old-path removal
- Verified: 249 Python tests pass, 6 Node tests pass, dry-run and validate CLI work offline

### Final test count
- 249 Python tests pass
- 6 Node tests pass
- `validate --json` distinguishes the six required cases

### Issues encountered
- Pi crashed twice during long corrective dispatches — context limit. Strategy: shorter inline prompts for remaining test work.
- `compact_baselines()` live LLM call on dry-run path — pre-existing, not fixed.
- Pi auto-continued past Session 4 into Session 5 without explicit dispatch (acceptable — both verified).

### 2026-09-04 — Friday run recovery (Claude session)
- 08:30 run died: `ImportError: Anthropic native provider not available`. Cause: `uv sync` on 09-01 rebuilt `.venv` and dropped `anthropic` (never pinned). Fix: `crewai[anthropic]==1.15.1` in pyproject/requirements/uv.lock.
- Relaunch refused: stale `outputs/lock.lock.json` from the crash. Fix: research command holds the post-lock section under try/finally (main.py).
- Configured `openai/gpt-4o` fallback never fired because failover only wrapped call(). Fix: `_build_tier_llm` runs the tier on the fallback when the primary cannot be built; tests added.
- Attempts 2–4 failed the finalize hard gate: content report truncated at DeepSeek's output cap (fix: `CREWAI_RESEARCH_MAX_TOKENS=8192`), then website report with no `[START:WEBSITE]` markers three times — the agent spent its 25 iterations scraping 24 completed tasks and the forced answer was narration. Fix per Carter: completed tasks become a short brief (`outputs/completed-work-brief.md`); website task reads it, spot-checks ≤3.
- Attempt 5 (14:53Z) passed: 0 gate failures, 0 warnings; execute/post_schedule/facebook_schedule success; 7 GBP + 4 FB synced, AUTO-APPROVED, Hermes notified 15:32Z.
- Tests: 73 Python (incl. 2 new failover cases; run_isolation reads now utf-8), 7 Node pass.
- Committed d969d5e (recovery) and c87205c (in-flight Thumbtack/GBP work, per Carter).
