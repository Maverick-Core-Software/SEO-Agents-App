# SEO Agents App — Phase 5 Implementation Plan

**Status:** Execution-ready. Awaiting owner authorization to begin.

**Prepared:** 2026-07-14

**Repository:** `C:\Workspace\Active\SEO-Agents-App`

**Scope:** Complete Phase 5 (dispatch gate, idempotency wiring, failure classification, observability lifecycle) and prepare for Phase 8 calibration.

---

## 1. What Has Been Done

The previous plan (`COMPLETED_TASKS.md`) covered Phases 0–4, 6, and 7. All are implemented and passing.

### Completed phases

| Phase | Commit(s) | Summary |
|---|---|---|
| **Phase 1** — Run isolation & dry-run safety | `12b16e4`, `a9660c5`, `781a2a7` | Dry-run is offline and non-mutating. `--skip-execute` added. Run context helper (`run_context.py`) provides unique run IDs, isolated paths, and exclusive locking. Writer lineage fixed. Observability atomic-append fix landed. |
| **Phase 2** — Claim extraction & provenance | `d4aae05` | `claims_extract.py` created with source-aware provenance, conservative confidence derivation, contradiction integrity, and extraction diagnostics. Parser tolerates Markdown variation, rejects ambiguous blocks. |
| **Phase 3** — Finalization & gate integration | `f1aa1d2` | `finalize.py` implements one-run finalizer with gate evaluation. `validate --json` distinguishes dry-run, research-only, live with missing extraction, stale/mixed-run, and gate failures. Old empty-write path removed. |
| **Phase 4** — Evidence-bound task translation | `efef54e`, `e984ce8`, `e11e9c0` | Claim references validated against claim graph. Unbound ordinary tasks converted to research gaps. Dependency blocking propagated through action-id namespace. Task graph wired into executor crew — blocked tasks excluded from `queue_context`. (Required 3 correction passes to fix test-vs-production mismatches.) |
| **Phase 6** — Prompt & parser contracts | `7cdf9fe` | Specialist prompts pinned with machine-readable claim blocks. Manager prompt emits `**Contradiction:**` format. Delegation prompt emits `**Supporting Claim IDs**` / `**Gap Reason**`. |
| **Phase 7** — Offline regression coverage | `0b191b1` | 25 regression tests covering dry-run offline, research-only mode, evidence extraction, gate failures, task translation, and end-to-end offline research. |

### Current test baseline

- Python suite: **291 passed**.
- Node helper suite: **6 passed**.

### Existing scaffolding (pre-dates the plan, partially satisfies Phase 5)

These functions exist but are **not wired into the live execution path**:

- `enforce_idempotency()` (`actions.py:1893`) — checks prior run records for matching idempotency key, returns dedupe hit. **Never called from CLI or automatic execution.**
- `classify_review_failure()` (`actions.py:1788`) — maps failure to recovery category. **Never called in live path; operates on stale action dict, not adapter result.**
- `apply_recovery()` (`actions.py:1853`) — applies recovery logic per failure class. **Never called in live path.**
- `live_unverified` status — handled correctly in `run_action()` (never auto-retried, preserved as distinct). **Missing dedicated tests.**
- Observability emit functions (`observability.py`): `emit_research_complete`, `emit_synthesis_gate`, `emit_queue_built`, `emit_approval`, `emit_adapter_run`, `emit_verification`, `emit_session4_metrics`. **None called from main.py, actions.py, or finalize.py.**

### Key file sizes (context budget reference)

| File | Bytes | Lines |
|---|---|---|
| `actions.py` | 87 KB | ~1,948 |
| `main.py` | 50 KB | ~1,139 |
| `crew.py` | 56 KB | — |
| `claims_extract.py` | 39 KB | — |
| `status.py` | 25 KB | — |
| `evidence.py` | 13 KB | — |
| `observability.py` | 13 KB | ~301 |
| `finalize.py` | 11 KB | ~235 |
| `contracts.py` | 9 KB | — |
| `run_context.py` | 9 KB | — |
| Tests (total) | — | ~5,275 |

---

## 2. What Remains — Phase 5

Phase 5 is the only implementation phase remaining before calibration (Phase 8) and production preflight (Phase 9) can begin.

