# CURRENT-STATE-INVENTORY

**Run:** mktg-consolidation-20260830
**Date:** 2026-08-30
**Sources:** `artifacts/audit-20260830/research/flow.md`, `artifacts/audit-20260830/research/secops.md`
**Scope:** production SEO/MCC operator surface as of the 2026-08-30 audit. Facts only. No secret values.

---

## 1. Services and processes

| Name | Owner repo / path | Startup path | Schedule | Port | Purpose |
|---|---|---|---|---|---|
| Grizzly SEO Photo Sync | SEO-Agents-App `scripts/sync-photos-from-drive.mjs` | Windows Task Scheduler via `scripts/setup-scheduled-tasks.ps1` | Friday 08:25 weekly | — | Mirror Google Drive GBP photos → local cache before research |
| Grizzly SEO Weekly Run | SEO-Agents-App `scripts/run-weekly-seo.py` | Windows Task Scheduler via `setup-scheduled-tasks.ps1` | Friday 08:30 weekly | — | Launch CrewAI research → schedules → supabase-sync |
| Grizzly SEO Monitor | SEO-Agents-App `scripts/seo-monitor.mjs` | Windows Task Scheduler via `setup-scheduled-tasks.ps1` | Friday 08:30 weekly, 14h window then exit | — | Watch Supabase, PM2, M: drive; auto-fix; alert |
| Grizzly SEO Watchdog | SEO-Agents-App `scripts/seo-watchdog.mjs` | Windows Task Scheduler via `setup-scheduled-tasks.ps1` | Daily 10:00, single-shot | — | Independent no-show / stale / failure detector |
| Grizzly SEO GBP Worker | SEO-Agents-App `scripts/gbp-worker.mjs` | Task Scheduler → `ops/gbp-worker-launch.vbs` (hidden `wscript`) | Daily 08:00 + logon; long-running poll | — | Daily GBP poster (Supabase CAS → Playwright) |
| `mav-console` | MCC `server.mjs` | PM2 `MCC/ecosystem.config.cjs` | Persistent | **3000**, binds `0.0.0.0` | MCC dashboard / approval UI |
| `mav-bridge` | SEO-Agents-App `scripts/mav-bridge.mjs` (listed in MCC ecosystem) | PM2, cwd SEO-Agents-App, `env_file` → SEO `.env` | Persistent, poll 30s | **8790** (`MAV_BRIDGE_PORT`) | Executor: FB / website / reconcile / alerts |
| `prometheus-sync` | MCC `scripts/prometheus-sync.mjs` | PM2, `env_file` → SEO `.env` | Persistent | — (egress to Supabase) | Metrics ingestion |
| `mcc-dashboard-agent` | `C:\Workspace\Shared\Agents\HomeLab-Agent\agent.py` | PM2 | Persistent | **7331** (comment) | HomeLab agent |
| `fb-comment-agent` | SEO-Agents-App `scripts/facebook-comment-agent.mjs` | PM2 `SEO-Agents-App/ecosystem.config.cjs` | Persistent | **8795** | Facebook first-comment agent |
| `downloads-watcher` | Neither repo — `C:\Users\carte\DownloadsOrganizer\downloads_watcher.py` | PM2, pythonw venv | Persistent | — | Homelab downloads organizer |

**Retired (comments only; do not re-add):** `maverickforge` (script missing, port 3012 conflict), `qwen3-llama` (canonical in `C:\Workspace\Infrastructure\llama-cpp-server\ecosystem.config.cjs`, :8080/:8081).

**Upstream defaults referenced by MCC/SEO:** Prometheus `192.168.1.12:9090`, RAG `:8181`, OpenAI-compatible gateway `:4000` (`OPENAI_BASE_URL`).

