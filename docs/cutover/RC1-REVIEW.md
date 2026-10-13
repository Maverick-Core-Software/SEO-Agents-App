# RC1 independent review: `origin/cutover/rc1` (ae3fdae) vs `origin/main` (6f748c0)

Reviewer: Fable 5.1 (read-only, detached worktree `_wt/SEO-review`, removed after). Date 2026-10-13.
Method: full reads of `gbp-runner.mjs`, `gbp-api-poster.mjs`, `gbp-worker.mjs`, `weekly/run.mjs`,
`weekly/lib/stage.mjs`, `weekly/lib/project.mjs`, `seo-watchdog.mjs`, the three guard test files; delegated full
reads (verified by spot-check) of `mav-bridge.mjs`, `seo-monitor.mjs`, `scripts/lib/*`, `deploy/aiwa/*`,
`run-weekly-seo.py`, `src/seo_agents/*`. Tests run in the worktree: `gbp-api-poster`, `gbp-runner`,
`e2e-new-mode`, `stage.stage`, `seo-watchdog`, `mav-bridge.bind` = 122/122 pass. No `.env` values read
(two name-only greps), no pm2, no AIWA, no network.

## Verdict

**PR after fixes: F1 (drop the `TZ` line from the PC `.env` instructions), F2 (pin `GBP_POSTER_SCRIPT` /
`GBP_POSTER_CONFIG` on the PC or gate the repo default off win32), F3 (persist `platform_post_id` on API exit 3),
F4 (alert when the GBP API is gated).** Items marked "before E" are Phase E/F prerequisites, not merge blockers,
but should be tracked in the runbook before any AIWA step.

The three guards named for mutation-check are honest (section 6). The GBP API path cannot create a localPost
twice through the daily tick, cannot mark `posted` on exit 5/6, and cannot post text-only (section 3).

## BLOCKER

| # | Where | Problem | Failure scenario | Fix |
|---|---|---|---|---|
| F1 | `docs/cutover/RC1-PR-BODY.md` "PC .env additions" + `CUTOVERPLAN.md` §6b: `TZ=America/Chicago` "harmless on the PC" | **False on Windows CPython.** `run-weekly-seo.py:30-37` force-loads `.env` into `os.environ`, and `:921` spawns the legacy crew with that env; `mav-bridge.mjs` and `gbp-worker.mjs` load `.env` into `process.env` and pass it to `seo-agents.exe` children. A Windows CPython child with `TZ=America/Chicago` treats UTC as local time. Reproduced from PowerShell with the repo venv: parent 15:18 CDT, child `TZ=America/Chicago` → 21:18, `time.timezone == 0`. (Git Bash masks it; the Task Scheduler does not.) | Friday 10-16 legacy crew and every `run-action` Python adapter stamp UTC as local; any `date.today()` after 19:00 CT is tomorrow; the wrapper's own `health.date` is unaffected, so the mismatch is silent. | Remove `TZ` from the PC list (Node needs no TZ on the PC; AIWA sets it in every unit and pm2 env). Optionally strip `TZ` from the Python child env on `os.name == "nt"` in the wrapper. |

## SHOULD-FIX (before PR merge)

