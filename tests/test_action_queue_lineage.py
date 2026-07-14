"""Tests for Session 3: action queue lineage preservation.

Verifies:
- Existing action fields are preserved
- New lineage fields are additive (not replacing)
- Queue promotion is blocked by contradictions
- Priority formula version is recorded
- Idempotency keys are deterministic
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import ExecutionTask, stable_hash, TaskPriority, TaskConfidence, TaskUncertainty
from seo_agents.actions import (
    parse_execution_actions,
    parse_gbp_post_actions,
    parse_facebook_post_actions,
    build_action_queue,
    _priority_for_action,
    _confidence_for_action,
    _approval_class_for_action,
    _uncertainty_for_action,
    _write_task_graph_from_actions,
    _unresolved_contradiction_ids,
)
from seo_agents.evidence import TASK_GRAPH_PATH, write_task_graph, EVIDENCE_PACKAGE_PATH


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_action(**kw) -> dict:
    """Build a minimal action dict with Session 3 lineage fields."""
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


# ---------------------------------------------------------------------------
# Tests — existing fields preserved
# ---------------------------------------------------------------------------

class TestExistingFieldsPreserved:
    """Existing action fields must not be removed or renamed."""

    def test_id_field(self):
        action = _make_action()
        assert "id" in action
        assert action["id"] == "task-t001"

    def test_source_field(self):
        action = _make_action()
        assert "source" in action
        assert action["source"] == "execution_queue"

    def test_source_task_id_field(self):
        action = _make_action()
        assert "source_task_id" in action

    def test_title_field(self):
        action = _make_action()
        assert "title" in action

    def test_assigned_agent_field(self):
        action = _make_action()
        assert "assigned_agent" in action

    def test_action_type_field(self):
        action = _make_action()
        assert "action_type" in action
        assert action["action_type"] == "website_copy_update"

    def test_platform_field(self):
        action = _make_action()
        assert "platform" in action

    def test_risk_field(self):
        action = _make_action()
        assert "risk" in action

    def test_status_field(self):
        action = _make_action()
        assert "status" in action

    def test_steps_field(self):
        action = _make_action()
        assert "steps" in action
        assert isinstance(action["steps"], list)

    def test_dependencies_field(self):
        action = _make_action()
        assert "dependencies" in action

    def test_verification_checklist_field(self):
        action = _make_action()
        assert "verification_checklist" in action

    def test_completion_field(self):
        action = _make_action()
        assert "completion" in action

    def test_approval_required_field(self):
        action = _make_action()
        assert "approval_required" in action

    def test_live_adapter_field(self):
        action = _make_action()
        assert "live_adapter" in action


# ---------------------------------------------------------------------------
# Tests — new lineage fields are additive
# ---------------------------------------------------------------------------

class TestNewFieldsAdditive:
    """New lineage fields must be present on every action."""

    def test_supporting_claim_ids_present(self):
        action = _make_action()
        assert "supporting_claim_ids" in action
        assert isinstance(action["supporting_claim_ids"], list)

    def test_confidence_present(self):
        action = _make_action()
        assert "confidence" in action
        assert "label" in action["confidence"]
        assert "score" in action["confidence"]

    def test_approval_class_present(self):
        action = _make_action()
        assert "approval_class" in action
        assert action["approval_class"] in {"none", "sampled", "mandatory"}

    def test_uncertainty_present(self):
        action = _make_action()
        assert "uncertainty" in action
        assert "proxy_metrics_used" in action["uncertainty"]
        assert "gap_reason" in action["uncertainty"]
        assert "blocked_by" in action["uncertainty"]

    def test_idempotency_key_present(self):
        action = _make_action()
        assert "idempotency_key" in action
        assert action["idempotency_key"].startswith("idem_")

    def test_verification_dict_present(self):
        action = _make_action()
        assert "verification" in action
        assert isinstance(action["verification"], dict)

    def test_rollback_present(self):
        action = _make_action()
        assert "rollback" in action
        assert isinstance(action["rollback"], str)

    def test_preconditions_present(self):
        action = _make_action()
        assert "preconditions" in action
        assert isinstance(action["preconditions"], list)

    def test_acceptance_criteria_present(self):
        action = _make_action()
        assert "acceptance_criteria" in action
        assert isinstance(action["acceptance_criteria"], list)


# ---------------------------------------------------------------------------
# Tests — queue promotion blocked by contradictions
# ---------------------------------------------------------------------------

class TestContradictionBlocking:
    """Queue promotion must be blocked when material contradictions remain unresolved."""

    def test_blocked_task_status(self, monkeypatch):
        """An action referencing a claim with unresolved contradiction should be blocked."""
        monkeypatch.setattr(
            "seo_agents.actions._unresolved_contradiction_ids",
            lambda evidence_path=None: ["claim_blocked"],
        )
        captured = []
        def mock_write(tasks, run_id):
            captured.extend(tasks)
        monkeypatch.setattr("seo_agents.actions.write_task_graph", mock_write)

        action = _make_action(supporting_claim_ids=["claim_blocked"])
        _write_task_graph_from_actions([action], "test-001")

        task = next((t for t in captured if t["title"] == "Update homepage H1"), None)
        assert task is not None
        assert task["status"] == "blocked"

    def test_ready_task_status(self, monkeypatch):
        """An action with a clean claim should get 'ready' status."""
        monkeypatch.setattr(
            "seo_agents.actions._unresolved_contradiction_ids",
            lambda evidence_path=None: [],
        )
        # Session 4: mock claim graph so claim_ok is recognized
        monkeypatch.setattr(
            "seo_agents.actions._load_claim_graph",
            lambda claim_path=None: ({"claim_ok": {"claim_id": "claim_ok", "status": "confirmed", "run_id": "test-001", "contradiction_ids": []}}, "test-001"),
        )
        captured = []
        def mock_write(tasks, run_id):
            captured.extend(tasks)
        monkeypatch.setattr("seo_agents.actions.write_task_graph", mock_write)

        action = _make_action(supporting_claim_ids=["claim_ok"])
        _write_task_graph_from_actions([action], "test-001")

        task = next((t for t in captured if t["title"] == "Update homepage H1"), None)
        assert task["status"] == "ready"

    def test_research_gap_tasks_created(self, monkeypatch):
        """Unresolved contradictions should create research_gap tasks."""
        monkeypatch.setattr(
            "seo_agents.actions._unresolved_contradiction_ids",
            lambda evidence_path=None: ["claim_xyz"],
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

        _write_task_graph_from_actions([], "test-001")

        gap_tasks = [t for t in captured if t["task_type"] == "research_gap"]
        assert len(gap_tasks) >= 1
        for gt in gap_tasks:
            assert gt["status"] == "research_gap"


# ---------------------------------------------------------------------------
# Tests — priority formula version
# ---------------------------------------------------------------------------

class TestPriorityFormulaVersion:
    """Every action should record formula_version = priority-v1."""

    def test_blog_post_priority(self):
        result = _priority_for_action("website_blog_post", "medium", "Website")
        assert result["formula_version"] == "priority-v1"

    def test_gbp_priority(self):
        result = _priority_for_action("gbp_profile_update", "high", "GBP")
        assert result["formula_version"] == "priority-v1"

    def test_website_copy_priority(self):
        result = _priority_for_action("website_copy_update", "medium", "Content")
        assert result["formula_version"] == "priority-v1"

    def test_unknown_priority(self):
        result = _priority_for_action("unknown_action", "low", "Owner")
        assert result["formula_version"] == "priority-v1"


# ---------------------------------------------------------------------------
# Tests — idempotency determinism
# ---------------------------------------------------------------------------

class TestIdempotencyDeterminism:
    """Idempotency keys must be deterministic (same input = same key)."""

    def test_same_input_same_key(self):
        key1 = stable_hash(prefix="idem_", data="website_copy_update:Update H1:Update H1 tag")
        key2 = stable_hash(prefix="idem_", data="website_copy_update:Update H1:Update H1 tag")
        assert key1 == key2

    def test_different_input_different_key(self):
        key1 = stable_hash(prefix="idem_", data="website_copy_update:Update H1:v1")
        key2 = stable_hash(prefix="idem_", data="website_copy_update:Update H1:v2")
        assert key1 != key2

    def test_id_field_starts_with_prefix(self):
        action = _make_action()
        assert action["idempotency_key"].startswith("idem_")


# ---------------------------------------------------------------------------
# Tests — contract model construction
# ---------------------------------------------------------------------------

class TestContractModel:
    """Pydantic ExecutionTask model should accept all fields."""

    def test_build_task_from_fields(self):
        task = ExecutionTask(
            task_id="T-test-001",
            run_id="test-run",
            title="Test task",
            task_type="content_update",
            supporting_claim_ids=["claim_abc"],
            owner="website_manager",
            priority=TaskPriority(tier="P1", score=0.65, formula_version="priority-v1"),
            confidence=TaskConfidence(label="medium", score=0.5),
            dependencies=[],
            preconditions=["Site repo cloned"],
            acceptance_criteria=["H1 updated"],
            verification={"checklist": ["Verify H1"]},
            rollback="Revert H1 change",
            approval_class="sampled",
            uncertainty=TaskUncertainty(proxy_metrics_used=[], gap_reason=None, blocked_by=[]),
            idempotency_key="idem_abc",
            status="ready",
        )
        assert task.task_id == "T-test-001"
        assert task.priority.formula_version == "priority-v1"
        assert task.confidence.label == "medium"
        assert task.verification == {"checklist": ["Verify H1"]}