### Hard constraints (carried forward)

- Do not replace CrewAI, the approval workflow, the website adapter, or scheduled GBP-worker ownership.
- Do not publish to GBP, Facebook, or the website during implementation.
- Do not write to Supabase during implementation.
- Never hardcode secrets.
- Preserve existing Markdown report markers and action-queue fields.
- Every implementation session must end at a verified commit boundary with all tests passing.
- Do not enable automatic retries for GBP `live_unverified` results.
- Live side effects must continue to route through the same action dispatcher.

### Required data invariants (carried forward)

- Every invocation has a unique `run_id` passed through all stages.
- Every durable claim has valid provenance, source mode, confidence, and status derived from validation.
- Every executable task has at least one valid claim ID (unless explicitly a research-gap or owner-review task).
- Gate failures are hard failures for live promotion.

---

## 3. Session Breakdown

Phase 5 is split into **4 sessions**, each sized to fit comfortably within a 131K context window. Each session ends at a verified commit boundary with all tests passing.

Sessions must be executed in order — each depends on the prior session's work.

---

### Session A — Dispatch gate + idempotency wiring

**Goal:** Build the dispatch gate function and wire idempotency into the CLI and automatic execution path.

**Context budget:** Reads `actions.py` (87 KB), `main.py` (50 KB), `run_context.py` (9 KB). Writes to `actions.py`, `main.py`, new test file. ~150 KB of source read + test writes. Fits in 131K with targeted reads (no full-file re-reads mid-session).

**Tasks:**

#### A.1 — Create `dispatch_gate()` function

**File:** `src/seo_agents/actions.py`

Create a function `dispatch_gate(action: dict, run_id: str, live: bool, claim_graph: dict, task_graph: dict) -> dict[str, Any]` that checks, at minimum:

- current run ID is present and matches the action's run ID;
- task graph status for this action is not `blocked`, `research_gap`, `waiting_on_owner`, or `waiting_on_tool_access`;
- claim references exist in the claim graph and are not `rejected` or `unknown`;
- no unresolved material contradictions on supporting claims;
- no evidence gate failures on supporting claims;
- dependency readiness (no blocked/unresolved dependencies);
- approval requirements met (if live);
- adapter availability (the action has a configured adapter);
- live/dry-run mode is consistent;
- action idempotency key is present;
- action is not from a stale/mixed run.

Returns a dict with:
- `passed: bool`
- `blocking_reasons: list[str]`
- `gate_id: str` (stable hash for observability)

The gate must run immediately before any live adapter invocation, even if an earlier queue-build gate passed.

#### A.2 — Wire `dispatch_gate()` into `run_action()`

**File:** `src/seo_agents/actions.py`

In `run_action()`, after the approval check and before any adapter invocation, call `dispatch_gate()`. If the gate fails:

- Record the gate failure in the run record.
- Do not invoke any adapter.
- Return a blocked run record with the blocking reasons.

For dry-run mode, the gate may pass with advisory warnings but must still block on hard failures (secrets, stale run, missing run ID).

#### A.3 — Wire `enforce_idempotency()` into the CLI

**File:** `src/seo_agents/main.py`

Replace the direct `run_action()` call at line ~1006 with `enforce_idempotency()`. The CLI path must go through idempotency enforcement, which internally calls `run_action()` if no prior successful run exists.

#### A.4 — Add atomic reservation to idempotency

**File:** `src/seo_agents/actions.py`

Update `enforce_idempotency()` to use an atomic reservation so two concurrent invocations cannot both pass the prior-run check. Use a file-based lock (e.g., write a `.lock` file in `ACTION_RUN_DIR` with the action ID, check before proceeding, clean up on completion/failure).

The stored run record must include:
- action ID;
- idempotency key;
- run ID;
- reservation state (`reserved`, `completed`, `deduplicated`);
- adapter result;
- final status;
- creation and completion timestamps;
- dedupe outcome.

#### A.5 — Route automatic execution through idempotency

**File:** `src/seo_agents/main.py`

In `_run_execute_pipeline()`, ensure any path that triggers live adapter calls goes through `enforce_idempotency()`, not direct `run_action()` calls. (If the automatic executor only produces deliverables and does not directly invoke adapters, document this and ensure the dispatch gate is still consulted before any side effect.)