| # | Where | Problem | Failure scenario | Fix |
|---|---|---|---|---|
| F2 | `src/seo_agents/actions.py:40-49`, `paths.py:27-36` | Ungated win32 default flip (ask item 1). Old: `GBP_POSTER_SCRIPT` = `C:\Users\carte\.claude\skills\gbp-poster\driver.mjs`, `GBP_POSTER_CONFIG` = `C:\Users\carte\.codex\plugins\...\config.local.json` (does not exist on the PC → poster effectively inert). New: repo `scripts/gbp-poster/driver.mjs` + `config/gbp-poster.config.json` because `resolve_default` prefers the repo path when it exists. The PC `.env` pins neither name (name-only grep: 0). Not in §6b. | `seo-agents run-action <publish_gbp_post> --live` from MCC now runs the repo Playwright driver with the real config, next to gbp-worker's own posting → double-post path that used to fail closed. Reachable only via `run-action`, not the Friday run. | Add both names to §6b/PR body, or restrict the repo-relative preference to non-win32 (keep the legacy literal first on win32). |
| F3 | `scripts/lib/gbp-runner.mjs:344-347` with `:143-148` | `applyDriverResult` writes `platform_post_id` only when `map.status === 'posted'`. API exit 3 (created, GET-back not LIVE) maps to `needs_verification` and the resource name the poster emits (`gbp-api-poster.mjs:650-658`) is dropped. RC1-NOTES claims "platform_post_id = resource name, reported on exit 3 too" — reported by the poster, not persisted. | Day 1 exit 3 → row `needs_verification`, `platform_post_id` null; F gate "Day 1 `platform_post_id` resource name" fails; operator cannot GET the post from the row; Grok `live` later stamps `verified-no-url`. Test `gbp-runner.test.mjs:576-581` asserts only the workbook gate, not the id. | In API mode, set `update.platform_post_id = parsed.postUrl` whenever `parsed.postUrl` is set and status is not `error`; add the assertion. |
| F4 | `gbp-worker.mjs:656-670`, `gbp-runner.mjs:96-98,167-169`, `seo-watchdog.mjs` (no weekly_posts check) | `api_gated` (exit 6) is logged, never alerted. Rows stay `scheduled`; `runDailyGbp` logs `info`; mav-bridge fault detection (`:839`) only looks at `error/needs_verification/posting`; watchdog/reconcile never look at overdue `scheduled` rows. | AIWA with `GBP_POSTER=api` while v4 is still gated (probe 2026-10-13): Friday Day 1 and every daily tick exit 6, zero GBP posts all week, no page. Same silence for any `scheduled` row whose date passed with the worker down. | `sendWorkerAlert` once when the startup probe reports `gated` and once per day when `applyDriverResult` maps `api_gated`; add a watchdog/reconcile check for `scheduled` rows with `post_date < today` (Chicago). |
| F5 | `scripts/run-weekly-seo.py:351-354, 881` | Unknown `SEO_PIPELINE` falls through to the legacy CrewAI path. The wrapper's `.env` parser keeps quotes/trailing comments; `render-env.sh:40-49` strips them, so `SEO_PIPELINE="new"` passes render-env and runs the crews. | On AIWA a quoted/typo'd value runs research/execute crews (preflight may exit 1 for missing crew keys, but the health says "preflight failed", not "wrong mode"). | After `pipeline_mode()`, reject anything not in `{legacy, shadow, new, offline}` → `write_runner_health("failed")`, exit 1; test it. |
| F6 | `scripts/seo-monitor.mjs:143` (`host: '127.0.0.1'`), `:279-303`, `:305-316` | Monitor probes mav-bridge on loopback; `deploy/aiwa/env.required` sets `MAV_BRIDGE_BIND=<LXC ip>`. `checkMCCDashboard` probes `127.0.0.1:3000`; MCC lives on CT 103. | AIWA Friday: "mav-bridge is not responding" after ~90 s on a healthy bridge, plus a standing "MCC Dashboard is not responding" — alert fatigue on the first live Friday. | Probe `resolveBind(env).host` (map `0.0.0.0` → `127.0.0.1`); make the MCC check opt-in (`MCC_HEALTH_URL`). before E |
| F7 | `deploy/aiwa/install.sh`, `RUNBOOK-AIWA.md:120`, `monitor-host.mjs:9-12` | No boot persistence for the pm2 apps (no `pm2 startup`/systemd unit; only `pm2 save`); monitor pm2 self-heal is off on Linux. | LXC reboot → gbp-worker/mav-bridge/fb-comment-agent stay down; Days 2-7 never post; nothing alerts (see F4). | Add `pm2 startup systemd -u seo --hp /opt/seo` to install.sh/runbook F3, or a `seo-pm2.service`. before E |
| F8 | `install.sh:72` creates `/srv/seo/photos/inbox` inside the cache; `gbp-photo-pick.mjs:124,398` excludes only `unused review`/`archive`; `seo-photo-sync.service:17-18,26` syncs Drive into that inbox | Every synced photo is discovered twice (`cache/x.jpg` and `cache/inbox/x.jpg`). | Repeat of the 9/25 duplicate-photo incident on the first AIWA Friday; the hash guard catches byte-identical reuse only after one is posted. | Put the rclone target outside `GBP_PHOTOS_LOCAL_CACHE`, or add `inbox` to `EXCLUDED_DIRS`. before E |
| F9 | `install.sh:41` (`gpg --dearmor -o` fails on re-run), `:70-73` (no `chown -R seo:seo /opt/seo`), `:88-95` (`runuser` inherits root cwd `/root` 0700 → npm `EACCES uv_cwd`), `:54` unpinned `curl \| sh` for uv | Not idempotent / not runnable as written on a fresh Debian 12 LXC after the runbook's root copy. | E2 fails midway; a second run fails earlier at the gpg step. | `--yes` on gpg; `cd "$APP_ROOT"` before step 7; recursive chown after the copy; pin the uv installer version. before E |
| F10 | `deploy/aiwa/systemd/*.timer` OnCalendar has no `America/Chicago` suffix; `render-env.sh` is advisory (no unit runs it) and does not check `MAV_BRIDGE_GBP=off`, `SEO_AUTO_APPROVE`, `FB_BOOST_API`, or that `*_FILE` paths exist | Correct only while `timedatectl set-timezone` (install.sh:75-85) holds; the safety pins the runbook relies on are unenforced. | A host tz reset fires Friday timers at 08:30 UTC; a `.env` missing `MAV_BRIDGE_GBP` passes render-env. | Append ` America/Chicago` to each OnCalendar (systemd 252 supports it); add the pins to render-env; wire `ExecStartPre=render-env.sh --check` into seo-weekly-run. before E |
| F11 | `deploy/aiwa/env.required` lacks `FB_AD_ACCOUNT_ID` (needed by `fb-boost-marketing.mjs:204-228` for `FB_BOOST_API=1`); no rclone remote config step for user `seo`; no `~/.hermes` provisioning for `HERMES_CLI` | F3 flips `FB_BOOST_API=1` with the boost client not `ready`; `seo-photo-sync` `ExecStartPre` fails loudly without `rclone.conf`; Hermes alerts fall to SMTP only. | Boost tick silently skipped on the first live Friday; photo sync unit red. | Add the name to env.required; add runbook steps for rclone and Hermes credentials. before E |
| F12 | `scripts/lib/monitor-host.mjs:18-20`, `seo-monitor.mjs:373-386` | `SEO_MONITOR_NET_USE` defaults **off** on win32 (unlike `SEO_MONITOR_PM2`, on by default). Documented in §6b, but the PC `.env` does not have it yet (name-only grep) and the only trace of forgetting it is a warn line every 30 s in the jsonl. | Carter forgets the line → PC loses the `M:` remount auto-fix and its alert on Friday. | Default on for win32 (mirror the pm2 default), or make the startup alert say "net use: DISABLED". |
| F13 | `scripts/mav-bridge.mjs:1471` with `:904-912` (B8) | A non-loopback bind exposes unauthenticated mutating routes (approve/retry/clear-lock/run/new-schedule) with `access-control-allow-origin: *`; `parseJsonBody` ignores Content-Type. `MAV_BRIDGE_BIND=0.0.0.0` accepted silently. | Any LAN browser can approve/replay a week via a simple cross-site POST once the bridge binds the LXC address. | Keep the CT-103-only firewall rule as a hard E3 gate; refuse `0.0.0.0`; shared-secret header is backlog C1. before E |

