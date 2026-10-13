# SEO-Agents-App cutover scoping audit (PC -> AIWA LXC, v2 live, GBP API)

Date: 2026-10-13. Author: lead auditor (read-only pass; no repo, AIWA, or pm2 mutations).
Scope: everything that makes up "SEO" on CMB-Workbench, what must change to run it on an
AIWA LXC, what flips the v2 pipeline live, and what the official GBP API path needs.
Evidence is `file:line` against the state in section 0.2 unless marked otherwise.

## 0. Repo state during this pass

### 0.1 Start snapshot (13:0x local, before the orchestrator's merge)
- Branch `feat/seo-v2` @ `4151431`, 17 modified + 2 untracked files (the 2026-09-30 phone change,
  `scripts/gbp-api-poster.mjs`, `scripts/log_monitor_web.py`, `artifacts/phone-change-2026-09-30/`).
- PR #7 `fix/ffmpeg-and-watchdog-followups` open; remote had 8 branches incl. `origin/barnscarter-ops/cockle`.

### 0.2 End snapshot (2026-10-13 18:29Z) - the state this audit is written against
- `main` @ `6f748c0`, clean tree (0 dirty). `main` = `2492234` + PR #7 (`e2850b4`, merged 18:16:49Z:
  ffmpeg fallback paths, watchdog/schedule freshness) + PR #8 (`6f748c0`, merged 18:16:54Z:
  `.gitattributes` LF fixtures, boost-ledger one clock, GBP photo not picked at sync).
- `feat/seo-v2` @ `4151431` untouched; **13 commits ahead, 5 behind main; NOT an ancestor of main**
  (`git log main..feat/seo-v2` = 12394e3..4151431; `git diff --stat main...feat/seo-v2` = 58 files,
  +6953/-1339).
- `wip/pc-local-2026-10-13` @ `fa4057d` = feat/seo-v2 + one commit parking the 26 PC-local files; pushed.
- Remote branches now: `main`, `feat/seo-v2`, `wip/pc-local-2026-10-13`, plus stale
  `origin/barnscarter-ops/cockle`, `origin/feat/seo-phase2-media`, `origin/feat/seo-plan-phase0-wave2`,
  `origin/fix/ffmpeg-and-watchdog-followups` in local packed-refs (not pruned).
- Fork `barnscarter-ops/SEO-Agents-App`: `archived: true` (GitHub API). `.git/config` has only
  `origin = Maverick-Core-Software/SEO-Agents-App`.
