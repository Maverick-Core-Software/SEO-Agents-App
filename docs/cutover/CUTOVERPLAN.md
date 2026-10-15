# SEO-Agents-App cutover plan: PC → AIWA, v2 live, GBP via API

Owner: Carter. Orchestrator: Claude (PC session). Lead worker: Fable 5.1. Build workers: Haiku 5.5 (≤4).
Source audit: `docs/cutover/2026-10-13-SCOPING-AUDIT.md` (file:line evidence for every claim below).
Governing runbook: `brain/agent-memory/runbooks/aiwa-deployment.md` (+ `proxmox-mcp-split.md`).
Written 2026-10-13. Status column is updated as phases complete.

## 0. Definition of done

1. SEO on the PC is **disabled but intact**: 5 scheduled tasks disabled (not deleted), pm2 apps stopped
   (not deleted, `pm2 save` taken first), `.env`, photo library, browser profile and state left in place.
   Reversal = re-enable tasks + `pm2 resurrect` + Carter re-auths GBP (`driver.mjs --auth`). Documented and
   rehearsed once (step F6).
2. SEO-Agents-App passes all tests on the deployed ref: `node --test "scripts/**/*.test.mjs"` 0 failures,
   `npm run lint` clean, pytest run with the known fixture caveat recorded.
3. One **successful full E2E Friday run on AIWA** with AIWA as the only publisher: v2 `--mode new`
   produced the week's plan, 7 GBP + 4 FB rows in `weekly_posts` with correct `week_of`, Day 1 GBP post LIVE
   via API with `platform_post_id`, Days 2-7 `scheduled` and Day 2 appears exactly once on Saturday 09:00 CT,
   FB posts published with media, Slack alert received, watchdog/reconcile health fresh, all output checks
   in section 8 green.

## 1. Decisions (owner)

Decisions below were given by Carter in the cloud project chat on 2026-10-13 18:47Z/18:50Z and relayed
to this session; confirmed-in-this-chat items are marked when Carter types them here.

| # | Decision | Carter's answer | Status |
|---|---|---|---|
| D1 | Target container | **New** dedicated LXC `seo-prod` (Debian 12, unprivileged, 4 vCPU, 8 GB RAM because the legacy crew moves too, 60 GB disk, static IP). | decided (relayed) |
| D2 | Secret delivery | **PC-built `.env`**, shipped to the LXC through the Orca release path (mode 600, `seo` user). Secret Manager project `carter-personal-secrets` holds his keys; nothing in code reads it. | decided (relayed) |
| D3 | Photo intake on Linux | **rclone** with an owner-minted Drive OAuth token syncing `GBP Photos` → `/srv/seo/photos/inbox` on the Fri 08:25 timer. | decided (relayed) |
| D4 | Thumbtack worker | **Stays on PC**; out of scope for this cutover. | decided (relayed) |
| D5 | Legacy CrewAI crew | **Moves to AIWA too** (`uv sync`; `SEO_PIPELINE=legacy` must work there as rollback). Adds the legacy monitor's pm2/`net use`/`M:` port and the Python-side paths to Phase B. | decided (relayed) |
| D6 | Proof before flip | **One full E2E test run on AIWA after the build. Clean → cut over.** No multi-Friday soak. | decided (relayed) |
| D7 | Orchestration owner | This PC session dispatches all workers; the cloud project session is the status/relay point and dispatches nothing against the repo. | agreed |
| D8 | GBP API | API project = **`exalted-slice-502415-s0`** ("Hermes Agent"): Business Profile APIs enabled there, installed-app OAuth client `client_secret_hermes_gbp.json` belongs to it. `carter-personal-secrets` is only the key store (has `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` names, no GBP-specific entries). Token minted 2026-10-13 20:16Z with the Grizzly account (accounts/102812174257783632337); location `locations/14305368671018787381` "Grizzly Electrical Solutions"; **v4 localPosts list → 200** (evidence `evidence/gbp-probe-2026-10-13-run3.txt`). The old probe's "gated" verdict was a false negative: `/v4/accounts` no longer exists; the gate must be the location's localPosts list. | **PASSED** |
| D9 | `C:\Workspace\Shared\Runbooks` in git | Yes (relayed). `C:\Workspace\Shared` is **not** a git repo today. Proposal: new private repo `Maverick-Core-Software/workspace-runbooks` rooted at `C:\Workspace\Shared\Runbooks` only (not all of Shared). Not created until Carter confirms in this chat. | pending Carter here |
| D10 | Merge `feat/seo-v2` into main before v2 goes live | Yes (relayed) = Phase A → R. | decided (relayed) |

## 2. Phase map

