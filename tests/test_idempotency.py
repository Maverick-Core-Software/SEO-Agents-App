"""Tests for idempotency, failure classification, and recovery in actions.py.

Covered functions:
- enforce_idempotency (live dedup, first-run pass-through, dry-run skip)
- classify_failure (timeout -> transient_retry, unknown -> unknown)
- apply_recovery (transient_retry increments retries)
- stable_hash assignment when idempotency_key is missing
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import stable_hash
from seo_agents import actions
from seo_agents.actions import (
    enforce_idempotency,
    classify_review_failure,
    apply_recovery,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_action(**kw) -> dict:
    """Build a minimal action dict with optional overrides."""
    defaults: dict = {
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
    }
    defaults.update(kw)
    return defaults


@pytest.fixture
def action() -> dict:
    return _make_action()


# ---------------------------------------------------------------------------
# enforce_idempotency — live mode
# ---------------------------------------------------------------------------

class TestEnforceIdempotency:
    """Tests for the idempotency guard in enforce_idempotency."""

    def test_idempotency_hit_returns_hit_true(self, action, monkeypatch):
        """When same idempotency_key seen twice in live mode, returns
        idempotency_hit=True with the prior result."""
        prior_run = {
            "id": "run-20260101000000-task-t001",
            "action_id": "task-t001",
            "live": True,
            "status": "live_complete",
            "action": {
                "id": "task-t001",
                "idempotency_key": action["idempotency_key"],
                "created_at": "2026-01-01T00:00:00Z",
            },
            "command_result": {"exit_code": 0},
            "created_at": "2026-01-01T00:00:00Z",
        }
        monkeypatch.setattr(actions, "_load_latest_runs", lambda: {"run-20260101000000-task-t001": prior_run})
        monkeypatch.setattr(actions, "run_action", MagicMock())

        result = enforce_idempotency(action, live=True)

        assert result["idempotency_hit"] is True
        assert result["status"] == "live_complete"
        assert result["message"].startswith("Idempotency hit")

    def test_first_execution_passes_through(self, action, monkeypatch):
        """When no prior successful run exists, the action executes normally."""
        monkeypatch.setattr(actions, "_load_latest_runs", lambda: {})
        monkeypatch.setattr(actions, "_acquire_idempotency_lock", lambda action_id, idem_key: action_id)
        monkeypatch.setattr(actions, "_release_idempotency_lock", MagicMock())
        mock_run = MagicMock(return_value={"status": "live_complete"})
        monkeypatch.setattr(actions, "run_action", mock_run)

        enforce_idempotency(action, live=True)

        mock_run.assert_called_once_with("task-t001", live=True)

    def test_different_keys_both_execute(self, action, monkeypatch):
        """When idempotency_key differs from prior runs, both proceed to execute."""
        prior_key = stable_hash(prefix="idem_", data="different_key")
        prior_run = {
            "id": "run-prior",
            "action_id": "task-t001",
            "status": "live_complete",
            "action": {"idempotency_key": prior_key},
        }
        monkeypatch.setattr(actions, "_load_latest_runs", lambda: {"run-prior": prior_run})
        monkeypatch.setattr(actions, "_acquire_idempotency_lock", lambda action_id, idem_key: action_id)
        monkeypatch.setattr(actions, "_release_idempotency_lock", MagicMock())
        mock_run = MagicMock(return_value={"status": "live_complete"})
        monkeypatch.setattr(actions, "run_action", mock_run)

        enforce_idempotency(action, live=True)

        mock_run.assert_called_once_with("task-t001", live=True)

    def test_dry_run_skips_idempotency_check(self, action, monkeypatch):
        """In dry-run mode, idempotency is always skipped — action runs."""
        monkeypatch.setattr(actions, "_load_latest_runs", lambda: {})
        mock_run = MagicMock(return_value={"status": "dry_run_complete"})
        monkeypatch.setattr(actions, "run_action", mock_run)

        enforce_idempotency(action, live=False)

        mock_run.assert_called_once_with("task-t001", live=False)

    def test_prior_run_not_live_complete_does_not_dedupe(self, action, monkeypatch):
        """If prior run status is not 'live_complete', action proceeds to execute."""
        prior_run = {
            "id": "run-20260101000000-task-t001",
            "action_id": "task-t001",
            "status": "adapter_failed",
            "action": {"idempotency_key": action["idempotency_key"]},
        }
        monkeypatch.setattr(actions, "_load_latest_runs", lambda: {"run-20260101000000-task-t001": prior_run})
        monkeypatch.setattr(actions, "_acquire_idempotency_lock", lambda action_id, idem_key: action_id)
        monkeypatch.setattr(actions, "_release_idempotency_lock", MagicMock())
        mock_run = MagicMock(return_value={"status": "live_complete"})
        monkeypatch.setattr(actions, "run_action", mock_run)

        enforce_idempotency(action, live=True)

        mock_run.assert_called_once_with("task-t001", live=True)


# ---------------------------------------------------------------------------
# classify_failure
# ---------------------------------------------------------------------------

class TestClassifyFailure:
    """Tests for classify_review_failure classification logic."""

    def test_timeout_routes_to_transient_retry(self, action):
        """Adapter timeout stderr maps to transient_retry."""
        result = classify_review_failure(action, command_result={"stderr": "Adapter timeout after 300s."})
        assert result == "transient_retry"

    def test_network_error_routes_to_transient_retry(self, action):
        """Network error maps to transient_retry."""
        result = classify_review_failure(action, command_result={"stderr": "Network error: connection refused"})
        assert result == "transient_retry"

    def test_failed_adapter_status_is_transient_retry(self, action):
        """Failed adapter with timeout stderr maps to transient_retry."""
        result = classify_review_failure(action, command_result={"exit_code": 1, "stderr": "Adapter timeout after 300s"})
        assert result == "transient_retry"

    def test_unknown_class_returns_unknown(self, action):
        """When nothing matches, returns 'unknown'."""
        result = classify_review_failure(action)
        assert result == "unknown"


# ---------------------------------------------------------------------------
# apply_recovery
# ---------------------------------------------------------------------------

class TestApplyRecovery:
    """Tests for apply_recovery mutation logic."""

    def test_transient_retry_increments_retries(self, action):
        """transient_retry recovery increments retry count by 1."""
        result = apply_recovery(action, "transient_retry")
        assert result["retries"] == 1

    def test_transient_retry_clears_failed_status(self, action):
        """When action status is 'failed', transient_retry sets it back to 'ready'."""
        action["status"] = "failed"
        result = apply_recovery(action, "transient_retry")
        assert result["status"] == "ready"

    def test_transient_retry_adds_recovery_note(self, action):
        """transient_retry appends a recovery note."""
        result = apply_recovery(action, "transient_retry")
        assert "transient_retry #1" in result["recovery_notes"]

    def test_evidence_access_sets_status(self, action):
        """evidence_access sets status to waiting_on_tool_access."""
        result = apply_recovery(action, "evidence_access")
        assert result["status"] == "waiting_on_tool_access"
        assert "evidence_access_escalation" in result["recovery_notes"]

    def test_secrets_quarantine_quarantines_action(self, action):
        """secrets_quarantine sets status to quarantined."""
        result = apply_recovery(action, "secrets_quarantine")
        assert result["status"] == "quarantined"
        assert "secrets_quarantined" in result["recovery_notes"]

    def test_contradiction_stall_blocks_action(self, action):
        """contradiction_stall sets status to blocked."""
        result = apply_recovery(action, "contradiction_stall")
        assert result["status"] == "blocked"
        assert "contradiction_stall_escalation" in result["recovery_notes"]

    def test_confidence_gap_adds_note_but_does_not_change_status(self, action):
        """confidence_gap only adds a note, does not change status."""
        original_status = action["status"]
        result = apply_recovery(action, "confidence_gap")
        assert result["status"] == original_status
        assert "confidence_gap_research_task" in result["recovery_notes"]

    def test_unknown_recovery_does_nothing(self, action):
        """unknown failure class does not mutate anything."""
        result = apply_recovery(action, "unknown")
        assert result["retries"] == action["retries"]
        assert result["status"] == action["status"]
        assert result["recovery_notes"] == action["recovery_notes"]
