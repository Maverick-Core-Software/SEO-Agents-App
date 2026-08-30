# Workstream: secops (status: ?)

All evidence gathered. Compiling the report.

## Findings

### 1. Process/service inventory, owner, startup path

| Process | Owner repo | Startup path | Port |
|---|---|---|---|
| `fb-comment-agent` | SEO-Agents-App (`ecosystem.config.cjs`) | PM2 → `C:\Workspace\Active\SEO-Agents-App\scripts\facebook-comment-agent.mjs`, loads own `.env` | 8795 |
| `mav-console` | MCC (`ecosystem.config.cjs`) | PM2 → `server.mjs`, cwd MCC; keys copied from MCC `.env` via `require('dotenv').config()` at PM2-start into `env:` block | 3000, binds `0.0.0.0` (server.mjs:535) |
| `prometheus-sync` | MCC ecosystem, script `MCC\scripts\prometheus-sync.mjs` | PM2, `env_file: C:\Workspace\Active\SEO-Agents-App\.env`; ALSO loads MCC `.env` if present, else falls back to hard-coded SEO `.env` (prometheus-sync.mjs:18-25) | — (egress to Supabase) |
| `mav-bridge` | MCC ecosystem, script `SEO-Agents-App\scripts\mav-bridge.mjs` | PM2, cwd SEO-Agents-App, `env_file` → SEO `.env`; loads `.env` itself (mav-bridge.mjs:38-43) | 8790 (`MAV_BRIDGE_PORT`) |
| `downloads-watcher` | Neither repo — `C:\Users\carte\DownloadsOrganizer\downloads_watcher.py` | PM2, pythonw venv | — |
| `mcc-dashboard-agent` | `C:\Workspace\Shared\Agents\HomeLab-Agent` | PM2 → `agent.py`, `env_file` → HomeLab-Agent `.env` (file exists) | 7331 (per comment) |
| Scheduled: `Grizzly SEO Photo Sync` / `Weekly Run` / `Monitor` | SEO-Agents-App `scripts\setup-scheduled-tasks.ps1` | Task Scheduler, Friday 08:25/08:30/08:30, S4U principal, RunLevel **Highest**, StartWhenAvailable + WakeToRun | — |
| Scheduled: `Grizzly SEO Watchdog` | same script | Task Scheduler **daily 10:00**, deliberately independent trigger | — |

Retired in comments, not to be re-added: `maverickforge` (script missing, port conflict 3012), `qwen3-llama` (canonical in `C:\Workspace\Infrastructure\llama-cpp-server\ecosystem.config.cjs`, :8080/:8081). Upstream dependencies referenced by default: Prometheus `192.168.1.12:9090`, RAG `:8181`, OpenAI-compatible gateway `:4000` (MCC ecosystem `OPENAI_BASE_URL`).

All processes run as the interactive Windows user via the PM2 daemon; scheduled tasks run as that user with S4U + admin.

### 2. Env keys by consumer (names only — values never read)