## NIT

| # | Where | Note |
|---|---|---|
| N1 | `gbp-api-poster.mjs:341-357,606` | G2 matches on the first 60 chars of the normalised summary within 7 days. Caption = headline+body (`sync-gbp-schedule.mjs:100-108`); the validator forbids duplicate hooks in a week (`validate.mjs:713-714`) so a collision needs two hooks sharing a 60-char prefix. Low risk, but a hit marks Day N `posted` with Day M's name and no create (success-on-no-post). Compare the full normalised summary, or exclude posts whose summary equals another workbook date's caption. |
| N2 | `gbp-api-poster.mjs:555-618` | G3 photo check runs before the G2 list. A row re-run after its photo was archived by `markGbpPostedAndArchive` (and the workbook `Posted` write failed) exits 5 `image_missing` → row `error` + alert although the post is live. In live mode list first, then photo. |
| N3 | `gbp-api-poster.mjs:476-485` | `createLocalPost` still accepts a falsy `mediaRef` and silently builds a text-only body. Make it throw; the "text-only impossible" guarantee then holds structurally, not only by call order. |
| N4 | `gbp-api-poster.mjs:93-95,406-419` | `isV4Gated` = any 404, so a wrong location resource (accounts[0]/locations[0] with no `GBP_LOCATION_NAME` override) looks "gated" forever and rows stay `scheduled` (see F4). |
| N5 | `seo-monitor.mjs:76,512` (`toISOString` today) vs `health.date` (local); `seo-watchdog.mjs:90-96` local time | Both depend on host TZ = Chicago. PC: a monitor restart Friday 19:00-24:00 CT gives a false no-show. Pre-existing; AIWA units set TZ. Use Intl America/Chicago. |
| N6 | `gbp-runner.mjs:28-35`, `gbp-api-poster.mjs:111-118` | `excelDateToIso(Date)` is UTC midnight (O3 in RC1-NOTES); consistent today, watch on AIWA. |
| N7 | `mav-bridge.mjs:396-406,735-744` | Pre-existing (not in this diff): FB rows flip to `posted` on unparseable poster stdout or when `platform_post_id`/token is missing. Matters more on the LXC if `FB_PAGE_ACCESS_TOKEN` is absent from `.env`. |
| N8 | `mav-bridge.mjs:808-827` | Stuck-`posting` TTL flips gbp rows owned by gbp-worker to `error` after 30 min (cross-owner write; a slow headed post then alerts/retries). Pre-existing. |
| N9 | `slack-alert.mjs:36-45`; `mav-bridge.mjs:156` + `alert-store.mjs:20-24`; `seo-monitor.mjs:247-252` | On Linux a missing `SLACK_ALERT_CHANNEL` silently disables Slack; dedupe keys are recorded before delivery so a failed first delivery is never retried. Log the Slack state at startup. |
| N10 | `run-weekly-seo.py:826-842` | Health is `success` on attempt `succeeded/degraded` regardless of child exit code (by design); log a warning when `returncode` is non-zero. `:340` module-level `int()` on `SEO_PIPELINE_TIMEOUT_MIN` raises before any health write. The 30-min new-mode cap kills only `node`, not grandchildren, on Windows. |
| N11 | `actions.py:50` `GBP_BROWSER_SESSION_DIR` → `Path.home()`; `website.py:30-35`, `crew.py:61`, `evidence.py:233` import-time env reads | Same value for `carte`; differs under SYSTEM/pm2. Import-time reads miss `.env`-only keys when invoked without the wrapper/bridge (`load_dotenv` at `main.py:899` runs later) → `WEBSITE_BRANCH` default `master` and `website.py:341` refuses to commit. |
| N12 | `deploy/aiwa/verify-units.sh` | "PASS" = structural lint (keys present, Persistent flags); it does not check OnCalendar values, ExecStart targets, or the TZ suffix. `.gitattributes` has no `deploy/aiwa/** eol=lf`. README items #1, #2, #4, #10 and the ecosystem comments (`:9-10,61`) are stale (BIND vars and `new` mode exist). |
| N13 | `tests/test_crew_output_dir_env.py`, `test_evidence_output_dir_default.py` | Import `seo_agents` in a subprocess via the editable install; from a worktree they can test the live checkout's `src`, not the branch. Pin `PYTHONPATH` to the test's repo root. |
| N14 | `scripts/weekly/test/e2e-offline.test.mjs:768` | The one failing test in the builder's gate is the documented junction artifact (passes from the main checkout). Confirmed as worktree-only. |