#### Verification

Create `tests/test_dispatch_gate.py` with tests for:

1. A valid action with all gates passing → `passed: True`.
2. An action with a blocked task graph status → `passed: False`, blocking reason names the status.
3. An action with a rejected claim → `passed: False`.
4. An action with an unresolved contradiction → `passed: False`.
5. An action with a blocked dependency → `passed: False`.
6. An action missing approval in live mode → `passed: False`.
7. An action with no configured adapter → `passed: False`.
8. An action from a stale/mixed run → `passed: False`.
9. A dry-run action with advisory warnings → `passed: True`.
10. An action with a secret-like excerpt → `passed: False`.

Create `tests/test_run_action_cli.py` with tests for:

11. The CLI `run-action` path routes through `enforce_idempotency()`, not `run_action()` directly.
12. Two concurrent calls with the same idempotency key produce one adapter invocation (mock the adapter).
13. A prior successful run with the same idempotency key returns the dedupe result without re-invoking.

**Full-suite verification:** `python -m pytest -q` — all tests pass. Report pass count.

**Commit:** `feat: add dispatch gate and wire idempotency into CLI and automatic execution`

---

### Session B — Failure classification & recovery integration

**Goal:** Wire `classify_review_failure()` and `apply_recovery()` into the live adapter path so they receive the actual adapter result, not a stale action dict.

**Context budget:** Reads `actions.py` (87 KB, targeted sections around `run_action`, `classify_review_failure`, `apply_recovery`). Writes to `actions.py`, new test file. Fits in 131K.

**Depends on:** Session A (dispatch gate must exist, as recovery logic checks gate state).

**Tasks:**

#### B.1 — Pass actual adapter result to failure classification

**File:** `src/seo_agents/actions.py`

In `run_action()`, after the adapter runs and produces a `command_result`, if the result status is `adapter_failed`, `live_unverified`, or any failure class:

1. Build a failure context dict that includes:
   - the action dict (updated with the latest run result);
   - the actual `command_result` / `driver_result`;
   - the dispatch gate result (from Session A);
   - the adapter type and exit code.
2. Call `classify_review_failure()` with this enriched context, not the stale pre-execution action dict.
3. Call `apply_recovery()` with the resulting failure class.
4. Record the failure class, recovery note, and classification basis in the run record.

#### B.2 — Fix `classify_review_failure()` to use adapter result

**File:** `src/seo_agents/actions.py`

Update `classify_review_failure()` to accept the actual adapter result and dispatch gate result as parameters (or accept a richer context dict). The function must map:

- timeout/network failure → `transient_retry`;
- missing access/tool → `evidence_access`;
- contradiction detected → `contradiction_stall`;
- low/unknown confidence → `confidence_gap`;
- secret detection → `quarantine`;
- GBP `live_unverified` → `needs_verification` (never `transient_retry`);
- unknown failure → `unknown`.

The function must not infer a failure class from a stale action status alone.

#### B.3 — Preserve GBP `live_unverified` protection

**File:** `src/seo_agents/actions.py`

Ensure `live_unverified`:
- is never automatically retried;
- is never silently converted to `adapter_failed`;
- requires explicit owner verification before another attempt;
- preserves the original adapter result and evidence in the run record.

Website push failures (`push_failed` → `live_unverified`) may have their own recovery class but must not inherit GBP duplicate-post behavior.

#### B.4 — Record recovery state

**File:** `src/seo_agents/actions.py`

The run record must include:
- failure class (or `none` on success);
- recovery notes;
- recovery action taken (e.g., `quarantined`, `escalation_task_created`, `none`);
- whether automatic retry is permitted (always `false` unless explicitly enabled by a future bounded-retry feature).

#### Verification

Create `tests/test_failure_classification.py` with tests for:

1. Timeout/network failure → `transient_retry` class.
2. Missing access/tool → `evidence_access` class.
3. Contradiction detected → `contradiction_stall` class.
4. Low/unknown confidence → `confidence_gap` class.
5. Secret detection → `quarantine` class.
6. GBP `live_unverified` → `needs_verification` class, no auto-retry.
7. Unknown failure → `unknown` class.
8. Successful adapter run → failure class is `none`, no recovery applied.
9. Recovery notes are recorded in the run record.
10. `live_unverified` is never converted to `adapter_failed`.

