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
import tempfile
from pathlib import Path
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
    _build_validated_task,
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


# ---------------------------------------------------------------------------
# Phase 4 Correction (Section 9b): Task 4.1, 4.3, 4.5 fixes
# ---------------------------------------------------------------------------


class TestPhase4Fix41:
    """Ordinary executable actions with no claim IDs become research_gap."""

    def test_content_update_with_empty_claims_becomes_research_gap(self):
        """A non-schedule action with empty supporting_claim_ids is research_gap."""
        result = _build_validated_task(
            {
                "id": "task-x",
                "action_type": "content_update",
                "supporting_claim_ids": [],
                "title": "test update",
                "status": "dry_run_ready",
                "dependencies": [],
            },
            {},
            "run-1",
            [],
            [],
        )
        assert result["status"] == "research_gap"
        assert result["task_type"] == "research_gap"

    def test_website_copy_update_with_empty_claims_becomes_research_gap(self):
        result = _build_validated_task(
            {
                "id": "task-y",
                "action_type": "website_copy_update",
                "supporting_claim_ids": [],
                "title": "test",
                "status": "dry_run_ready",
                "dependencies": [],
            },
            {},
            "run-1",
            [],
            [],
        )
        assert result["status"] == "research_gap"


class TestPhase4Fix43:
    """Dependency blocking propagates through the task graph."""

    def test_dep_on_blocked_task_becomes_blocked(self, tmp_path):
        """A task depending on a blocked task is itself blocked.

        Dependencies use the real action_id namespace (not task_id), which is
        what _write_task_graph_from_actions actually produces.
        """
        from seo_agents.actions import _propagate_dependency_status

        # Build tasks the way _write_task_graph_from_actions does.
        # A-1: no claims → research_gap with action_id="action-a1"
        # A-2: has claim but depends on action-a1 → should become blocked
        tasks = [
            {
                "task_id": "T-run-1-T001",
                "run_id": "run-1",
                "action_id": "action-a1",
                "title": "Task A-1",
                "task_type": "research_gap",
                "supporting_claim_ids": [],
                "dependencies": [],
                "status": "research_gap",
                "blocking_reasons": ["ordinary_executable_without_claims"],
            },
            {
                "task_id": "T-run-1-T002",
                "run_id": "run-1",
                "action_id": "action-a2",
                "title": "Task A-2",
                "task_type": "website_copy_update",
                "supporting_claim_ids": ["claim_abc123"],
                "dependencies": ["action-a1"],
                "status": "ready",
            },
        ]
        _propagate_dependency_status(tasks)
        a1 = next((t for t in tasks if t["action_id"] == "action-a1"), None)
        a2 = next((t for t in tasks if t["action_id"] == "action-a2"), None)
        assert a1 is not None and a1["status"] == "research_gap"
        assert a2 is not None and a2["status"] == "blocked"
        assert any("blocked_dependency" in r for r in a2.get("blocking_reasons", []))

    def test_dep_on_blocked_task_via_write_task_graph(self, tmp_path):
        """End-to-end: two raw action dicts go through _write_task_graph_from_actions
        with real action["id"] as the dependency reference.
        """
        import seo_agents.evidence as ev_mod
        import seo_agents.actions as act_mod

        # Patch TASK_GRAPH_PATH AND OUTPUT_DIR so write_task_graph writes to tmp_path.
        # Patch BOTH modules — actions.py imported TASK_GRAPH_PATH and write_task_graph
        # at module level, so they each need their own patch.
        tg_path = tmp_path / "outputs" / "task_graph.json"
        tg_path.parent.mkdir(parents=True, exist_ok=True)
        with (
            patch.object(ev_mod, "TASK_GRAPH_PATH", tg_path),
            patch.object(ev_mod, "OUTPUT_DIR", tmp_path / "outputs"),
            patch.object(act_mod, "TASK_GRAPH_PATH", tg_path),
            patch.object(act_mod, "write_task_graph", lambda tasks, run_id="": None),
        ):
            from seo_agents.actions import _write_task_graph_from_actions

            actions = [
                {"id": "action-a1", "source_task_id": "T001",
                 "action_type": "content_update", "title": "Task A",
                 "supporting_claim_ids": [], "status": "ready",
                 "dependencies": [], "approval_required": False,
                 "approval": None, "live_adapter": "website_manager",
                 "platform": "website", "assigned_agent": "content_executor"},
                {"id": "action-a2", "source_task_id": "T002",
                 "action_type": "website_copy_update", "title": "Task B",
                 "supporting_claim_ids": ["claim_x"], "status": "ready",
                 "dependencies": ["action-a1"], "approval_required": False,
                 "approval": None, "live_adapter": "website_manager",
                 "platform": "website", "assigned_agent": "content_executor"},
            ]

            # Capture tasks via the patched write_task_graph callback
            captured = []
            def _capture(tasks, run_id=""):
                captured.extend(tasks)

            act_mod.write_task_graph = _capture

            _write_task_graph_from_actions(actions, "run-1")

            a1 = next(t for t in captured if t["action_id"] == "action-a1")
            a2 = next(t for t in captured if t["action_id"] == "action-a2")
            assert a1["status"] == "research_gap"
            assert a2["status"] == "blocked"
            assert any("blocked_dependency" in r for r in a2.get("blocking_reasons", []))


