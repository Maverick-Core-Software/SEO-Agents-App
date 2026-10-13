# PR body draft: `cutover/rc1` → `main`

Title: **cutover rc1: v2 live switch, Linux portability, AIWA deploy, GBP API path (Phase A–D) + review fixes**

## Summary

Release candidate for the SEO-Agents-App cutover (plan: `docs/cutover/CUTOVERPLAN.md`, audit:
`docs/cutover/2026-10-13-SCOPING-AUDIT.md`). It merges the six Phase B/C branches on top of
`cutover/phase-a-v2-merge` (`c4233e7`), reconciles their seams, adds Phase D (GBP API) plus the
Phase C findings V4/V5, and carries the fixes from the independent review (`docs/cutover/RC1-REVIEW.md`,
verdict "PR after fixes") as one commit per finding (section "Review fixes" below). Every change to PC
behaviour sits behind an env gate; with the current PC `.env` plus the additions listed below the
legacy/shadow Friday run and the Playwright GBP path are unchanged.

Nothing in this PR is deployed by merging it: AIWA provisioning (Phase E) and the flip (Phase F) are
separate, Carter-approved steps in `docs/cutover/RUNBOOK-AIWA.md`.

Integration notes, conflict resolutions, seams and the review findings: `docs/cutover/RC1-NOTES.md`.

## Build items

| Item | What landed |
|---|---|
| B1 + G4 | Machine paths via env with platform defaults (`scripts/lib/platform-defaults.mjs`); one `GBP_POSTER` default (`playwright`) in `scripts/lib/gbp-mode.mjs` read by mav-bridge and gbp-worker |
| B2 + B3 | Linux-safe alert transport (`HERMES_CLI`, Slack env), seo-monitor without pm2 unless `SEO_MONITOR_PM2` (`scripts/lib/monitor-host.mjs`); the `net use` remount defaults on for win32 (F12) |
| B4 + B5 | `deploy/aiwa/*` (units, install, render-env, verify-units), `docs/cutover/RUNBOOK-AIWA.md`, `scripts/ops/rekey-state.mjs` |
| B6 + B7 | realpath entry guard (`scripts/lib/entry.mjs`), loopback binds for fb-comment-agent/thumbtack, Linux-portable crew defaults (`src/seo_agents/paths.py`, `SEO_OUTPUT_DIR` in crew + evidence, `WEBSITE_BRANCH`), venv-aware wrapper |
| B8 | `MAV_BRIDGE_BIND` listen address for mav-bridge (`scripts/lib/bridge-bind.mjs`); `0.0.0.0` refused, non-loopback warned (F13) |
| C (V1–V3) | `--mode new` in `scripts/weekly/run.mjs` / `lib/stage.mjs` / `run-weekly-seo.py` (new replaces the crews; Supabase store required, exit 2 otherwise; exports to `outputs/`; projection into `weekly_posts`/`website_tasks`), notify receipt on the attempt (V2), `reconcile-health.json` on success and failure (V3), `budget_usd` 20→5 |
| V4 | Rerun guard: `--mode new` exits 2 when `seo_runs(week_of)` is approved/executing/done or any `weekly_posts` row is past `pending_approval`; an existing pending week needs `--force-replan`, which only replaces pending rows |
| V5 | Export-after-project: new-mode schedules are staged and promoted into `outputs/` only after `projectPlan` succeeds; a failed attempt keeps its artifacts under `outputs/shadow/failed-<attempt>/` and leaves nothing in `outputs/` |
| G1 | API mode: Day 1 posts, Days 2-7 are `scheduled` with no `--schedule` spawn; the ≥09:00 CT daily tick (`dailyTickDue`) posts each once; every API-created post closes the workbook `Posted` gate |
| G2 | Idempotent create: list `v4/{location}/localPosts` before create; same 60-char summary prefix within 7 days → `already_live` (exit 0, resource name as `platform_post_id`); REJECTED match → exit 5 |
| G3 | Photo rule at post time: image only via the audited selection manifest, sha256 of the final bytes, 8-week cross-platform no-reuse, `checkImagePolicy` (JPG/PNG ≥10 KB), HEIC→JPEG via `heic-convert`, optional `GBP_PHOTO_VISION_CHECK=1`; text-only posting is impossible (structurally since N3); `--dry-run` prints `{date,image_path,image_sha256,image_exists,manifest_ok}` |
| D extra | `authorize-gbp.mjs` / `authorize-search-console.mjs` exit after `server.close` (libuv teardown crash); gated v4 (404) → poster exit 6 `api_gated`, rows stay `scheduled`, worker logs **and alerts** it (F4) |
| v4 gate (`28ea781`) | The v4 gate is the location's `localPosts` list (`pageSize=1`), never the removed `/v4/accounts` endpoint: `probeV4`, `gbp-access-probe.mjs`, the poster's pre-create check and the worker's startup probe all use it; `scripts/lib/gbp-location.mjs` resolves the account/location from `GBP_ACCOUNT_ID` / `GBP_LOCATION_ID` (pinned on AIWA) or the v1 lookup |
| hermetic e2e (`67f3a7f`) | `WEEKLY_SKIP_DOTENV` + a hermetic child env in the weekly e2e tests; `supabase-sync.mjs` honours it |

