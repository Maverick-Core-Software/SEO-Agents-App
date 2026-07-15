"""Phase 5 integration tests for dispatch, idempotency, recovery, and observability."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import stable_hash


def _patch_temp_workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    out = tmp_path / "outputs"
    out.mkdir(parents=True, exist_ok=True)
    run_dir = out / "action_runs"
    run_dir.mkdir(parents=True, exist_ok=True)

    import seo_agents.actions as actions
    import seo_agents.evidence as evidence
    import seo_agents.observability as observability

    monkeypatch.setattr(actions, "OUTPUT_DIR", out, raising=False)
    monkeypatch.setattr(actions, "ACTION_QUEUE_FILE", out / "action_queue.json", raising=False)
    monkeypatch.setattr(actions, "ACTION_APPROVALS_FILE", out / "action_approvals.json", raising=False)
    monkeypatch.setattr(actions, "ACTION_RUN_DIR", run_dir, raising=False)

    monkeypatch.setattr(evidence, "OUTPUT_DIR", out, raising=False)
    monkeypatch.setattr(evidence, "CLAIM_GRAPH_PATH", out / "claim_graph.json", raising=False)
    monkeypatch.setattr(evidence, "TASK_GRAPH_PATH", out / "task_graph.json", raising=False)
    monkeypatch.setattr(evidence, "OBSERVABILITY_PATH", out / "observability.jsonl", raising=False)

    monkeypatch.setattr(observability, "OUTPUT_DIR", out, raising=False)
    return out


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _read_events(output_dir: Path) -> list[dict]:
    path = output_dir / "observability.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _base_action(**overrides) -> dict:
    action = {
        "id": "task-t001",
        "title": "Test action",
        "assigned_agent": "Test Agent",
        "action_type": "website_copy_update",
        "platform": "website",
        "status": "dry_run_ready",
        "idempotency_key": stable_hash(prefix="idem_", data="website_copy_update:Test action:Test Agent:|"),
        "confidence": {"label": "high", "score": 0.8},
        "live_adapter": "website_manager",
        "approval_required": False,
        "approval": None,
        "supporting_claim_ids": ["claim_abc"],
        "dependencies": [],
    }
    action.update(overrides)
    return action


@pytest.fixture
def temp_workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    return _patch_temp_workspace(monkeypatch, tmp_path)


def test_valid_action_runs_through_approval_dispatch_idempotency_and_creates_run_record(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action(approval_required=True, approval={"approved_by": "owner", "approved_at": "2026-07-15T00:00:00Z"})
    task_graph = {
        "run_id": "run-1",
        "tasks": [{"task_id": "T-run-1-001", "action_id": action["id"], "status": "ready"}],
    }
    claim_graph = {
        "run_id": "run-1",
        "claims": [{
            "claim_id": "claim_abc",
            "run_id": "run-1",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }],
    }
    _write_json(temp_workspace / "claim_graph.json", claim_graph)
    _write_json(temp_workspace / "task_graph.json", task_graph)

    monkeypatch.setattr(actions, "write_action_queue", lambda: {"run_id": "run-1", "actions": [action], "summary": {}})
    monkeypatch.setattr(actions, "dispatch_gate", lambda *args, **kwargs: {"passed": True, "blocking_reasons": [], "gate_id": "gate-run-1"})
    monkeypatch.setattr(actions, "run_website_action", lambda *args, **kwargs: {"status": "pushed", "commit": "abc123", "exit_code": 0})

    events_before = len(_read_events(temp_workspace))

    result = actions.enforce_idempotency(action, live=True)

    assert result["status"] == "live_complete"
    assert result.get("idempotency_hit") is not True
    assert result["reservation_state"] == "completed"
    run_files = sorted((temp_workspace / "action_runs").glob("run-*.json"))
    assert run_files, "expected a persisted run record"
    run_record = json.loads(run_files[-1].read_text(encoding="utf-8"))
    assert run_record["action_id"] == action["id"]
    assert run_record["status"] == "live_complete"
    assert run_record["classification_basis"] == "none"
    assert run_record["failure_class"] == "none"
    assert run_record["auto_retry_permitted"] is False
    assert run_record["gate_result"]["passed"] is True
    assert run_record["gate_result"]["blocking_reasons"] == []
    assert len(_read_events(temp_workspace)) > events_before


def test_blocked_action_stops_at_dispatch_gate_and_records_blocking_reasons(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action()
    _write_json(temp_workspace / "claim_graph.json", {
        "run_id": "run-2",
        "claims": [{
            "claim_id": "claim_abc",
            "run_id": "run-2",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }],
    })
    _write_json(temp_workspace / "task_graph.json", {
        "run_id": "run-2",
        "tasks": [{"task_id": "T-run-2-001", "action_id": action["id"], "status": "blocked"}],
    })

    monkeypatch.setattr(actions, "write_action_queue", lambda: {"run_id": "run-2", "actions": [action], "summary": {}})
    adapter_called = {"count": 0}
    monkeypatch.setattr(actions, "run_website_action", lambda *args, **kwargs: adapter_called.__setitem__("count", adapter_called["count"] + 1) or {"status": "pushed", "exit_code": 0})

    result = actions.run_action(action["id"], live=True, run_id="run-2")

    assert result["status"] == "gate_blocked"
    assert adapter_called["count"] == 0
    assert result["gate_result"]["blocking_reasons"]
    run_files = sorted((temp_workspace / "action_runs").glob("run-*.json"))
    assert run_files
    run_record = json.loads(run_files[-1].read_text(encoding="utf-8"))
    assert run_record["status"] == "gate_blocked"
    assert run_record["gate_result"]["blocking_reasons"] == result["gate_result"]["blocking_reasons"]


def test_failed_adapter_emits_failure_classification_recovery_and_ordered_events(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action()
    _write_json(temp_workspace / "claim_graph.json", {
        "run_id": "run-3",
        "claims": [{
            "claim_id": "claim_abc",
            "run_id": "run-3",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }],
    })
    _write_json(temp_workspace / "task_graph.json", {
        "run_id": "run-3",
        "tasks": [{"task_id": "T-run-3-001", "action_id": action["id"], "status": "ready"}],
    })

    monkeypatch.setattr(actions, "write_action_queue", lambda: {"run_id": "run-3", "actions": [action], "summary": {}})
    monkeypatch.setattr(actions, "run_website_action", lambda *args, **kwargs: {"status": "error", "exit_code": 124, "stderr": "Adapter timeout after 300s."})

    result = actions.run_action(action["id"], live=True, run_id="run-3")

    assert result["status"] == "adapter_failed"
    assert result["failure_class"] == "transient_retry"
    assert result["recovery_notes"]
    assert any("transient_retry" in note for note in result["recovery_notes"])
    assert result["recovery_action"] != "none"

    event_types = [event["event_type"] for event in _read_events(temp_workspace)]
    assert event_types == [
        "gate_result",
        "adapter_result",
        "verification_complete",
        "failure_classified",
        "recovery_applied",
    ]
    events = _read_events(temp_workspace)
    assert all(event["run_id"] == "run-3" for event in events)


def test_prior_successful_run_returns_dedupe_without_reinvoking_adapter(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action()
    prior_run = {
        "id": "run-prior",
        "action_id": action["id"],
        "status": "live_complete",
        "action": {"idempotency_key": action["idempotency_key"]},
        "command_result": {"exit_code": 0},
        "created_at": "2026-07-15T00:00:00Z",
    }
    monkeypatch.setattr(actions, "_load_latest_runs", lambda: {"run-prior": prior_run})
    monkeypatch.setattr(actions, "run_action", lambda *args, **kwargs: pytest.fail("run_action should not be called"))

    result = actions.enforce_idempotency(action, live=True)

    assert result["idempotency_hit"] is True
    assert result["status"] == "live_complete"
    assert result["reservation_state"] == "deduplicated"


def test_two_concurrent_calls_with_same_idempotency_key_produce_one_adapter_invocation(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action()
    monkeypatch.setattr(actions, "_load_latest_runs", lambda: {})

    call_count = {"value": 0}
    entered = threading.Event()
    release = threading.Event()

    def fake_run_action(action_id: str, live: bool = False, run_id: str = "") -> dict:
        call_count["value"] += 1
        entered.set()
        release.wait(timeout=2)
        return {"status": "live_complete", "message": "ok"}

    monkeypatch.setattr(actions, "run_action", fake_run_action)

    results: list[dict] = []

    def invoke() -> None:
        results.append(actions.enforce_idempotency(action, live=True))

    t1 = threading.Thread(target=invoke)
    t2 = threading.Thread(target=invoke)
    t1.start()
    entered.wait(timeout=2)
    t2.start()
    time.sleep(0.1)
    release.set()
    t1.join(timeout=5)
    t2.join(timeout=5)

    assert call_count["value"] == 1
    assert len(results) == 2
    assert any(result.get("status") == "concurrent_retry" for result in results)


def test_live_unverified_is_not_auto_retried(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action(live_adapter="google_business_profile")
    _write_json(temp_workspace / "claim_graph.json", {
        "run_id": "run-4",
        "claims": [{
            "claim_id": "claim_abc",
            "run_id": "run-4",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }],
    })
    _write_json(temp_workspace / "task_graph.json", {
        "run_id": "run-4",
        "tasks": [{"task_id": "T-run-4-001", "action_id": action["id"], "status": "ready"}],
    })

    monkeypatch.setattr(actions, "write_action_queue", lambda: {"run_id": "run-4", "actions": [action], "summary": {}})
    monkeypatch.setattr(actions, "_run_gbp_poster", lambda *args, **kwargs: {"status": "push_failed", "exit_code": 3, "stderr": "push failed"})

    result = actions.run_action(action["id"], live=True, run_id="run-4")

    assert result["status"] == "live_unverified"
    assert result["failure_class"] == "needs_verification"
    assert result["auto_retry_permitted"] is False
    assert result["recovery_action"] == "none"
    assert result["recovery_notes"] == []


def test_validated_task_graph_blocks_automatic_execution_bypass(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions

    action = _base_action()
    _write_json(temp_workspace / "claim_graph.json", {
        "run_id": "run-5",
        "claims": [{
            "claim_id": "claim_abc",
            "run_id": "run-5",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }],
    })
    _write_json(temp_workspace / "task_graph.json", {
        "run_id": "run-5",
        "tasks": [{"task_id": "T-run-5-001", "action_id": action["id"], "status": "blocked"}],
    })

    monkeypatch.setattr(actions, "write_action_queue", lambda: {"run_id": "run-5", "actions": [action], "summary": {}})
    adapter_called = {"count": 0}
    monkeypatch.setattr(actions, "run_website_action", lambda *args, **kwargs: adapter_called.__setitem__("count", adapter_called["count"] + 1) or {"status": "pushed", "exit_code": 0})

    result = actions.run_action(action["id"], live=True, run_id="run-5")

    assert result["status"] == "gate_blocked"
    assert adapter_called["count"] == 0


def test_complete_lifecycle_event_sequence_is_ordered(temp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import seo_agents.actions as actions
    import seo_agents.finalize as finalize
    import seo_agents.observability as observability
    from seo_agents.run_context import RunContext

    observability.emit_research_complete("run-6", ["content_report.md"], 1.0)

    report_dir = temp_workspace / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    archive_dir = temp_workspace / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    ctx = RunContext(
        invocation_id="inv-6",
        topic="test",
        site_url="https://example.com",
        audience="audience",
        region="region",
        keywords="kw",
        started_at="2026-07-15T00:00:00Z",
        provider="unknown",
        research_model="unknown",
        exec_model="unknown",
        output_dir=temp_workspace,
        archive_dir=archive_dir,
        lock_file=temp_workspace / "lock.lock.json",
    )

    monkeypatch.setattr(
        finalize,
        "build_claim_graph_from_dir",
        lambda **kwargs: {
            "counts": {"claims": 1, "evidence": 1},
            "evidence": [{"status": "confirmed"}],
            "claims": [{"claim_id": "claim_abc", "run_id": "run-6", "status": "confirmed"}],
            "contradictions": [],
            "diagnostics": [],
        },
    )
    monkeypatch.setattr(finalize, "validate_evidence_package", lambda evidence_list: {"ok": True, "gates": [], "fail_gates": 0, "warning_gates": 0})
    monkeypatch.setattr(finalize, "validate_claim_graph", lambda claims: {"ok": True, "gates": [], "failed_gates": 0})
    monkeypatch.setattr(
        finalize,
        "evaluate_gates",
        lambda **kwargs: {
            "hard_fail": False,
            "promotable": True,
            "extraction_empty": False,
            "extraction_justified": True,
            "failures": [],
            "warnings": [],
        },
    )
    finalize.finalize_run(ctx=ctx, report_dir=report_dir, output_dir=temp_workspace, dry_run=False, research_only=False, unavailable_tools=[])

    action = _base_action(approval_required=True, approval={"approved_by": "owner", "approved_at": "2026-07-15T00:00:00Z"})
    _write_json(temp_workspace / "claim_graph.json", {
        "run_id": "run-6",
        "claims": [{
            "claim_id": "claim_abc",
            "run_id": "run-6",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }],
    })
    _write_json(temp_workspace / "task_graph.json", {
        "run_id": "run-6",
        "tasks": [{"task_id": "T-run-6-001", "action_id": action["id"], "status": "ready"}],
    })

    monkeypatch.setattr(actions, "write_action_queue", lambda: {"run_id": "run-6", "actions": [action], "summary": {}})
    monkeypatch.setattr(actions, "run_website_action", lambda *args, **kwargs: {"status": "error", "exit_code": 124, "stderr": "Adapter timeout after 300s."})
    actions.run_action(action["id"], live=True, run_id="run-6")

    event_types = [event["event_type"] for event in _read_events(temp_workspace)]
    assert event_types == [
        "research_complete",
        "finalization_complete",
        "gate_result",
        "adapter_result",
        "verification_complete",
        "failure_classified",
        "recovery_applied",
    ]
