# cutover/rc1 integration notes

Branch `cutover/rc1`, based on `origin/cutover/phase-a-v2-merge` @ `c4233e7`. Built 2026-10-13 in a git
worktree (`_wt/SEO-rc1`), never on the main checkout. Plan: `docs/cutover/CUTOVERPLAN.md` section 7 (Phase R).

## 1. Merge table (JOB 1)

Merged in this order with `--no-ff`; each merge is its own commit.

| # | Branch | Head | Result | Conflicts |
|---|---|---|---|---|
| 1 | `cutover/b1-paths-env` | `e0fc671` | clean | none |
| 2 | `cutover/b2-b3-alerts-monitor` | `2babfe9` | conflict | `scripts/lib/gbp-runner.mjs` |
| 3 | `cutover/b4-b5-deploy-rekey` | `5331a49` | clean | none |
| 4 | `cutover/b6-b7-guards-legacy-linux` | `a009b66` | conflict | `src/seo_agents/main.py` |
| 5 | `cutover/b8-bridge-bind` | `904a871` | conflict | `scripts/mav-bridge.mjs` |
| 6 | `cutover/c-mode-new` | `be0b013` | conflict | `scripts/weekly/reconcile.mjs` |

### Conflict resolutions (file -> how)

| File | Sides | Resolution |
|---|---|---|
| `scripts/lib/gbp-runner.mjs` | B1 `resolveGbpArchiveFolder` (platform-defaults) vs B3 `gbpArchiveFolder` (monitor-host) | kept B1's import/call. Follow-up seam commit: `monitor-host.gbpArchiveFolder` now delegates to `resolveGbpArchiveFolder`, so there is one archive default in the repo and seo-monitor's import surface is unchanged. |
| `src/seo_agents/main.py` | B2 `_DEFAULT_HERMES_CLI` using `os.name == "nt"` vs B7 same constant using `sys.platform == "win32"` | identical semantics; kept B2's wording (the surrounding function already uses `os`). |
| `scripts/mav-bridge.mjs` | B1 `resolveSeoAgentsExe` vs B8 inline exe candidates + `resolveBind` | B8's `resolveBind` import and `BRIDGE_HOST` listen + startup log; B1's `resolveSeoAgentsExe` for the CLI path. The B8 branch had turned 135 lines LF in an otherwise CRLF file; rc1 restores pure CRLF so the logical diff vs base is 7 lines (`git diff --ignore-all-space`). |
| `scripts/weekly/reconcile.mjs` | B1 `resolveSearchConsoleTokenFile()` vs C `makeSearchConsolePages(env, now)` closure with a hard-coded `C:/Users/carte/...` token path | kept C's closure (it is what `runReconcile` injects) with the token file resolved by `resolveSearchConsoleTokenFile({ env })`; the Windows literal is gone from this file. |

Expected overlaps that merged without conflict and were checked by hand: `scripts/run-weekly-seo.py` (B2
hermes default function, B7 `_venv_python`, C `PIPELINE_MODES=("shadow","new","offline")` and the `new`
launcher all present), `scripts/gbp-worker.mjs` (G4 `resolveGbpMode` + B6 entry guard), `.env.example` (no
duplicate keys), `docs/cutover/*` (B4 runbook + B8 notes, see seams).

## 2. Seams reconciled after the merges

| Seam | Fix | Commit |
|---|---|---|
| Two archive-folder defaults (B1 platform-defaults, B3 monitor-host) | monitor-host delegates to platform-defaults | `675d111` |
| `crew.py` `OUTPUT_DIR` ignored `SEO_OUTPUT_DIR` while `evidence.py` honoured it (B7 note) | `OUTPUT_DIR = Path(os.getenv("SEO_OUTPUT_DIR") or PROJECT_ROOT/"outputs")`; contract test `tests/test_crew_output_dir_env.py` asserts crew and evidence resolve to the same folder with and without the override | `6cb4d15` |
| `deploy/aiwa/env.required` missing names the build items introduced | added `GBP_WORKBOOK_DIR`, `MAV_BRIDGE_BIND`, `SEO_MONITOR_NET_USE`, `WEBSITE_BRANCH` (render-env.sh requires every listed name non-empty on AIWA) | `6cb4d15` |
| `.env.example` gaps | added `SEO_OUTPUT_DIR`, `WEBSITE_BRANCH`, `SEO_MONITOR_NET_USE`, `SEO_MONITOR_PM2` (commented, with the PC/AIWA defaults); `SEO_PIPELINE` comment now lists `new` | `6cb4d15` |
| `docs/cutover/B8-NOTES.md` carried the network notes because the runbook lived on another branch | content moved into `RUNBOOK-AIWA.md` section 3a "Network: mav-bridge bind"; B8-NOTES.md removed | `6cb4d15` |

