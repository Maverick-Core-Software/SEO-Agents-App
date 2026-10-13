# PR body draft: `cutover/rc1` → `main`

Title: **cutover rc1: v2 live switch, Linux portability, AIWA deploy, GBP API path (Phase A–D)**

## Summary

Release candidate for the SEO-Agents-App cutover (plan: `docs/cutover/CUTOVERPLAN.md`, audit:
`docs/cutover/2026-10-13-SCOPING-AUDIT.md`). It merges the six Phase B/C branches on top of
`cutover/phase-a-v2-merge` (`c4233e7`), reconciles their seams, and adds Phase D (GBP API) plus the
Phase C findings V4/V5. Every change to PC behaviour sits behind an env gate; with the current PC
`.env` plus the additions listed below the legacy/shadow Friday run and the Playwright GBP path are unchanged.

Nothing in this PR is deployed by merging it: AIWA provisioning (Phase E) and the flip (Phase F) are
separate, Carter-approved steps in `docs/cutover/RUNBOOK-AIWA.md`.

Integration notes, conflict resolutions, seams and the review findings: `docs/cutover/RC1-NOTES.md`.

## Build items

| Item | What landed |
|---|---|
| B1 + G4 | Machine paths via env with platform defaults (`scripts/lib/platform-defaults.mjs`); one `GBP_POSTER` default (`playwright`) in `scripts/lib/gbp-mode.mjs` read by mav-bridge and gbp-worker |
| B2 + B3 | Linux-safe alert transport (`HERMES_CLI`, Slack env), seo-monitor without pm2/`net use` unless `SEO_MONITOR_PM2` / `SEO_MONITOR_NET_USE=1` (`scripts/lib/monitor-host.mjs`) |
| B4 + B5 | `deploy/aiwa/*` (units, install, render-env, verify-units), `docs/cutover/RUNBOOK-AIWA.md`, `scripts/ops/rekey-state.mjs` |
| B6 + B7 | realpath entry guard (`scripts/lib/entry.mjs`), loopback binds for fb-comment-agent/thumbtack, Linux-portable crew defaults (`src/seo_agents/paths.py`, `SEO_OUTPUT_DIR` in crew + evidence, `WEBSITE_BRANCH`), venv-aware wrapper |
| B8 | `MAV_BRIDGE_BIND` listen address for mav-bridge (`scripts/lib/bridge-bind.mjs`) |
| C (V1–V3) | `--mode new` in `scripts/weekly/run.mjs` / `lib/stage.mjs` / `run-weekly-seo.py` (new replaces the crews; Supabase store required, exit 2 otherwise; exports to `outputs/`; projection into `weekly_posts`/`website_tasks`), notify receipt on the attempt (V2), `reconcile-health.json` on success and failure (V3), `budget_usd` 20→5 |
| V4 | Rerun guard: `--mode new` exits 2 when `seo_runs(week_of)` is approved/executing/done or any `weekly_posts` row is past `pending_approval`; an existing pending week needs `--force-replan`, which only replaces pending rows |
| V5 | Export-after-project: new-mode schedules are staged and promoted into `outputs/` only after `projectPlan` succeeds; a failed attempt keeps its artifacts under `outputs/shadow/failed-<attempt>/` and leaves nothing in `outputs/` |
| G1 | API mode: Day 1 posts, Days 2-7 are `scheduled` with no `--schedule` spawn; the ≥09:00 CT daily tick (`dailyTickDue`) posts each once; every API-created post closes the workbook `Posted` gate |
| G2 | Idempotent create: list `v4/{location}/localPosts` before create; same 60-char summary prefix within 7 days → `already_live` (exit 0, resource name as `platform_post_id`); REJECTED match → exit 5 |
| G3 | Photo rule at post time: image only via the audited selection manifest, sha256 of the final bytes, 8-week cross-platform no-reuse, `checkImagePolicy` (JPG/PNG ≥10 KB), HEIC→JPEG via `heic-convert`, optional `GBP_PHOTO_VISION_CHECK=1`; text-only posting is impossible; `--dry-run` prints `{date,image_path,image_sha256,image_exists,manifest_ok}` |
| D extra | `authorize-gbp.mjs` / `authorize-search-console.mjs` exit after `server.close` (libuv teardown crash); gated v4 (404) → poster exit 6 `api_gated`, rows stay `scheduled`, worker logs it at startup |

## Gates (worktree `_wt/SEO-rc1` on the PC, after JOB 2)

| Gate | Command | Result |
|---|---|---|
| node | `node --test "scripts/**/*.test.mjs"` | tests 977, pass 976, fail 1 — the junction artifact only (`scripts/weekly/test/e2e-offline.test.mjs` "resolves the module to the real repo path through the alias" fails in every git worktree because `C:\Workspace` resolves to the main checkout; passes from the main checkout) |
| lint | `npm run lint` | exit 0 |
| pytest | `uv run --with pytest pytest -q` | 403 passed, 1 failed — `tests/test_research_regression.py::TestDryRunCalibration::test_dry_run_no_live_adapter` (known, pre-existing) |
| units | `bash deploy/aiwa/verify-units.sh` | PASS |

Baseline before the merges (`cutover/phase-a-v2-merge`): node 901 tests; this branch adds 76.

## PC `.env` additions before this runs on the PC (CUTOVERPLAN §6b; names only, Carter edits `.env`)

- `SEO_MONITOR_NET_USE=1` — B3 gates the `net use M:` remount behind it (default off).
- `MAV_BRIDGE_GBP=off` — explicit.
- `TZ=America/Chicago` — harmless on the PC, mandatory on AIWA.
- `WEBSITE_BRANCH=main` — `website.py` defaults to `master`; the live site serves `main` (both hosts).
- Optional on the PC: `HERMES_CLI` (win32 default unchanged), `GBP_WORKBOOK_DIR` (AIWA-only; the PC config still carries the Windows dir).
- Unchanged and still required: `GBP_POSTER=playwright`, `SEO_PIPELINE=legacy|shadow` until Phase F.

## Not in this PR / follow-ups

- G0 access proof: the probe on 2026-10-13 shows account management v1 = 200 and legacy v4 = 404 for
  project `exalted-slice-502415-s0`; the API path fails closed (exit 6, rows stay `scheduled`) until that clears.
- Phase E (AIWA provision, shadow Friday) and Phase F (flip) per the runbook; each live step needs Carter's yes.
- Review findings left open are listed in `docs/cutover/RC1-NOTES.md` section "Review findings".

## Rollback

Rollback ref on `main`: `6f748c0`. Tag after merge: `seo-aiwa-rc1`. PC reversal steps: `docs/cutover/RUNBOOK-AIWA.md` section 10.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