## 1. PC behaviour changes not behind a §6b-documented gate (legacy/shadow, win32)

- F2: `GBP_POSTER_SCRIPT`/`GBP_POSTER_CONFIG` defaults (ungated; `run-action` path only).
- N11: `GBP_BROWSER_SESSION_DIR` → `Path.home()` (identical for `carte`).
- `gbp-mode.mjs:5`: mav-bridge's `GBP_POSTER` default flipped `api` → `playwright`; inert because `MAV_BRIDGE_GBP` defaults off and the PC `.env` sets `GBP_POSTER`.
- `resolveSeoAgentsExe` on win32 drops only the `.venv/bin/seo-agents` candidate (a Windows venv has no `bin/`): no effect.
- Everything else compared literal-for-literal (secrets dir, photo cache/curated, `M:\backups\gbp-archive`, Hermes exe, Slack `%LOCALAPPDATA%` fallback, poll intervals, ports, pm2 names, bind host): unchanged on win32.
- F1 is the inverse case: a documented addition that changes PC behaviour.

## 2. Silent failures found

F4 (api_gated / overdue `scheduled` rows), F5 (unknown mode → crews), F8 (double discovery), F12 (net use off), N1, N7, N9, N10. Checked and clean: `selectStore` refuses `new` without Supabase (exit 2); V5 leaves nothing in `outputs/` on a failed projection (test `e2e-new-mode.test.mjs:283-321` asserts both directions); `week_of` from `chicagoToday` (`week-spec.mjs:48,84`); daily tick via Intl Chicago (`centralDateHour`); Friday timers `Persistent=false` (no late Monday publish), daily timers `Persistent=true` (appropriate); `EnvironmentFile` without `-` fails the unit on a missing `.env`; `gbp-worker` exits 1 on missing Supabase env; the two authorize scripts exit only from `server.close`.

