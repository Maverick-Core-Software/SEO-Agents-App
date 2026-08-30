# Workstream: tests (status: ?)

I have complete evidence. Compiling the report.

## Findings

### A. Test inventory — `C:\Workspace\Active\SEO-Agents-App\tests\` (21 files, pytest)

| Test file | Production module | Behavior protected |
|---|---|---|
| `test_idempotency.py` | `actions.py` | `enforce_idempotency` (live dedupe, first-run pass, dry-run skip), `classify_review_failure` timeout→transient_retry, `apply_recovery` retries, stable-hash fallback |
| `test_action_queue_lineage.py` | `actions.py` | Field preservation/additive lineage, contradiction blocking of queue promotion, priority formula version, idempotency-key determinism |
| `test_task_translation.py` | `actions.py`, `crew.py` | Priority/confidence/approval-class formulas, dependency cycles, task object contract, blocked-by-contradiction, research-gap creation, executor filter excludes blocked tasks |
| `test_claims_reference_validation.py` | `actions.py` | Full referential integrity of claim refs (not prefix), unknown/wrong-run/rejected claims block promotion, dependency validation, schedule-action policy, cycle detection |
| `test_dispatch_gate.py` | `actions.py` | 10 gate cases (valid/blocked/rejected/contradiction/dep/no-approval/no-adapter/stale/dry-run/secret) + dry-run hard failures |
| `test_failure_classification.py` | `actions.py` | All 7 failure classes → recovery mapping, `run_action` wiring records class + recovery notes, live_unverified not auto-converted |
| `test_run_action_cli.py` | `main.py`, `actions.py` | CLI `run-action` routes through idempotency; atomic reservation (concurrent → one invocation); prior success → dedupe |
| `test_phase5_integration.py` | full engine | End-to-end lifecycle: approval→dispatch→idempotency→run record; blocked stops at gate; failed adapter → classification+ordered events; concurrent dedupe; task-graph blocks execution bypass; ordered event sequence |
| `test_finalization.py` | `finalize.py`, `status.py` | Finalizer populates artifacts, archives snapshots, extraction diagnostics; zero-claims gates (live/research-only/justified/dry-run); failed package not replaced; execution gated on validation; `validate_outputs_json` 8 cases |
| `test_evidence_contracts.py` | `evidence.py` | Source modes (live/baseline/unavailable/negative), stale evidence, contradiction gate, high-conf-weak-source, missing provenance, claim status derives from evidence |
| `test_synthesis_gates.py` | `evidence.py`, `status.py` | Evidence-package + claim-graph gates, research-gap classification |
| `test_claims_extract.py` | `claims_extract.py` | Timestamp parsing, all source modes, malformed blocks, duplicate IDs, contradictions, secrets quarantine, graph validation, JSON round-trip (18 test classes) |
| `test_live_evidence_wiring.py` | `claims_extract`, `evidence` | Phase-7 integration: valid reports→evidence+claims, missing claim block→diagnostic, unknown claim→research gap, ordered events |
| `test_observability.py` / `test_observability_persistence.py` | `observability.py` | Event schema, boundary emitters, metric helpers, per-phase one-event invariants, ordered persistence, full lifecycle sequence |
| `test_run_isolation.py` | `run_context.py`, `main.py` | Dry-run touches no crew/supabase/baselines; skip-execute; unique run IDs; concurrent run lock rejected; release; writer lineage (run_id preserved); observability no-overwrite |
| `test_dry_run_offline.py` | `main.py` | No LLM calls, skips compact_baselines/supabase, artifacts marked dry_run |
| `test_llm_failover.py` | `crew.py` | Provider outage → fallback (408/429/5xx), request-shaped errors don't fail over, unconfigured fallback = unchanged, `_is_provider_down` |
| `test_research_regression.py` | evidence/observability/contracts | Worker-3 acceptance A1–A11 (provenance, confidence, negative findings, contradictions, promotion requires evidence, secrets quarantine), gate metrics, dry-run calibration, T10 watchdog |
| `test_website_adapter_status.py` | `website.py` | Missing section_id doesn't raise; well-formed index reports live-ready |

Fixtures: `tests/fixtures/research/*.json` (8 files) consumed by `test_research_regression.py:_load_fixture`.

### B. Test inventory — `scripts/*.test.mjs` (16 files, assert-based self-checks)