**Full-suite verification:** `python -m pytest -q` — all tests pass. Report pass count.

**Commit:** `feat: wire failure classification and recovery into live adapter path`

---

### Session C — Observability lifecycle integration

**Goal:** Wire all observability emit functions into the actual lifecycle boundaries so the complete event sequence is persisted.

**Context budget:** Reads `observability.py` (13 KB), `main.py` (50 KB, targeted sections), `actions.py` (87 KB, targeted sections), `finalize.py` (11 KB). Writes to `main.py`, `actions.py`, `finalize.py`, new test file. Fits in 131K with targeted reads.

**Depends on:** Sessions A and B (need dispatch gate IDs and failure classes for observability events).

**Tasks:**

#### C.1 — Wire emit functions into research completion

**File:** `src/seo_agents/main.py`

After research kickoff completes (agents finish, reports written), call `emit_research_complete(run_id, outputs, duration_s)`.

#### C.2 — Wire emit functions into finalization

**File:** `src/seo_agents/finalize.py`

In `finalize_run()`, after gate evaluation:
- Call `emit_synthesis_gate(run_id, gate_name, passed, duration_s)` for each gate evaluated.
- If `finalize.py` already has a local `_emit_gate_events()`, replace it with calls to the shared `observability.py` emit functions.

#### C.3 — Wire emit functions into queue build

**File:** `src/seo_agents/actions.py`

In `write_action_queue()` / `_write_task_graph_from_actions()`, after the task graph is built, call `emit_queue_built(run_id, total, needs_approval, approved, verified)`.

#### C.4 — Wire emit functions into approval, dispatch, adapter, verification

**File:** `src/seo_agents/actions.py`

- In `approve_action()`: call `emit_approval(run_id, action_id, approved_by)`.
- In `run_action()`, after dispatch gate evaluation: emit a gate event with the gate result.
- In `run_action()`, after adapter execution: call `emit_adapter_run(run_id, adapter, action_id, exit_code, success, duration_s)`.
- In `run_action()`, after verification: call `emit_verification(run_id, action_id, verified, duration_s)`.

#### C.5 — Wire emit functions into failure classification and recovery

**File:** `src/seo_agents/actions.py`

After `classify_review_failure()` and `apply_recovery()` run (Session B), emit an observability event with:
- run ID;
- action/task ID;
- failure class;
- recovery action;
- gate ID (from Session A);
- timestamp;
- producer;
- event type (`failure_classified` / `recovery_applied`);
- schema version.

If `observability.py` does not have an emit function for this, add one: `emit_failure_classification(run_id, action_id, failure_class, recovery_action, gate_id)`.

#### C.6 — Ensure every event includes required fields

**File:** `src/seo_agents/observability.py`

Verify every emit function produces events with:
- run ID;
- task/action ID when applicable;
- gate ID when applicable;
- timestamp;
- producer;
- event type;
- schema version;
- proposed/advisory status where applicable;
- outcome and blocking reason.

Add any missing fields to existing emit functions.

#### Verification

Create `tests/test_observability_persistence.py` with tests for:

1. Research completion emits one event with the correct run ID.
2. Gate evaluation emits one event per gate.
3. Queue build emits one event with counts.
4. Approval emits one event with approver.
5. Adapter run emits one event with exit code and success flag.
6. Verification emits one event.
7. Failure classification emits one event with failure class.
8. Two or more observability events persist in order in the JSONL file.
9. Every event includes run ID, timestamp, producer, event type, and schema version.
10. A full lifecycle (research → finalize → queue → approve → dispatch → adapter → verify) produces the complete event sequence in the JSONL file.

**Full-suite verification:** `python -m pytest -q` — all tests pass. Report pass count.

**Commit:** `feat: persist complete lifecycle observability events`

---

### Session D — Integration verification & Phase 5 closeout

**Goal:** End-to-end integration tests proving all Phase 5 gates work together, plus a full regression pass.

**Context budget:** Reads test files and targeted source sections. Writes one new test file. Fits in 131K.

**Depends on:** Sessions A, B, and C.

**Tasks:**