**Who the processes run as:** PM2 apps run as the interactive Windows user via the PM2 daemon. Friday photo/run/monitor/watchdog tasks: S4U principal, RunLevel Highest, “Run whether user is logged on or not”. GBP worker: user session `carte` (Playwright + `H:\` + saved Google session).

---

## 2. Persistence layers (owners)

| Layer | Owner | What it owns | Boot / persistence |
|---|---|---|---|
| Windows Task Scheduler | SEO `setup-scheduled-tasks.ps1` + `ops/gbp-worker-task.xml` | Friday kickoff, monitor, watchdog, photo sync, GBP daily worker | S4U + StartWhenAvailable + WakeToRun. Photo/run/monitor: restart count 2 / 5 min. Watchdog: 10-minute limit, no restarts. |
| PM2 | MCC `ecosystem.config.cjs` + SEO `ecosystem.config.cjs` | Always-on: mav-bridge, mav-console, prometheus-sync, mcc-dashboard-agent, fb-comment-agent, downloads-watcher | Survives reboot only if `MCC/scripts/setup-pm2-boot.ps1` registered a boot task for `pm2 resurrect`. |
| Supabase | `supabase/schema.sql` | Approval / execution status for `seo_runs`, `weekly_posts`, `website_tasks`, `run_logs` | Cloud. Handoff from crew markdown → `supabase-sync.mjs`. |
| Local filesystem | SEO `outputs/`, `state/` | Schedules, health markers, alert dedupe, photo cache | Host disk. Not the approval gate. |

---

## 3. Scheduled-task settings

| Setting | Photo Sync / Weekly Run / Monitor | Watchdog | GBP Worker |
|---|---|---|---|
| Logon | S4U, “Run whether user is logged on or not” | Same | User session `carte` (logon + daily 08:00) |
| StartWhenAvailable | Yes | Yes | Daily trigger restarts if dead; IgnoreNew while running |
| WakeToRun | Yes | Yes | (task XML) |
| Restart on failure | 2 retries / 5 min | None | Yes (runbook) |
| Execution time limit | `MonitorHours + 2` (16h) | 10 minutes | Long-running daemon |
| Launcher | `node` / venv `python.exe` | `node` | `ops/gbp-worker-launch.vbs` hidden (prevents 2026-07-10 console-close exit `0xC000013A`) |

---

## 4. Friday sequence — state writes and side effects

| When | Owner | State writes | Side effects |
|---|---|---|---|
| Fri 08:25 | Task Scheduler → `sync-photos-from-drive.mjs` | Copies `H:\My Drive\GBP Photos` → `C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos` | Local filesystem only (additive, idempotent) |
| Fri 08:30 | Task Scheduler → `run-weekly-seo.py` | `outputs/weekly-runner-health.json` `{status:"started"}`; `outputs/weekly-runner-YYYY-MM-DD.log` append | None yet |
| Fri 08:30 (parallel) | Task Scheduler → `seo-monitor.mjs` | `outputs/monitor-YYYY-MM-DD.jsonl` per poll | Hermes SMS + Gmail SMTP “SEO Monitor Started”. Auto-fix: `pm2 restart`, one-shot `pm2 resurrect`, `net use M: \\192.168.1.12\Proxmox`. Poll 30s × 14h. |
| Fri ~08:30 | `run-weekly-seo.py` → pytrends | `state/topic-history.json` append (dedupe last 4 weeks) | Google Trends API (US-TX, 7-day, batches of 5). Fallback: ISO week rotation |
| Fri ~08:36 | CrewAI via `.venv` `seo-agents` | `outputs/weekly-crew-YYYY-MM-DD.log`; `outputs/run_health.json`; research/plan/queue/baselines; `outputs/archive/YYYY-MM-DD_HHMMSS/` | LLM calls (`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` via CrewAI); scrape grizzlyelectrical.com |
| Crew Phase 1 | Research crew | `outputs/seo_research_report.md`, `outputs/manager_plan.md`; `run_health` research=success | LLM |
| Crew Phase 1.5 | `finalize_run` | `outputs/run-manifest.json`, `outputs/evidence-package.json` | None external |
| Crew Phase 2 | Executor crew | `outputs/final_report.md`; website edits / task completions; `run_health` execute=success | Website adapter (if live) |
| Crew Phase 3 | GBP poster crew | `outputs/gbp_posting_schedule.md`; `run_health` post_schedule=success | None (schedule only) |
| Crew Phase 4 | Facebook schedule crew | `outputs/facebook_posting_schedule.md`; `run_health` facebook_schedule=success | None (schedule only) |
| Crew Phase 5 | `node scripts/supabase-sync.mjs` | Supabase UPSERT `seo_runs` (`week_of`, `pending_approval`); INSERT `weekly_posts` + `website_tasks` (`pending_approval`) | Hermes SMS approval ping (deduped by run_id+counts). If `SEO_AUTO_APPROVE=1`: auto-approves run+posts, different SMS. Website tasks still need manual approval. |
| Fri ~08:55 | `run-weekly-seo.py` | `weekly-runner-health.json` → `success` or `failed` | Exit code to Task Scheduler |
| User / auto | MCC `:3000` or `POST /seo/actions/approve` on `:8790` or `SEO_AUTO_APPROVE` | `seo_runs.status` → `approved`; cascade `weekly_posts` → `approved` | mav-bridge next 30s poll |
| After approval | `mav-bridge` `executeApprovedRun()` | `seo_runs` → `executing` then `done`/`error`; FB rows `posting`→`posted`/`error`; `run_logs` INSERT; website_tasks `approved`→`executing`→`done`/`error` | Photo curation (`gbp-photo-pick.mjs`, 8 min); Facebook Graph v22.0; Veo 3 video (up to 45 min); first comments; website `seo-agents.exe` if `MAV_WEBSITE_AUTO_EXEC=1` (default ON). GBP in-bridge only if `MAV_BRIDGE_GBP=on` (default OFF). |
| Fri ~22:30 | `seo-monitor.mjs` self-exit | Final summary log line | “SEO Monitor Done” alert with run status + post counts |

---

## 5. Daily loops — state writes and side effects

| When | Owner | State writes | Side effects |
|---|---|---|---|
| Daily 09:00+ (days 2–7) | `gbp-worker.mjs` | GBP `weekly_posts` `posting` → `posted` / `error` / `needs_verification` | `gbp-photo-pick.mjs`; Playwright Chromium → GBP; re-read verify; M: archive `\backups\gbp-archive`; alert on unverified |
| Daily (mav-bridge tick) | `mav-bridge.mjs` | FB scheduled → `posted`/`error`; first-comment drain | Graph reconcile; Marketing API boost if `FB_BOOST_API=1` (ledger-gated) |
| Daily 10:00 | `seo-watchdog.mjs` | `outputs/watchdog.jsonl` | Checks: (1) run-day no-show past 09:00, (2) run-day failure, (3) staleness >8 days (`SEO_WATCHDOG_STALE_DAYS`). Hermes + SMTP. Exit 1 if all alert channels fail. |
| Stuck posting >30 min | mav-bridge TTL sweep | `posting` row → `error` | Retry via MCC `/seo/actions/retry` |
| Fault alerts | mav-bridge + monitor | `state/alerted.json`, `state/fault-acks.json` | Dual-channel, `alertOnce` dedup |

---

## 6. State-write map (stores)

| Store | Writers | Readers | Notes |
|---|---|---|---|
| Supabase `seo_runs` / `weekly_posts` / `website_tasks` / `run_logs` | `supabase-sync.mjs`, `mav-bridge.mjs`, `gbp-worker.mjs`, `website-task-runner.mjs` | mav-bridge, gbp-worker, seo-monitor, MCC (proxy + anon fallback) | Authoritative for status/approval/execution |
| `outputs/*.md` schedules + queue + reports | CrewAI; then mutated by `fb-photo-rewrite.mjs`, `gbp-photo-pick.mjs`, `fb-repost-week.mjs` | Parsers + facebook-poster (file, not DB, at post time) | Authoritative for published content |
| `outputs/weekly-runner-health.json` | `run-weekly-seo.py` | seo-monitor, seo-watchdog | No-show marker |
| `outputs/run_health.json` | Python crew | seo-monitor; **not** MCC (`/seo/status` returns `runHealth: null`) | Phase flags |
| `outputs/monitor-YYYY-MM-DD.jsonl` | seo-monitor | Operator | 14h window |
| `outputs/watchdog.jsonl` | seo-watchdog | Operator | Daily |
| `state/topic-history.json` | run-weekly-seo.py | same | Last-4-week dedupe |
| `state/alerted.json`, `state/fault-acks.json`, `state/approval-notified.json` | mav-bridge, supabase-sync | same | Local op-state; not in Supabase |
| MCC `seoTaskLog` (local JSON, cap 100) | MCC `logSeoEvent` on approve/run/retry/dismiss | MCC UI only | Not in Supabase |
| `outputs/fb-boost-ledger.json` | `fb-boost-ledger.mjs` | `fb-boost-api.mjs` (daily from mav-bridge) | Boost money path; not in Supabase |
| GBP workbook + `GBP_ARCHIVE_FOLDER` | gbp-runner / driver | gbp-worker | Playwright path |
| Photo cache | photo-sync, gbp-photo-pick | posters | `H:\` / curated folder |

---

## 7. Failure detection and recovery

| Failure | Detection | Recovery | Source |
|---|---|---|---|
| Task Scheduler never fires Friday run | Watchdog daily 10:00: no `weekly-runner-health.json` entry for today | Re-run `setup-scheduled-tasks.ps1`; Start-ScheduledTask | `HANDOFF-2026-07-31-missed-run.md` #5; 2026-07-24 silent miss |
| PM2 missing after reboot | Monitor `checkPM2Processes` → `pm2 resurrect` once | `pm2 resurrect` or `setup-pm2-boot.ps1` | `seo-monitor.mjs`; `FRIDAY-RUNBOOK.md` |
| M: drive unmounted | Monitor `checkMDrive` | `net use M: \\192.168.1.12\Proxmox`; alert if fail | `seo-monitor.mjs` |
| Python / venv broken | Wrapper `resolve_seo_agents_cmd()` 4 paths then `-m` | `pip install -e .` in venv | `run-weekly-seo.py` |
| LLM 402 / timeout | Crew non-zero → health=`failed` | Monitor alert; retry via MCC | wrapper + monitor |
| Supabase sync fails | `supabase-sync.mjs` exit 1 → wrapper exit | `node scripts/supabase-sync.mjs --week-of YYYY-MM-DD` | supabase-sync |
| Facebook token stale | mav-bridge `checkFacebookToken` before pipeline | Re-auth; bridge alerts | mav-bridge |
| Run stuck `executing` >30 min | Monitor `checkRunStatus` | `pm2 restart mav-bridge` | seo-monitor |
| Post stuck `posting` >30 min | mav-bridge TTL → `error` | MCC `/seo/actions/retry` | mav-bridge |
| GBP `needs_verification` | Monitor alert | Manual GBP verify; mark posted in MCC | seo-monitor |
| Run stranded `executing` (crash) | `executeApprovedRunSafe` → `error` | Retry via MCC | mav-bridge |
| All alert channels down | Watchdog exit 1 → Task Scheduler LastTaskResult=1 | Read `outputs/watchdog.jsonl` | seo-watchdog |
| `.env` incomplete on new host | Monitor exits immediately if `SUPABASE_URL` missing — **silent** | Complete `.env` (`.env.example` incomplete) | HANDOFF #6 |
| `getWeekOf()` TZ / clock keying | Wrong `week_of` → orphan row; upsert on `week_of` misses | Pass `--week-of YYYY-MM-DD`; do not use UTC `.toISOString()` for local dates | HANDOFF “SEPARATE BUG”; supabase-sync |
| GBP worker console closed | 2026-07-10 exit `0xC000013A` | VBS hidden launcher | `ops/gbp-worker-launch.vbs` |
| Schedule starves (no new run) | Daily GBP poster idle; `run_logs` indistinguishable from healthy idle | Watchdog only | HANDOFF |
| GBP auth / session expired | Driver `session_expired` / captcha (human-blocking) | `node scripts/authorize-gbp.mjs` | gbp-worker runbook |

**Monitor coverage gaps (secops):** `downloads-watcher`, `mcc-dashboard-agent`, `fb-comment-agent` are not in seo-monitor’s target list. `mav-console` HTTP health is watched only during the Friday 14h window.

---

## 8. Listeners and trust boundary

| Listener | Bind | Auth on mutating routes | Notes |
|---|---|---|---|
| MCC `server.mjs` | `0.0.0.0:3000` | **None** on `/api/build/apply`, `/api/list-dirs`, `/api/workflows/seo/actions/*`, `/api/orchestrator/*`, `/api/chat`, `/api/build-chat`, `/api/extract-file`, `/api/realtime-token` | CORS: `ALLOWED_ORIGINS` plus suffix match `*.vercel.app` / `*.ts.net` |
| mav-bridge | `:8790` | Local loopback intended (`SEO_APP_URL=http://127.0.0.1:8790`) | Approval / execute / retry |
| fb-comment-agent | `:8795` | (not in seo-monitor target list) | |
| mcc-dashboard-agent | `:7331` | Homelab | |
| `/api/photos/upload` | MCC :3000 | Bearer `GBP_UPLOAD_TOKEN`; fail-closed if unset | Positive pattern |

`/api/build/apply` accepts arbitrary absolute paths that survive `resolveSafePath` (blocklist only) and runs `pm2 start/restart`. **Out of scope for this slice** (MCC is not edited).

---

## 9. Env keys by consumer (names only)

**SEO `.env`:** `OPENAI_API_KEY`, `SERPAPI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `HERMES_ALERT_TO`, `HERMES_CLI`, `SMTP_APP_PASSWORD`, `SMTP_FROM`, `SMTP_TO`, `SMTP_FROM_EMAIL`, `SMTP_TO_EMAIL`, `SEO_RUN_DOW`, `SEO_NO_SHOW_DEADLINE`, `SEO_WATCHDOG_STALE_DAYS`, `SEO_AUTO_APPROVE`, `MAV_WEBSITE_AUTO_EXEC`, `CREWAI_{RESEARCH,EXEC}_{MODEL,API_KEY,API_BASE,MAX_TOKENS}`, `CREWAI_{RESEARCH,EXEC}_FALLBACK_MODEL`, `CREWAI_TEMPERATURE`, `CREWAI_VERBOSE`, `CREWAI_STRUCTURED_COMPLETIONS`, `GROK_VIDEO_RESOLUTION`, `GRIZZLY_REFERENCE_IMAGES`, `WORDPRESS_{SITE_CONFIG,ACTION_ADAPTER,BROWSER_SESSION_DIR,ADAPTER_TIMEOUT_S}`, `GBP_{POSTER_SCRIPT,POSTER_CONFIG,BROWSER_SESSION_DIR,POSTER_TIMEOUT_S,POSTER_HEADLESS,ARCHIVE_FOLDER}`, `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`, `FB_ADS_ACCESS_TOKEN`, `FB_AD_ACCOUNT_ID`, `FB_BOOST_API`, `FB_BOOST_CAMPAIGN_ID`, `FB_BOOST_WEEKLY_CAP`, `FB_BOOST_GEO_*`, `FB_BOOST_AGE_*`, `FB_GRAPH_API_VERSION`, `FB_USE_PLAYWRIGHT`, `FB_MEDIA_MODE`, `FB_SLIDESHOW_*`, `FB_VIDEO_BACKEND`, `GEMINI_API_KEY`, `GEMINI_VEO_MODEL`, `VENICE_API_KEY`, `MAV_BRIDGE_PORT`, `MAV_BRIDGE_GBP`, `MAV_BRIDGE_FB_BOOST`, `MAV_BRIDGE_POLL_MS`, `MCC_PORT`, `XAI_API_KEY` / `GROK_API_KEY`, `SEO_AGENTS_EXE`, `GBP_POSTER`.

**MCC `.env`:** `MCC_ENV_FILE`, `PORT`, `NODE_ENV`, `SEO_APP_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_REALTIME_KEY`, `OPENROUTER_{API_KEY,BASE_URL,MODEL,EXECUTOR_MODEL}`, `NVIDIA_NIM_API_KEY`, `NIM_{MODEL,QC_MODEL}`, `ANTHROPIC_{API_KEY,BASE_URL,MODEL}`, `ZAI_{API_KEY,BASE_URL,MODEL,VISION_MODEL}`, `GEMINI_{API_KEY,MODEL}`, `VENICE_{API_KEY,BASE_URL,MODEL,VISION_MODEL,QC_MODEL,LOCAL_FALLBACK_MODEL}`, `LOCAL_MODEL_URL`, `LOCAL_MODEL`, `LLAMA_DIRECT_URL`, `PROMETHEUS_URL`, `MAV_RAG_URL`, `MAV_LOCAL_SERVER_URL`, `MAV_EXTRA_ROOTS`, `MAV_CONSOLE_{DATA_DIR,WORKSPACE}`, `MAV_MEMORY_PATH`, `MAV_SKILLS_PATH`, `BRAIN_VAULT_PATH`, `HCP_PROJECT_DIR`, `PI_{EXECUTABLE,MODEL}`, `BRAVE_SEARCH_API_KEY`, `THUMBTACK_*` (webhook, OAuth, staging, encryption, token store, auto-reply, HCP writes), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `GBP_PHOTOS_{LOCAL_CACHE,FOLDER}`, `GBP_UPLOAD_TOKEN`, `GBP_UPLOAD_MAX_BYTES`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `OPS_SMS_FROM`, `OPS_SMS_TO`.

**Cross-repo:** `SUPABASE_SERVICE_KEY` from SEO `.env` is consumed by seo-monitor, mav-bridge, prometheus-sync **and** by mav-console (MCC’s own `.env` copy). One service-role key spans two repos and 4+ processes.

**Client bundle (MCC Vite):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE` only. Anon key is intended-public; no endpoint returns raw `process.env` provider keys. `POST /api/realtime-token` is unauthenticated and returns an ephemeral OpenAI Realtime `client_secret`.

**Stale gitignored copies (names only):** SEO — `.env.bak-2026-08-29-failover`, `.env.bak-golive-20260817`, `.env.bak-mediapaths-20260829`, `.env.bak-preads-20260817`, `.env.bak-scaffold-20260817`, `.env.pre-venice-revert-2026-07-27`. MCC — `.env.bak-20260807T161757Z`, `.env.bak-20260825T144831Z`.

**PM2 `env:` block (mav-console)** copies key *names* `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_NIM_API_KEY`, `SUPABASE_SERVICE_KEY`, `THUMBTACK_WEBHOOK_SECRET` into PM2 state (`~/.pm2/dump.pm2` after `pm2 save`). Sibling apps use `env_file` instead.

---

## 10. Design facts that load-bear recovery

| Fact | Detail |
|---|---|
| Watchdog independence | Daily 10:00 trigger on purpose: monitor shares Friday 08:30 with the run it watches. 2026-07-24 both died silently. Watchdog reads only the local health marker. |
| Platform split | GBP = `gbp-worker` (user session, Playwright). Facebook + website + orchestration = `mav-bridge` (PM2). `MAV_BRIDGE_GBP` defaults `off` to prevent double-post. |
| Photo sync pre-run | 08:25 because Google Drive Desktop must be running for `H:\`. |
| Auto-approve | `SEO_AUTO_APPROVE=1` bypasses MCC for **posts**; website tasks still need manual approval. |
| Dual-channel alerts | Hermes SMS/Slack primary + Gmail SMTP best-effort; explicit “ALL alert channels failed” line. |
| Positive auth pattern | Bearer-gated photo upload; Thumbtack config fail-closed. |
| Windows-only coupling | 18+ files hardcode `C:\Workspace`, `M:\`, `H:\`, `net use`, `pm2 jlist`, `hermes.exe`. Zero AIWA/Linux awareness (HANDOFF #7). |
| No cross-host monitor | If the host is down, no alert fires. No external dead-man’s switch. |