- **SEO `.env`** (.env.example structure + script greps): `OPENAI_API_KEY, SERPAPI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, HERMES_ALERT_TO, HERMES_CLI, SMTP_APP_PASSWORD, SMTP_FROM, SMTP_TO, SMTP_FROM_EMAIL, SMTP_TO_EMAIL, SEO_RUN_DOW, SEO_NO_SHOW_DEADLINE, SEO_WATCHDOG_STALE_DAYS, SEO_AUTO_APPROVE, MAV_WEBSITE_AUTO_EXEC, CREWAI_{RESEARCH,EXEC}_{MODEL,API_KEY,API_BASE,MAX_TOKENS}, CREWAI_{RESEARCH,EXEC}_FALLBACK_MODEL, CREWAI_TEMPERATURE, CREWAI_VERBOSE, CREWAI_STRUCTURED_COMPLETIONS, GROK_VIDEO_RESOLUTION, GRIZZLY_REFERENCE_IMAGES, WORDPRESS_{SITE_CONFIG,ACTION_ADAPTER,BROWSER_SESSION_DIR,ADAPTER_TIMEOUT_S}, GBP_{POSTER_SCRIPT,POSTER_CONFIG,BROWSER_SESSION_DIR,POSTER_TIMEOUT_S,POSTER_HEADLESS,ARCHIVE_FOLDER}, FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, FB_ADS_ACCESS_TOKEN, FB_AD_ACCOUNT_ID, FB_BOOST_API, FB_BOOST_CAMPAIGN_ID, FB_BOOST_WEEKLY_CAP, FB_BOOST_GEO_*, FB_BOOST_AGE_*, FB_GRAPH_API_VERSION, FB_USE_PLAYWRIGHT, FB_MEDIA_MODE, FB_SLIDESHOW_*, FB_VIDEO_BACKEND, GEMINI_API_KEY, GEMINI_VEO_MODEL, VENICE_API_KEY, MAV_BRIDGE_PORT, MAV_BRIDGE_GBP, MAV_BRIDGE_FB_BOOST, MAV_BRIDGE_POLL_MS, MCC_PORT, XAI_API_KEY/GROK_API_KEY, SEO_AGENTS_EXE, GBP_POSTER`.
- **MCC `.env`** (ecosystem + lib/config.mjs): `MCC_ENV_FILE, PORT, NODE_ENV, SEO_APP_URL, OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_REALTIME_KEY, OPENROUTER_{API_KEY,BASE_URL,MODEL,EXECUTOR_MODEL}, NVIDIA_NIM_API_KEY, NIM_{MODEL,QC_MODEL}, ANTHROPIC_{API_KEY,BASE_URL,MODEL}, ZAI_{API_KEY,BASE_URL,MODEL,VISION_MODEL}, GEMINI_{API_KEY,MODEL}, VENICE_{API_KEY,BASE_URL,MODEL,VISION_MODEL,QC_MODEL,LOCAL_FALLBACK_MODEL}, LOCAL_MODEL_URL, LOCAL_MODEL, LLAMA_DIRECT_URL, PROMETHEUS_URL, MAV_RAG_URL, MAV_LOCAL_SERVER_URL, MAV_EXTRA_ROOTS, MAV_CONSOLE_{DATA_DIR,WORKSPACE}, MAV_MEMORY_PATH, MAV_SKILLS_PATH, BRAIN_VAULT_PATH, HCP_PROJECT_DIR, PI_{EXECUTABLE,MODEL}, BRAVE_SEARCH_API_KEY, THUMBTACK_{WEBHOOK_SECRET,CLIENT_ID,CLIENT_SECRET,STAGING_CLIENT_ID,STAGING_CLIENT_SECRET,OAUTH_AUTH_URL,OAUTH_TOKEN_URL,API_BASE_URL,SCOPES,STAGING_OAUTH_AUTH_URL,STAGING_OAUTH_TOKEN_URL,STAGING_API_BASE_URL,STAGING_SCOPES,TOKEN_ENCRYPTION_KEY,TOKEN_STORE_PATH,PRODUCTION_TOKEN_STORE_PATH,AUTO_REPLY_ENABLED,NATIVE_AUTO_REPLY_DISABLED,HCP_WRITES_ENABLED,AGENT_TIMEOUT_MS}, SUPABASE_URL, SUPABASE_SERVICE_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, GBP_PHOTOS_{LOCAL_CACHE,FOLDER}, GBP_UPLOAD_TOKEN, GBP_UPLOAD_MAX_BYTES, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OPS_SMS_FROM, OPS_SMS_TO`.
- **Cross-repo sharing**: `SUPABASE_SERVICE_KEY` from SEO `.env` is consumed by seo-monitor, mav-bridge, prometheus-sync (via `env_file`) AND by mav-console (from MCC's own `.env` copy). One service-role key spans two repos and 4+ processes.

### 3. Secret leak paths to browser/client (MCC)

- **No endpoint returns raw `process.env` or provider keys.** Frontend bundle uses only `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE` (`src/supabase.js:3-4`, `src/lib/api.js:5`) — anon key, intended public.
- **`POST /api/realtime-token`** (server.mjs:~370): **unauthenticated**; mints an OpenAI Realtime session with server-side `OPENAI_REALTIME_KEY`/`OPENAI_API_KEY` and returns the ephemeral `client_secret` token to any caller.
- **CORS wildcard suffixes** (server.mjs:55-57): `origin.endsWith('.vercel.app') || origin.endsWith('.ts.net')` — ANY Vercel-hosted app (including an attacker's) or any Tailscale host gets browser-callable access. `ALLOWED_ORIGINS` allowlist exists but is bypassed by these two lines.
- **Unauthenticated mutating routes** on the same `0.0.0.0:3000` listener: `/api/build/apply` (writes/deletes files at **arbitrary absolute paths** via `resolveSafePath` — which permits any path outside its blocklist (lib/exec.mjs:12-28) — and runs `pm2 start/restart` via `execSync`, routes/build.mjs:9-81), `/api/list-dirs` (directory enumeration, defaults to `C:\`, routes/build.mjs:83-93), `/api/workflows/seo/actions/{approve,run,dismiss,retry,clear-fault}`, `/api/orchestrator/*`, `/api/chat`, `/api/build-chat`, `/api/extract-file`.
- Positive: `/api/photos/upload` requires `Bearer GBP_UPLOAD_TOKEN` and fails closed if unset (routes/photos.mjs:35-40); Thumbtack scopes/tokens fail closed by design (lib/config.mjs); `lib/load-env.mjs` is `quiet` and `override` only for explicit `MCC_ENV_FILE`; `lib/ops-notify.mjs` fails closed and never logs secrets.

### 4. Monitoring/alerting in place

- `seo-monitor.mjs` (Fri 08:30, 14h): PM2 health for `mav-bridge`/`mav-console`/`prometheus-sync` with auto-restart and one-shot `pm2 resurrect` cold-boot recovery; HTTP `/health` checks on 8790/3000 with 2-3 poll debounce; M: drive remount; Supabase `seo_runs`/`weekly_posts` tracking with error, stuck->30min, post-failure, and needs-verification alerts; no-show detection via `outputs/weekly-runner-health.json` marker; alert channels: hermes SMS/Slack primary + Gmail SMTP best-effort secondary, with explicit "ALL alert channels failed" log line. Logs to `outputs/monitor-YYYY-MM-DD.jsonl`.
- `seo-watchdog.mjs` daily 10:00, independent trigger (guards against the Friday trigger itself dying), stale-activity alert (`SEO_WATCHDOG_STALE_DAYS`, default 8).
- PM2: autorestart + `min_uptime`/`restart_delay`/`exp_backoff_restart_delay` crash-loop guards documented per app.
- Coverage gaps: `downloads-watcher`, `mcc-dashboard-agent`, `fb-comment-agent` are **not** in seo-monitor's target list; mav-console health is only actively watched during the Friday 14h window.

### 5. Hard-coded paths and stale .env files

- Hard-coded: `\\192.168.1.12\Proxmox` in `net use` remount (seo-monitor.mjs `mountMDrive`); `192.168.1.12` defaults in MCC config.mjs (`PROMETHEUS_URL`, `MAV_RAG_URL`) and ecosystem `OPENAI_BASE_URL:4000`; `C:\Workspace\Active\SEO-Agents-App\.env` fallback in prometheus-sync.mjs:23; absolute `C:\Users\carte\...` and `C:\Workspace\...` paths throughout both ecosystem files, config.mjs (`memoryPath`, `brainPath`, `gbpPhotosFolder`), setup-scheduled-tasks.ps1 (`$ProjectRoot`), and `.env.example`.
- Stale env copies on disk (gitignored but present): **SEO-Agents-App** — `.env` + `.env.bak-2026-08-29-failover`, `.env.bak-golive-20260817`, `.env.bak-mediapaths-20260829`, `.env.bak-preads-20260817`, `.env.bak-scaffold-20260817`, `.env.pre-venice-revert-2026-07-27` (6 stale). **MCC** — `.env` + `.env.bak-20260807T161757Z`, `.env.bak-20260825T144831Z` (2 stale). MCC `.gitignore` comment states these "hold old secrets".
- SEO `.gitignore` pattern `.env.*` also matches `.env.example` — if the example is meant to be tracked, it needs a `!.env.example` negation (unverified whether currently tracked).
- Repo noise in SEO root: mangled directory `CWorkspaceActiveSEO-Agents-Apptestsfixturesresearchartifacts/` (path-separator bug artifact), a `nul` file, `logs.txt`.

## Analysis

**Severity-ranked inferences and the hardening plan:**

1. **Critical — unauth file-write + PM2 exec surface.** `/api/build/apply` accepts any absolute path that survives `resolveSafePath` (blocklist only covers system dirs/`.git`/`.env`), backs up, then **overwrites or deletes** it, then runs `pm2 start` — with no authentication, on `0.0.0.0:3000`, with CORS granted to any `*.vercel.app`/`*.ts.net` origin. A malicious page visited by anyone on the LAN/owner's browser, or any LAN host, can modify config/source anywhere on C: (e.g. replace a script a scheduled task or PM2 runs) and restart processes. CORS is not auth — even without the wildcard, non-browser callers on the LAN are unblocked. **Fix:** require a bearer token (pattern already exists in routes/photos.mjs) on all mutating routes at minimum; tighten `resolveSafePath` for build/apply to `workspacePath`/`stagingRoot`.
2. **High — CORS wildcard.** Replace `endsWith` checks with the explicit `ALLOWED_ORIGINS` list (own vercel domain + own ts.net hostname).
3. **High — secrets duplicated into PM2 state.** MCC ecosystem copies `OPENAI_API_KEY, ANTHROPIC_API_KEY, ZAI_API_KEY, GEMINI_API_KEY, NVIDIA_NIM_API_KEY, SUPABASE_SERVICE_KEY, THUMBTACK_WEBHOOK_SECRET` into the `env:` block. After `pm2 save` these persist in `~/.pm2/dump.pm2` plaintext and are plausibly visible via `pm2 jlist`/`pm2 describe` (verify without printing values, e.g. count occurrences of the key NAME in jlist output). Prefer `env_file` (as the sibling entries already do) or in-process dotenv via `MCC_ENV_FILE`, so the only at-rest copy is the repo `.env`. Rotate any service key if the machine is ever multi-user.
4. **Medium — shared `SUPABASE_SERVICE_KEY`** across two repos and 4+ processes (including a metrics scraper that only needs `insert into metrics`). Least privilege: separate keys/roles per consumer; prometheus-sync gets a scoped key.
5. **Medium — stale `.env.bak-*` files** keep rotated secrets alive indefinitely. Adopt retention (delete after verified rotation, or move to an encrypted store); at minimum confirm all 6 SEO + 2 MCC backups contain only already-rotated credentials.
6. **Medium — monitoring coverage.** Add `downloads-watcher`, `mcc-dashboard-agent`, `fb-comment-agent` to the monitor/watchdog target list, or run a 24/7 lightweight PM2+`/health` watchdog; today mav-console is only health-watched ~14h/week.
7. **Low — hard-coded topology.** `192.168.1.12` IPs, UNC `\\192.168.1.12\Proxmox`, and absolute user paths should move to env with defaults documented in `.env.example`; the `net use /persistent:yes` remount depends on cached Windows credentials — document that cache as a secret location. `.env.example` contains a real SMS number and gmail address (PII) — consider placeholder-izing.
8. **Positive patterns to keep:** fail-closed Thumbtack config, bearer-gated photo upload, quiet dotenv loader, `alertOnce` dedup + dual-channel alerts with an explicit all-channels-failed line, the no-show/watchdog double-trigger design, and the ecosystem comments documenting retired processes (maverickforge, qwen3-llama) to prevent regressions.

Residual risks: I did not read `.env` contents, run any commands, or verify PM2 runtime behavior (jlist env exposure, `env_file` support in the installed PM2 version, actual task registrations) — those need operator verification.