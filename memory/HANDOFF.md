# SEO Agents App — Handoff State

**Last updated:** 2026-07-14
**Branch:** main
**Latest commit:** `ac40969` (chore: untrack PLAN.md)

## Current State

Evidence-first research-to-execution architecture implemented across 5 plan sessions + 1 corrective session. All sessions executed via local Qwen (qwen3.6-35b-a3b) through Orca pi terminal.

### Commits (this build handoff)
| Commit | Session | Description |
|---|---|---|
| `b64e811` | S1 | Add evidence and run lineage contracts |
| `1a3cb77` | S2 | Add evidence provenance and synthesis gates |
| `1813347` | S3 | Make execution queue evidence-bound and dependency-aware |
| `8d7ccb7` | S4 | Add lifecycle observability and safe recovery controls |
| `f32d415` | S5 | Add research regression corpus and pilot calibration |
| `ac40969` | — | chore: untrack PLAN.md from repo |

### Test suite
- **249 Python tests** pass (`pytest -q`)
- **6 Node tests** pass (`node --test scripts\lib\*.test.mjs`)
- `validate --json` distinguishes dry-run, research-only, live missing extraction, stale/mixed artifacts, gate failure, and malformed artifact

### Key files added/modified
- `src/seo_agents/contracts.py` — Pydantic models; added `research_only` flag to RunManifest
- `src/seo_agents/evidence.py` — serialization, gate validation, atomic JSON writers; prefer explicit `run_id` when writing empty collections
- `src/seo_agents/finalize.py` — new run finalizer: report snapshot, claim extraction, gate evaluation, artifact + diagnostic writers, observability events
- `src/seo_agents/observability.py` — structured JSONL event emitter with proposed metrics
- `src/seo_agents/actions.py` — action queue lineage, idempotency enforcement, failure classification + recovery
- `src/seo_agents/status.py` — gate wiring, task graph writer, new `validate_outputs_json()` with six-case classification
- `src/seo_agents/crew.py` — run ID + route/tool metadata
- `src/seo_agents/main.py` — live research path now finalizes before execution; hard gate failures stop execution
- `prompts/agents/*.txt` — claim fields, source mode, negative findings, contradiction detection
- `tests/` — added `test_finalization.py` (18 tests); existing suites still pass
- `tests/fixtures/research/` — 8 regression fixture JSON files

### Outputs (additive, no Markdown removed)
- `outputs/run_manifest.json` — deterministic run lineage metadata
- `outputs/evidence_package.json` — evidence units collected per run
- `outputs/claim_graph.json` — claims with relations and contradictions
- `outputs/task_graph.json` — tasks with dependencies, priority, idempotency keys
- `outputs/observability.jsonl` — structured lifecycle events
- `outputs/workflow_status.json` — existing status with gate results appended

## Known Issues

1. **`compact_baselines()` calls live LLM before `--dry-run` returns** — pre-existing code path in `main.py:708-714`. Runs `_call_local_llm()` for baseline compaction before the dry-run check. Non-destructive but violates "no live LLM on dry-run" intent. Track for fix.
2. **`test_idempotency.py` was missing from Session 4** — `enforce_idempotency()` and `classify_failure()` exist in `actions.py` but the test file was never written. Corrective session needed.
3. **Session 5 missing watchdog/T10 path** — `monitoring_alert_check` task type and advisory-vs-blocking gate not tested in `test_research_regression.py`.
4. **Thresholds are proposed defaults** — `priority-v1` formula thresholds (P0>=0.80, P1>=0.60, P2>=0.40, P3<0.40) are engineering defaults, not calibrated from observed data. 3 dry-run cycles needed for calibration.
5. **PLAN.md is untracked** — build-handoff plan file should stay out of git. Archived separately.

## Next Steps

- Collect calibration data from 3 representative dry-run cycles
- Tune priority thresholds from observed data (versioned change note required)
- Fix `compact_baselines()` live LLM call on dry-run path
- Add `test_idempotency.py` and watchdog tests
- Run full pipeline end-to-end with live LLM to validate evidence collection and gate behavior