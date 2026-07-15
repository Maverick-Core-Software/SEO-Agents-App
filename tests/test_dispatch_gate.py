"""Tests for dispatch_gate() — Session 5, Task A.1.

Covers all 10 verification cases from the plan:
1. Valid action with all gates passing → passed: True
2. Blocked task graph status → passed: False
3. Rejected claim → passed: False
4. Unresolved contradiction → passed: False
5. Blocked dependency → passed: False
6. Missing approval in live mode → passed: False
7. No configured adapter → passed: False
8. Stale/mixed run → passed: False
9. Dry-run with advisory warnings → passed: True
10. Secret-like excerpt in claim evidence → passed: False
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.actions import dispatch_gate


def _make_action(**kw) -> dict:
    """Build a minimal action dict with overrides."""
    defaults = {
        "id": "task-t001",
        "action_type": "website_copy_update",
        "status": "dry_run_ready",
        "approval_required": False,
        "approval": None,
        "live_adapter": "website_manager",
        "idempotency_key": "idem_abc123",
        "supporting_claim_ids": ["claim_abc"],
        "dependencies": [],
        "platform": "website",
    }
    defaults.update(kw)
    return defaults


def _make_claim_graph(**kw) -> dict:
    defaults = {
        "run_id": "run-2026",
        "claims": [
            {
                "claim_id": "claim_abc",
                "run_id": "run-2026",
                "status": "confirmed",
                "contradiction_ids": [],
                "gate_failures": 0,
            }
        ],
    }
    defaults.update(kw)
    return defaults


def _make_task_graph(**kw) -> dict:
    defaults = {
        "run_id": "run-2026",
        "tasks": [
            {
                "task_id": "T-run-2026-001",
                "action_id": "task-t001",
                "status": "ready",
            }
        ],
    }
    defaults.update(kw)
    return defaults


class TestDispatchGateCases:
    """All 10 verification cases from Session A plan."""

    def test_01_valid_action_all_gates_pass(self):
        """Case 1: A valid action with all gates passing → passed: True."""
        action = _make_action()
        claim_graph = _make_claim_graph()
        task_graph = _make_task_graph()

        result = dispatch_gate(action, "run-2026", False, claim_graph, task_graph)

        assert result["passed"] is True
        assert result["blocking_reasons"] == []
        assert "gate_id" in result

    def test_02_blocked_task_graph_status(self):
        """Case 2: An action with a blocked task graph status → passed: False."""
        task_graph = _make_task_graph(tasks=[{
            "task_id": "T-run-2026-001",
            "action_id": "task-t001",
            "status": "blocked",
        }])
        action = _make_action()

        # In live mode, blocked task status always blocks
        result = dispatch_gate(action, "run-2026", True, {}, task_graph)

        assert result["passed"] is False
        assert any("task_graph_status_blocked" in r for r in result["blocking_reasons"])

    def test_03_rejected_claim(self):
        """Case 3: An action with a rejected claim → passed: False."""
        claim_graph = _make_claim_graph(claims=[{
            "claim_id": "claim_abc",
            "run_id": "run-2026",
            "status": "rejected",
            "contradiction_ids": [],
            "gate_failures": 0,
        }])
        action = _make_action()

        result = dispatch_gate(action, "run-2026", False, claim_graph, _make_task_graph())

        assert result["passed"] is False
        assert any("claim_claim_abc_status_rejected" in r for r in result["blocking_reasons"])

    def test_04_unresolved_contradiction(self):
        """Case 4: An action with an unresolved contradiction → passed: False."""
        claim_graph = _make_claim_graph(claims=[{
            "claim_id": "claim_abc",
            "run_id": "run-2026",
            "status": "confirmed",
            "contradiction_ids": ["contra-001"],
            "gate_failures": 0,
        }])
        action = _make_action()

        result = dispatch_gate(action, "run-2026", False, claim_graph, _make_task_graph())

        assert result["passed"] is False
        assert any("unresolved_contradiction_on_claim_claim_abc" in r for r in result["blocking_reasons"])

    def test_05_blocked_dependency(self):
        """Case 5: An action with a blocked dependency → passed: False."""
        task_graph = _make_task_graph(tasks=[
            {"task_id": "T-run-2026-001", "action_id": "task-t001", "status": "ready"},
            {"task_id": "T-run-2026-002", "action_id": "dep-task", "status": "blocked"},
        ])
        action = _make_action(dependencies=["dep-task"])

        result = dispatch_gate(action, "run-2026", False, {}, task_graph)

        assert result["passed"] is False
        assert any("blocked_dependency_dep-task" in r for r in result["blocking_reasons"])

    def test_06_missing_approval_live(self):
        """Case 6: An action missing approval in live mode → passed: False."""
        action = _make_action(
            live=True,
            approval_required=True,
            approval=None,
        )

        result = dispatch_gate(action, "run-2026", True, _make_claim_graph(), _make_task_graph())

        assert result["passed"] is False
        assert any("live_action_requires_approval" in r for r in result["blocking_reasons"])

    def test_07_no_configured_adapter(self):
        """Case 7: An action with no configured adapter → passed: False."""
        action = _make_action(live_adapter=None, live=True)

        result = dispatch_gate(action, "run-2026", True, _make_claim_graph(), _make_task_graph())

        assert result["passed"] is False
        assert any("no_live_adapter_for_action" in r for r in result["blocking_reasons"])

    def test_08_stale_mixed_run(self):
        """Case 8: An action from a stale/mixed run → passed: False."""
        claim_graph = _make_claim_graph(run_id="run-2026", claims=[{
            "claim_id": "claim_abc",
            "run_id": "run-2025",  # Different run ID — stale/mixed
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }])
        action = _make_action()

        result = dispatch_gate(action, "run-2026", False, claim_graph, _make_task_graph())

        assert result["passed"] is False
        assert any("mixed_run_claim_claim_abc_run_run-2025" in r for r in result["blocking_reasons"])

    def test_09_dry_run_advisory_warnings(self):
        """Case 9: A dry-run action with advisory warnings → passed: True."""
        # Dry-run with advisory-only reasons (no hard failures)
        # Include the claim so claim_not_found doesn't block
        claim_graph = _make_claim_graph(claims=[{
            "claim_id": "claim_abc",
            "run_id": "run-2026",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }])
        # Only task_graph_status_blocked is advisory in dry-run
        task_graph = _make_task_graph(tasks=[{
            "task_id": "T-run-2026-001",
            "action_id": "task-t001",
            "status": "blocked",
        }])
        action = _make_action()

        result = dispatch_gate(action, "run-2026", False, claim_graph, task_graph)

        # In dry-run, task_graph_status_blocked is advisory and passes
        assert result["passed"] is True

    def test_10_secret_like_excerpt(self):
        """Case 10: An action with a secret-like excerpt → passed: False."""
        # Gate failures on a claim indicate potential secrets
        claim_graph = _make_claim_graph(claims=[{
            "claim_id": "claim_abc",
            "run_id": "run-2026",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 1,  # Evidence gate failure
        }])
        action = _make_action()

        result = dispatch_gate(action, "run-2026", False, claim_graph, _make_task_graph())

        assert result["passed"] is False
        assert any("evidence_gate_failure_on_claim_claim_abc" in r for r in result["blocking_reasons"])


class TestDispatchGateDryRunHardFailures:
    """Dry-run must still block on hard failures."""

    def test_dry_run_blocks_on_missing_run_id(self):
        """Dry-run blocks when run_id is empty."""
        action = _make_action()

        result = dispatch_gate(action, "", False, _make_claim_graph(), _make_task_graph())

        assert result["passed"] is False
        assert "missing_run_id" in result["blocking_reasons"]

    def test_dry_run_blocks_on_stale_run(self):
        """Dry-run blocks on stale/mixed run_id mismatch."""
        task_graph = _make_claim_graph(run_id="run-2025", claims=[])  # Use claim_graph as task_graph
        # Override to have proper run_id mismatch
        task_graph = {"run_id": "run-2025", "tasks": [{"task_id": "T-run-2025-001", "action_id": "task-t001", "status": "ready"}]}
        claim_graph = _make_claim_graph(claims=[{
            "claim_id": "claim_abc",
            "run_id": "run-2025",
            "status": "confirmed",
            "contradiction_ids": [],
            "gate_failures": 0,
        }])
        action = _make_action()

        result = dispatch_gate(action, "run-2026", False, claim_graph, task_graph)

        assert result["passed"] is False
        # Either stale_run_id or mixed_run should appear as a hard failure
        assert any("stale_run" in r or "mixed_run" in r for r in result["blocking_reasons"])