| Test file | Protects |
|---|---|
| `lib/gbp-runner.test.mjs` | Excel date conversion, driver JSON parse, exit-code→status mapping (0/1/3/4/crash 3221226505), verify disposition, `runDailyGbp` posted + scheduled_native flip (no driver run), Day-1 approval stamped **before** driver (regression run 2c5fc296), Days 2–7 `--schedule` |
| `lib/website-task-runner.test.mjs` | Priority sort, claim→execute→done, non-pushed→error mapping, subprocess throw never stuck in executing, ❌ stdout surfaced, lost claim doesn't execute, orphan sweep gated on settled runs |
| `lib/gbp-paths.test.mjs` | Curated-folder fallback (E: → cache), photo resolution by name/date-fallback/abs path |
| `lib/photo-selection.test.mjs` | Service-term derivation, manifest must be audited + same-service |
| `lib/schedule-text.test.mjs` | Photo filename normalization (backticks/bold/blank sentinels/annotations/VIDEO_PROMPT leak) |
| `lib/parse-website-tasks.test.mjs` | 8/14 garbage EXCERPT title repro, executable gate (blocks waiting_on_owner/pending_approval/garbage) |
| `lib/comment-name-guard.test.mjs` | Never invents customer names; 2026-08-28 panel-upgrade reply regression; mid-sentence proper nouns preserved |
| `lib/seo-run-status.test.mjs` | `liveRunStatus` mapping: frozen-rejected≠executing, skipped/missed=scheduled_native counted finished, in-flight=partial, errors=blocked |
| `lib/action-enrich.test.mjs` | Status bucketing, stuck thresholds per type, agent mapping, media downgrade mapping |
| `lib/alert-store.test.mjs` | Fire-once alerting, persistence across restarts, cold-start baseline adoption |
| `lib/run-phase.test.mjs` | Subprocess wrapper: exit codes, stdout capture, hopError logging |
| `lib/facebook-insights.test.mjs` | Post metric summarization, ranking, small-sample low-confidence |
| `lib/fb-boost-marketing.test.mjs` | Minor units, act_ prefix, targeting, boost plan, config readiness |
| `fb-boost-ledger.test.mjs` | Week detection from schedule file (spawns real process) |
| `sync-gbp-schedule.test.mjs` | MD→workbook sync, phone-number exclusion from GBP caption, approval stamping, backup creation |
| `lib/curated-photo.test.mjs` | Curated-by-date fallback rule (video-day) |

Plus `facebook-poster.selfcheck.mjs` (not matching `*.test.mjs` glob): token-expiry classification, caption building, FB schedule parsing.

### C. Facts about test infrastructure

1. `package.json` has **no `test` script** (only `lint`). No `.github/workflows`. mjs checks run manually via `node --test scripts/lib/*.test.mjs` (referenced in `COMPLETED_TASKS.md:179`).
2. `pyproject.toml` has no `[tool.pytest.ini_options]`.
3. Mixed mjs conventions: some files use `node:test` (`describe/it/test`), others bare asserts + `console.log('ok …')` — the latter report as one file-level pass under `node --test`.
4. **`tests/conftest.py` `fix_output_dir` fixture is a no-op**: docstring claims it "patches the constant so writers write to the test output directory," but the body assigns `test_output = real_output` and patches nothing (`tests/conftest.py:12-34`). Protection relies entirely on per-test `tmp_path`/monkeypatching.
5. `test_research_regression.py:303-380` (T10 watchdog tests) only construct `ExecutionTask` objects and assert the fields just set — they exercise no watchdog production code (the actual watchdogs are `seo-monitor.mjs`/`seo-watchdog.mjs`, untested JS).
6. Stray directory `CWorkspaceActiveSEO-Agents-Apptestsfixturesresearchartifacts/` at repo root — path-join bug artifact, repo noise.

## Analysis

### Coverage matrix: behavior → test → status

