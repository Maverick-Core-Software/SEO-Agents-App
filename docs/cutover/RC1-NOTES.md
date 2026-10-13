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
