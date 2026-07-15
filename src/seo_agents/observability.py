"""Structured lifecycle observability events for Session 4.

Emits JSONL-formatted events from research, synthesis, queue, approval,
adapter, and verification boundaries. Every event carries run_id, task_id
(when applicable), gate_id, timestamp, producer, and metric fields.

Initial metrics (explicitly marked ``proposed``):
- claim_validity_rate
- contradiction_density
- evidence_to_task_binding_rate
- gate_pass_rates (Claim, Decomposition, Sequencing)
- dependency_cycle_rate
- review_escalation_rate
- retry_rate_by_failure_class
- p50_p95_latency_and_cost_by_task_type
- adapter_dedupe_idempotency_outcomes
- research_gap_closure_rate
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from seo_agents.evidence import OUTPUT_DIR, now_iso

# ---------------------------------------------------------------------------
# Event schema
# ---------------------------------------------------------------------------
# Every emitted event is a dict with these keys:
#   run_id       — shared lineage for the run (str)
#   task_id      — when applicable, else empty string (str)
#   gate_id      — optional gate identifier (str, nullable)
#   timestamp    — ISO-8601 UTC (str)
#   producer     — component that emitted the event (str)
#   event_type   — high-level category (str)
#   fields       — free-form metric / status dict (dict)
#   version      — schema version (str)

OBS_EVENT_VERSION = "session4-v1"


def _make_event(
    producer: str,
    event_type: str,
    run_id: str = "",
    task_id: str = "",
    gate_id: str = "",
    fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a structured observability event dict."""
    event: dict[str, Any] = {
        "run_id": run_id or "unknown",
        "task_id": task_id or "",
        "gate_id": gate_id or "",
        "timestamp": now_iso(),
        "producer": producer,
        "event_type": event_type,
        "schema_version": OBS_EVENT_VERSION,
        "version": OBS_EVENT_VERSION,
        "fields": fields or {},
    }
    return event