## GBP access (G0): PASS

`docs/cutover/evidence/gbp-probe-2026-10-13-run4.txt` (real probe, read-only GETs, 2026-10-13): v1 accounts
200 (`accounts/102812174257783632337`), v1 locations 200 (`locations/14305368671018787381` "Grizzly
Electrical Solutions"), **v4 `localPosts` list 200** (verdict: "v4 localPosts reachable — API posting
possible"). The legacy `/v4/accounts` and the v4 location GET answer 404 HTML because Google removed those
endpoints, which is why the gate moved to the `localPosts` list. The API path is live-capable; `GBP_POSTER`
default remains `playwright` until Phase F.

## Review fixes (`docs/cutover/RC1-REVIEW.md`, one commit each on `cutover/rc1-fixes`)

| # | Finding | Commit | Fix | Test |
|---|---|---|---|---|
| F1 (blocker) | `TZ=America/Chicago` in the PC `.env` would make Windows CPython children read UTC as local | `a69ec86` | `python_child_env()` (wrapper) and `scripts/lib/child-env.mjs` `pythonChildEnv()` strip `TZ` on win32/nt at every seo-agents.exe spawn (wrapper preflight + crew launch, mav-bridge, website-task-runner, run-phase); posix keeps it | `child-env.test.mjs`; `tests/test_wrapper_child_env.py` |
| F2 | Repo poster driver/config became the PC default via `resolve_default` | `ecc5b78` | win32 keeps the legacy literal (present or not) unless env overrides; repo-relative is posix-only | `tests/test_paths_win32_defaults.py` |
| F3 | API exit 3 dropped the reported `platform_post_id` | `8e54819` | `applyDriverResult` persists the resource name on exit 3 in API mode | `gbp-runner.test.mjs` "F3: API exit 3 persists platform_post_id" |
| F4 | `api_gated` never alerted; overdue `scheduled` rows invisible | `12b7e4f` | poster emits `auth_failed` on 401/403 (row stays `scheduled`); `createGbpApiGateLatch` = one hermes/slack alert per episode shared by the startup probe and every poster result; watchdog `evaluateGbpOverdue` ("GBP OVERDUE": gbp rows `scheduled` for < today any hour, = today from 12:00 CT) with a Supabase query in `main()`; seo-monitor runs the same check per poll | `gbp-runner.test.mjs` "F4 api-gate alert latch"; `seo-watchdog.test.mjs` "evaluateGbpOverdue"; `gbp-api-poster.test.mjs` "gate 401 is a structured auth_failed" |
| F5 | Unknown/quoted `SEO_PIPELINE` fell through to the legacy crews | `7a54e03` | `pipeline_mode()` strips quotes/whitespace, lower-cases; unknown value → REFUSED log, health `failed`, exit 2 before any crew | `tests/test_pipeline_mode_guard.py` |
| F6 (before E) | Monitor probed mav-bridge/MCC on a fixed loopback | `1065a01` | `resolveMonitorProbes`: bridge from `MAV_BRIDGE_BIND` (or `MAV_BRIDGE_HEALTH_URL`), MCC from `MCC_HEALTH_URL`; documented in `.env.example` / `env.required` | `monitor-host.test.mjs` resolveMonitorProbes |
| F7 (before E) | No pm2 boot persistence on the LXC | `3992016` | `install.sh --pm2-startup` runs `pm2 startup systemd -u seo --hp /opt/seo` (opt-in, Carter-approved RUNBOOK 8 F3 line before `pm2 start` / `pm2 save`); RUNBOOK 9 verifies | verify-units PASS |
| F8 (before E) | rclone inbox inside the photo cache → double discovery | `296427f` | inbox is `/srv/seo/photos-inbox`; `gbp-photo-pick` `EXCLUDED_DIRS` += `inbox` | gbp-photo-pick tests; verify-units PASS |
| F9 (before E) | install.sh not idempotent / not runnable as written | `8c23e03` | gpg keyring skip/`--yes`, `chown -R seo:seo`, `runuser` from `/opt/seo`, uv installer pinned (0.12.7, `SEO_UV_VERSION`) | `bash -n`; verify-units PASS |
| F10 (before E) | timers without an explicit zone; render-env advisory | `5bf6919` | ` America/Chicago` on every `OnCalendar` (lint checks it; timedatectl kept); render-env enforces `GBP_POSTER`/`SEO_PIPELINE`/`MAV_BRIDGE_GBP`/`SEO_AUTO_APPROVE`/`FB_BOOST_API` values and no unspecified `MAV_BRIDGE_BIND`; `--check-paths` requires every path name to resolve; `seo-weekly-run.service` runs it as `ExecStartPre` | probed with synthetic env files; verify-units PASS |
| F11 (before E) | `FB_AD_ACCOUNT_ID` missing; no rclone/hermes provisioning for `seo` | `b8e6c0d` | `env.required` += `FB_AD_ACCOUNT_ID`, `GBP_ACCOUNT_ID`, `GBP_LOCATION_ID`; RUNBOOK 3b (rclone remote, hermes config, ad account, GBP ids) | verify-units PASS |
| F12 | `SEO_MONITOR_NET_USE` off by default on win32 | `3565472` | unset = on for win32 (like `SEO_MONITOR_PM2`), `0` disables, never on linux; **no PC `.env` line needed any more** | `monitor-host.test.mjs` |
| F13 (before E) | `MAV_BRIDGE_BIND=0.0.0.0` accepted silently | `ee2622c` | `resolveBind` throws on an unspecified address unless `MAV_BRIDGE_ALLOW_ANY=1`; `bindWarning` logged for any non-loopback bind; RUNBOOK 3a makes the CT-103-only firewall rule a hard E3 gate with evidence | `mav-bridge.bind.test.mjs` |
| Nits N3, N12, FB bind | `createLocalPost` falsy `mediaRef`; stale deploy README/ecosystem comments; `FB_COMMENT_AGENT_BIND` undocumented | `1fb8a27` | `createLocalPost` throws without media; README follow-ups 1/2/4 marked landed; `.env.example` line | `gbp-api-poster.test.mjs` "createLocalPost itself refuses a falsy mediaRef" |

Nits left as listed (not changed): N1 (60-char summary-prefix match, spec'd in plan §6 G2), N2 (photo check
before the G2 list on a re-run), N4 (`isV4Gated` = any HTML 404; the gate is now the `localPosts` list so a wrong
location resource surfaces as a JSON 404 → error, not gated), N5 (monitor/watchdog legacy checks use host local
time; the new GBP OVERDUE check uses Intl Chicago), N6 (`excelDateToIso` UTC midnight), N7/N8 (pre-existing FB
and stuck-`posting` behaviour in mav-bridge), N9 (Slack state not logged at startup), N10 (health success on
non-zero child exit, module-level `int()`), N11 (import-time env reads), N13 (pytest contract tests import the
editable install), N14 (junction artifact, below). Also open from RC1-NOTES: R1–R3 (orchestrator decisions on
Phase A content), R4/R5 (manifest load/tag), R7 (reconcile-stale noise in shadow mode on the PC).

## Gates (worktree `_wt/SEO-rc1b` on the PC, after the review fixes)

| Gate | Command | Result |
|---|---|---|
| node | `node --test "scripts/**/*.test.mjs"` | tests 995, pass 994, fail 1 — the junction artifact only (`scripts/weekly/test/e2e-offline.test.mjs` "resolves the module to the real repo path through the alias" fails in every git worktree because `C:Workspace` resolves to the main checkout; passes from the main checkout) |
| lint | `npm run lint` | exit 0 |
| pytest | `uv run --with pytest pytest -q` | 428 passed, 1 failed — `tests/test_research_regression.py::TestDryRunCalibration::test_dry_run_no_live_adapter` (known, pre-existing) |
| units | `bash deploy/aiwa/verify-units.sh` | PASS |

Baseline before the merges (`cutover/phase-a-v2-merge`): node 901 tests.

## PC `.env` additions before this runs on the PC (CUTOVERPLAN §6b; names only, Carter edits `.env`)

- `MAV_BRIDGE_GBP=off` — explicit.
- `WEBSITE_BRANCH=main` — `website.py` defaults to `master`; the live site serves `main` (both hosts).
- **Do NOT set `TZ` on the PC.** Windows CPython with `TZ` set treats UTC as local time; `TZ` is AIWA-only
  (Linux). As of F1 the Python children never see it on Windows anyway, but the line stays out of the PC `.env`.
- `SEO_MONITOR_NET_USE` is **no longer needed** on the PC: F12 defaults it on for win32 (set `0` only to
  disable the `net use M:` remount).
- Optional on the PC: `HERMES_CLI` (win32 default unchanged), `GBP_WORKBOOK_DIR` (AIWA-only; the PC config
  still carries the Windows dir). `GBP_POSTER_SCRIPT` / `GBP_POSTER_CONFIG` need no pin: F2 keeps the legacy
  PC defaults on win32.
- Unchanged and still required: `GBP_POSTER=playwright`, `SEO_PIPELINE=legacy|shadow` until Phase F.

## Not in this PR / follow-ups

- Phase E (AIWA provision, shadow Friday) and Phase F (flip) per the runbook; each live step needs Carter's yes.
  New E prerequisites from the review are in the runbook: 3a firewall hard gate (F13), 3b provisioning (F11),
  F3 `--pm2-startup` line (F7), `render-env.sh --check-paths` after the data copy (F10).
- Review findings left open are listed above and in `docs/cutover/RC1-NOTES.md` section "Review findings".
- `docs/cutover/CUTOVERPLAN.md` lives only in the main checkout (untracked); its §6b sentence about
  `SEO_MONITOR_NET_USE=1` should now read "not needed (defaults on for win32 since F12)".

## Rollback

Rollback ref on `main`: `6f748c0`. Tag after merge: `seo-aiwa-rc1`. PC reversal steps: `docs/cutover/RUNBOOK-AIWA.md` section 10.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
