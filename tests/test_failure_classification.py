"""Session B tests for live failure classification and recovery wiring."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import stable_hash
from seo_agents import actions
from seo_agents.actions import apply_recovery, classify_review_failure, run_action


def _make_action(**overrides) -> dict:
    action = {
        "id": "task-t001",
        "title": "Test action",
        "assigned_agent": "TestAgent",
        "action_type": "website_copy_update",
        "platform": "website",
        "status": "dry_run_ready",
        "idempotency_key": stable_hash(prefix="idem_", data="website_copy_update:Test action:TestAgent:|"),
        "last_run": {},
        "retries": 0,
        "recovery_notes": [],
        "confidence": {"label": "high", "score": 0.8},
        "evidence": {},
        "rejection_reason": "",
        "blocker": "",
        "task_type": "content_update",
        "live_adapter": "website_manager",
        "approval_required": False,
        "approval": None,
        "supporting_claim_ids": ["claim_abc"],
        "dependencies": [],
    }
    action.update(overrides)
    return action


def _make_context(action: dict | None = None, **overrides) -> dict:
    action = action or _make_action()
    context = {
        "action": action,
        "command_result": overrides.get("command_result", {}),
        "driver_result": overrides.get("driver_result", {}),
        "gate_result": overrides.get("gate_result", {"passed": True, "blocking_reasons": [], "gate_id": "gate-1"}),
        "adapter_type": overrides.get("adapter_type", action.get("live_adapter")),
        "exit_code": overrides.get("exit_code", 0),
        "result_status": overrides.get("result_status", "adapter_failed"),
    }
    context.update(overrides)
    return context


def _patch_live_run(monkeypatch, action: dict, adapter_result: dict) -> None:
    monkeypatch.setattr(actions, "write_action_queue", lambda: {"actions": [action], "summary": {}})
    monkeypatch.setattr(actions, "dispatch_gate", lambda *args, **kwargs: {"passed": True, "blocking_reasons": [], "gate_id": "gate-1"})
    monkeypatch.setattr(actions, "run_website_action", lambda *args, **kwargs: adapter_result)
    monkeypatch.setattr(actions, "_run_gbp_poster", lambda *args, **kwargs: adapter_result)


class TestFailureClassification:
    def test_timeout_maps_to_transient_retry(self):
        context = _make_context(
            command_result={"exit_code": 124, "stderr": "Adapter timed out after 300s."},
            result_status="adapter_failed",
        )
        assert classify_review_failure(context) == "transient_retry"

    def test_missing_access_maps_to_evidence_access(self):
        context = _make_context(
            command_result={"exit_code": 126, "stderr": "Missing tool access for browser session."},
            result_status="adapter_failed",
        )
        assert classify_review_failure(context) == "evidence_access"

    def test_contradiction_maps_to_contradiction_stall(self):
        context = _make_context(
            command_result={"exit_code": 1, "stderr": "Contradiction detected during validation."},
            gate_result={"passed": False, "blocking_reasons": ["unresolved_contradiction_on_claim_claim_abc"], "gate_id": "gate-2"},
            result_status="adapter_failed",
        )
        assert classify_review_failure(context) == "contradiction_stall"

    def test_low_confidence_maps_to_confidence_gap(self):
        context = _make_context(action=_make_action(confidence={"label": "low", "score": 0.31}), result_status="adapter_failed")
        assert classify_review_failure(context) == "confidence_gap"

    def test_secret_detection_maps_to_quarantine(self):
        context = _make_context(
            command_result={"exit_code": 1, "stderr": "secret api_key leaked into command output"},
            result_status="adapter_failed",
        )
        assert classify_review_failure(context) == "secrets_quarantine"

    def test_live_unverified_maps_to_needs_verification(self):
        context = _make_context(
            command_result={"exit_code": 3, "status": "push_failed", "stderr": "push failed"},
            driver_result={"verified": False, "result": "posted"},
            adapter_type="google_business_profile",
            result_status="live_unverified",
        )
        assert classify_review_failure(context) == "needs_verification"

    def test_unknown_maps_to_unknown(self):
        context = _make_context(command_result={"exit_code": 9, "stderr": "unexpected adapter output"}, result_status="adapter_failed")
        assert classify_review_failure(context) == "unknown"


class TestRunActionRecoveryWiring:
    def test_successful_adapter_run_records_none_failure_class(self, monkeypatch, tmp_path):
        action = _make_action()
        _patch_live_run(monkeypatch, action, {"status": "pushed", "commit": "abc123", "exit_code": 0})
        monkeypatch.setattr(actions, "ACTION_RUN_DIR", tmp_path)

        result = run_action(action["id"], live=True, run_id="run-2026")

        assert result["status"] == "live_complete"
        assert result["failure_class"] == "none"
        assert result["recovery_notes"] == []
        assert result["recovery_action"] == "none"
        assert result["classification_basis"] == "none"
        assert result["auto_retry_permitted"] is False
        assert result["completed_at"]

    def test_recovery_notes_are_recorded_in_run_record(self, monkeypatch, tmp_path):
        action = _make_action()
        _patch_live_run(
            monkeypatch,
            action,
            {"status": "failed", "stderr": "Adapter timeout after 300s.", "exit_code": 124, "message": "Timed out"},
        )
        monkeypatch.setattr(actions, "ACTION_RUN_DIR", tmp_path)

        result = run_action(action["id"], live=True, run_id="run-2026")

        assert result["status"] == "adapter_failed"
        assert result["failure_class"] == "transient_retry"
        assert result["classification_basis"] == "adapter_result"
        assert result["recovery_notes"]
        assert any("transient_retry" in note for note in result["recovery_notes"])
        assert result["recovery_action"] == result["recovery_action_taken"]

    def test_live_unverified_is_not_converted_to_adapter_failed(self, monkeypatch, tmp_path):
        action = _make_action(live_adapter="google_business_profile")
        _patch_live_run(
            monkeypatch,
            action,
            {"status": "push_failed", "stderr": "push failed", "exit_code": 3, "message": "Submitted but unverified"},
        )
        monkeypatch.setattr(actions, "ACTION_RUN_DIR", tmp_path)

        result = run_action(action["id"], live=True, run_id="run-2026")

        assert result["status"] == "live_unverified"
        assert result["failure_class"] == "needs_verification"
        assert result["recovery_notes"] == []
        assert result["recovery_action"] == "none"
        assert result["auto_retry_permitted"] is False
        assert result["classification_basis"] == "adapter_result"

    def test_apply_recovery_accepts_quarantine_alias(self):
        action = _make_action()
        result = apply_recovery(action, "quarantine")
        assert result["status"] == "quarantined"
        assert "secrets_quarantined" in result["recovery_notes"]