| Phase | What | Where | Who | Gate to pass |
|---|---|---|---|---|
| A | Repo convergence: merge v2, cherry-pick WIP subset | PC, branch `cutover/phase-a-v2-merge` | Fable | tests ≥800/0 fail, lint clean, notes written |
| B | Portability build items B1-B5 | PC, worktrees per item, branched off A | Haiku ×4, Fable review | per-item tests + B gate |
| C | v2 live switch V1-V3 | PC, branch off A+B | Fable (V1), Haiku (V2,V3) | offline `new`-mode e2e passes |
| D | GBP API G0-G4 | PC; G0 owner | Fable (G1,G2,G3), Haiku (G4) | runner/poster tests; dry-run 7-date table |
| R | Release candidate: merge A+B+C+D → `cutover/rc1`, full gates, PR to main | PC | Fable | Carter approves PR; main = rc |
| E | AIWA provision + **one full E2E test run** (publishers in dry-run, PC still live) | AIWA via Orca | Orchestrator + Carter approvals | E gate (section 8) — clean = go |
| F | Flip: PC disabled-but-intact, AIWA publishes next Friday | PC + AIWA | Carter runs PC steps; Orca for AIWA | F gate (section 8) + done criteria |
| G | Post-flip: first-Friday audit, reversal drill | both | Orchestrator | reversal rehearsed |

Dependencies: B, C, D can run in parallel after A. E needs R merged to main + D8 token. F needs E clean.

## 2a. Live risk on the PC right now (from the inventory, 2026-10-13)