## 3. Gates after JOB 1 (worktree, PC)

| Gate | Command | Result |
|---|---|---|
| node | `node --test "scripts/**/*.test.mjs"` | tests 943, pass 942, fail 1 (junction artifact, below) |
| lint | `npm run lint` | exit 0 |
| pytest | `uv run --with pytest pytest -q` | 401 passed, 1 failed (`test_research_regression.py::TestDryRunCalibration::test_dry_run_no_live_adapter`, known) |
| units | `bash deploy/aiwa/verify-units.sh` | PASS |

Known worktree-only failure, not a regression: `scripts/weekly/test/e2e-offline.test.mjs` "resolves the module
to the real repo path through the alias" fails in every git worktree because the `C:\Workspace` junction resolves
to the main checkout (`D:\Workspace\Active\SEO-Agents-App`), not the worktree. It passes from the main checkout.

## 4. JOB 2: Phase D + V4/V5 (one commit per item on `cutover/rc1`)

| Item | Commit | What | Tests (file: cases) |
|---|---|---|---|
| G1 scheduling semantics | `c67bb81` | `gbp-runner.mjs`: `GBP_POSTER=api` → Day 1 posts, Days 2-7 `weekly_posts.status='scheduled'` with no poster/`--schedule` spawn (brain patch `gbp-runner-drop-native-scheduling.patch`, gated to API mode; Playwright path untouched). `applyDriverResult` closes the workbook `Posted` gate for every API-created post (exit 0 and exit 3, via `markGbpPostedAndArchive({ force })`), never for refused ones. `dailyTickDue()` is the tested ≥09:00 CT once-per-day latch now used by `gbp-worker.mjs`. | `scripts/lib/gbp-runner.test.mjs`: "API mode must never spawn --schedule / only Day 1 invokes the API poster / Days 2 and 3 are marked scheduled"; "API mode: workbook Posted=TRUE for a created-but-unconfirmed post" vs "playwright mode: exit 3 leaves the Posted gate open"; "later ticks on the same day post nothing"; `dailyTickDue` cases |
| G2 idempotent create | `60c54bb` | `gbp-api-poster.mjs`: `runPoster(args, deps)` with injectable `gbpFetch`/`getGbpAccessToken`/`fetchImpl`/`now`; lists `GET v4/{location}/localPosts` (pageSize 100, follows `nextPageToken`) before create; a post whose whitespace-normalised summary shares the first 60 chars within 7 days → exit 0 `{result:'already_live', status:'already_live', name, postUrl:name}`; REJECTED/TAKEN_DOWN match → exit 5 `google_rejected`; list failure propagates (exit 1). `platform_post_id` = resource name, reported on exit 3 too. | `scripts/gbp-api-poster.test.mjs` (G2 describes): "a matching post within 7 days: no create…", "no match: creates once…list runs before the create", "REJECTED: exit 5 google_rejected", "listing failure propagates", "exit 3 still carries the resource name", "listLocalPosts follows nextPageToken" |
| G3 photo-rule guard | `99cd225` | `gbp-api-poster.mjs`: image resolved only via the selection manifest (`resolveManifestEntry` → `isManifestSelectionCompatible`), no `<date>-` scan, no curated fallback, no text-only branch; `preparePhoto()` → exit 5 with `reason` ∈ image_missing (no entry / file gone / bytes ≠ audited sha256 / no hash), image_format (HEIC without or failing `heic-convert`), image_policy (`checkImagePolicy`, JPG/PNG ≥10 KB), hash_conflict (`hashConflicts`, 8 weeks, all platforms, other dates and earlier gbp-api posts), vision_rejected/vision_unavailable (`GBP_PHOTO_VISION_CHECK=1` → `verifyPhotoCandidates`, gpt-4o). `--dry-run` prints `{date,image_path,image_sha256,image_exists,manifest_ok}`. Success appends `{platform:'gbp', postedBy:'gbp-api', photoHash, localPostName, postedAt}` under `withManifestLock`. | `scripts/gbp-api-poster.test.mjs` (G3 describe): "text-only is impossible…no API call at all", "`<date>-` file without a manifest entry is still image_missing", "file gone", "bytes differ", "duplicate hash…hash_conflict", "same hash used by a gbp-api post for another date", ">8 weeks does not block", "under 10 KB → image_policy", "HEIC converted…fails closed", "--dry-run prints {…} and touches no API", "refused dry-run still prints the row and exits 5", "success appends a postedBy gbp-api row under the lock", "vision no/unavailable/yes", "preparePhoto never returns ok without…" |
| D extra (coordinator) | `a568645` | `authorize-gbp.mjs` / `authorize-search-console.mjs`: respond, then `server.close(() => process.exit(code))` on response finish (fixes the libuv `UV_HANDLE_CLOSING` crash after the token was saved). `gbp-api-poster.mjs`: v4 404 "route not served" on list/upload/create → exit 6 `{result:'api_gated', reason:'v4_gated'}` (distinct from policy 5); `probeV4()`; `gbp-runner.mjs` maps exit 6 / `api_gated` to `status:'scheduled'` + note on both paths (never error/posted); `gbp-worker.mjs` runs `probeV4` at startup in API mode and logs GATED loudly. `GBP_POSTER` default stays `playwright`. | poster: "404 on the localPosts list → exit 6…no create, no upload", "404 on media:startUpload → exit 6", "non-404 failure is still an error", "probeV4 reports gated on 404 and ok on 200"; runner: "gbp-runner api-gated exit 6" block |
| V5 export-after-project | `106f80d` | `stage.mjs`: new mode with a projector writes the seven exports to `<out>/.staging-<attempt>/`, promotes them into `<out>/` only after the store write and `projectPlan` succeed; any failure after they were written moves them to `failedExportDir(out, attempt)` = `<out>/shadow/failed-<attempt>/` (`e.failedExportDir`). `run.mjs`: end-of-run mirrors follow the same rule when a new-mode attempt failed before its projection; `attempt.json` is still mirrored to `--out` (the wrapper's `attempt_records` reads it). | `stage.stage.test.mjs`: "refuses to project a plan that failed validation…" (exports under the failed dir, none in outDir, staging gone), "propagates a project failure…exports land in the failed dir (V5)", "promotes the exports into outDir only after the projection succeeded (V5)"; `e2e-new-mode.test.mjs`: "marks the project stage failed…" now asserts no `*_posting_schedule.md` in the out dir and artifacts under `shadow/failed-<attempt>/` |
| V4 rerun guard | `8550b91` | `run.mjs`: `checkRerunGuard` after `selectStore`, before the attempt exists: refuses (RerunRefused → exit 2) when `seo_runs(week_of)` is approved/executing/done or any `weekly_posts` row of the week is past `pending_approval` (`--force-replan` never overrides these); an existing pending run is refused unless `--force-replan`, which only lets `projectPlan` replace the pending rows. new mode without a Supabase client → StoreRefused (exit 2). | `e2e-new-mode.test.mjs`: "a second new-mode run…is refused (exit 2, zero new rows) without --force-replan (V4)", "--force-replan replaces the pending rows", rerun-guard describe: approved/executing/done refused even with force; a posted row refused even with force; force with only pending rows → 11 rows replaced; `checkRerunGuard` passes an empty week and deletes nothing; `--force-replan` parse |

Gates after JOB 2 (worktree, PC):

| Gate | Result |
|---|---|
| `node --test "scripts/**/*.test.mjs"` | tests 977, pass 976, fail 1 (junction artifact: `e2e-offline.test.mjs:768` "resolves the module to the real repo path through the alias") |
| `npm run lint` | exit 0 |
| `uv run --with pytest pytest -q` | 403 passed, 1 failed (`test_research_regression.py::TestDryRunCalibration::test_dry_run_no_live_adapter`, known) |
| `bash deploy/aiwa/verify-units.sh` | PASS |

Design notes recorded for the orchestrator:
- The access probe on 2026-10-13 showed account management v1 = 200 and legacy v4 = 404 (project still gated). The API path is built as specified; with `GBP_POSTER=api` on a gated project every post exits 6 and its row stays `scheduled` with the gating note, so nothing is marked error or posted. `GBP_POSTER` default remains `playwright`.
- The poster's `--dry-run` prints the resolved row and exits 5 (not 0) when the photo rule refuses, so a 7-date dry-run loop fails loudly on a missing/unaudited image.
- `resolveManifestEntry` ignores rows with `postedBy:'gbp-api'` when choosing a selection and `reuseHistory` excludes this date's own gbp rows from the 8-week check; everything else with the same hash is a conflict.

## 5. Review findings (JOB 3: `git diff origin/main...cutover/rc1`, 130 files)

Method: a targeted sweep of every ADDED line in `scripts/`, `src/`, `deploy/` and `.env.example` for
swallowed errors (`catch {}`), UTC date math (`toISOString().slice(0,10)`, `getDate/getHours`), file-store
fallbacks, `process.exit` inside handlers, secrets and absolute user paths, plus the design review done while
building G1-G3/V4/V5 (runner exit-code mappings, the new-mode export/projection order, the wrapper's health
derivation). A delegated full-file review pass was started but had not reported back when this branch was
handed off, so treat this as a targeted, not exhaustive, review; the orchestrator's Fable pass (plan §7 step 2)
still applies.

### Fixed on `cutover/rc1`

| # | Where | Problem | Fix (commit) |
|---|---|---|---|
| F1 | `scripts/gbp-api-poster.mjs` `parseArgs` | default `--date` was the UTC day: a manual run after 19:00 CT targeted tomorrow's row | `chicagoDate()` (America/Chicago via Intl) is the default; the runner always passes `--date` so the automated path was unaffected (this commit) |
| F2 | `scripts/run-weekly-seo.py` `run_new_pipeline` | a refused `--mode new` (exit 2) writes no attempt, so the health error said only `failed (no attempt written)`: the FAILED alert carried no reason | `_refusal_line` lifts the engine's `[weekly] refused: …` line into the health error (`5dcafb5`) |
| F3 | `scripts/gbp-api-poster.mjs`, `scripts/lib/gbp-runner.mjs` | on the still-gated v4 API a 404 would have surfaced as a generic failure and the runner would have flipped rows to `error` | exit 6 `api_gated` → rows stay `scheduled` with the note; worker startup probe (`a568645`) |
| F4 | `scripts/weekly/reconcile.mjs` (C branch) | hard-coded `C:/Users/carte/...` Search Console token path outside any win32 branch | merged onto B1's `resolveSearchConsoleTokenFile({ env })` (`88215cb`) |
| F5 | `scripts/lib/monitor-host.mjs` vs `platform-defaults.mjs` | two independent GBP archive defaults (B1 and B3) could drift | one source of truth (`675d111`) |
| F6 | `src/seo_agents/crew.py` | `OUTPUT_DIR` ignored `SEO_OUTPUT_DIR` while `evidence.py` honoured it (two output folders on AIWA) | same rule + contract test (`6cb4d15`) |
| F7 | `scripts/mav-bridge.mjs` | B8 turned 135 lines LF in a CRLF file (whole-file diff noise) | pure CRLF restored; logical diff is 7 lines (`88215cb`) |

### Open (listed, not changed)

| # | Where | Note | Severity |
|---|---|---|---|
| O1 | `scripts/classify-electrical.mjs` label `date: now().toISOString().slice(0,10)` | label metadata date is the UTC day (Phase A code); cosmetic, not used for scheduling | nit |
| O2 | `scripts/gbp-poster/driver.mjs` composer locator probing (`try { … } catch {}` ×2) | deliberate try-next-strategy fallthrough in the Playwright path (Phase A, legacy); not a silent success | nit |
| O3 | `excelDateToIso` (`gbp-api-poster.mjs`, `gbp-runner.mjs`) | a workbook `Date` cell is read as UTC midnight (`toISOString().slice(0,10)`), the same convention the driver and runner have always used; consistent, but a workbook written with local-time Date objects would shift. Watch on AIWA (TZ=America/Chicago). | nit/watch |
| O4 | `scripts/run-weekly-seo.py` `run_new_pipeline` | after a failed new-mode run the `plan.json` it reads for `topic` now lives under `outputs/shadow/failed-<attempt>/` (V5), so the health `topic` is blank for failed runs; `attempt.json` is still mirrored to `--out` so status/returncode derivation is unchanged | nit |
| O5 | `scripts/gbp-worker.mjs` API mode | the startup `probeV4` makes one network call on boot (API mode only); a transient failure is logged as a warning and never stops the worker | note |
| O6 | Review coverage | the delegated full-diff review did not report back before handoff; the orchestrator's review pass should read `scripts/mav-bridge.mjs` (`--ignore-all-space`), `scripts/seo-monitor.mjs` and `deploy/aiwa/*` in full, which this sweep covered only by grep | process |

### Delegated full-diff review (arrived after the first push; recorded here verbatim in substance)

A second reviewer read every non-test source diff, `deploy/aiwa/*` and the Python files (not the tests or
docs prose). Its findings, with the rc1 disposition:

| # | Severity | Where | Finding | Disposition |
|---|---|---|---|---|
| R1 | blocker | `scripts/gbp-worker.mjs` session probe (startup + 08:00 daily, Playwright mode) | the worker launches Chromium for `driver.mjs --check-session`; a failed probe stops claims and the 09:00 post, releases the pidfile; no env gate | **open, orchestrator decision.** This is Phase A content (`cutover/phase-a-v2-merge`, the G3 session-ownership work), not introduced by rc1's merges. Options: gate behind `GBP_SESSION_PROBE` (default on for win32 to keep today's behaviour) or sign off as intended. |
| R2 | blocker | `scripts/facebook-poster.mjs` (`resolvePhotoPath`, `curatedPhotosForPost`, `buildCaption`) | an explicit `PHOTO_FILE` not in the manifest is now rejected (was warn), the date-prefixed curated "fill" fallback is gone, the retired phone number throws; no gate | **open, orchestrator decision.** Phase A content: the 2026-09-25 photo rule (memory `gbp-check-photos-before-posting`) and the phone retirement are deliberate; confirm or gate (`FB_MANIFEST_STRICT`). |
| R3 | blocker | `src/seo_agents/crew.py` `build_tools` | the legacy SerpApi tool is skipped unless `SEO_LEGACY_SERPAPI=1`; the PC legacy crew silently loses it | **open, orchestrator decision.** Phase A content. If the PC keeps running `SEO_PIPELINE=legacy` before the flip, either default it on for `os.name == 'nt'` / `SEO_PIPELINE=legacy` or add `SEO_LEGACY_SERPAPI=1` to the PC `.env` list in §6b. |
| R4 | should-fix | `scripts/lib/photo-selection.mjs` `loadSelectionManifest` | a corrupt/unreadable manifest returns `[]` silently; the pickers then write a fresh file, wiping the other platform's 8-week history | **open.** Pre-existing behaviour; fix is to treat only ENOENT as empty and abort on a parse error (all three pickers + the API poster would inherit it). Not changed in rc1 to avoid touching the pickers' contract late. |
| R5 | should-fix | manifest platform tags (`'facebook'` in fb-photo-pick vs `'fb'` retag elsewhere, gbp-photo-pick re-saving all buckets into gbp) | FB rows can end up duplicated/mislabelled | **open.** Pre-existing; the rc1 poster appends with `{ platform: 'gbp' }` only and keeps the other buckets. Unify on one tag constant in a follow-up. |
| R6 | should-fix | `seo-monitor.mjs` / `monitor-host.mjs` `netUseEnabled` | `net use` remount is off on win32 unless `SEO_MONITOR_NET_USE=1` (was always on) | **documented gate, not a bug:** CUTOVERPLAN §6b tells Carter to add `SEO_MONITOR_NET_USE=1` to the PC `.env`; listed in RC1-PR-BODY. Consider defaulting on for win32 like `SEO_MONITOR_PM2`. |
| R7 | should-fix | `seo-watchdog.mjs` `evaluatePipelineWatchdog` via seo-monitor `checkPipelineWatch` | in `SEO_PIPELINE=shadow` on the PC, `outputs/reconcile-health.json` does not exist until the first reconcile run → "RECONCILE STALE (never recorded)" alerts | **open (PC noise risk after merge).** Fix: skip the reconcile check when the file is absent in shadow mode, or limit it to `new`. |
| R8 | should-fix | exit 6 `api_gated` | a gated week stays `scheduled` with only a startup log line; no daily alert | **open, by design for now:** the coordinator asked for fail-closed with no error flip while v4 is gated. Add one alert/day when a due row returns `api_gated` before Phase F. |
| R9 | should-fix | `run-weekly-seo.py` `run_new_pipeline` | attempt succeeded/degraded but `projection.json` missing or for another attempt → WARNING, exit 0, health `success` | **fixed in rc1** (this commit): that case is now `failed` (exit 1, health error "attempt … finished but no projection for it — nothing reached weekly_posts"). Test added. |
| R10 | should-fix | `mav-bridge.mjs` + `bridge-bind.mjs` | `MAV_BRIDGE_BIND` can expose :8790 beyond loopback; the `/seo/actions/*` and `/seo/ops/clear-lock` routes have no auth beyond the firewall note | **open, design item for Phase E:** runbook §3a already requires the firewall rule; add a shared-secret header when the bind host is not loopback, or refuse `0.0.0.0`. |
| R11 | should-fix | `src/seo_agents/actions.py` + `paths.resolve_default` | on the PC `GBP_POSTER_SCRIPT` / `GBP_POSTER_CONFIG` resolve to the repo copies whenever present, ahead of the legacy `~/.claude/skills/...` paths; `GBP_POSTER_CONFIG` removed from `.env.example` | **open, verify PC `.env`:** `.env.example` still carries `GBP_POSTER_SCRIPT`; if the PC `.env` pins both, no change. Otherwise prefer `legacy_win` when it exists on win32. |
| R12 | should-fix | `config/weekly-policy.json` `budget_usd` 20→5 | applies to the PC shadow run too | **intended (CUTOVERPLAN §5 V1 row);** `WEEKLY_BUDGET_USD` overrides per host. |
| R13 | should-fix | `ecosystem.config.cjs` gbp-worker `autorestart:false` on the PC | rollback path | **open, confirm:** B6 documents the worker as Task-Scheduler-launched; the PC reversal in runbook §10 uses `pm2 resurrect` from the F1 save. |
| R14 | should-fix | `gbp-api-poster.mjs` `findLivePostForSummary` | two distinct posts sharing a 60-char opener within 7 days → second skipped as `already_live` | **open, spec'd this way (plan §6 G2).** Captions in the weekly plan start with a distinct hook; tightening to the full normalised text would miss Google-side edits. Keep, note for the dry-run eyeball. |
| R15 | should-fix | `scripts/lib/hermes-alert.mjs` `buildHermesInvocation` (win32 `PYTHONPATH`) | PC behaviour change, win32-gated, low risk | noted here. |
| R16-R27 | nit | exit-5 schedule mapping (intended), manifest append failure only logged (**fixed:** now in the emitted result as `manifestAppendError`), `GBP_WORKBOOK_PATH` unset skips the Posted gate (env.required lists it), spin-wait lock / 20-page list cap, `.staging-<id>` left if killed mid-run, website refs by insertion order, driver.mjs Windows literals (Playwright path only), mav-bridge log-line text, stale "no bind-host env" header in `ecosystem.linux.config.cjs`, `FB_COMMENT_AGENT_BIND` missing from `.env.example`, PC-only ops script paths, `curl \| sh` in install.sh, `os.name` vs `sys.platform` mix, phone number not verified against the facts file | listed; none changed in rc1 except the manifest-append one. |