- `C:\Workspace` is an NTFS junction to `D:\Workspace` (fsutil reparse tag 0xa0000003; realpath of
  `C:\Workspace\Active\SEO-Agents-App` = `D:\...`). One checkout, two spellings; scheduled tasks and pm2
  launch via `C:\`, Node resolves to `D:\` (memory: scheduled-node-scripts-c-vs-d-junction-guard).
- This repo has **no AGENTS.md / CLAUDE.md**; `.claude/launch.json` only points at an unrelated MCC dev server.

### 0.3 Live operational state observed (PC, today)
- `state/gbp-session-health.json` @ 18:17:55Z: `{"context":"startup","mode":"playwright","ok":false,"reason":"logged_out"}`;
  no `state/gbp-worker.pid`; `logs/gbp-worker.log` loops "session check failed: GBP session expired"
  with 15-min backoff. **GBP posting on the PC is gated right now** (Days 5-7 of week-of 10-12 =
  10-13..10-15 are at risk unless native-scheduled cards exist on Google).
- `outputs/weekly-runner-health.json`: legacy `success` 2026-10-09; shadow `succeeded` but
  `notify.sent=false, status=missing` (see 2.5).
- `outputs/reconcile-health.json` does not exist -> the daily `Grizzly SEO Reconcile` task has never
  completed (or was never registered; `docs/NEXT-SESSION.md:10` still says "register ... from an elevated shell").
- `H:\` (Drive for Desktop) and `M:\` (`\\192.168.1.12\Proxmox`) are not mounted; `E:\` gone since 08-29.

---

## 1. Service inventory (what runs on the PC)

Legend: LEG = legacy CrewAI Friday chain; V2 = `scripts/weekly`; SHR = shared publisher/infra used by both.

| # | Service / job | Script | Launcher + schedule (all America/Chicago) | What it does | Talks to | Tier |
|---|---|---|---|---|---|---|
| 1 | Grizzly SEO Photo Sync | `scripts/sync-photos-from-drive.mjs` | Task Scheduler weekly Fri 08:25 (`scripts/setup-scheduled-tasks.ps1:72-73`, S4U principal `:51`) | Mirrors `H:\My Drive\GBP Photos` -> local cache, additive (`:37-39`) | local FS only | SHR (feeds the picker) |
| 2 | Grizzly SEO Weekly Run | `scripts/run-weekly-seo.py` | Task Scheduler Fri 08:30 (`setup-scheduled-tasks.ps1:78`) | Preflight, topic rotation, launches `python -m seo_agents.main` (CrewAI, 150-min cap `:40`), then `supabase-sync.mjs`, then **if `SEO_PIPELINE=shadow`** `node scripts/weekly/run.mjs --mode shadow` (`:282-320`, 30-min cap `:311`) | DeepSeek/Anthropic/OpenAI (CrewAI tiers), SerpApi (legacy tool), Supabase, Hermes CLI (`:292`), SMTP | LEG host + V2 launcher |
| 2a | `supabase-sync.mjs` (child of 2) | `scripts/supabase-sync.mjs` | invoked by 2 | Parses `outputs/*_posting_schedule.md`, upserts `seo_runs(week_of)`, inserts `weekly_posts`/`website_tasks`; auto-approves when `SEO_AUTO_APPROVE=1`; Hermes ping | Supabase, Hermes CLI | LEG (v2 `new` mode would replace via `project.mjs`) |
| 3 | Grizzly SEO Monitor | `scripts/seo-monitor.mjs --run-hours 14` | Task Scheduler Fri 08:30 (`setup-scheduled-tasks.ps1:84`) | Polls Supabase every 30 s for 14 h; **`pm2 jlist/restart/resurrect`** (`:152-178`); **`net use M:` remount** (`:186-198`); HTTP health of mav-bridge :8790 and MCC :3000; no-show alarm; exits silently if `SUPABASE_URL` unset (`:63-65`) | Supabase REST, pm2, SMB, Hermes, SMTP | LEG (v2-branch adds shadow block) |
| 4 | Grizzly SEO Watchdog | `scripts/seo-watchdog.mjs` | Task Scheduler daily 10:00 (`setup-scheduled-tasks.ps1:94-102`) | Independent no-show/failed/stale detector from `outputs/weekly-runner-health.json`; on v2 branch also PIPELINE NO-SHOW/FAILED/HUNG/NOTIFY MISS/RECONCILE STALE gated on `SEO_PIPELINE` (`seo-watchdog.mjs:70-71,218-250` v2) | Hermes, SMTP | SHR |
| 5 | Grizzly SEO Reconcile | `scripts/weekly/reconcile.mjs` | Task Scheduler daily 10:10 (`setup-scheduled-tasks.ps1:113-121`) - **not evidently running** (no `outputs/reconcile-health.json`) | FB 7/28-day metrics + Search Console into `performance_observations`; copies publish status to `plan_items` | Graph API, Search Console (token `C:/Users/carte/gmail-multi/tokens/grizzly-search-console.json`, `reconcile.mjs:63-64`), Supabase | V2 only |
| 6 | Grizzly SEO GBP Worker | `scripts/gbp-worker.mjs` (pm2 wrapper `scripts/gbp-worker-service.mjs`) | **Two conflicting launchers**: pm2 app `gbp-worker` (`ecosystem.config.cjs:28-40`, "since 2026-09-11") and Task Scheduler `Grizzly SEO GBP Worker` (`ops/gbp-worker-task.xml` -> `ops/gbp-worker-launch.vbs`, logon + daily 08:00; `ops/gbp-move-off-session0.ps1` dated 09-25 moves it back to the task). Pidfile `state/gbp-worker.pid` is the mutex (`gbp-worker.mjs:85-122`) | 30-s poll (`:48`); claims `weekly_posts platform=gbp status=approved` (CAS), runs `gbp-photo-pick.mjs` (gpt-4o scoring), `sync-gbp-schedule.mjs` (xlsx), driver Day 1 live + Days 2-7 `--schedule` (`lib/gbp-runner.mjs:326-381`); daily >=09:00 CT posts `scheduled`/`scheduled_native` rows for today (`gbp-runner.mjs:421-442`, in-memory latch `gbp-worker.mjs:614-623`); Grok verdict reconcile (`:495-559`); session probe startup + 08:00 (`:224-360`) | Supabase, business.google.com (Playwright), api.openai.com (gpt-4o), Hermes, `M:\backups\gbp-archive` | SHR (publisher for legacy and v2) |
| 7 | mav-bridge | `scripts/mav-bridge.mjs` | pm2 app **defined in MCC**: `C:\Workspace\Active\MCC\ecosystem.config.cjs:69-80` (cwd SEO repo, `env_file` SEO `.env`); port 8790 (`mav-bridge.mjs:54`), poll 30 s (`:53,1478`) | Executes approved runs: FB Graph posting via `facebook-poster.mjs` (slideshow Reels via ffmpeg), first comments, website tasks via `seo-agents` CLI (`:55-61`), FB reconcile (`:664-745`), boost tick >=09:30 CT (`:87,756-757` -> `fb-boost-api.mjs`, Marketing API, ledger-gated), 30-min `posting` TTL sweep (`:817`), Slack Block Kit approvals (`lib/slack-alert.mjs` reads `%LOCALAPPDATA%\hermes\.env`), Hermes alerts; GBP only if `MAV_BRIDGE_GBP=on` (`:70`); **`GBP_POSTER` default `api` (`:63`) vs worker default `playwright` (`gbp-worker.mjs:60`)** - only `.env` keeps them aligned | Supabase, graph.facebook.com, Hermes, Slack, MCC | SHR |
| 8 | fb-comment-agent | `scripts/facebook-comment-agent.mjs` | pm2 (`ecosystem.config.cjs:5-19`), port 8795 `/health` only (`:358-361`) | Polls page posts/comments, replies via xAI | Graph API, xAI | SHR (independent of Friday) |
| 9 | thumbtack-worker | `scripts/thumbtack-worker.mjs` | pm2 (`ecosystem.config.cjs:41-56`), `127.0.0.1:8796` (`:66-68`); also `ops/Start-ThumbtackWorker.ps1` breakaway start | Thumbtack webhooks/OAuth, first-touch SMS | api.thumbtack.com, Twilio, Mav fabric; public ingress via Tailscale Funnel on `cmb-workbench` | **Not SEO** - separate cutover decision (ingress hostname is PC-bound: `scripts/lib/thumbtack/config.mjs:43-45`, `list-webhooks.mjs:6`) |
| 10 | mav-console (MCC :3000) | MCC repo `server.mjs` | pm2 in MCC ecosystem; **already runs on AIWA CT 103 per the orchestrator's inventory** | Approval UI; thin proxy to mav-bridge `http://127.0.0.1:8790` (`marketing-control/docs/AUDIT-FINDINGS.md:343`) | mav-bridge, Supabase | SHR (consumer) |
| 11 | Hermes CLI (`hermes send`) | `C:\Users\carte\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe` | invoked by 2,2a,3,4,6,7, boost | Slack alerts (`HERMES_ALERT_TO=slack`) (`scripts/lib/hermes-alert.mjs:19-27`) | Slack | SHR transport |
| 12 | Grizzly-Electrical-Classify | `scripts/run-electrical-classify.ps1` -> `classify-electrical.mjs` | Task Scheduler Mon 02:00 per `docs/ingestion/icloud-photos-automation.md:12-50` only (not in setup script); starts a local `llama-server.exe` | Labels raw photos (local vision) | local llama (port per script) | SHR (library hygiene; optional) |
| 13 | Other cron-like loops | `seo-monitor` 30 s x 14 h; `mav-bridge` 30 s; `gbp-worker` 30 s + 08:00 probe + 09:00 daily latch + 09:30 boost tick (bridge); `fb-comment-agent` `FB_COMMENT_POLL_MS` | | | | |

Not found anywhere: a cron/timer for `verify-gbp-posts.mjs` (manual), `gbp-analytics-collector.mjs`
(dormant), `facebook-insights-collector.mjs` (manual per `FRIDAY-RUNBOOK.md:252-256`).

Friday sequence (from `marketing-control/docs/CURRENT-STATE-INVENTORY.md:58-77` + wrapper): 08:25 photo
sync -> 08:30 legacy crew + monitor -> ~08:37 crew phases -> supabase-sync (auto-approve) -> ~08:40
shadow run -> mav-bridge executes FB within 30 s of approval; gbp-worker posts Day 1 + schedules 2-7 ->
09:30 boost tick -> 10:00 watchdog -> 10:10 reconcile -> 22:30 monitor exit.

---

## 2. V2 readiness

### 2.1 What `SEO_PIPELINE` gates, exactly
- `scripts/run-weekly-seo.py:289-296` (main): `run_shadow_pipeline()` runs **only** when
  `SEO_PIPELINE=shadow`, after a successful legacy run, as `node scripts/weekly/run.mjs --mode shadow`,
  30-min timeout, result into the health file's `shadow` block (`:320`). Default `legacy` = nothing new runs.
  On `feat/seo-v2` the wrapper grows `PIPELINE_MODES=("shadow","offline")` (`:311`),
  `NOTIFY_MODES=("shadow","new")` (`:314`), `--rehearsal`, attempt-record health, `SEO_SHADOW_TIMEOUT_MIN`.
- `scripts/seo-watchdog.mjs:70-71,218-250` (v2 branch): pipeline checks only when mode in `{shadow,new}`.
- `scripts/seo-monitor.mjs:546`: reports the mode; v2 branch reads the same shadow block.
- **There is no `new` mode in `scripts/weekly/run.mjs`** on either branch (`--mode shadow|offline` only,
  `scripts/weekly/README.md:12-15`). `projectPlan()` (`scripts/weekly/lib/project.mjs:111-144`, v2 branch;
  `allowLive` guard) writes `seo_runs`/`weekly_posts`/`website_tasks` but **nothing calls it**. T21
  (`PLAN.md:437`: budget to $5, `--pipeline new`, legacy crews disabled) is unbuilt. "Making v2 live"
  therefore means: add `--mode new` (collect/select/generate/validate/stage as today + `projectPlan`
  with `autoApprove` from `SEO_AUTO_APPROVE`), make the wrapper skip the CrewAI research/execute/schedule
  crews when `SEO_PIPELINE=new`, keep `supabase-sync` out of the path (projection replaces it), and keep
  the publishers (mav-bridge, gbp-worker) unchanged - they consume `weekly_posts` rows (`docs/rebuild/...plan.md:15`).
- Shadow writes only `seo_attempts`, `seo_week_leases`, `research_observations`, `plan_revisions`,
  `plan_items`, `performance_observations` (+ `outputs/shadow/`, `state/weekly/serp-cache`); legacy owns
  `seo_runs`, `weekly_posts`, `website_tasks`, `run_logs` (`supabase/schema.sql:7-77`,
  `supabase/migrations/003_weekly_pipeline.sql:21-179`; `.from()` counts: v2 reads `weekly_posts` x6 for history).

### 2.2 main vs feat/seo-v2 (what v2 actually needs that main lacks)
`git diff --stat main...feat/seo-v2`: 58 files. The material groups:
- Wrapper: `scripts/run-weekly-seo.py` +439 (T2 attempt-derived health, T6 kill finalization, T16 rehearsal seam, `--notify`, `SEO_LEGACY_SERPAPI` skip in `src/seo_agents/crew.py`).
- v2 package: `attempt.mjs`, `collectors/serpapi.mjs` +231 (T5 concurrency/quota stop), `history.mjs` (T9), `select.mjs` (T8), `validate.mjs` +139 (T12 boost normalizer, T13 anecdotes, T14 carousel downgrade), `llm.mjs`/`cost-meter.mjs` (T7 served-model pin), `notify.mjs` (T1 receipt), `reconcile.mjs` (T10/T11 health), `project.mjs` (T19 row-id links), `run.mjs` +154, `DESIGN.md`, 9 test files.
- GBP durability/media: `gbp-poster/driver.mjs` (P2.8 storageState, `--check-session`, `--export-session`), `gbp-worker.mjs` +358 (session probe, pidfile ownership, stuck-poll fail-closed), `lib/photo-selection.mjs` +723 (P2.3 shared selection, **sha256 no-reuse 8 weeks**, labels gates, manifest lock), `lib/gbp-paths.mjs` (G4 policy), `classify-electrical` labels, `facebook-insights.mjs`.
- Watchdog/monitor shadow checks (T3), `reset-gbp-scheduled.mjs` guard (L3), `hermes-alert.mjs` PYTHONPATH fix, `tests/test_friday_fixes.py`.
- **Conflict surface with the merged PRs** (files changed on both sides since `2492234`):
  `scripts/fb-boost-ledger.mjs`, `scripts/lib/ffmpeg-bin.mjs`, `scripts/lib/gbp-paths.mjs`,
  `scripts/lib/gbp-paths.test.mjs`, `scripts/seo-watchdog.mjs`, `scripts/seo-watchdog.test.mjs`,
  `scripts/slideshow-reel.mjs`. The ffmpeg fix exists twice (`4151431` on v2, `6e53c23` on main);
  PR #8's `resolveGbpImagePath(..., fallback)` in `gbp-paths.mjs` must be reconciled with v2's G4 policy edits.
- Verdict: **v2 readiness requires merging `feat/seo-v2` into main** (M, with 7 conflict files to resolve
  by hand) and then building `--mode new` (M). Main alone is the 2026-09-06-era shadow code.

### 2.3 The parked WIP branch (`wip/pc-local-2026-10-13` @ fa4057d vs feat/seo-v2)
`git diff --ignore-all-space --stat` of the parked files (17 tracked + 2 untracked): 118 ins / 36 del.
| File | What | Needed for cutover? |
|---|---|---|
| `knowledge/baselines/grizzly-business-facts.md` | published main phone `(469) 863-9804` -> `(469) 716-9870` (owner-authorized 2026-09-30); old number marked "unverified external" | **Yes** - this is v2's `FACTS_PATH` (`scripts/weekly/lib/paths.mjs:15`); the validator will reject the new number and accept the retired one until this lands. Main still carries the old number. |
| `knowledge/website-structure.md`, `prompts/agents/gbp-local-rankings-agent.txt` | same phone swap (prompt diff is 2 lines ignoring CRLF) | Yes (legacy crew prompt), small |
| `scripts/facebook-poster.mjs` (+47) + `facebook-poster.selfcheck.mjs` | `hasRetiredMainNumber` guard: refuses env overrides and **throws in `buildCaption` if the retired number is in post text** (`:497-507` on WIP) | **Yes** - prevents republishing the retired number; note it is a hard throw, so a stale schedule fails the whole FB batch (acceptable, but alert path must surface it) |
| `scripts/gbp-api-poster.mjs` (+27 ignoring ws; ~65 raw) | exit 5 `policy_violation` via `gbp-poster/policy-check.mjs` (caption only), selfcheck cases, `realpathSync` entry guard for the C:/D: junction | **Yes for the API switch** - gives parity with the driver's exit-code contract (`lib/gbp-runner.mjs` maps exit 5). This is GBP API work in progress, not Thumbtack. |
| `scripts/lib/thumbtack/first-touch.mjs`, `policy.mjs` | phone swap + removes "this is Jaime" wording | Thumbtack only; owner call; not cutover |
| `scripts/weekly/test/*` fixtures (7 files) | phone swap in fixtures/tests | Yes with the facts change (tests pin the number) |
| `scripts/log_monitor_web.py`, `artifacts/phone-change-2026-09-30/` | ad-hoc monitor UI; FB API edit inventory | No |
Recommendation: cherry-pick the phone/facts/poster-guard/API-poster/fixture subset onto main after the v2 merge; leave Thumbtack wording for Carter.

### 2.4 PR #7 / #8 (now in main)
- #7: `scripts/lib/ffmpeg-bin.mjs` backslash-in-template bug (fallback paths never matched), watchdog
  checks on any day, schedule files must be newer than the kickoff. Required for the FB slideshow path
  under pm2 on Windows; on Linux `ffmpeg` resolves from PATH anyway (`ffmpeg-bin.mjs:47` `tryRun(name)`).
- #8: LF fixtures (`.gitattributes`), boost staleness clock, `sync-gbp-schedule` no longer substitutes a
  service-blind photo at sync time. Not v2-specific; keeps the test suite green on Windows.

### 2.5 Shadow run evidence (latest: 2026-10-09, week of 2026-10-12)
- `outputs/shadow/attempt.json`: `2026-10-12-20261009T133714Z-974f54`, `succeeded`, 198 s, $0.24 of $20,
  `deepseek-chat`, all 7 stages ok, store = Supabase (`outputs/weekly-shadow-2026-10-09.log:3`).
- `outputs/shadow/compare.md`: GBP 7/7/7, FB 4/4/4, website legacy 5 vs shadow 3; **0 of 11 slots off-spec
  on both sides**; facts violations: legacy none, shadow none; legacy FB header has no ISO week date
  (legacy sync needs `--week-of`), shadow has `2026-10-12`. Topics diverge (legacy: breaker tripping;
  shadow: recessed lighting Rowlett) - compare.md is structural; there is **no recorded content-quality
  verdict** (`FRIDAY-RUNBOOK.md` clean-Friday table on the v2 branch is empty; root decision 12).
- Shadow log series: 09-11, 09-18, 09-25 (+rerun), 10-02, 10-09 = five Fridays of shadow.
- Known defects in the 10-09 artifacts: (a) health `shadow.notify = {sent:false,status:"missing"}` while
  the shadow log says "notify: sent via hermes" -> receipt is not written to the attempt record on main's
  code (v2-branch T1 fixes the receipt) - this would raise PIPELINE NOTIFY MISS every week on the v2
  watchdog; (b) `meter.json` preflight "served deepseek-flash, requested deepseek-chat" (model-pin
  mismatch warning); (c) SerpApi `22 ok / 58 unavailable` (free-plan quota; T23 capacity gate unresolved);
  (d) carousel downgraded to photo on FB day 5, boost normalized $10x5 -> $50x1 (expected T12/T14 behaviour);
  (e) no `reconcile-health.json` (section 0.3) -> `performance_observations` memory is not advancing.
- Legacy that same morning auto-approved 11 posts (`outputs/weekly-crew-2026-10-09.log` tail) - the live
  publishers are fed by legacy today.

### 2.6 Tests
- Node: `node --test "scripts/**/*.test.mjs"` from clean `main @ 6f748c0`, Node v24.19.0:
  **800 tests / 159 suites, 800 pass, 0 fail, 56.9 s, exit 0**; working tree still clean afterwards.
  Side effects: 22 of 58 test files use `mkdtemp`; none write `outputs/` or `state/` directly
  (`scripts/weekly/test/e2e-offline.test.mjs:55-70` isolates store/out; the e2e also traps `fetch`).