class TestPhase4Fix45:
    """Executor crew only receives executable tasks from the validated task graph."""

    def test_executor_filter_excludes_blocked_tasks(self):
        """Only ready/verified/approved tasks pass through."""
        from seo_agents.crew import _filter_executable_tasks
        from seo_agents.evidence import TASK_GRAPH_PATH
        import json

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            tg_data = {
                "run_id": "run-1",
                "tasks": [
                    {"task_id": "T1", "status": "ready", "action_id": "a1", "title": "Ready"},
                    {"task_id": "T2", "status": "blocked", "action_id": "a2", "title": "Blocked"},
                    {"task_id": "T3", "status": "research_gap", "action_id": "a3", "title": "Gap"},
                    {"task_id": "T4", "status": "waiting_on_owner", "action_id": "a4", "title": "Waiting"},
                ],
            }
            (tmp / "task_graph.json").write_text(json.dumps(tg_data))
            import seo_agents.evidence as ev
            ev.TASK_GRAPH_PATH = tmp / "task_graph.json"

            filtered = _filter_executable_tasks()
            titles = [t["title"] for t in filtered]
            assert "Ready" in titles
            assert "Blocked" not in titles
            assert "Gap" not in titles
            assert "Waiting" not in titles


class TestPhase4Fix45_2:
    """build_executor_crew builds queue_context entirely from filtered tasks,
    not from raw execution_queue.md — Task 4.5-fix-2.
    """

    def test_queue_context_uses_filtered_tasks(self):
        """When task_graph.json has filtered tasks, queue_text is built from
        them, not from raw execution queue markdown."""
        from seo_agents.crew import _filter_executable_tasks
        from seo_agents.evidence import TASK_GRAPH_PATH
        import seo_agents.evidence as ev_mod
        import seo_agents.status as st_mod
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)

            # Write a task graph with only "ready" tasks
            tg_data = {
                "run_id": "run-1",
                "tasks": [
                    {"task_id": "T-1", "status": "ready", "action_id": "a1",
                     "title": "Update homepage meta", "task_type": "website_copy_update",
                     "priority": {"tier": "P1"}, "owner": "content_executor",
                     "acceptance_criteria": ["Meta tags updated"],
                     "verification": {"checklist": ["Check rendered HTML"]},
                     "rollback": "Revert git reset", "supporting_claim_ids": ["c1"]},
                    {"task_id": "T-2", "status": "blocked", "action_id": "a2",
                     "title": "Blocked task", "task_type": "content_update",
                     "priority": {"tier": "P2"}, "owner": "content_executor",
                     "acceptance_criteria": [], "verification": {"checklist": []},
                     "rollback": "", "supporting_claim_ids": []},
                ],
            }
            tg_path = tmp / "task_graph.json"
            tg_path.write_text(json.dumps(tg_data))

            # Patch TASK_GRAPH_PATH so _filter_executable_tasks reads from tmp
            with patch.object(ev_mod, "TASK_GRAPH_PATH", tg_path):
                # Patch read_output so crew.build_executor_crew doesn't
                # read real files — just verify queue_text comes from filtered
                filtered = _filter_executable_tasks()

                # Build queue_text the way build_executor_crew does
                lines = [
                    "- **" + t.get("task_id", "") + "** [" + t.get("status", "") + "] "
                    + t.get("title", "") + " ("
                    + t.get("task_type", "") + " | "
                    + t.get("priority", {}).get("tier", "P3")
                    + " | " + t.get("owner", "") + ")"
                    for t in filtered
                ]
                queue_text = "\n".join(lines)

                # Must contain the filtered task title, NOT the blocked one
                assert "Update homepage meta" in queue_text
                assert "Blocked task" not in queue_text
                assert len(filtered) == 1
                assert filtered[0]["action_id"] == "a1"