Reviewer "not verified": whether the PC `.env` pins `GBP_POSTER_CONFIG`, `GBP_POSTER_SCRIPT`, `GBP_POSTER`,
`SEO_MONITOR_NET_USE` (R6, R11); whether workbook image paths on the LXC match the manifest after `rekey-state`
(the API poster rejects a workbook path that is not the audited one).

### Checked and clean

- Secrets: none in added lines. The only `xoxb-` strings are test fakes in `scripts/mav-bridge.*test*`; no keys, tokens or `-----BEGIN` blocks.
- Absolute user paths: `C:/Users/carte/gmail-multi` and the hermes venv path appear only inside `platform === 'win32'` / `os.name == 'nt'` branches or in tests asserting those win32 defaults; `.env.example` keeps its documented PC paths as before.
- File-store fallback: `selectStore` refuses `--mode new` without Supabase (exit 2); `createFileStore` appears in added lines only in tests and the offline path. V4 adds a second guard (`StoreRefused` when no client).
- Text-only GBP posts: no path in `gbp-api-poster.mjs` reaches `createLocalPost` without a `mediaRef` (the upload is unconditional after `preparePhoto` ok; tests "text-only is impossible").
- Legacy/shadow behaviour on the PC: every change is behind `GBP_POSTER` (default `playwright`), `SEO_PIPELINE` (default `legacy`), `SEO_MONITOR_NET_USE`/`SEO_MONITOR_PM2` (win32 defaults keep today's behaviour), `MAV_BRIDGE_BIND` (default loopback), `MAV_BRIDGE_GBP`, `HERMES_CLI`, `SEO_OUTPUT_DIR`, `WEBSITE_BRANCH` (code default still `master`), `TZ`, and the `GBP_*`/`SEO_*` path overrides with win32 defaults equal to the old literals. The Playwright exit-code mappings in `gbp-runner.mjs` are unchanged (new branches are keyed on exit 6 / `api_gated` and on `GBP_POSTER=api`).
- `process.exit`: the two authorize scripts now exit only from `server.close` callbacks; the poster's `runPoster` returns codes and `main()` sets `process.exitCode`.