#### D.1 — End-to-end dispatch + idempotency + recovery integration test

Create `tests/test_phase5_integration.py` with tests for:

1. A valid action passes the dispatch gate, runs through idempotency, executes the adapter (mocked), and produces a run record with all fields.
2. A blocked action is stopped at the dispatch gate, never reaches the adapter, and the run record contains blocking reasons.
3. A failed adapter run triggers failure classification, recovery, and observability events — all with the correct run ID.
4. A second call with the same idempotency key returns the dedupe result without re-invoking the adapter.
5. A `live_unverified` result is classified as `needs_verification`, recovery notes are recorded, and no auto-retry occurs.
6. The complete event sequence (gate → adapter → verification → failure → recovery) is present in the observability JSONL in order.

#### D.2 — Verify Phase 7 integration scenarios 11–14

The plan's Phase 7 requires these integration scenarios that depend on Phase 5:

- Scenario 11: A valid task is dispatched only after approval and all gates pass.
- Scenario 12: The automatic execution path cannot bypass the validated task graph.
- Scenario 13: Two concurrent calls with the same idempotency key produce one adapter invocation.
- Scenario 14: GBP `live_unverified` is never automatically retried.

Add or extend tests to cover these explicitly.

#### D.3 — Full regression pass

Run:
```bash
python -m pytest -q
node --test scripts/lib/*.test.mjs
```

Confirm all tests pass. Report final pass counts.

#### D.4 — Phase 5 completion checklist

Verify all Phase 5 requirements are met:

- [ ] Dispatch gate checks all required conditions before any adapter invocation.
- [ ] All live actions route through `enforce_idempotency()`.
- [ ] Idempotency uses atomic reservation.
- [ ] Run records include all required fields (action ID, idempotency key, run ID, reservation state, adapter result, final status, timestamps, dedupe outcome).
- [ ] GBP `live_unverified` is never auto-retried.
- [ ] Failure classification receives the actual adapter result.
- [ ] Failure classification covers all required mappings.
- [ ] Recovery is recorded first; no automatic retry loop.
- [ ] Observability events are emitted at all lifecycle boundaries.
- [ ] Observability events persist in order without overwriting.
- [ ] Every event includes all required fields.
- [ ] `tests/test_dispatch_gate.py` exists and passes.
- [ ] `tests/test_run_action_cli.py` exists and passes.
- [ ] `tests/test_failure_classification.py` exists and passes.
- [ ] `tests/test_observability_persistence.py` exists and passes.
- [ ] `tests/test_phase5_integration.py` exists and passes.
- [ ] Full Python and Node suites pass.

**Commit:** `test: add Phase 5 integration tests and closeout verification`

---

## 4. After Phase 5

Once Phase 5 is complete, the remaining phases are:

- **Phase 8 — Supervised calibration:** Three `research --skip-execute` runs with different topics. Measure extraction yield, gate pass rates, blocked-task rates, etc. Must hit ≥80% extraction yield bar. No live adapters or Supabase writes.
- **Phase 9 — Production preflight & watched run:** Verify scheduled tasks are armed, working tree is clean, adapters report readiness, calibration passed all hard gates. Then one watched production run with post-run verification.

These phases do not require code changes (unless calibration reveals prompt/parser issues) and are not blocked by context window size.

---

## 5. Stop conditions (carried forward)

Stop immediately and report if:

- a required output path or consumer contract differs from this plan;
- the automatic executor still reads unvalidated raw queue tasks;
- claim references cannot be validated against a current claim graph;
- a test requires live credentials or an external side effect;
- a dry-run mutates files or calls the network;
- two concurrent runs can both reserve the same action;
- observability events are lost or overwritten;
- a GBP result is ambiguous about whether a post was published;
- a requested change would alter GBP ownership, authorization scope, or unrelated services.

---

## 6. Final completion criteria for Phase 5

Phase 5 is complete only when:

- all live adapters route through approval and atomic idempotency enforcement;
- the dispatch gate runs before every adapter invocation;
- GBP unverified outcomes cannot auto-retry;
- failure records contain meaningful classification from the actual adapter result;
- observability persists the complete event sequence at all lifecycle boundaries;
- offline tests and Node tests pass;
- the automatic executor cannot bypass the task graph (verified in integration).