## 3. GBP API path correctness

- Double create: the daily tick selects only `scheduled`/`scheduled_native` rows for today (`gbp-runner.mjs:474-480`); a row leaves that set on the first result, so the in-memory latch resetting on a worker restart cannot repost (test `:605-633`). Days 2-7 get no poster call in API mode (`:410-417`). A crash between create and the Supabase update is covered by G2's list (`gbp-api-poster.mjs:597-618`), subject to N1. Grok `not_found` retry (`gbp-worker.mjs:539-549`) also passes through G2.
- Posted without LIVE: exit 0 `posted` requires `verified:true` from the GET-back or `already_live` from the list; exit 3 → `needs_verification` (but see F3); exit 5 → `error`; exit 6 → `scheduled` (`gbpDailyStatusForExit:96-98`, `gbpScheduleStatusForExit:167-169`); abnormal exit → `needs_verification`. Exit 6 cannot reach `error`/`posted` on either mapping; `apiCreated` requires `postUrl` and status ≠ `error`, so a refused post never closes the workbook gate (test `:591-598`).
- Image without manifest audit: `preparePhoto` is the only route to `uploadMedia`/`createLocalPost`; it requires a manifest entry, on-disk file, matching sha256, policy pass, no hash conflict (8 weeks, cross-platform, excluding this date's own gbp rows). Dry-run exits 5, not 0, on refusal. N3 is the only structural softness.

## 4. Deploy artifacts

Unit/timer semantics match the PC schedule (Fri 08:25/08:30/08:30, daily 10:00/10:10); every service has `User=seo`, `WorkingDirectory=/opt/seo`, `EnvironmentFile=/opt/seo/.env`, `Environment=TZ=America/Chicago`, `Type=oneshot`. Open: F6-F11, N12. `render-env.sh` never prints values; `env.required` names are all read by code; `SUPABASE_SERVICE_KEY`/`SERPAPI_API_KEY` spelling matches the code.

## 5. Secrets / paths / hostnames

No tokens, keys, `-----BEGIN` blocks or `.env` contents in added lines; `xoxb-` strings are test fakes. `C:\Users\carte` / `C:\Workspace` literals in added code are inside `win32`/`nt` branches or `legacy_win=` arguments, plus the pre-existing `slack-alert.mjs:14-18` LOCALAPPDATA path builder and SMTP default address (`seo-watchdog.mjs:109-110`, `seo-monitor.mjs:47-48`). `deploy/aiwa` README mentions `CMB-Workbench`/`CARTERSPC` cosmetically. No log line prints a token.

## 6. Test honesty (mutation check)

- **V4 rerun guard** (`e2e-new-mode.test.mjs:325-346`): sets `seo_runs.status` to approved/executing/done, or one row to `posted`, then runs with `forceReplan`; asserts `RerunRefused` with the right code **and** `JSON.stringify(tables)` unchanged. Deleting either branch of `checkRerunGuard` makes projectPlan replace rows → the table assertion fails. Honest.
- **G3 text-only impossible** (`gbp-api-poster.test.mjs:237-247`): no manifest, blank workbook image; asserts exit 5 `image_missing`, `api.calls.length === 0`, `created.length === 0`. A text-only fallback would make `calls > 0`. Honest; `:177-190` additionally asserts the create carries `media[0].dataRef`.
- **G1 no `--schedule` spawn** (`gbp-runner.test.mjs:501-542`): API mode with 3 rows; asserts no arg `--schedule`, exactly one poster call (Day 1), two `scheduled` updates, no `scheduled_native`. Removing the API branch yields 3 poster calls with `--schedule` → fails. Honest.
- Gaps: no test that API exit 3 persists `platform_post_id` (would have caught F3); no test for an invalid/quoted `SEO_PIPELINE` (F5); no test that `api_gated` produces an alert (F4); N13 on the two pytest contract tests.