- Python: not run. `tests/conftest.py:12-35` `fix_output_dir` is a documented no-op (AUDIT-FINDINGS M10)
  so a stray test can write real `outputs/`, and `test_research_regression.py::test_dry_run_no_live_adapter`
  needs a git-ignored `outputs/run_manifest.json`. Command: `uv sync --locked && uv run --with pytest pytest`
  (PR #8 reported 385/386 on this checkout, the 1 failure being that fixture).
- `npm run lint` = `eslint scripts/ --quiet` (`package.json`). No CI exists (M11).

### 2.7 References to the archived fork
- Remote-tracking ref `refs/remotes/origin/barnscarter-ops/cockle` (`.git/packed-refs:6`) - a stale branch
  name on origin, not a fork URL; prune.
- Docs/text only: `README.md:86` and `knowledge/website-structure.md:4` (`github.com/barnscarter-ops/grizzly-website`
  - the **website** repo, used by `src/seo_agents/website.py:26` live pushes; confirm that repo's home),
  `docs/ingestion/ios-photo-shortcut.md:148` (MaverickField), `memory/JOURNAL.md:29`,
  `artifacts/audit-20260830/FIX-PLAN.md:7`, `.../fix-run/scratchpad.md:5`, `outputs/archive/final_report_2026-07-17.md:46`.
- No code, config, package.json, `.pi/`, `.claude/`, or git remote references the fork.

---

## 3. Windows dependencies (file:line, path tier, Linux equivalent, effort)

Effort: S = env var/config only, M = small code change, L = redesign.

### 3.1 In the v2 path (`scripts/weekly` + its imports)
| Where | What | Linux equivalent | Effort |
|---|---|---|---|
| `scripts/weekly/reconcile.mjs:63-64` | default `GBP_TOKEN_FILE = C:/Users/carte/gmail-multi/tokens/grizzly-search-console.json` | set `SEARCH_CONSOLE_TOKEN_FILE` in env; copy token JSON to a mode-600 dir | S |
| `scripts/lib/gbp-api-auth.mjs:10-18`, `scripts/lib/search-console.mjs:12-13`, `scripts/authorize-*.mjs:18-29` | `GMAIL_MULTI_DIR = C:/Users/carte/gmail-multi` defaults for client secret + tokens | `GBP_CLIENT_SECRET`, `GBP_TOKEN_FILE`, `SEARCH_CONSOLE_TOKEN_FILE` env | S |
| `scripts/lib/hermes-alert.mjs:19-27` | `hermes.exe` default, `windowsHide` | `HERMES_CLI=/path/to/hermes` on the LXC (Hermes-Supervisor already runs on AIWA) **or** replace transport with a direct Slack webhook/bot post; `windowsHide` is ignored on Linux | M |
| `scripts/lib/gbp-paths.mjs:8-13` (imported by `weekly/run.mjs:59`) | `C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos`, `E:\Media\Grizzly\Curated` defaults | `GBP_PHOTOS_LOCAL_CACHE`, `GBP_CURATED_FOLDER` env pointing at the LXC mount | S |
| `scripts/weekly/run.mjs:922-927` | junction realpath guard | harmless on Linux | - |
| `scripts/weekly/lib/stage.mjs:237`, `lib/store.mjs:68` | EPERM/EBUSY retries | harmless | - |
| `scripts/run-weekly-seo.py:94-95,111` | venv `Scripts\python.exe` first, `bin/python` fallback | works; `uv sync` on Linux | S |
| `scripts/run-weekly-seo.py:292`, `src/seo_agents/main.py:96` | `hermes.exe` default | `HERMES_CLI` | S |

### 3.2 Shared publishers (needed by both pipelines)
| Where | What | Linux equivalent | Effort |
|---|---|---|---|
| `scripts/lib/ffmpeg-bin.mjs:14-29,47` | winget/`C:/ffmpeg` candidates, then bare `ffmpeg` on PATH | `apt install ffmpeg`; PATH lookup already works; optional `FFMPEG_DIR` | S |
| `scripts/facebook-poster.mjs:165-167` | `C\:/Windows/Fonts/arialbd.ttf` with a non-win32 fallback | `apt install fonts-dejavu` or set `GRIZZLY_ENDCARD_FONT` | S |
| `scripts/facebook-poster.mjs:102` | default photo folder `C:\...\GBP Post Photos` | `GBP_PHOTO_PATH` env | S |
| `scripts/facebook-poster.mjs:175,1485`, `gbp-profile-adapter.mjs:45` | `~/.claude/fb-session`, Playwright fallback node_modules under `C:\Workspace\Active\homelab-noc-dashboard` | only used when `FB_USE_PLAYWRIGHT=1` (off) | - |
| `scripts/mav-bridge.mjs:55-61`, `scripts/gbp-worker.mjs:53-57` | `.venv\Scripts\seo-agents.exe` + `C:\Users\carte\AppData\...\seo-agents.exe` candidates, `.venv/bin/seo-agents` fallback | `SEO_AGENTS_EXE=/opt/seo/.venv/bin/seo-agents` | S |
| `scripts/lib/slack-alert.mjs:14-16,33-36` | reads `%LOCALAPPDATA%\hermes\.env` for `SLACK_BOT_TOKEN`/home channel | set `SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL` explicitly (`.env.example:19-24` documents the override) | S |
| `scripts/lib/thumbtack/mav-room-notify.mjs:3` | `C:\Workspace\Active\Mav-Room\.mav-room\runtime.env` | Thumbtack only | n/a |
| `config/gbp-poster.config.json:2-4`, `scripts/gbp-api-poster.mjs:37`, `scripts/gbp-poster/driver.mjs:15-16,25`, `lint-workbook.mjs:15` | workbook dir `C:\Workspace\Shared\Operations\Grizzly\GBP`, `DEFAULT_CONFIG` absolute | pass `--config` / `GBP_WORKBOOK_PATH`; make `DEFAULT_CONFIG` relative to `PROJECT_ROOT` | M (one-line) |
| `scripts/lib/gbp-runner.mjs:253`, `scripts/seo-monitor.mjs:47,186-198,379` | `M:\backups\gbp-archive` + `net use` remount | `GBP_ARCHIVE_FOLDER=/srv/seo/gbp-archive` (local or NFS from the Proxmox host); delete the `net use` check or gate on `process.platform` | M |
| `scripts/seo-monitor.mjs:152-178,338-371` | `pm2 jlist/restart/resurrect` self-healing | on AIWA keep pm2 (present on CT 103) **or** switch to systemd units and replace with `systemctl is-active`; gate by env `SEO_MONITOR_PM2=0` | M |
| `scripts/gbp-poster/driver.mjs:78-93` | `icacls` ACL on storage-state (win32-gated) | n/a once GBP is API; else `chmod 600` branch exists | - |
| `scripts/lib/thumbtack/token-store.mjs:13,125-130` | chmod only on non-Windows | fine | - |
| `ecosystem.config.cjs:7-8,31-32,43-44` + MCC `ecosystem.config.cjs:69-80` | absolute `C:\\Workspace\\...` script/cwd/`env_file`, `windowsHide` | new Linux ecosystem (or systemd units) with `/opt/seo/...`; **move the mav-bridge entry into this repo's ecosystem** so AIWA-SEO owns it | M |
| `scripts/setup-scheduled-tasks.ps1` (whole), `ops/gbp-worker-task.xml`, `ops/gbp-worker-launch.vbs`, `ops/*.ps1` | Task Scheduler/S4U/wscript | systemd timers: `seo-photo-sync` (Fri 08:25), `seo-weekly-run` (Fri 08:30), `seo-monitor` (Fri 08:30), `seo-watchdog` (daily 10:00), `seo-reconcile` (daily 10:10); each unit `Environment=TZ=America/Chicago` | M |
| `src/seo_agents/evidence.py:232` | `OUTPUT_DIR = Path(r"C:\Workspace\Active\SEO-Agents-App\outputs")` **hardcoded** | derive from package root | M |
| `src/seo_agents/actions.py:41-60`, `crew.py:1038,1188`, `main.py:849,1123`, `website.py:26` | `C:\Users\carte\.claude\skills\gbp-poster\driver.mjs` (stale copy), `.codex\plugins\...config.local.json` (**does not exist**), `GBP_PHOTO_PATH`, website repo dir | env overrides exist (`GBP_POSTER_SCRIPT`, `GBP_POSTER_CONFIG`, `GBP_PHOTO_PATH`, `WEBSITE_REPO_DIR`); legacy-only | S (or retire with legacy) |
| `scripts/sync-photos-from-drive.mjs:37-39`, `gbp-photo-pick.mjs:93`, `verify-photo-ingestion.mjs:33-35` | `H:\My Drive\GBP Photos` (Drive for Desktop) | **no Drive-for-Desktop on Linux**: replace with `rclone sync gdrive:GBP\ Photos /srv/seo/photos/inbox` under the same timer (needs an rclone OAuth token = owner action) or route the iOS Shortcut to a folder rclone can read | M |
| `scripts/classify-electrical.mjs:74-75`, `run-electrical-classify.ps1` | iCloud Photos dir, `llama-server.exe` | stays on PC (local GPU) or retire | - |
| `scripts/google-photos-picker-import.mjs:64-65`, `authorize-*.mjs:113-123` | `cmd /c start` to open OAuth URL | owner runs authorize flows on a machine with a browser, copies tokens | - |
| Hostnames `CARTERSPC\carte` (`ops/gbp-worker-task.xml`), `CMB-Workbench` in alert text (`seo-watchdog.mjs:146,192,323`, `seo-monitor.mjs:357`) | cosmetic | update strings | S |

Not found: Credential Manager/cmdkey/DPAPI/keytar, COM/Office (xlsx is the pure-JS npm package; `openpyxl`
in `actions.py:1823` legacy), chrome.exe/edge paths (Playwright bundles Chromium).
State files with absolute paths: `state/photo-cache.json` keys are `C:\...` absolute (4,667 entries);
`state/photo-selection-manifest.json` `photoPath` absolute but entries carry `photoHash`/`sourceHash`;
`state/curated-labels.json` is sha256-keyed (portable). See section 7.

---

## 4. Browser / Playwright dependencies

| Driver | Launch | Profile / desktop need | API alternative | Disposition for AIWA |
|---|---|---|---|---|
| GBP post driver `scripts/gbp-poster/driver.mjs:154,354,542` (via gbp-worker) | headed `launchPersistentContext(~/.claude/gbp-session)`; `GBP_SESSION_MODE=persistent` default (`:131`) keeps the P2.8 storageState branch (`:134-153`) off; `storage-state.json` **absent** on disk | persistent Google login (602 MB profile, 3,948 files); needs an unlocked interactive desktop (`ecosystem.config.cjs:20-27`, `docs/runbooks/gbp-worker.md:4-7`); **session is logged out today** | **Yes**: `scripts/gbp-api-poster.mjs` (v4 localPosts + media) | **Go to API** (section 5). Keep the PC driver disabled-but-intact as rollback (needs Carter's interactive `--auth`). |
| GBP listing verify `scripts/verify-gbp-posts.mjs:215`, dup pre-check `lib/gbp-listing.mjs:178-215` | headed, same profile | same | v4 `GET localPosts` list / `GET {postName}` state | API (build: list-based dup check in the API poster) |
| GBP profile adapter `scripts/gbp-profile-adapter.mjs:229,291` (description/hours; via `actions.py:1700`) | headed, same profile | same | `mybusinessbusinessinformation.v1 locations.patch` (`gbp-hours-sync.mjs` exists) | API later; owner-gated and rare - can stay manual |
| `scripts/gbp-post-once.mjs:36` | one-shot, hardcoded | same | n/a | retire |
| Facebook poster `scripts/facebook-poster.mjs:1695,1707` | only if `FB_USE_PLAYWRIGHT=1` (`:84`) | `~/.claude/fb-session` | Graph API is primary (`:1803-1814`) | API already; no browser on AIWA |
| FB boost | documented UI rollback only (`FB-BOOST-RUNBOOK.md:282-288`, CDP :9223) | fb-session | `scripts/fb-boost-api.mjs` Marketing API primary (`:261`) | API already |
| fb-comment-agent, thumbtack-worker, mav-bridge (own code), v2 pipeline | no browser (grep: 0 Playwright hits in those entry points) | - | - | headless-free |
| WordPress adapter | `.env.example:102-103` references `scripts/wordpress-action-adapter.mjs` + `config/wordpress-sites/` - **neither exists** | - | - | dead config; drop |

Conclusion: with GBP on the API, **no service in the Friday path needs a browser**; Playwright can be
left uninstalled on the LXC (`package.json` still lists it; `npm ci --omit=optional` is not enough -
make it a lazy import or accept the 300 MB download without `npx playwright install`).

---

## 5. GBP API switch

### 5.1 What exists (names only)
- GCP project "Hermes Agent" `exalted-slice-502415-s0` / `1084301840332`; installed-app OAuth client file
  `C:\Users\carte\gmail-multi\client_secret_hermes_gbp.json` (exists); scope `business.manage`
  (`scripts/lib/gbp-api-auth.mjs:10-18`, `scripts/authorize-gbp.mjs`, `PLANSCOPE.MD:7`).
- Token file default `C:\Users\carte\gmail-multi\tokens\grizzly-gbp.json` - **missing** (only
  `grizzly-search-console.json` is present; brain note 08-21 says it was lost in the 690->870 move).
  Owner must run `node scripts/authorize-gbp.mjs` once (PKCE loopback, browser).
- Env names: `GBP_CLIENT_SECRET`, `GBP_TOKEN_FILE`, `GBP_POSTER` (`playwright|api`), `GBP_WORKBOOK_PATH`,
  `GBP_ARCHIVE_FOLDER`; none of them are in `.env.example`.
- Code: `scripts/gbp-api-poster.mjs` (357 lines, commit `b7b6007`, plus the WIP policy-gate/realpath
  change), `scripts/lib/gbp-api-auth.mjs` (refresh-token flow, `gbpFetch`), `scripts/gbp-access-probe.mjs`
  (7-endpoint verdict), dormant `gbp-analytics-collector.mjs`, `gbp-review-agent.mjs`, `gbp-media-sync.mjs`,
  `gbp-hours-sync.mjs`; `gbp-qanda-agent.mjs` never written. Brain: `projects/gbp-api-access.md`
  (case `2-5921000040991`, Surefire allowlist theory), `projects/gbp-runner-drop-native-scheduling.patch`
  (unapplied: makes the runner stop passing `--schedule`).
- History caution: commit `32de91d` ("GBP API access granted - PLANSCOPE now ACTIVE") was a false
  positive corrected in `PLANSCOPE.MD:11-25` on 08-09. Today's grant must be **proven by the probe**
  (`node scripts/gbp-access-probe.mjs` -> v4 `/accounts` not 404) and one real read before any flip.

### 5.2 Action map: browser driver today -> Business Profile API
| Action (driver evidence) | API capability | Status in `gbp-api-poster.mjs` | Gap / build |
|---|---|---|---|
| Create "Update" post with summary (`driver.mjs:468-478,538-552`) | `POST v4/{location}/localPosts` `topicType=STANDARD` | implemented (`:177-189`) | STANDARD only; OFFER/EVENT/ALERT types available but unused |
| Attach one photo, HEIC converted by picker (`driver.mjs:439-466`) | `media:startUpload` + bytes upload, `media[].dataRef` | implemented (`:139-175`) | content-type by extension (HEIC mislabelled); no size/format policy (G4), no hash/manifest audit (5.3) |
| "Learn more" CTA + URL (`driver.mjs:518-536`) | `callToAction {LEARN_MORE,url}` | implemented | parity |
| **Native scheduling Days 2-7 at 9:00 AM** (`driver.mjs:480-516`, runner `lib/gbp-runner.mjs:364-379`) | **none** - the API has no scheduled posts | header says unsupported; `--schedule` silently ignored | **Blocker-grade**: today the runner would post Days 2-7 immediately and map exit 0 -> `scheduled_native`, then the daily tick posts them again (`gbp-runner.mjs:166,421-442`; no workbook Posted flag written for 2-7). Build: in API mode mark Days 2-7 `scheduled` (no driver call) and let the 09:00 CT daily tick publish each day (the brain patch). |
| Post-submit verification (driver emits `verified:false`; Grok listing verdicts `gbp-worker.mjs:495-559`) | `GET v4/{postName}` state LIVE/PROCESSING; `searchUrl` | implemented (`:193-200`), exit 3 if not LIVE | parity or better; `platform_post_id` = resource name (stable). Grok public-listing verifier becomes optional. |
| Duplicate pre-check against the All-posts list (`lib/gbp-listing.mjs`) | `GET v4/{location}/localPosts` (list) | **not implemented** | Build: list and compare summary prefix for the date before create (idempotency after a crash between create and the Supabase write - AUDIT-FINDINGS H10) |
| Already-posted guard | workbook `Posted` | implemented (`:243-247`) | depends on `markGbpPostedAndArchive` writing the workbook - API path returns before that on exit 3 |
| Delete/edit a post | `DELETE`/`PATCH v4/.../localPosts/{id}` | not built | optional (would have fixed the 09-25 duplicate incident without manual deletes) |
| Profile gallery upload (`gbp-media-sync.mjs`) | v4 `media` (the script targets a v1 `media` path - unverified endpoint) | dormant | verify endpoint before use |
| Hours (`gbp-profile-adapter.mjs:151-201`) | `businessinformation.v1 locations.patch specialHours/regularHours` (`gbp-hours-sync.mjs`) | dormant, endpoint real | later |
| Description (`gbp-profile-adapter.mjs:117-149`) | `locations.patch profile.description` | not built | later |
| Reviews reply (`gbp-review-agent.mjs`) | v4 `accounts/*/locations/*/reviews/*/reply` (script uses a `mybusinessreviews` v1 host - unverified) | dormant | verify host |
| Q&A | `mybusinessqanda.v1` (probe checks it) | never written | later |
| Performance metrics (`gbp-analytics-collector.mjs`) | `businessprofileperformance.v1 getDailyMetricsTimeSeries` (probe) vs the collector's `mybusinessperformance` host | dormant, host mismatch | fix host when enabling (feeds v2 selection T9) |
| Categories/attributes/services | `businessinformation.v1` | not built | not needed |
- Quota: new projects get low default write QPM on v4; run the probe + one dry-run and record
  `quota_limit` before the first Friday.

### 5.3 Enforcing the 2026-09-25 photo rule in the API path
Rule (memory `gbp-check-photos-before-posting`): resolve every date's image, hash-compare, view each one,
one post per call. Today it is enforced only inside the picker (`gbp-photo-pick.mjs:546-558,666-674`;
`lib/photo-selection.mjs:471,489-494`, 8-week cross-platform sha256 ledger in
`state/photo-selection-manifest.json`) and by the FB poster's manifest audit (`facebook-poster.mjs:104-117,575-615`).
**Not enforced** at GBP post time: the driver (`driver.mjs:714-731` via `lib/gbp-paths.mjs:148-225`
`pickCuratedFallbackPhoto` = pseudo-random curated image, no hash) and the API poster
(`gbp-api-poster.mjs:76-87,249-275`: workbook path or first `<date>-` file, text-only when missing).
`verifyPhotoCandidates` (caption-vs-image vision check, `photo-selection.mjs:538-576`) is tested but called
by nothing. Proposal (build item G3, size M):
1. API poster resolves the image **only** through the manifest (`isManifestSelectionCompatible`) - no
   `<date>-` prefix scan, no curated fallback; missing/unaudited image => exit 5 `policy_violation`
   with `image_missing`, never text-only.
2. Compute sha256 of the final bytes; refuse if it collides with any manifest entry inside 8 weeks
   (`hashConflicts`) or with another date in the same run; include `image_sha256` and `image_path` in
   the `--dry-run` JSON so the operator gate ("view each one") has something to view.
3. Run `checkImagePolicy` (JPG/PNG >= 10 KB, G4) and HEIC->JPEG via `heic-convert` before upload.
4. Optionally call `verifyPhotoCandidates` (one gpt-4o yes/no, 3-candidate cap) - behind `GBP_PHOTO_VISION_CHECK=1`.
5. Append a manifest entry with `postedBy:'gbp-api'` and the localPost name on success, under the
   existing manifest lock, so FB and the next week see the hash.
6. The shadow/dry-run Friday on AIWA prints the 7 resolved `{date, image_path, sha256}` rows; the
   operator (or a Hermes/Slack card) eyeballs them before `GBP_POSTER=api` is allowed to post.

---

## 6. Secrets and configuration

### 6.1 Env var names by service (from `process.env.*` / `os.environ` sweep; `.env.example` marks which are documented)
- Core (all): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (one service-role key shared by seo-monitor,
  mav-bridge, prometheus-sync, mav-console - AUDIT-FINDINGS M7), `SUPABASE_ANON_KEY`, `TZ`.
- Alerts: `HERMES_CLI`, `HERMES_ALERT_TO`, `SMTP_APP_PASSWORD`, `SMTP_FROM`, `SMTP_TO`
  (`SMTP_FROM_EMAIL`/`SMTP_TO_EMAIL` for Python), `SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL` (optional override).
- Wrapper/legacy crew: `SEO_PIPELINE`, `SEO_AUTO_APPROVE`, `SEO_CREW_TIMEOUT_MIN`, `SEO_SHADOW_TIMEOUT_MIN`,
  `SEO_REHEARSAL_DIR`, `SEO_LEGACY_SERPAPI`, `SEO_RUN_DOW`, `SEO_NO_SHOW_DEADLINE`, `SEO_WATCHDOG_STALE_DAYS`,
  `SEO_WATCHDOG_HUNG_MINUTES`, `SEO_RECONCILE_STALE_HOURS`, `CREWAI_RESEARCH_*`, `CREWAI_EXEC_*`,
  `CREWAI_*_FALLBACK_MODEL`, `CREWAI_TEMPERATURE`, `CREWAI_VERBOSE`, `CREWAI_STRUCTURED_COMPLETIONS`,
  `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SERPAPI_API_KEY`, `MAV_WEBSITE_AUTO_EXEC`,
  `WEBSITE_REPO_DIR`, `WEBSITE_BRANCH`, `WEBSITE_SITE_URL`, `WEBSITE_GIT_TIMEOUT_S`, `SEO_AGENTS_EXE`.
- v2: `WEEKLY_MODEL`, `WEEKLY_BUDGET_USD`, `DEEPSEEK_API_KEY`, `SERPAPI_API_KEY`, `SEARCH_CONSOLE_TOKEN_FILE`,
  `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`, `GBP_PHOTOS_LOCAL_CACHE`, `GBP_CURATED_FOLDER`, `GBP_PHOTO_LABELS`,
  `GBP_PHOTO_SELECTION_MANIFEST`, `GBP_PHOTO_COMPAT_ALLOWLIST`, `PHOTO_LABEL_MIN_SCORE`.
- Facebook/mav-bridge: `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN` (`FB_ACCESS_TOKEN` alias), `FB_GRAPH_API_VERSION`,
  `FB_MEDIA_MODE`, `FB_SLIDESHOW_*`, `FB_FIRST_COMMENT`, `GRIZZLY_BRAND_*`, `GRIZZLY_TEXT_LINE`,
  `GRIZZLY_LOGO_PATH`, `GRIZZLY_ENDCARD_PATH`, `GRIZZLY_ENDCARD_FONT`, `FFMPEG_DIR`/`FFMPEG_PATH`/`FFPROBE_PATH`,
  `FB_BOOST_API`, `FB_AD_ACCOUNT_ID`, `FB_ADS_ACCESS_TOKEN`, `FB_BOOST_*`, `MAV_BRIDGE_PORT`, `MAV_BRIDGE_POLL_MS`,
  `MAV_BRIDGE_GBP`, `MAV_BRIDGE_FB_BOOST`, `MAV_BRIDGE_FB_BOOST_AFTER`, `MCC_PORT`, `XAI_API_KEY`/`GROK_API_KEY`,
  `GEMINI_API_KEY`, `VENICE_API_KEY` (AI-video legacy), `FACEBOOK_POSTER_TIMEOUT_S`.
- GBP: `GBP_POSTER`, `GBP_CLIENT_SECRET`, `GBP_TOKEN_FILE`, `GBP_WORKBOOK_PATH`, `GBP_ARCHIVE_FOLDER`,
  `GBP_WORKER_POLL_MS`, `GBP_WORKER_STUCK_MS`, `GBP_SESSION_*` (Playwright only), `GBP_PHOTO_PATH`,
  `GBP_PHOTOS_FOLDER`, `GBP_PHOTO_SCORE_BUDGET`, `GBP_MIN_PHOTO_SCORE`, `GBP_CURATED_SEED_SCORE`,
  `GBP_POSTER_SCRIPT`/`GBP_POSTER_CONFIG`/`GBP_BROWSER_SESSION_DIR`/`GBP_POSTER_HEADLESS` (legacy Python path).
- fb-comment-agent: `FB_COMMENT_AGENT_PORT`, `FB_COMMENT_POLL_MS`, `FB_COMMENT_MAX_*`, `XAI_API_KEY`.
- Thumbtack (`THUMBTACK_*`, `TWILIO_*`, `OPS_SMS_*`, `MAV_FABRIC_*`): not SEO; omit from the SEO LXC env.

### 6.2 Where they come from today
- Repo `.env` (8.8 KB; git-ignored; 8 stale `.env.bak-*` siblings - M8) loaded by: `mav-bridge.mjs:43-47`
  (manual parse), `gbp-worker.mjs`, `scripts/weekly/lib/env.mjs:10`, `python-dotenv` (`main.py:891`,
  `crew.py:321`); MCC pm2 `env_file` for mav-bridge; `gbp-photo-pick.mjs:77-83` force-overrides
  `OPENAI_API_KEY` from `.env` over the User env var.
- Hermes runtime `.env` at `%LOCALAPPDATA%\hermes\.env` for Slack (`slack-alert.mjs:14-16`).
- Google OAuth JSON files under `C:\Users\carte\gmail-multi\` (client secret, tokens).
- Thumbtack encrypted token store under `state/thumbtack/`.
- Google Secret Manager project `carter-personal-secrets` is the declared canonical store since 09-27
  (memory), but **no code in this repo reads it**; `.env` is the runtime truth and must be treated as a
  rendered artifact.

### 6.3 What AIWA needs
- A rendered `/opt/seo/.env` (mode 600, owner `seo`) produced from Secret Manager by a deploy step:
  either (a) run `gcloud secrets versions access` on the PC (classifier-gated) and ship the file through the
  Orca release path, or (b) a dedicated GCP service account with `roles/secretmanager.secretAccessor` on
  only the SEO secrets, key stored on the LXC, and a `render-env.sh` that writes `.env` at deploy time.
  (b) is cleaner for rotation; (a) needs no new IAM. Secret names in GSM must match the env names above -
  verify with `gcloud secrets list --project carter-personal-secrets` (names only).
- Copy the Google OAuth files: `client_secret_hermes_gbp.json`, `grizzly-search-console.json`, and a
  freshly minted `grizzly-gbp.json` (owner action on a browser machine) to `/opt/seo/secrets/` and set
  `GBP_CLIENT_SECRET`, `GBP_TOKEN_FILE`, `SEARCH_CONSOLE_TOKEN_FILE`. Note `gbp-api-auth.mjs:66`
  rewrites the token file on refresh - the dir must be writable by the service user.
- `TZ=America/Chicago` in every unit/pm2 env (runbook `agent-memory/runbooks/aiwa-deployment.md`),
  verified by `node -e "console.log(new Date().toString())"` inside the service env.
- Pin explicitly on AIWA (do not rely on code defaults): `GBP_POSTER` (both bridge and worker read it;
  defaults disagree), `MAV_BRIDGE_GBP=off`, `SEO_PIPELINE`, `SEO_AUTO_APPROVE`, `FB_BOOST_API`, `HERMES_CLI`.
- `.env.example` is incomplete (L2): add the GBP API, photo-path, ffmpeg and Slack-override names.

---

## 7. Media and state

| Item | Location (PC) | Size | Move / mount | Notes |
|---|---|---|---|---|
| Photo library | `C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos` | 15.1 GB, 6,281 files (Curated 4,363 / 10.6 GB; Unused Review 1,585 / 3.6 GB; Archive 170 / 0.5 GB) | one-time rsync to an LXC bind mount (`/srv/seo/photos`), then rclone from Drive for new intake | picker scans the cache, not Drive (`gbp-photo-pick.mjs:90-95`) |
| Drive inbox | `H:\My Drive\GBP Photos` (Drive for Desktop) | n/a (unmounted now) | replace with rclone (owner OAuth) | iOS Shortcut uploads here (`docs/ingestion/ios-photo-shortcut.md`) |
| Backfill | `C:\Workspace\Shared\Assets\Media\Grizzly\Backfill` | 913 MB, 458 files | optional | classify only |
| GBP workbook | `C:\Workspace\Shared\Operations\Grizzly\GBP\Grizzly GBP Schedule.xlsx` (+ backups) | 1.7 MB, 32 files | move; set `GBP_WORKBOOK_PATH`/config | Excel file-lock retries become moot |
| `state/` | repo | 32 MB, 294 files | **move**; rekey | `photo-cache.json` 2.1 MB keyed by absolute `C:\` paths (4,667) -> rewrite keys to the new root or accept a one-time gpt-4o re-score (40 photos/run budget); `photo-selection-manifest.json` 139 KB has hashes (no-reuse survives; `photoPath` cosmetic); `curated-labels.json` 3.4 MB sha256-keyed (portable); `state/weekly/serp-cache` 12 MB (5-day TTL, can drop); `alerted.json`, `fb-first-comments.json`, `fb-pending-first-comments.json`, `topic-history.json`, `gbp-grok*` small, move |
| `outputs/` | repo (git-ignored) | 237 MB, 914 files | move only: `fb-boost-ledger.json` (**money gate**), `fb-boost-api-last.json`, `*_posting_schedule.md`, `weekly-runner-health.json`, `run_manifest.json`, `shadow/`, `archive/` (8.7 MB) | drop `gbp-debug/` 118 MB, `fb-videos/` 89 MB, `monitor-*.jsonl` |
| Supabase | cloud | - | nothing to move; shared state for both hosts (the main reason a shadow on AIWA is safe) | RLS unverified (H11/M1) |
| `assets/` | repo | 40 MB (audio bed 37 MB) | in git | |
| GBP browser profile | `C:\Users\carte\.claude\gbp-session` | 602 MB | **do not move** (API replaces it) | PC rollback only |
| `.venv`, `node_modules` | repo | 781 MB / 100 MB | rebuild (`uv sync --locked`, `npm ci`) | Node 20+ required (`scripts/weekly/DESIGN.md:12`); tests ran on 24.19 |
| `logs/` | repo | 1 MB | no | |

---

## 8. Target sizing and placement
- Load profile: CrewAI legacy crew ~40 min CPU-light Python + remote LLMs; v2 run ~3-13 min
  (collect dominated by SerpApi/Search Console); gpt-4o photo scoring remote; **ffmpeg slideshow Reels**
  are the only CPU-heavy step (1080p Ken Burns, minutes, single-threaded-ish; `outputs/fb-videos` shows ~1.5 MB each);
  no Chromium once GBP is API. Peak RSS estimate: Node services 150-300 MB each (mav-bridge, gbp-worker,
  fb-comment-agent), monitor 100 MB, Python crew 1-2 GB, ffmpeg 0.5-1 GB.
- Recommendation: **dedicated new LXC** (`seo-prod`, Debian 12, unprivileged): 4 vCPU, 6 GB RAM (8 if the
  legacy crew stays for a rollback window), 60 GB disk (15 GB photos + growth, 1 GB venv, 0.3 GB node,
  outputs), Node 24 (or 22 LTS), Python 3.12 + uv, ffmpeg + fonts-dejavu, rclone, pm2 for long-running
  apps (same pattern as CT 103) + systemd timers for the Friday/daily jobs. Bind-mount `/srv/seo/photos`
  from host storage so it is backed up with the host.
- Why not CT 103: it hosts mav-console whose `:3000` has unauthenticated write/pm2-exec routes
  (AUDIT-FINDINGS C1) - putting the service-role key, the photo library, the boost ledger and the GBP
  token on the same box widens that blast radius; 8 GB would be shared with mav-console; lifecycle
  (MCC releases vs SEO Fridays) differs. Keep MCC -> mav-bridge over the AIWA LAN
  (`SEO_APP_URL=http://seo-prod:8790`, bind mav-bridge to the LXC address, not loopback) - that is a one-line MCC env change.

---

## 9. Risk register (ranked; detection by output checks, not logs)

| # | Risk | Silent? | Detect by |
|---|---|---|---|
| 1 | **GBP double-post on API flip** (runner posts Days 2-7 immediately, then daily tick re-posts; no workbook Posted for 2-7) | yes | before flip: `--dry-run` for every date shows no create; after Day 1: `GET v4 localPosts` list count for the week == rows `posted` in `weekly_posts`; a count > 1 for a date = duplicate |
| 2 | **Wrong `week_of` filing** on a UTC host (`supabase-sync.mjs getWeekOf` clock-derived; `seo-monitor localHHMM`; `week-spec.mjs` uses Chicago) | yes | `select week_of from seo_runs order by created_at desc limit 1` must be the Monday after the run Friday; `compare.md` "0 of 11 slots off-spec" line; TZ probe in the unit env |
| 3 | **Duplicate / mismatched photos** (driver fallback and API poster bypass the hash ledger) | yes | dry-run table of `{date, sha256}` with 7 distinct hashes; manifest gains 7 new `gbp` entries with distinct `photoHash`; the Friday audit opens each image |
| 4 | **Empty media path -> text-only GBP post** (`gbp-api-poster.mjs:273-275`) or no FB media | yes | result JSON `image_exists:true` for all 7; `weekly_posts.media_status` not `none/downgraded` (MCC `postHealth` RED rule) |
| 5 | **Alert transport dead on Linux** (`hermes.exe` path; Slack token from `%LOCALAPPDATA%`) - the 07-24 silent-miss class | yes | `shadow.notify.sent:true` with a channel in `weekly-runner-health.json` **and** a message visible in Slack; watchdog exit code 0 |
| 6 | **No-show**: timers not enabled / `SUPABASE_URL` missing makes monitor exit 0 silently (`seo-monitor.mjs:63-65`) | yes | `weekly-runner-health.json` `started` written Friday 08:30 CT; watchdog NO-SHOW at 10:00; run a Thursday rehearsal (`run-weekly-seo.py --rehearsal`) |
| 7 | **Two hosts publishing at once** during shadow (PC gbp-worker/mav-bridge still live + AIWA copy) | partly | AIWA shadow must run with `SEO_PIPELINE=shadow`, `MAV_BRIDGE_GBP=off`, **mav-bridge and gbp-worker NOT started on AIWA** until PC services are disabled; verify `weekly_posts` writers by `run_logs` host tag |
| 8 | **GBP API not actually approved** (history of false positives) or quota 0 | no (loud 429) | probe verdict + one real `GET accounts`; record `quota_limit` |
| 9 | **Validator rejects the new phone** because `grizzly-business-facts.md` on main still carries 863-9804 | yes (plan degraded/regen) | `validate` stage 0 errors in `summary.md`; cherry-pick the WIP facts first |
| 10 | **Reconcile never runs** -> performance memory stale -> selection on stale data | yes | `outputs/reconcile-health.json` `last_success_at` < 48 h |
| 11 | **Photo intake stops** (no Drive on Linux) | yes | `verify-photo-ingestion.mjs` counts; inbox mtime within 7 days |
| 12 | **SerpApi quota exhaustion -> degraded Friday** (58/80 unavailable on 10-09) | no (degraded flag) | `attempt.status` must be `succeeded`, not `degraded` (clean-Friday gate) |
| 13 | **Boost ledger loss/duplication** if `outputs/fb-boost-ledger.json` is not moved exactly once | yes (spend) | `fb-boost-ledger.mjs status` week totals identical on both hosts before PC disable; only one host runs the 09:30 tick |
| 14 | **`.env` drift between hosts** (`GBP_POSTER` defaults disagree) | yes | print the effective mode at startup (`gbp-worker.mjs:656` already logs `GBP_POSTER=`); AIWA env review in the release checklist |
| 15 | MCC proxy pointing at the wrong bridge after the move | no | MCC approval page reads `/seo/status` from the AIWA bridge |

---

## 10. Recommendations: one combined cutover with an AIWA shadow first

Principle: AIWA runs read-mostly first (shadow pipeline + dry-run posters), PC keeps publishing; then
one Friday flip where AIWA publishes (v2 `new` + GBP API) and the PC is disabled-but-intact.

### Phase A - repo convergence (PC, this week)
1. Merge `feat/seo-v2` into `main`, resolving the 7 conflict files (keep PR #7/#8 semantics; take v2's
   watchdog/photo work). Re-run `node --test` (expect >= 800) + `npm run lint`. **M**
2. Cherry-pick from `wip/pc-local-2026-10-13`: facts/prompt/website-structure phone change, FB poster
   retired-number guard + selfcheck, `gbp-api-poster` policy gate + realpath, v2 fixtures. Leave Thumbtack
   wording and `log_monitor_web.py` for Carter. **S**
3. Prune `origin/barnscarter-ops/cockle` and the three merged feature branches; fix the two doc lines that
   name `barnscarter-ops/grizzly-website` once that repo's home is confirmed. **S**

### Phase B - portability code (build items)
4. **B1 Paths-to-env** (S): `DEFAULT_CONFIG`/workbook/archive/photo/token defaults relative to
   `PROJECT_ROOT` or env (`gbp-api-poster.mjs:37`, `gbp-paths.mjs:8-13`, `gbp-api-auth.mjs:10-18`,
   `search-console.mjs:12-13`, `reconcile.mjs:63-64`, `evidence.py:232`, `mav-bridge.mjs:55-61`,
   `gbp-worker.mjs:53-57`); add every name to `.env.example`.
5. **B2 Alerts on Linux** (M): `HERMES_CLI` pointing at the AIWA Hermes install, or a direct Slack
   transport in `lib/hermes-alert.mjs` + `slack-alert.mjs` reading `SLACK_BOT_TOKEN` from env; keep the
   receipt contract (T1) so NOTIFY MISS stays meaningful.
6. **B3 Monitor without pm2/`net use`** (M): gate `pm2*`/`net use` behind `process.platform==='win32'` or
   `SEO_MONITOR_PM2`; replace `M:` check with a plain `fs.existsSync(GBP_ARCHIVE_FOLDER)`.
7. **B4 Deploy artifacts** (M): Linux `ecosystem.config.cjs` (mav-bridge moved into this repo,
   gbp-worker, fb-comment-agent; `env: {TZ:'America/Chicago'}`), five systemd timer/service units
   (photo-sync, weekly-run, monitor, watchdog, reconcile) with `Environment=TZ=America/Chicago` and
   `EnvironmentFile=/opt/seo/.env`, `render-env.sh` (Secret Manager -> `.env`), `rclone` sync unit for photo
   intake, `docs/cutover/RUNBOOK-AIWA.md`.
8. **B5 State rekey** (S): script that rewrites `photo-cache.json` keys and manifest `photoPath` from the
   Windows root to the LXC root (hash fields untouched); run once at migration.

### Phase C - v2 live switch (build items)
9. **V1 `--mode new`** (M): `run.mjs` mode that runs the existing stages then `projectPlan({allowLive:true,
   autoApprove: SEO_AUTO_APPROVE})`; wrapper skips CrewAI crews and `supabase-sync` when
   `SEO_PIPELINE=new`; `WEEKLY_BUDGET_USD=5`; watchdog/monitor parity already exists on the v2 branch.
   Offline test: a `new`-mode e2e that asserts 7 GBP + 4 FB rows with `week_of` from WeekSpec.
10. **V2 notify receipt check** (S): confirm T1's `notify:<event>` receipt lands in the attempt record on
    the merged code (10-09 health shows `missing`).
11. **V3 Reconcile timer** (S): the AIWA timer makes `reconcile-health.json` exist for the first time;
    RECONCILE STALE then has meaning.

### Phase D - GBP API (build items)
12. **G0 Access proof** (owner, S): `node scripts/authorize-gbp.mjs` (mints `grizzly-gbp.json`),
    `node scripts/gbp-access-probe.mjs` -> v4 answers; one real `GET accounts/locations`; record quota.
13. **G1 Scheduling semantics** (M): in `lib/gbp-runner.mjs` API mode, Days 2-7 -> `scheduled` without a
    driver call (apply/port the brain patch); `applyDriverResult` writes workbook Posted for every API
    post; `gbp-worker` daily tick already publishes `scheduled` rows at >= 09:00 CT. Test: runner test
    asserting no `--schedule` spawn in API mode and status `scheduled`.
14. **G2 Idempotent create** (M): list `localPosts` for the location and skip create when a post with the
    same day's summary prefix exists in the last 7 days; return `already_live` (exit 0) with its name.
15. **G3 Photo-rule guard in the API poster** (M): section 5.3 items 1-5; `--dry-run` emits
    `{date,image_path,image_sha256}`.
16. **G4 Worker defaults** (S): one `GBP_POSTER` default (`playwright`) in both `mav-bridge.mjs:63` and
    `gbp-worker.mjs:60`; skip the session probe/export in API mode (already `SESSION_PROBE_SUPPORTED`).
17. Later, not for cutover: analytics collector host fix (feeds T9), reviews/Q&A agents, profile edits via API.

### Phase E - AIWA shadow Friday (configure)
18. Create the LXC (section 8), deploy the merged ref via Orca, rsync photos/state/outputs subset, render
    `.env` with `SEO_PIPELINE=shadow`, `GBP_POSTER=api`, `MAV_BRIDGE_GBP=off`, `SEO_AUTO_APPROVE=0`,
    `FB_BOOST_API=0`, `TZ=America/Chicago`; enable only the **weekly-run (shadow-only variant: wrapper with
    the legacy crew disabled is not available until V1, so run `node scripts/weekly/run.mjs --mode shadow --notify`
    from the timer directly), watchdog, reconcile, photo-sync** timers. Do **not** start mav-bridge,
    gbp-worker or fb-comment-agent on AIWA yet (the PC still publishes).
19. Same Friday, on AIWA: `node scripts/gbp-api-poster.mjs --dry-run --date <each of 7 dates>` against a
    copy of the workbook; collect the 7 `{date, image_sha256}` rows for the eyeball gate. Audit per
    `PLAN.md` 5.2: attempt `succeeded`, 7/4 counts, dates on spec, alert received in Slack, reconcile
    health fresh, TZ probe CDT.
20. Carter records the content verdict (decision 12). Clean-Friday rule says two consecutive; given five
    shadow Fridays already ran on the PC, one AIWA shadow plus one AIWA-published Friday audited is a
    reasonable owner decision.

### Phase F - flip Friday (configure; owner-approved live steps)
21. Thursday: PC - disable the five scheduled tasks and `pm2 stop` gbp-worker/mav-bridge/fb-comment-agent
    (owner runs it; leave the apps saved for `pm2 resurrect` rollback); copy the current
    `outputs/fb-boost-ledger.json`, `state/*.json` deltas to AIWA; confirm no PC process holds the pidfile.
22. AIWA: `.env` -> `SEO_PIPELINE=new`, `SEO_AUTO_APPROVE=1` (owner policy 09-05), `GBP_POSTER=api`,
    `FB_BOOST_API=1`; start mav-bridge, gbp-worker, fb-comment-agent under pm2; MCC `SEO_APP_URL` ->
    AIWA bridge. Thursday rehearsal: `run-weekly-seo.py --rehearsal` + `gbp-api-poster --dry-run`.
23. Friday audit (output checks from section 9): one GBP live post with `platform_post_id` = resource
    name and `GET` state LIVE; Days 2-7 `scheduled`; 4 FB posts scheduled with media; Slack alert; ledger
    unchanged until 09:30 tick; Saturday 09:00 Day-2 post appears once.
24. Rollback (any gate fails): AIWA `pm2 stop` all + disable timers; PC `pm2 resurrect` + re-enable tasks;
    Carter re-auths the GBP profile (`driver.mjs --auth`) since the PC session is already logged out.

### Build-item sizes (summary)
A1 v2 merge M | A2 WIP cherry-pick S | A3 branch/doc hygiene S | B1 paths-to-env S | B2 alerts M |
B3 monitor M | B4 deploy artifacts M | B5 state rekey S | V1 `--mode new` M | V2 receipt S | V3 reconcile S |
G0 access proof S (owner) | G1 scheduling M | G2 idempotent create M | G3 photo guard M | G4 defaults S.
No L items; the largest risk is G1+G2 correctness, not size.

### Open owner decisions (block specific items)
- Secret delivery to AIWA: service-account render (preferred) vs PC-rendered `.env` via Orca (6.3).
- Photo intake on Linux: rclone with an owner OAuth token, or keep the PC syncing into a share the LXC mounts.
- Thumbtack worker: stays on the PC (Tailscale Funnel hostname is PC-bound) or moves separately.
- Legacy crew on AIWA: install for rollback (`SEO_PIPELINE=legacy` still works) or cut it at flip (T21 says retire gates one session later).
- Clean-Friday count before publishing from AIWA (one shadow + audited flip vs two shadows).
