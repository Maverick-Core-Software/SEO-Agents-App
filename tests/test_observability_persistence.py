"""Tests for Session C observability persistence wiring."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import stable_hash
from seo_agents.observability import (
    emit_adapter_run,
    emit_approval,
    emit_dispatch_gate,
    emit_failure_classification,
    emit_finalization_complete,
    emit_queue_built,
    emit_research_complete,
    emit_synthesis_gate,
    emit_verification,
)


def _patch_output_dirs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    out = tmp_path / "outputs"
    out.mkdir(parents=True, exist_ok=True)
    run_dir = out / "action_runs"
    run_dir.mkdir(parents=True, exist_ok=True)

    import seo_agents.actions as actions
    import seo_agents.evidence as evidence
    import seo_agents.observability as observability

    monkeypatch.setattr(observability, "OUTPUT_DIR", out, raising=False)
    monkeypatch.setattr(evidence, "OUTPUT_DIR", out, raising=False)
    monkeypatch.setattr(actions, "OUTPUT_DIR", out, raising=False)
    monkeypatch.setattr(actions, "ACTION_QUEUE_FILE", out / "action_queue.json", raising=False)
    monkeypatch.setattr(actions, "ACTION_APPROVALS_FILE", out / "action_approvals.json", raising=False)
    monkeypatch.setattr(actions, "ACTION_RUN_DIR", run_dir, raising=False)
    return out


def _read_events(output_dir: Path) -> list[dict]:
    path = output_dir / "observability.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _base_action(action_id: str = "task-t001") -> dict:
    return {
        "id": action_id,
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


def test_research_completion_emits_one_event(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    emit_research_complete("run-001", ["content_report.md"], 12.5)

    events = _read_events(out)
    assert len(events) == 1
    event = events[0]
    assert event["run_id"] == "run-001"
    assert event["event_type"] == "research_complete"
    assert event["schema_version"]
    assert event["fields"]["outputs"] == ["content_report.md"]
    assert event["fields"]["outcome"] == "complete"


def test_gate_evaluation_emits_one_event_per_gate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    import seo_agents.finalize as finalize_mod
    from seo_agents.run_context import RunContext

    report_dir = out / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    archive_dir = out / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    ctx = RunContext(
        invocation_id="inv-001",
        topic="test",
        site_url="https://example.com",
        audience="audience",
        region="region",
        keywords="kw",
        started_at="2026-07-14T00:00:00Z",
        provider="unknown",
        research_model="unknown",
        exec_model="unknown",
        output_dir=out,
        archive_dir=archive_dir,
        lock_file=out / "lock.lock.json",
    )

    monkeypatch.setattr(
        finalize_mod,
        "build_claim_graph_from_dir",
        lambda **kwargs: {
            "counts": {"claims": 1, "evidence": 1},
            "evidence": [{"status": "confirmed"}],
            "claims": [{"claim_id": "claim-1", "status": "confirmed"}],
            "contradictions": [],
            "diagnostics": [],
        },
    )
    monkeypatch.setattr(finalize_mod, "validate_evidence_package", lambda evidence_list: {"ok": True, "gates": [], "fail_gates": 0, "warning_gates": 0})
    monkeypatch.setattr(finalize_mod, "validate_claim_graph", lambda claims: {"ok": True, "gates": [], "failed_gates": 0})
    monkeypatch.setattr(
        finalize_mod,
        "evaluate_gates",
        lambda **kwargs: {
            "hard_fail": True,
            "promotable": False,
            "extraction_empty": False,
            "extraction_justified": True,
            "failures": [{"gate": "claim_missing", "detail": "missing evidence", "claim_id": "claim-1", "report": "content_report.md"}],
            "warnings": [{"gate": "timing_warning", "detail": "slow report", "claim_id": "", "report": "website_report.md"}],
        },
    )

    finalize_mod.finalize_run(
        ctx=ctx,
        report_dir=report_dir,
        output_dir=out,
        dry_run=False,
        research_only=False,
        unavailable_tools=[],
    )

    events = _read_events(out)
    gate_events = [event for event in events if event["event_type"] == "gate_result"]
    assert len(gate_events) == 2
    assert any(event["event_type"] == "finalization_complete" for event in events)
    assert {event["fields"]["outcome"] for event in gate_events} == {"blocked", "passed"}


def test_queue_build_emits_one_event_with_counts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    import seo_agents.actions as actions_mod

    monkeypatch.setattr(
        actions_mod,
        "build_action_queue",
        lambda run_id="": {
            "run_id": run_id,
            "summary": {"total": 3, "needs_approval": 1, "approved": 1, "verified": 1},
            "actions": [],
        },
    )
    monkeypatch.setattr(actions_mod, "_write_task_graph_from_actions", lambda *args, **kwargs: None)

    actions_mod.write_action_queue(run_id="run-queue")

    events = _read_events(out)
    queue_events = [event for event in events if event["event_type"] == "queue_built"]
    assert len(queue_events) == 1
    assert queue_events[0]["run_id"] == "run-queue"
    assert queue_events[0]["fields"]["total_actions"] == 3
    assert queue_events[0]["fields"]["approved"] == 1


def test_approval_emits_one_event_with_approver(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    import seo_agents.actions as actions_mod

    monkeypatch.setattr(
        actions_mod,
        "build_action_queue",
        lambda run_id="": {
            "run_id": run_id or "run-approve",
            "summary": {"total": 1, "needs_approval": 1, "approved": 0, "verified": 0},
            "actions": [_base_action()],
        },
    )
    monkeypatch.setattr(actions_mod, "_write_task_graph_from_actions", lambda *args, **kwargs: None)

    actions_mod.approve_action("task-t001", approved_by="mcc")

    events = _read_events(out)
    approval_events = [event for event in events if event["event_type"] == "approval_granted"]
    assert len(approval_events) == 1
    assert approval_events[0]["fields"]["approved_by"] == "mcc"
    assert approval_events[0]["fields"]["action_id"] == "task-t001"


def test_adapter_run_emits_one_event_with_exit_code_and_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    import seo_agents.actions as actions_mod

    action = _base_action()
    monkeypatch.setattr(
        actions_mod,
        "write_action_queue",
        lambda: {"run_id": "run-adapter", "actions": [action], "summary": {}},
    )
    monkeypatch.setattr(actions_mod, "dispatch_gate", lambda *args, **kwargs: {"passed": True, "blocking_reasons": [], "gate_id": "gate-1"})
    monkeypatch.setattr(actions_mod, "run_website_action", lambda *args, **kwargs: {"status": "pushed", "commit": "abc123", "exit_code": 0})

    result = actions_mod.run_action(action["id"], live=True, run_id="run-adapter")

    assert result["status"] == "live_complete"
    events = _read_events(out)
    adapter_events = [event for event in events if event["event_type"] == "adapter_result"]
    assert len(adapter_events) == 1
    assert adapter_events[0]["fields"]["exit_code"] == 0
    assert adapter_events[0]["fields"]["success"] is True


def test_verification_emits_one_event(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    emit_verification("run-verify", "task-t001", True, 1.25)

    events = _read_events(out)
    verification_events = [event for event in events if event["event_type"] == "verification_complete"]
    assert len(verification_events) == 1
    assert verification_events[0]["fields"]["verified"] is True
    assert verification_events[0]["fields"]["action_id"] == "task-t001"


def test_failure_classification_emits_one_event_with_failure_class(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    import seo_agents.actions as actions_mod

    action = _base_action()
    monkeypatch.setattr(
        actions_mod,
        "write_action_queue",
        lambda: {"run_id": "run-failure", "actions": [action], "summary": {}},
    )
    monkeypatch.setattr(actions_mod, "dispatch_gate", lambda *args, **kwargs: {"passed": True, "blocking_reasons": [], "gate_id": "gate-2"})
    monkeypatch.setattr(actions_mod, "run_website_action", lambda *args, **kwargs: {"status": "push_failed", "exit_code": 3, "stderr": "push failed"})

    result = actions_mod.run_action(action["id"], live=True, run_id="run-failure")

    assert result["status"] == "live_unverified"
    events = _read_events(out)
    failure_events = [event for event in events if event["event_type"] == "failure_classified"]
    assert len(failure_events) == 1
    assert failure_events[0]["fields"]["failure_class"] == "needs_verification"
    assert failure_events[0]["fields"]["recovery_action"] == "none"


def test_two_or_more_observability_events_persist_in_order(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    emit_research_complete("run-order", ["content_report.md"], 1.0)
    emit_verification("run-order", "task-t001", False, 0.2)

    events = _read_events(out)
    assert [event["event_type"] for event in events] == ["research_complete", "verification_complete"]


def test_every_event_includes_required_fields(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    emit_queue_built("run-fields", 2, 1, 1, 0)
    emit_dispatch_gate("run-fields", "task-t001", "gate-1", True, [], 0.1)
    emit_adapter_run("run-fields", "website_manager", "task-t001", 0, True, 0.4)

    required = {"run_id", "timestamp", "producer", "event_type", "schema_version"}
    for event in _read_events(out):
        assert required.issubset(event.keys())


def test_full_lifecycle_produces_complete_event_sequence(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out = _patch_output_dirs(monkeypatch, tmp_path)

    import seo_agents.actions as actions_mod
    import seo_agents.finalize as finalize_mod
    from seo_agents.run_context import RunContext

    emit_research_complete("run-full", ["content_report.md"], 2.0)

    report_dir = out / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    archive_dir = out / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    ctx = RunContext(
        invocation_id="inv-full",
        topic="full",
        site_url="https://example.com",
        audience="audience",
        region="region",
        keywords="kw",
        started_at="2026-07-14T00:00:00Z",
        provider="unknown",
        research_model="unknown",
        exec_model="unknown",
        output_dir=out,
        archive_dir=archive_dir,
        lock_file=out / "lock.lock.json",
    )

    monkeypatch.setattr(
        finalize_mod,
        "build_claim_graph_from_dir",
        lambda **kwargs: {
            "counts": {"claims": 1, "evidence": 1},
            "evidence": [{"status": "confirmed"}],
            "claims": [{"claim_id": "claim-1", "status": "confirmed"}],
            "contradictions": [],
            "diagnostics": [],
        },
    )
    monkeypatch.setattr(finalize_mod, "validate_evidence_package", lambda evidence_list: {"ok": True, "gates": [], "fail_gates": 0, "warning_gates": 0})
    monkeypatch.setattr(finalize_mod, "validate_claim_graph", lambda claims: {"ok": True, "gates": [], "failed_gates": 0})
    monkeypatch.setattr(
        finalize_mod,
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
    finalize_mod.finalize_run(
        ctx=ctx,
        report_dir=report_dir,
        output_dir=out,
        dry_run=False,
        research_only=False,
        unavailable_tools=[],
    )

    monkeypatch.setattr(
        actions_mod,
        "build_action_queue",
        lambda run_id="": {
            "run_id": run_id or "run-full",
            "summary": {"total": 1, "needs_approval": 1, "approved": 0, "verified": 0},
            "actions": [_base_action()],
        },
    )
    monkeypatch.setattr(actions_mod, "_write_task_graph_from_actions", lambda *args, **kwargs: None)
    actions_mod.write_action_queue(run_id="run-full")

    emit_approval("run-full", "task-t001", "owner")
    emit_dispatch_gate("run-full", "task-t001", "gate-full", True, [], 0.05)
    emit_adapter_run("run-full", "website_manager", "task-t001", 0, True, 0.2)
    emit_verification("run-full", "task-t001", True, 0.01)

    event_types = [event["event_type"] for event in _read_events(out)]
    assert event_types == [
        "research_complete",
        "finalization_complete",
        "queue_built",
        "approval_granted",
        "gate_result",
        "adapter_result",
        "verification_complete",
    ]
