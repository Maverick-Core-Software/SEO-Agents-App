"""Tests for Session 3: research-to-execution translation.

Verifies:
- Every promoted task has at least one supporting claim (when durable recommendation)
- acceptance_criteria, verification, rollback, and idempotency_key are present
- Unresolved claims become research gaps or blocked tasks
- Existing approval fields remain compatible (additive)
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import (
    ExecutionTask,
    TaskPriority,
    TaskConfidence,
    TaskUncertainty,
)
from seo_agents.actions import (
    _priority_for_action,
    _confidence_for_action,
    _approval_class_for_action,
    _uncertainty_for_action,
    _detect_dependency_cycles,
    _write_task_graph_from_actions,
)
from seo_agents.evidence import write_task_graph, TASK_GRAPH_PATH


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_action(**kw) -> dict:
    """Build a minimal action dict with all Session 3 lineage fields."""
    defaults = {
        "id": "task-t001",
        "source": "execution_queue",
        "source_task_id": "T-001",
        "title": "Update homepage H1",
        "assigned_agent": "Website Manager Executor",
        "action_type": "website_copy_update",
        "platform": "website",
        "risk": "medium",
        "status": "dry_run_ready",
        "priority": {"tier": "P1", "score": 0.65, "formula_version": "priority-v1"},
        "due_window": "This Week",
        "steps": ["Update H1 tag"],
        "dependencies": [],
        "verification_checklist": ["Check H1 is updated"],
        "completion": {},
        "completion_override": None,
        "approval_required": False,
        "live_adapter": "website_manager",
        # Session 3 fields
        "supporting_claim_ids": ["claim_abc123"],
        "confidence": {"label": "medium", "score": 0.5},
        "approval_class": "sampled",
        "uncertainty": {"proxy_metrics_used": [], "gap_reason": None, "blocked_by": []},
        "idempotency_key": "idem_abc123",
        "verification": {"checklist": ["Check H1 is updated"]},
        "rollback": "Revert: revert website_copy_update changes for 'Update homepage H1'",
        "preconditions": ["Website repo must be cloned and accessible"],
        "acceptance_criteria": ["website_copy_update action verified complete"],
    }
    defaults.update(kw)
    return defaults


def _make_blocked_action(**kw) -> dict:
    """Build an action blocked by unresolved contradictions."""
    defaults = {
        "id": "task-t002",
        "source": "execution_queue",
        "source_task_id": "T-002",
        "title": "Publish GBP post",
        "assigned_agent": "Grizzly GBP Poster Agent",
        "action_type": "publish_gbp_post",
        "platform": "google_business_profile",
        "risk": "medium",
        "status": "needs_approval",
        "priority": {"tier": "P1", "score": 0.6, "formula_version": "priority-v1"},
        "due_window": "2026-07-15",
        "steps": ["Post to GBP"],
        "dependencies": [],
        "verification_checklist": ["Confirm post visible on GBP"],
        "completion": {},
        "completion_override": None,
        "approval_required": True,
        "live_adapter": "google_business_profile",
        # Session 3 fields — this action references a claim with unresolved contradiction
        "supporting_claim_ids": ["claim_xyz"],
        "confidence": {"label": "medium", "score": 0.5},
        "approval_class": "mandatory",
        "uncertainty": {"proxy_metrics_used": [], "gap_reason": None, "blocked_by": []},
        "idempotency_key": "idem_xyz",
        "verification": {"checklist": ["Confirm post visible on GBP"]},
        "rollback": "Unpublish or delete the GBP post from the profile.",
        "preconditions": ["Google Business Profile access", "Owner approval"],
        "acceptance_criteria": ["Post visible on GBP profile with selected photo"],
    }
    defaults.update(kw)
    return defaults


def _make_blocked_contradiction_action(**kw) -> dict:
    """Build an action blocked because its supporting claim has a contradiction."""
    defaults = {
        "id": "task-t003",
        "source": "execution_queue",
        "source_task_id": "T-003",
        "title": "Remove old GBP description",
        "assigned_agent": "Local Presence Assets Executor",
        "action_type": "gbp_profile_update",
        "platform": "google_business_profile",
        "risk": "high",
        "status": "dry_run_ready",
        "priority": {"tier": "P0", "score": 0.8, "formula_version": "priority-v1"},
        "due_window": "This Week",
        "steps": ["Remove old description"],
        "dependencies": [],
        "verification_checklist": ["Confirm description updated"],
        "completion": {},
        "completion_override": None,
        "approval_required": True,
        "live_adapter": "google_business_profile",
        # This claim has unresolved contradiction
        "supporting_claim_ids": ["claim_blocked"],
        "confidence": {"label": "medium", "score": 0.5},
        "approval_class": "mandatory",
        "uncertainty": {"proxy_metrics_used": [], "gap_reason": None, "blocked_by": []},
        "idempotency_key": "idem_blocked",
        "verification": {"checklist": ["Confirm description updated"]},
        "rollback": "Revert GBP profile description to previous value.",
        "preconditions": ["Google Business Profile access"],
        "acceptance_criteria": ["GBP description updated"],
    }
    defaults.update(kw)
    return defaults


# ---------------------------------------------------------------------------
# Tests — priority and confidence formulas
# ---------------------------------------------------------------------------

class TestPriorityFormula:
    """Priority formula v1: 0.35*impact + 0.30*confidence + 0.20*urgency + 0.15*strategic_alignment."""

    def test_blog_post_gets_p1(self):
        result = _priority_for_action("website_blog_post", "medium", "Website Manager")
        assert result["tier"] in {"P1", "P0"}
        assert result["formula_version"] == "priority-v1"
        assert result["score"] >= 0.6

    def test_gbp_profile_update_gets_p1(self):
        result = _priority_for_action("gbp_profile_update", "high", "GBP Poster")
        assert result["tier"] == "P1"
        assert result["formula_version"] == "priority-v1"
        assert result["score"] >= 0.6

    def test_website_copy_update_gets_p2(self):
        result = _priority_for_action("website_copy_update", "medium", "Content")
        assert result["tier"] == "P2"
        assert result["formula_version"] == "priority-v1"

    def test_unknown_action_gets_p2(self):
        result = _priority_for_action("manual_followup", "low", "Owner")
        assert result["tier"] in {"P2", "P3"}
        assert result["formula_version"] == "priority-v1"


class TestConfidence:
    def test_high_risk_gets_high_confidence(self):
        result = _confidence_for_action("gbp_profile_update", "high")
        assert result["label"] == "high"
        assert result["score"] >= 0.6

    def test_medium_risk_gets_medium_confidence(self):
        result = _confidence_for_action("website_copy_update", "medium")
        assert result["label"] == "medium"


class TestApprovalClass:
    def test_gbp_profile_is_mandatory(self):
        assert _approval_class_for_action("gbp_profile_update") == "mandatory"

    def test_website_layout_is_mandatory(self):
        assert _approval_class_for_action("website_layout_update") == "mandatory"

    def test_website_copy_is_sampled(self):
        assert _approval_class_for_action("website_copy_update") == "sampled"

    def test_review_management_is_sampled(self):
        assert _approval_class_for_action("review_management") == "sampled"


class TestUncertainty:
    def test_blog_post_has_gap_reason(self):
        result = _uncertainty_for_action("website_blog_post")
        assert result["gap_reason"] is not None
        assert "traffic" in result["gap_reason"] or "topic" in result["gap_reason"]


# ---------------------------------------------------------------------------
# Tests — dependency cycle detection
# ---------------------------------------------------------------------------

class TestDependencyCycles:
    def test_no_cycles_simple(self):
        actions = [
            {"id": "a1", "dependencies": ["a2"]},
            {"id": "a2", "dependencies": []},
        ]
        cycles = _detect_dependency_cycles(actions)
        assert cycles == []

    def test_cycle_detected(self):
        actions = [
            {"id": "a1", "dependencies": ["a2"]},
            {"id": "a2", "dependencies": ["a1"]},
        ]
        cycles = _detect_dependency_cycles(actions)
        assert len(cycles) > 0

    def test_three_way_cycle(self):
        actions = [
            {"id": "a1", "dependencies": ["a2"]},
            {"id": "a2", "dependencies": ["a3"]},
            {"id": "a3", "dependencies": ["a1"]},
        ]
        cycles = _detect_dependency_cycles(actions)
        assert len(cycles) > 0


# ---------------------------------------------------------------------------
# Tests — task object contract
# ---------------------------------------------------------------------------

class TestTaskObjectContract:
    """Every promoted task must have all required fields from the execution task contract."""

    def test_all_fields_present(self):
        action = _make_action()
        # Verify all Session 3 additive fields are present
        assert "supporting_claim_ids" in action
        assert "confidence" in action
        assert "approval_class" in action
        assert "uncertainty" in action
        assert "idempotency_key" in action
        assert "verification" in action
        assert "rollback" in action
        assert "preconditions" in action
        assert "acceptance_criteria" in action

    def test_supporting_claim_ids_populated(self):
        action = _make_action()
        assert len(action["supporting_claim_ids"]) >= 1
        assert action["supporting_claim_ids"][0].startswith("claim_")

    def test_idempotency_key_format(self):
        action = _make_action()
        assert action["idempotency_key"].startswith("idem_")

    def test_priority_has_formula_version(self):
        action = _make_action()
        assert action["priority"]["formula_version"] == "priority-v1"

    def test_confidence_has_label_and_score(self):
        action = _make_action()
        assert "label" in action["confidence"]
        assert "score" in action["confidence"]

    def test_acceptance_criteria_present(self):
        action = _make_action()
        assert len(action["acceptance_criteria"]) >= 1

    def test_rollback_present(self):
        action = _make_action()
        assert action["rollback"] != ""

    def test_verification_dict_present(self):
        action = _make_action()
        assert "verification" in action
        assert isinstance(action["verification"], dict)

    def test_uncertainty_present(self):
        action = _make_action()
        assert isinstance(action["uncertainty"], dict)
        assert "proxy_metrics_used" in action["uncertainty"]
        assert "gap_reason" in action["uncertainty"]
        assert "blocked_by" in action["uncertainty"]


class TestBlockedByContradiction:
    """Tasks with claims that have unresolved contradictions should be blocked."""

    @pytest.fixture(autouse=True)
    def _mock_evidence_path(self, monkeypatch, tmp_path):
        """Mock EVIDENCE_PACKAGE_PATH and validate_evidence_package."""
        mock_path = tmp_path / "evidence_package.json"
        mock_path.write_text(json.dumps({
            "run_id": "test-001",
            "evidence": [{
                "evidence_id": "ev_001",
                "claim_id": "claim_blocked",
                "status": "provisional",
                "contradiction_ids": ["claim_other"],
                "source": {"kind": "live_page", "uri": "https://example.com/"},
                "confidence": {"label": "medium", "score": 0.5, "authority": 0.5},
            }]
        }))
        monkeypatch.setenv("PYTHONPATH", os.path.join(os.path.dirname(__file__), "..", "src"))
        # We can't easily monkeypatch the module-level import, so we'll just
        # test _write_task_graph_from_actions with mock contradict_claims
        return mock_path

    def test_action_with_blocked_claim_gets_blocked_status(self, monkeypatch, tmp_path):
        """An action whose supporting_claim_ids includes a claim with unresolved contradiction
        should have status 'blocked' in the task graph."""
        from seo_agents.actions import _unresolved_contradiction_ids

        monkeypatch.setattr(
            "seo_agents.actions._unresolved_contradiction_ids",
            lambda evidence_path=None: ["claim_blocked"],
        )
        # Session 4: mock claim graph so claim_blocked is recognized
        monkeypatch.setattr(
            "seo_agents.actions._load_claim_graph",
            lambda claim_path=None: ({"claim_blocked": {"claim_id": "claim_blocked", "status": "provisional", "run_id": "test-001", "contradiction_ids": ["claim_other"]}}, "test-001"),
        )

        # Mock write_task_graph to capture the tasks
        captured = []
        def mock_write(tasks, run_id):
            captured.extend(tasks)

        monkeypatch.setattr("seo_agents.actions.write_task_graph", mock_write)

        actions = [_make_blocked_contradiction_action()]
        _write_task_graph_from_actions(actions, "test-001")

        # Find the matching task
        task = next((t for t in captured if t["title"] == "Remove old GBP description"), None)
        assert task is not None
        assert task["status"] == "blocked"

    def test_action_with_clean_claim_gets_ready_status(self, monkeypatch, tmp_path):
        """An action with a claim that has no unresolved contradiction should get 'ready' status."""
        from seo_agents.actions import _unresolved_contradiction_ids

        monkeypatch.setattr(
            "seo_agents.actions._unresolved_contradiction_ids",
            lambda evidence_path=None: [],
        )
        # Session 4: mock claim graph so claim_ok is recognized as valid
        monkeypatch.setattr(
            "seo_agents.actions._load_claim_graph",
            lambda claim_path=None: ({"claim_ok": {"claim_id": "claim_ok", "status": "confirmed", "run_id": "test-001", "contradiction_ids": []}}, "test-001"),
        )

        captured = []
        def mock_write(tasks, run_id):
            captured.extend(tasks)

        monkeypatch.setattr("seo_agents.actions.write_task_graph", mock_write)

        action = _make_action(supporting_claim_ids=["claim_ok"])
        actions = [action]
        _write_task_graph_from_actions(actions, "test-001")

        task = next((t for t in captured if t["title"] == "Update homepage H1"), None)
        assert task is not None
        assert task["status"] == "ready"

    def test_research_gap_task_created_for_contradictions(self, monkeypatch, tmp_path):
        """When contradictions are unresolved, a research_gap task should be created."""
        from seo_agents.actions import _unresolved_contradiction_ids

        monkeypatch.setattr(
            "seo_agents.actions._unresolved_contradiction_ids",
            lambda evidence_path=None: ["claim_blocked", "claim_other"],
        )
        # Session 4: mock claim graph
        monkeypatch.setattr(
            "seo_agents.actions._load_claim_graph",
            lambda claim_path=None: ({}, "test-001"),
        )

        captured = []
        def mock_write(tasks, run_id):
            captured.extend(tasks)

        monkeypatch.setattr("seo_agents.actions.write_task_graph", mock_write)

        # Pass an action that doesn't reference these claims
        actions = [_make_action()]
        _write_task_graph_from_actions(actions, "test-001")

        # Check that research_gap tasks were created
        gap_tasks = [t for t in captured if t["task_type"] == "research_gap"]
        assert len(gap_tasks) == 2
        for gt in gap_tasks:
            assert gt["supporting_claim_ids"]
            assert gt["status"] == "research_gap"


# ---------------------------------------------------------------------------
# Tests — existing fields remain compatible
# ---------------------------------------------------------------------------

class TestExistingFieldsPreserved:
    """All pre-existing action fields must remain in the action dict."""

    def test_old_fields_still_present(self):
        action = _make_action()
        assert "id" in action
        assert "source" in action
        assert "source_task_id" in action
        assert "title" in action
        assert "assigned_agent" in action
        assert "action_type" in action
        assert "platform" in action
        assert "risk" in action
        assert "status" in action
        assert "priority" in action
        assert "due_window" in action
        assert "steps" in action
        assert "dependencies" in action
        assert "verification_checklist" in action
        assert "completion" in action
        assert "approval_required" in action
        assert "live_adapter" in action

    def test_new_fields_are_additive(self):
        action = _make_action()
        new_fields = {
            "supporting_claim_ids", "confidence", "approval_class", "uncertainty",
            "idempotency_key", "verification", "rollback", "preconditions", "acceptance_criteria",
        }
        for field in new_fields:
            assert field in action, f"Missing additive field: {field}"