| Production behavior | Test | Status |
|---|---|---|
| **Engine: idempotency/dedupe** | test_idempotency, test_run_action_cli, test_phase5_integration | **Covered** |
| **Engine: evidence/claims/contradictions/secrets** | test_claims_extract, test_evidence_contracts, test_live_evidence_wiring, fixtures | **Covered** |
| **Engine: dispatch gates/approval gating** | test_dispatch_gate | **Covered** |
| **Engine: failure classification/recovery** | test_failure_classification | **Covered** |
| **Engine: dry-run isolation/no-LLM** | test_dry_run_offline, test_run_isolation | **Covered** |
| **Engine: run lock/concurrency** | test_run_isolation | **Covered** |
| **Engine: LLM provider failover** | test_llm_failover | **Covered** |
| **Engine: finalization/zero-claims gates** | test_finalization | **Covered** |
| **Engine: observability ordering** | test_observability*, test_phase5_integration | **Covered** |
| **GBP: daily poster orchestration + exit codes** | gbp-runner.test.mjs | **Covered** |
| **GBP: Day-1 approval ordering (incident 2c5fc296)** | gbp-runner.test.mjs | **Covered** |
| **GBP: schedule MD→workbook + approval stamps** | sync-gbp-schedule.test.mjs | **Covered** |
| **GBP: photo resolution/fallback** | gbp-paths.test.mjs | **Covered** |
| **Website: task claim/execute/sweep/error mapping** | website-task-runner.test.mjs | **Covered** |
| **Website: task parsing (8/14 garbage repro)** | parse-website-tasks.test.mjs | **Covered** |
| **FB: media selection + curated fallback** | photo-selection, curated-photo, schedule-text tests | **Covered** |
| **FB: caption build/schedule parse/token expiry** | facebook-poster.selfcheck.mjs | Partially (outside test glob) |
| **FB: comment name guard** | comment-name-guard.test.mjs | **Covered** |
| **FB: boost budget/ledger** | fb-boost-marketing, fb-boost-ledger tests | **Covered** (lib only; `fb-boost-api.mjs` untested) |
| **Dashboard: run status mapping** | seo-run-status.test.mjs | **Covered** |
| **Friday wrapper `run-weekly-seo.py` (health.json, phase failures)** | none | **UNTESTED** |
| **`seo-monitor.mjs` (no-show alarm, cold-boot pm2 resurrect, env exit-1)** | none | **UNTESTED** |
| **`seo-watchdog.mjs` (daily dead-man check)** | none | **UNTESTED** |
| **`supabase-sync.mjs` (`getWeekOf` TZ bug, `week_of` upsert dedupe)** | none | **UNTESTED** (bug documented in HANDOFF, still open) |
| **`mav-bridge.mjs` approval execution** | none | **UNTESTED** |
| **`gbp-worker.mjs` top-level poller** | none (lib only) | **UNTESTED** |
| **`approve-run.mjs`, `authorize-gbp.mjs`** | none | **UNTESTED** |
| **Video generation (`gemini/xai-video-generator`, `video-postprocess`, `slideshow-reel`)** | none | **UNTESTED** |
| **Alert transports (`lib/hermes-alert.mjs`, SMTP `sendAlert`)** | none | **UNTESTED** |
| **`setup-scheduled-tasks.ps1` / `setup-pm2-boot.ps1`** | none | **UNTESTED** (ops scripts, low value to unit test) |

### Untested failure transitions (from FRIDAY-RUNBOOK.md + HANDOFF)

| Failure transition (source) | Test status |
|---|---|
| Scheduler never fired → no-show alarm (Runbook triage A; HANDOFF #5) | **UNTESTED** — `seo-monitor.mjs:487-515` `checkRunStarted` and all of `seo-watchdog.mjs` have zero tests. This is the mitigation for the 2026-07-24 silent miss; a regression silently reintroduces the incident. **Severity: High** |
| Monitor env vars missing → `process.exit(1)` silent (HANDOFF #6, `seo-monitor.mjs:62-65`) | **UNTESTED** |
| PM2 empty after reboot → cold-boot `pm2 resurrect` (Runbook; HANDOFF H4) | **UNTESTED** |
| Research crew failed → `run_health.json` research=failed (Runbook triage C) | **UNTESTED** — `run-weekly-seo.py` phase wrapper has no tests; engine-side failure classification *is* tested |
| `getWeekOf()` local-time→UTC off-by-one (HANDOFF "SEPARATE BUG", `supabase-sync.mjs:43`) | **UNTESTED** — bug known since 2026-07-31, no regression test, affects `onConflict: 'week_of'` dedupe (`supabase-sync.mjs:285`) |
| GBP poster starvation: empty queue ≡ dead poller (HANDOFF #2) | Partially — run-status *mapping* tested (`seo-run-status.test.mjs`); the poller's "nothing to do" logging path untested |
| Alert channel failure (hermes.exe path missing on new host, HANDOFF H4) | **UNTESTED** |
| Engine failure classes (timeout/access/contradiction/confidence/quarantine) | **Covered** (test_failure_classification) |
| LLM provider outage | **Covered** (test_llm_failover) |
| scheduled_native flip, Day-1 approval gate, garbage titles, name guard | **Covered** (regression tests exist per incident) |

### Severity-ranked gaps

1. **High** — No-show/watchdog/alerting path (the exact 2026-07-24 incident chain) has zero automated coverage across `seo-monitor.mjs`, `seo-watchdog.mjs`, `lib/hermes-alert.mjs`.
2. **High** — `supabase-sync.mjs` entirely untested; contains a documented live bug affecting upsert dedupe.
3. **High** — `run-weekly-seo.py` (the Friday entry point writing both health markers) untested.
4. **Medium** — `tests/conftest.py:12-34` no-op fixture contradicts its docstring; any test missing explicit output-path patching writes to real `outputs/`. Currently tests self-patch, but the safety net is illusory.
5. **Medium** — No test wiring: no `npm test`, no CI, no pytest config; mjs checks and pytest must be invoked manually, so regressions surface only in production (Friday).
6. **Medium** — T10 watchdog tests (`test_research_regression.py:303-380`) are tautological; they provide apparent-but-not-real watchdog coverage.
7. **Low** — Mixed mjs test conventions; selfcheck file outside test glob; video pipeline and one-off ops scripts untested (acceptable).