def write_observability_event(event: dict[str, Any]) -> None:
    """Append one structured event to the JSONL observability log."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    event["run_id"] = event.get("run_id", "unknown")
    if "timestamp" not in event or not event["timestamp"]:
        event["timestamp"] = now_iso()
    if "schema_version" not in event:
        event["schema_version"] = OBS_EVENT_VERSION
    if "version" not in event:
        event["version"] = event["schema_version"]

    target = OUTPUT_DIR / "observability.jsonl"
    tmp = OUTPUT_DIR / f"observability.jsonl.tmp-{uuid.uuid4().hex[:8]}"
    existing = ""
    if target.exists():
        existing = target.read_text(encoding="utf-8")
    content = existing.rstrip("\n")
    if content:
        content += "\n"
    content += json.dumps(event) + "\n"
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(target)


# ---------------------------------------------------------------------------
# Boundary emitters — one per session boundary
# ---------------------------------------------------------------------------

def emit_research_complete(run_id: str, outputs: list[str], duration_s: float) -> None:
    """Research crew boundary — emitted after the research phase completes."""
    write_observability_event(_make_event(
        producer="research_crew",
        event_type="research_complete",
        run_id=run_id,
        task_id=run_id,
        fields={
            "dry_run": True,
            "outputs": outputs,
            "duration_s": round(duration_s, 2),
            "outcome": "complete",
            "blocking_reason": "",
            "proposed": True,
            "_metric": "research_duration_s",
            "_proposed": True,
        },
    ))


def emit_synthesis_gate(
    run_id: str,
    gate_name: str,
    passed: bool,
    duration_s: float,
    blocking_reason: str = "",
    advisory: bool = False,
) -> None:
    """Synthesis boundary — emitted after each synthesis/validation gate."""
    write_observability_event(_make_event(
        producer="synthesis_gate",
        event_type="gate_result",
        run_id=run_id,
        task_id="",
        gate_id=gate_name,
        fields={
            "gate_name": gate_name,
            "passed": passed,
            "duration_s": round(duration_s, 2),
            "outcome": "passed" if passed else "blocked",
            "blocking_reason": blocking_reason,
            "advisory": advisory,
            "proposed": False,
            "_proposed": True,
        },
    ))


def emit_queue_built(run_id: str, total: int, needs_approval: int, approved: int, verified: int) -> None:
    """Queue boundary — emitted after the action queue is built."""
    write_observability_event(_make_event(
        producer="action_queue",
        event_type="queue_built",
        run_id=run_id,
        task_id="",
        fields={
            "total_actions": total,
            "needs_approval": needs_approval,
            "approved": approved,
            "verified": verified,
            "outcome": "built",
            "blocking_reason": "",
            "proposed": True,
            "_proposed": True,
        },
    ))


def emit_approval(run_id: str, action_id: str, approved_by: str) -> None:
    """Approval boundary — emitted when an action is approved."""
    write_observability_event(_make_event(
        producer="approval_gate",
        event_type="approval_granted",
        run_id=run_id,
        task_id=action_id,
        fields={
            "action_id": action_id,
            "approved_by": approved_by,
            "outcome": "approved",
            "blocking_reason": "",
            "proposed": True,
            "_proposed": True,
        },
    ))


def emit_adapter_run(run_id: str, adapter: str, action_id: str, exit_code: int, success: bool, duration_s: float) -> None:
    """Adapter boundary — emitted after an adapter subprocess runs."""
    write_observability_event(_make_event(
        producer=f"adapter_{adapter}",
        event_type="adapter_result",
        run_id=run_id,
        task_id=action_id,
        fields={
            "adapter": adapter,
            "exit_code": exit_code,
            "success": success,
            "duration_s": round(duration_s, 2),
            "outcome": "success" if success else "failed",
            "blocking_reason": "" if success else f"exit_code_{exit_code}",
            "proposed": True,
            "_proposed": True,
        },
    ))


def emit_verification(run_id: str, action_id: str, verified: bool, duration_s: float) -> None:
    """Verification boundary — emitted after adapter verification."""
    write_observability_event(_make_event(
        producer="verification",
        event_type="verification_complete",
        run_id=run_id,
        task_id=action_id,
        fields={
            "action_id": action_id,
            "verified": verified,
            "duration_s": round(duration_s, 2),
            "outcome": "verified" if verified else "unverified",
            "blocking_reason": "" if verified else "verification_failed",
            "proposed": True,
            "_proposed": True,
        },
    ))


def emit_dispatch_gate(
    run_id: str,
    action_id: str,
    gate_id: str,
    passed: bool,
    blocking_reasons: list[str],
    duration_s: float,
) -> None:
    """Dispatch boundary — emitted immediately before adapter execution decisions."""
    blocking_reason = "; ".join(blocking_reasons)
    write_observability_event(_make_event(
        producer="dispatch_gate",
        event_type="gate_result",
        run_id=run_id,
        task_id=action_id,
        gate_id=gate_id,
        fields={
            "action_id": action_id,
            "passed": passed,
            "blocking_reasons": blocking_reasons,
            "duration_s": round(duration_s, 2),
            "outcome": "passed" if passed else "blocked",
            "blocking_reason": blocking_reason,
            "advisory": False,
            "proposed": False,
            "_proposed": False,
        },
    ))


def emit_failure_classification(
    run_id: str,
    action_id: str,
    failure_class: str,
    recovery_action: str,
    gate_id: str,
    event_type: str = "failure_classified",
) -> None:
    """Failure/recovery boundary — emitted after classification and recovery."""
    write_observability_event(_make_event(
        producer="failure_recovery",
        event_type=event_type,
        run_id=run_id,
        task_id=action_id,
        gate_id=gate_id,
        fields={
            "action_id": action_id,
            "failure_class": failure_class,
            "recovery_action": recovery_action,
            "outcome": recovery_action if event_type == "recovery_applied" else failure_class,
            "blocking_reason": failure_class if failure_class not in {"", "none", "unknown"} else "",
            "event_type": event_type,
            "proposed": False,
            "_proposed": False,
        },
    ))


def emit_finalization_complete(
    run_id: str,
    hard_fail: bool,
    extraction_empty: bool,
    extraction_justified: bool,
    failure_count: int,
    warning_count: int,
    duration_s: float,
) -> None:
    """Finalization boundary — emitted after gate evaluation completes."""
    write_observability_event(_make_event(
        producer="run_finalizer",
        event_type="finalization_complete",
        run_id=run_id,
        fields={
            "hard_fail": hard_fail,
            "extraction_empty": extraction_empty,
            "extraction_justified": extraction_justified,
            "failure_count": failure_count,
            "warning_count": warning_count,
            "duration_s": round(duration_s, 2),
            "outcome": "blocked" if hard_fail else "complete",
            "blocking_reason": "hard_fail" if hard_fail else "",
            "proposed": False,
            "_proposed": False,
        },
    ))


# ---------------------------------------------------------------------------
# Metric helpers — compute metrics from observability log or passed data
# ---------------------------------------------------------------------------

def compute_claim_validity_rate(evidence_list: list[dict[str, Any]]) -> float:
    """Compute claim validity rate: fraction of evidence units with status=confirmed."""
    if not evidence_list:
        return 0.0
    confirmed = sum(1 for e in evidence_list if e.get("status") == "confirmed")
    return round(confirmed / len(evidence_list), 4)


def compute_contradiction_density(evidence_list: list[dict[str, Any]]) -> float:
    """Compute contradiction density: fraction of evidence units with unresolved contradictions."""
    if not evidence_list:
        return 0.0
    contradictory = sum(1 for e in evidence_list if e.get("contradiction_ids") and e.get("status") != "confirmed")
    return round(contradictory / len(evidence_list), 4)


def compute_evidence_to_task_binding_rate(task_list: list[dict[str, Any]]) -> float:
    """Compute evidence-to-task binding rate: fraction of tasks with at least one supporting claim."""
    if not task_list:
        return 0.0
    bound = sum(1 for t in task_list if t.get("supporting_claim_ids"))
    return round(bound / len(task_list), 4)


def compute_gate_pass_rates(gate_results: list[dict[str, Any]]) -> dict[str, float]:
    """Compute pass rates for each gate type (Claim, Decomposition, Sequencing)."""
    rates: dict[str, dict[str, Any]] = {}
    for gate in gate_results:
        gate_name = gate.get("gate", "unknown")
        if gate_name not in rates:
            rates[gate_name] = {"total": 0, "passed": 0}
        rates[gate_name]["total"] += 1
        if gate.get("passed", True):
            rates[gate_name]["passed"] += 1
    return {
        k: round(v["passed"] / v["total"], 4) if v["total"] > 0 else 0.0
        for k, v in rates.items()
    }


def compute_dependency_cycle_rate(task_list: list[dict[str, Any]]) -> float:
    """Compute dependency-cycle rate: fraction of tasks involved in dependency cycles."""
    if not task_list:
        return 0.0
    # In practice cycles are detected and removed; this counts cycle-blocked tasks
    cycle_blocked = sum(1 for t in task_list if t.get("status") == "blocked" and t.get("task_type") != "research_gap")
    return round(cycle_blocked / len(task_list), 4)


def compute_review_escalation_rate(action_list: list[dict[str, Any]]) -> float:
    """Compute review escalation rate: fraction of actions needing escalation."""
    if not action_list:
        return 0.0
    escalated = sum(1 for a in action_list if a.get("status") in {"needs_review", "blocked_access", "blocked"})
    return round(escalated / len(action_list), 4)


def compute_retry_rate_by_failure_class(action_list: list[dict[str, Any]]) -> dict[str, int]:
    """Compute retry counts grouped by failure class."""
    classes: dict[str, int] = {"adapter_failed": 0, "timeout": 0, "approval_blocked": 0}
    for a in action_list:
        if a.get("status") == "failed" or a.get("last_run", {}).get("status") == "adapter_failed":
            classes["adapter_failed"] += 1
        elif a.get("status") == "blocked_approval":
            classes["approval_blocked"] += 1
    return classes


def compute_latency_p50_p95(durations: list[float]) -> dict[str, float]:
    """Compute p50 and p95 latency from a list of durations (seconds)."""
    if not durations:
        return {"p50": 0.0, "p95": 0.0}
    sorted_d = sorted(durations)
    n = len(sorted_d)
    p50_idx = int(0.5 * n)
    p95_idx = int(0.95 * n)
    return {"p50": round(sorted_d[max(0, p50_idx - 1)], 2), "p95": round(sorted_d[min(n - 1, p95_idx)], 2)}


def compute_adapter_dedupe_outcomes(action_list: list[dict[str, Any]]) -> dict[str, int]:
    """Compute adapter dedupe/idempotency outcomes: how many actions share the same idempotency key."""
    key_counts: dict[str, list[str]] = {}
    for a in action_list:
        key = a.get("idempotency_key", "")
        if key:
            key_counts.setdefault(key, []).append(a.get("id", ""))
    duplicates = sum(1 for v in key_counts.values() if len(v) > 1)
    return {"unique_keys": len(key_counts), "duplicate_keys": duplicates}


def compute_research_gap_closure_rate(task_list: list[dict[str, Any]]) -> float:
    """Compute research gap closure rate: fraction of research_gap tasks that became verified."""
    if not task_list:
        return 0.0
    rg_tasks = [t for t in task_list if t.get("task_type") == "research_gap"]
    if not rg_tasks:
        return 0.0
    closed = sum(1 for t in rg_tasks if t.get("status") == "verified")
    return round(closed / len(rg_tasks), 4)


# ---------------------------------------------------------------------------
# Public API for consumers
# ---------------------------------------------------------------------------

def emit_session4_metrics(
    evidence_list: list[dict[str, Any]],
    task_list: list[dict[str, Any]],
    gate_results: list[dict[str, Any]],
    action_list: list[dict[str, Any]],
    durations: list[float],
    run_id: str = "unknown",
) -> None:
    """Emit all initial Session 4 metrics as structured JSONL events.

    All metrics are explicitly marked ``proposed``.
    """
    write_observability_event(_make_event(
        producer="session4_metrics",
        event_type="metrics_snapshot",
        run_id=run_id,
        fields={
            "proposed": True,
            "claim_validity_rate": compute_claim_validity_rate(evidence_list),
            "contradiction_density": compute_contradiction_density(evidence_list),
            "evidence_to_task_binding_rate": compute_evidence_to_task_binding_rate(task_list),
            "gate_pass_rates": compute_gate_pass_rates(gate_results),
            "dependency_cycle_rate": compute_dependency_cycle_rate(task_list),
            "review_escalation_rate": compute_review_escalation_rate(action_list),
            "retry_rate_by_failure_class": compute_retry_rate_by_failure_class(action_list),
            "latency": compute_latency_p50_p95(durations),
            "adapter_dedupe": compute_adapter_dedupe_outcomes(action_list),
            "research_gap_closure_rate": compute_research_gap_closure_rate(task_list),
        },
    ))