The PC checkout was switched from `feat/seo-v2`+local edits to `main` @ 6f748c0 today. **Running processes
(mav-bridge since ~Sep 14, gbp-worker, seo-log-monitor) still have the v2 code in memory, but any restart,
the daily 10:00 watchdog, and the Friday 10-16 08:25/08:30 tasks now execute main's files from disk:**
older wrapper (no attempt-health/rehearsal/notify receipt), older `gbp-worker.mjs` (no session probe), older
watchdog (no pipeline checks), and `scripts/log_monitor_web.py` is absent (pm2 `seo-log-monitor` restart would fail).
Mitigation (needs Carter's approval, step A6): once `cutover/phase-a-v2-merge` passes its gates, check it out
on the PC **before Friday 10-16** — it is a strict superset (main + v2 + the phone/poster subset). Until then
do not restart any SEO pm2 app or task. Also live: GBP session logged out (no GBP posts until
`driver.mjs --auth` with Carter present), `Grizzly SEO Reconcile` task never registered, `fb-comment-agent`
dead since 08-29 (Chief expects it), thumbtack-worker down (Mav :3012 also down), mav-bridge error log 44 MB
of Supabase `fetch failed`.

## 3. Phase A: repo convergence (PC)

| Step | Action | Evidence of done |
|---|---|---|
| A1 | Merge `feat/seo-v2` (4151431) into `cutover/phase-a-v2-merge` from main 6f748c0. Resolve 7 conflicts: `fb-boost-ledger.mjs`, `lib/ffmpeg-bin.mjs`, `lib/gbp-paths.mjs` (+test), `seo-watchdog.mjs` (+test), `slideshow-reel.mjs`. Keep PR #7/#8 semantics; take v2 watchdog/photo/G4 work. | `docs/cutover/PHASE-A-NOTES.md` conflict table; merge commit body |
| A2 | Cherry-pick from `wip/pc-local-2026-10-13`: facts/prompt/website-structure phone change, FB poster retired-number guard + selfcheck, `gbp-api-poster.mjs` policy gate + realpath, 7 weekly test fixtures. Exclude Thumbtack, `log_monitor_web.py`, artifacts. | commits on branch; validator accepts (469) 716-9870 |
| A3 | `git fetch --prune`; list merged remote branches for Carter (no deletes). | list in PHASE-A-NOTES |
| A4 | Gates: `node --test` ≥800/0, `npm run lint`, tree clean. | numbers verbatim in notes |
| A5 | Push branch. main untouched. | `origin/cutover/phase-a-v2-merge` |
| A6 | **Carter approves**: `git checkout cutover/phase-a-v2-merge` on the PC so Friday 10-16 runs the superset, not bare main. Record which running processes still hold old code (no restarts without approval). | branch name in `git branch --show-current`; `pm2`/task state unchanged |

## 4. Phase B: portability (PC, parallel Haiku workers, each in its own git worktree + branch off A)

| Item | Size | Scope (audit §3) | Test / proof |
|---|---|---|---|
| B1 paths-to-env | S | Defaults relative to `PROJECT_ROOT` or env: `gbp-api-poster.mjs:37` DEFAULT_CONFIG, `lib/gbp-paths.mjs:8-13`, `lib/gbp-api-auth.mjs:10-18`, `lib/search-console.mjs:12-13`, `weekly/reconcile.mjs:63-64`, `src/seo_agents/evidence.py:232`, `mav-bridge.mjs:55-61`, `gbp-worker.mjs:53-57`, `facebook-poster.mjs:102,165-167` font fallback, `config/gbp-poster.config.json`. Add every name to `.env.example` (GBP_*, photo paths, ffmpeg, Slack override, SEARCH_CONSOLE_TOKEN_FILE, SEO_AGENTS_EXE, HERMES_CLI). | Unit test: with env unset on linux platform, defaults resolve under PROJECT_ROOT, no `C:` strings; grep `C:\\` in scripts/lib + scripts/weekly = 0 outside win32-gated blocks |
| B2 Linux alert transport | M | `lib/hermes-alert.mjs:19-27`: `HERMES_CLI` env (absolute path, no `.exe` assumption), `windowsHide` only on win32; `lib/slack-alert.mjs:14-16,33-36`: `SLACK_BOT_TOKEN`/`SLACK_ALERT_CHANNEL` from env first, `%LOCALAPPDATA%` fallback only on win32. Keep T1 receipt contract. | Test: on linux with env tokens set, no LOCALAPPDATA read, receipt object identical |
| B3 monitor without pm2 / net use | M | `seo-monitor.mjs:152-178,338-371` pm2 self-heal behind `SEO_MONITOR_PM2` (default on only on win32); `:186-198` `net use M:` → `fs.existsSync(GBP_ARCHIVE_FOLDER)`; `gbp-runner.mjs:253` archive path from env. Hostname strings `CMB-Workbench` → `os.hostname()`. | Test: linux + `SEO_MONITOR_PM2=0` → no child_process spawn of pm2/net |
| B4 deploy artifacts | M | New `deploy/aiwa/`: `ecosystem.linux.config.cjs` (mav-bridge moved into this repo, gbp-worker, fb-comment-agent; `env: {TZ:'America/Chicago'}`, `/opt/seo` paths, `env_file`); 5 systemd units+timers (`seo-photo-sync` Fri 08:25, `seo-weekly-run` Fri 08:30, `seo-monitor` Fri 08:30, `seo-watchdog` daily 10:00, `seo-reconcile` daily 10:10) each `Environment=TZ=America/Chicago` + `EnvironmentFile=/opt/seo/.env`; `render-env.sh` (D2); `rclone` sync unit (D3); `install.sh` (apt: nodejs 22/24, python3.12+uv, ffmpeg, fonts-dejavu, rclone, pm2; user `seo`; dirs `/opt/seo`, `/srv/seo/photos`, `/srv/seo/gbp-archive`, `/opt/seo/secrets` 700); `docs/cutover/RUNBOOK-AIWA.md`. | `systemd-analyze verify` on each unit (run in a Debian container or via Orca sandbox later); shellcheck on scripts; timers' OnCalendar reviewed against the PC schedule table |
| B6 entry-guard + binds | S | `facebook-comment-agent.mjs` and `thumbtack-worker.mjs` entry guards are plain path compares (silently skip `main()` under the C:/D: junction; irrelevant on Linux but keep PC rollback honest): port the realpath guard pattern from `gbp-worker.mjs`/`run.mjs` (a fix also exists as `6a33c18` on stale `origin/barnscarter-ops/cockle`). Bind `fb-comment-agent` health (:8795) and `log_monitor_web.py` (:8899) to `127.0.0.1` by default (`*_BIND` env). Remove the stale `gbp-worker` entry from the PC `ecosystem.config.cjs` or mark it `autorestart:false` with a comment (it would double-launch next to the Task Scheduler instance). | Test: guard resolves true when argv[1] is a junction alias of the module; server default host is loopback |
| B7 legacy crew on Linux (D5) | M | `src/seo_agents/evidence.py:232` hardcoded `OUTPUT_DIR` → package-root derived; `actions.py:41-60`, `crew.py:1038,1188`, `main.py:849,1123` stale `C:\Users\carte\.claude\skills\gbp-poster\driver.mjs` / `.codex\plugins` defaults → env (`GBP_POSTER_SCRIPT`, `GBP_POSTER_CONFIG`, `GBP_PHOTO_PATH`) with repo-relative fallbacks; `run-weekly-seo.py:94-95,111` venv `bin/python` path first on posix; `main.py:96` `hermes.exe` → `HERMES_CLI`; `website.py:26` `WEBSITE_REPO_DIR` must point at a Linux clone of the website repo (+ git identity/credential on the LXC — owner item); `run-electrical-classify.ps1` stays on PC. `uv sync --locked` must succeed on Debian 12 / Python 3.12 (pin check of wheels, e.g. pytrends, crewai). | `uv run --with pytest pytest` on Linux (record the known `run_manifest.json` fixture failure); `python -m seo_agents.main --help` from a Linux venv; grep `C:\\` in `src/` = 0 outside win32 branches |
| B8 mav-bridge bind host | S | `scripts/mav-bridge.mjs:1473` listens on `127.0.0.1` with no override; MCC on CT 103 must reach the bridge on `seo-prod`. Add `MAV_BRIDGE_BIND` (default `127.0.0.1`; AIWA `.env` sets the LXC address), log the bind at startup, and note in RUNBOOK-AIWA that the LXC firewall must allow only CT 103 → :8790. Keep `/seo/actions/*` POST routes unchanged (auth is a separate backlog item, audit C1). | Test: server factory binds to the env host; default stays loopback |
| B5 state rekey | S | `scripts/ops/rekey-state.mjs --from 'C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos' --to /srv/seo/photos`: rewrites `state/photo-cache.json` keys and manifest `photoPath`; hash fields untouched; dry-run default; idempotent. | Test on fixture copies: key count unchanged, hashes unchanged, no C:\ left |

B gate: all item tests pass; full `node --test` still 0 fail on the integrated branch; Fable reviews each diff.

## 5. Phase C: v2 live switch (PC)

| Item | Size | Scope (audit §2.1) | Test / proof |
|---|---|---|---|
| V1 `--mode new` | M | Four coordinated sites (inventory §B3): (1) `scripts/weekly/run.mjs`: add `new` to `MODES` (:63); `selectStore()` (:445) must use the Supabase store for `new` (today only `shadow` does, else silent file-store fallback); pass a `project` callback into `stagePlan()` (~:775) calling `projectPlan({allowLive:true, autoApprove: SEO_AUTO_APPROVE==='1'})`; notify gate (:856) accepts `new`. (2) `scripts/weekly/lib/stage.mjs`: `EXPORT_MODES` (:25) includes `new` and exports the Markdown schedules to `outputs/` (not `outputs/shadow/`) because `gbp-photo-pick`, `sync-gbp-schedule`, `facebook-poster`, `fb-boost-ledger`, `fb-photo-pick` read `outputs/*_posting_schedule.md`; `stagePlan` already branches on `effectiveMode==='new'` (:327). (3) `run-weekly-seo.py`: `new` in `PIPELINE_MODES`; `new` **replaces** the crew launch (skip research/execute/schedule crews + `supabase-sync`), `--notify` kept, 30-min cap, attempt-derived health. (4) `config/weekly-policy.json` `budget_usd` 20→5. Publishers untouched. | Offline e2e: `new`-mode against a fake store asserts 7 GBP + 4 FB rows, `week_of` = WeekSpec Monday, `status` per autoApprove, both schedule .md files present under the out dir; wrapper unit test: crews not invoked when `SEO_PIPELINE=new`; store-selection test: `new` never falls back to file store silently |
| V2 notify receipt | S | Confirm T1 receipt lands in attempt record on merged code (10-09 showed `missing`); fix if not. | Test asserting `attempt.notify.sent===true` + channel after a stubbed send |
| V3 reconcile timer | S | Covered by B4 unit; verify `reconcile.mjs` writes `outputs/reconcile-health.json` on success and failure. | Test: health file written both paths |
| V4 rerun guard (from Phase C findings) | S | `--mode new` must refuse (exit 2, alert) when `seo_runs(week_of)` already exists with status `approved`/`executing`/`done` or when non-pending `weekly_posts` rows exist for that `week_of`, unless `--force-replan` is passed; `--force-replan` only deletes `pending_approval` rows (never approved/posted). Prevents the one-command duplicate-approve rerun. | Test with fake store: second run → exit 2, zero new rows; with --force-replan and only pending rows → replaced |
| V5 export-after-project | S | In `new` mode write the legacy `.md` exports to a temp dir and move them into `outputs/` only after `projectPlan` succeeds; on projection failure leave nothing in `outputs/` and keep the attempt artifacts under `outputs/shadow/failed-<attempt>/`. Prevents gbp-photo-pick/sync-gbp-schedule acting on a week the publishers never received. | Test: projection throws → no `*_posting_schedule.md` in out dir |

## 6. Phase D: GBP API (PC + owner)

| Item | Size | Scope (audit §5) | Test / proof |
|---|---|---|---|
| G0 access proof | S (owner) | Carter: `node scripts/authorize-gbp.mjs` → `grizzly-gbp.json`. Then `node scripts/gbp-access-probe.mjs`: v4 `/accounts` must not 404; one real `GET accounts/*/locations`; record `quota_limit`. | probe JSON saved to `docs/cutover/evidence/gbp-probe-<date>.json` (no tokens) |
| G1 scheduling semantics | M | `lib/gbp-runner.mjs`: in API mode Day 1 → driver call; Days 2-7 → `weekly_posts.status='scheduled'` with **no** driver call (port brain patch `gbp-runner-drop-native-scheduling.patch`); `applyDriverResult` writes workbook `Posted` for every API post; daily tick (`gbp-worker.mjs` ≥09:00 CT) publishes `scheduled` rows once. | Runner test: API mode spawns no `--schedule`; statuses correct; tick test: a `scheduled` row for today posts exactly once (latch) |
| G2 idempotent create | M | `gbp-api-poster.mjs`: before create, `GET v4/{location}/localPosts`, skip if a post with the same day's summary prefix exists in last 7 days → exit 0 `already_live` with its name; `platform_post_id` = resource name. | Test with mocked list response: no create on match; create on no match |
| G3 photo-rule guard | M | `gbp-api-poster.mjs`: image resolved **only** via manifest (`isManifestSelectionCompatible`); missing/unaudited → exit 5 `image_missing`, never text-only; sha256 of final bytes, refuse `hashConflicts` within 8 weeks or same-run duplicate; `checkImagePolicy` (JPG/PNG ≥10 KB) + HEIC→JPEG via `heic-convert`; append manifest entry `postedBy:'gbp-api'` under the manifest lock; `--dry-run` emits `{date,image_path,image_sha256,image_exists}`; optional `GBP_PHOTO_VISION_CHECK=1` → `verifyPhotoCandidates`. | Tests: text-only path impossible; duplicate hash → exit 5; HEIC converted; dry-run JSON shape |
| G4 defaults | S | One `GBP_POSTER` default (`playwright`) in `mav-bridge.mjs:63` and `gbp-worker.mjs:58`; log effective mode at startup (both); skip session probe/export in API mode. | Test: default equal in both modules |

D gate: all tests; `node scripts/gbp-api-poster.mjs --dry-run --date <7 dates>` on the PC against a workbook copy prints 7 rows with 7 distinct hashes and `image_exists:true`.

### 6a. G0: Carter's steps to mint the GBP token and prove access (PC, ~5 minutes)

Facts checked 2026-10-13 (names only): `C:\Users\carte\gmail-multi\client_secret_hermes_gbp.json` exists, type
`installed`, project `exalted-slice-502415-s0`, redirect `http://localhost`; `tokens\grizzly-gbp.json` does not
exist; `tokens\grizzly-search-console.json` exists. `authorize-gbp.mjs` uses PKCE + a loopback listener on a
random port and writes the token file itself.

1. Open a terminal in `D:\Workspace\Active\SEO-Agents-App` and run:
   `node scripts/authorize-gbp.mjs`
2. A browser tab opens. Sign in as the Google account that **manages the Grizzly Electrical Business Profile**
   (the one that sees the listing at business.google.com), accept the `business.manage` consent, and if Google
   shows "unverified app", click Advanced → continue (the client is your own installed app).
3. The script prints "token saved" and exits; confirm `C:\Users\carte\gmail-multi\tokens\grizzly-gbp.json` exists
   (do not open or paste it anywhere).
4. Run the probe: `node scripts/gbp-access-probe.mjs`
   Pass = v4 `accounts` returns 200 with at least one account and `locations` lists the Grizzly location. 403/404 on
   v4 means the API-access approval was granted to a different project than `exalted-slice-502415-s0`, or hasn't
   propagated; stop and tell the orchestrator.
5. Tell the orchestrator "token minted, probe <pass|fail>". The probe JSON (no tokens inside) is saved to
   `docs/cutover/evidence/gbp-probe-2026-10-13.json` by the orchestrator.
Optional later: store the client secret and refresh token in `carter-personal-secrets` Secret Manager under
`GBP_CLIENT_SECRET_JSON` / `GBP_REFRESH_TOKEN_JSON` so the LXC `.env` build can pull them; not required for D2.

### 6b. PC `.env` additions required before the RC runs on the PC (Carter edits `.env`; names only)

Checked 2026-10-13: `.env` has `GBP_POSTER` and `SEO_PIPELINE`; it lacks `MAV_BRIDGE_GBP`, `SEO_MONITOR_NET_USE`,
`GBP_WORKBOOK_DIR`, `HERMES_CLI`, `TZ`. Because the build items change defaults, add on the PC:
`MAV_BRIDGE_GBP=off` (explicit). (`SEO_MONITOR_NET_USE` is no longer needed on the PC: after review fix F12 it
defaults ON for win32; set `0` only to disable.)
**Do NOT set `TZ=America/Chicago` on the PC**: `run-weekly-seo.py` loads `.env` into the environment of the
Python crew child, and Windows CPython with `TZ` set treats UTC as local (reviewer reproduced: parent 15:18 CDT,
child 21:18). `TZ` is AIWA-only (Linux). `GBP_WORKBOOK_DIR` is AIWA-only (the PC config still carries the
Windows dir). `HERMES_CLI` optional on the PC (win32 default unchanged). Also pin on the PC
`GBP_POSTER_SCRIPT` / `GBP_POSTER_CONFIG` to the current skill driver paths if the legacy `publish_gbp_post`
action must keep its old behaviour (review F2); otherwise the repo copies are used.
Also `WEBSITE_BRANCH=main` on both hosts: the live site (grizzlyelectricaltx.com, checked 2026-10-13) serves
`main`'s content, but `website.py:27` defaults to `master` and the PC checkout at
`D:\Workspace\Active\Grizzly Launch\grizzly-website` sits on `master` (2026-08-14, old phone number in 33 files);
SEO website tasks would commit to the dead branch. The LXC clone must be on `main`.

## 7. Phase R: release candidate

1. Merge A+B+C+D branches into `cutover/rc1`; resolve; full gates (`node --test`, lint, pytest with caveat).
2. Fable review pass of the whole diff vs main (correctness, silent-failure paths, secrets in diff = none).
3. Open PR `cutover/rc1 → main`. **Carter approves and merges.** Tag `seo-aiwa-rc1`. Rollback ref = `6f748c0`.

## 8. Phase E: AIWA provision + shadow Friday (Orca only; each live step needs Carter's approval)

| Step | Action | Approval | Evidence |
|---|---|---|---|
| E1 | **DONE 2026-10-13 21:3xZ** (Carter approved in chat; executed via Orca `aiwa-host` with `pct create`/`pct start`): LXC **107 `seo-prod`**, Debian 12.12 template, 4 vCPU, 8192 MB, 2048 swap, `local-lvm:vm-107-disk-0` 80 GB, unprivileged, nesting=1, onboot=1, eth0 vmbr0 `192.168.1.16/24` gw/DNS `.254`. Verified inside: hostname seo-prod, gw-ok, dns-ok, 79 GB free. No host bind mount (photos live in the rootfs; CT backups cover them). In-container work runs via Orca `aiwa-host` → `pct exec 107` (no new Orca pairing required). | done | `get_container_config` 107 matches; `/tmp/ct107-check.txt` on host |
| E2 | **In progress 2026-10-13** via Orca `aiwa-host` → `pct exec 107`. Done: clone at `seo-aiwa-rc1` (a614f7b) to `/opt/seo`; `install.sh` exit 0 after two fixes (uv absolute path; Node 24 instead of 22 — Node 22 fails the weekly collector suites); Node 24.21, uv 0.12.7, ffmpeg 5.1, rclone, pm2, user `seo`, TZ America/Chicago (probe prints CDT), 10 units installed, `verify-units` PASS. LXC-only findings, all now fixed or in flight: (1) `e2e-offline` "kill/timeout (T6)" hung (test awaited an already-fired child `exit`; now bounded) and the Thumbtack `mav-room-notify` test was PC-coupled (now hermetic) — both in PR #10 @ 511a51e, verified on the LXC: 40 tests / 37 pass / 2 skipped / 1 fail; (2) the 1 fail is a **real production bug**: `run.mjs:266-273 unusedPhotos()` uses `path.basename()` on Windows paths stored in `weekly_posts.photo_file`, so on Linux the prior-week photo exclusion never matches (duplicate-photo risk) — fixed in PR #10 @ 33d2ce6 (`scripts/lib/photo-name.mjs`). **E2 gate green on the LXC with the PR #10 head overlaid (2026-10-13 ~23:3xZ): `node --test` 1005 tests / 192 suites / 1003 pass / 0 fail / 2 skipped (junction-only), Node 24.21, TZ probe CDT, verify-units PASS.** **E2 DONE 2026-10-14 00:4xZ:** PRs #10/#11/#12 merged (Carter approved), main 5cd55b3 = tag `seo-aiwa-rc2`; `/opt/seo` checked out at the tag, final `install.sh` exit 0, full suite on the tag: **1029 tests / 192 suites / 1027 pass / 0 fail / 2 skipped**, Node 24.21. PC checkout pinned to `seo-aiwa-rc1` (a614f7b) as the Friday fallback until the flip; no PC process restarted. **Finding:** no Hermes CLI exists in CT 107 and none is reachable from it (Hermes runs on the AIWA host as systemd services + CT101 state), so alerts need a direct-Slack hop (branch `feat/alert-slack-direct`); `HERMES_CLI` stays unset on AIWA. Release ref will be re-cut as `seo-aiwa-rc2` after PR #10 + these fixes merge, and `/opt/seo` redeployed to it before E6. | Carter approved "proceed" | `/tmp/ct107-*.txt` on host; this table |
| E3 | **DONE 2026-10-14 ~21:05Z** (Carter: "Go: stage and copy and store the JSONs"): `.env` + 3 OAuth JSONs staged on the `mavshare` share, `pct push` into CT 107 (0600, owner seo), staging shredded and verified empty; `render-env` OK 34/34, transports: slack; GBP probe inside the CT: v4 localPosts 200 → PASS. The 3 JSONs also stored in Secret Manager (`GBP_CLIENT_SECRET_JSON`, `GBP_TOKEN_JSON`, `SEARCH_CONSOLE_TOKEN_JSON`; the token ones carry CRLF from gcloud's Windows text mode, JSON-equivalent). Original spec: D2 path; render `/opt/seo/.env` (mode 600) with `SEO_PIPELINE=shadow`, `GBP_POSTER=api`, `MAV_BRIDGE_GBP=off`, `SEO_AUTO_APPROVE=0`, `FB_BOOST_API=0`, `TZ=America/Chicago`, `HERMES_CLI`, Slack vars; copy `client_secret_hermes_gbp.json`, `grizzly-search-console.json`, `grizzly-gbp.json` to `/opt/seo/secrets/` (700). | Carter (credentials) | `.env` key names listed (no values); `node -e "console.log(new Date().toString())"` prints CDT/CST |
| E4 | **Pre-check done 2026-10-13 (PC, read-only, `scripts/ops/photo-case-audit.mjs` in PR #10):** 10,425 photo refs → 10,321 exact, 1 case-only (rekey fixes), 103 missing (66 under the dead `E:\Media\Grizzly\Curated`, 37 root-relative names absent; by source manifest 9 / cache 30 / workbook 64), 0 collisions. **DONE 2026-10-14 ~21:20Z:** robocopy ×4 (exit 1 = copied; photos 6,281 files / 15,114,046,516 B byte-exact; state 290; outputs 562; workbook 32) → share → tar over `pct exec` into CT 107, owner seo; rekey applied (4,667 cache keys → `/srv/seo/photos`, 0 Windows keys left); photo audit default gate **exit 0** (0 forward-looking misses; 107 historical, incl. the 66 dead-E:-drive refs, accepted as historical — no recovery needed); `render-env --check-paths` OK; staging wiped. Original spec: Data: rsync photo library (15.1 GB) → `/srv/seo/photos`; `state/` (minus serp-cache) and `outputs/` subset (`fb-boost-ledger.json`, `*_posting_schedule.md`, `weekly-runner-health.json`, `run_manifest.json`, `shadow/`, `archive/`) → `/opt/seo`; run `rekey-state.mjs`; workbook → `/srv/seo/gbp/`. Transport: Orca-approved path only (rsync over the LAN from a Carter-run command, or Syncthing share) — no SCP from an agent. | Carter | file counts + a sample sha256 match on both sides |
| E5 | Enable `seo-watchdog`, `seo-reconcile`, `seo-photo-sync` timers. Do **not** enable the weekly-run timer or start mav-bridge/gbp-worker/fb-comment-agent yet (PC still publishes this week). *(Timers still disabled as of 2026-10-14; enabled at F3.)* | Carter | `systemctl list-timers` |
| E5-fw | **DONE 2026-10-14 ~21:45Z** (Carter "Go"): firewall hard gate (review F13) as in-CT nftables (`deploy/aiwa/nftables-seo-prod.conf` → `/etc/nftables.conf`, `nftables.service` enabled): tcp/8790 accepted only from 127.0.0.1 and 192.168.1.15, else dropped. Verified with a temporary listener: CT 103 → 200; AIWA host, CT 102, PC → blocked. Chosen over the Proxmox datacenter firewall (disabled cluster-wide). Rollback: `nft flush ruleset; systemctl disable --now nftables`. | done | terminal capture 2026-10-14 |
| E6 | **The full E2E test run (D6)**, on a weekday before the flip Friday, for the *coming* week: on AIWA run `run-weekly-seo.py` with `SEO_PIPELINE=new`, `SEO_AUTO_APPROVE=0`, `--week-of <next Monday>`. It produces the real plan as `pending_approval` rows + schedule `.md` files. Then with publishers in dry-run: `gbp-api-poster --dry-run` for the 7 dates (table `{date,image_path,image_sha256,image_exists}`), `facebook-poster.mjs --dry-run` for the 4 FB slots incl. one slideshow build (ffmpeg on Linux), `reconcile.mjs` once, watchdog once. Carter eyeballs the 7 images (09-25 rule) and the post text. | Carter approves the run | evidence folder `docs/cutover/evidence/e2e-<date>/` |
| E7 | If every E-gate check is green → proceed straight to Phase F the same week (disable PC Thursday, AIWA publishes Friday using the rows from E6, approved by Carter or auto-approve). If anything fails → fix, re-run E6; PC keeps publishing. | — | E gate below |

E gate (output checks, not logs): `attempt.status=succeeded` (not degraded); exactly 7 GBP + 4 FB `weekly_posts` rows `pending_approval` with `week_of` = the chosen Monday and no legacy rows for that week; both schedule `.md` files under `outputs/`; 0 validator errors; 7 distinct image hashes, all `image_exists:true`, all in the manifest; FB dry-run renders media for all 4 (slideshow `.mp4` produced); Slack alert visible + `notify.sent:true` **with the receipt naming `slack` (direct hop) as the delivering channel, `HERMES_CLI` unset and `SMTP_APP_PASSWORD` empty on AIWA**; `reconcile-health.json` written; watchdog exit 0; TZ probe CDT in every unit env; `node --test` on AIWA = PC numbers; no live post created anywhere (GBP `localPosts` list unchanged, FB page unchanged). Carter records the content verdict.

## 9. Phase F: flip Friday

| Step | Action | Who |
|---|---|---|
| F1 (Thu) | PC: `pm2 save`; `pm2 stop gbp-worker mav-bridge fb-comment-agent`; disable (not delete) the 5 scheduled tasks; confirm no process holds `state/gbp-worker.pid`. Record `fb-boost-ledger.mjs status` totals. | Carter (pm2 is session-0) |
| F2 (Thu) | Copy ledger + `state/*.json` deltas since E4 to AIWA; compare ledger totals; rekey. | Orchestrator via Orca, Carter approves |
| F3 (Thu) | AIWA `.env` → `SEO_PIPELINE=new`, `SEO_AUTO_APPROVE=1`, `GBP_POSTER=api`, `FB_BOOST_API=1`; `pm2 start deploy/aiwa/ecosystem.linux.config.cjs`; `pm2 save`; enable full `seo-weekly-run` timer. MCC on CT 103: `SEO_APP_URL=http://<seo-prod>:8790`. | Carter approves each |
| F4 (Thu) | Rehearsal: `run-weekly-seo.py --rehearsal`; `gbp-api-poster --dry-run` 7 dates; eyeball gate. | — |
| F5 (Fri) | Live. Audit by F gate. | — |
| F6 (Sat) | Reversal rehearsal (done criterion 1): on a non-posting window, re-enable one PC task + `pm2 resurrect` dry (`pm2 list` only), confirm the PC path is reachable; then re-disable. Document in RUNBOOK-AIWA.md §Rollback. | Carter |

F gate: Day 1 GBP `platform_post_id` resource name, `GET` state LIVE, list count for that date = 1; Days 2-7 `scheduled`; Saturday 09:00 CT Day-2 post appears **once**; 4 FB rows `posted` with `media_status` not none/downgraded; Slack alert; ledger unchanged until 09:30 tick then exactly one boost; `week_of` correct; watchdog exit 0 at 10:00; reconcile health fresh Saturday.

Rollback (any gate fails): AIWA `pm2 stop` all + disable timers; PC re-enable tasks + `pm2 resurrect`; Carter `driver.mjs --auth` (PC GBP session is already logged out); set PC `SEO_PIPELINE=legacy`.

## 10. Phase G: post-flip

- Weeks 1-2: Friday audits by the F gate; watch risks 1, 3, 11, 12 from the audit register.
- Retire PC: after 2 clean Fridays, Carter decides to delete PC tasks/pm2 apps and the GBP browser profile.
- Later backlog (not cutover): analytics collector host fix, reviews/Q&A agents, profile edits via API, MCC `:3000` auth (audit C1), Thumbtack move (D4), legacy crew retirement (D5).

## 11. Worker protocol

- Every build item: own branch `cutover/<item>` off `cutover/phase-a-v2-merge`, own worktree under `D:\Workspace\Active\_wt\SEO-<item>`, `npm ci` there, tests for silent-failure guards only (Carter's rule), no `.env` edits, no secrets printed, no pm2, no AIWA.
- Done = tests pass + `git status` clean + branch pushed + ≤15-line report with verbatim test numbers.
- Fable reviews every diff before it enters `rc1`. Orchestrator merges.
- All AIWA actions: Orca terminals only, per `aiwa-deployment.md`; Carter approves each live step; every terminal closed and re-listed after use.
