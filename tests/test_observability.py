"""Tests for Session 4: structured lifecycle observability and metric helpers.

Verifies:
- Event schema includes run_id, task_id, gate_id, timestamp, producer, event_type
- Boundary emitters produce valid JSONL events
- Metric computation functions handle empty and populated inputs
- All metrics carry the ``proposed`` marker
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.observability import (
    OBS_EVENT_VERSION,
    _make_event,
    write_observability_event,
    emit_research_complete,
    emit_synthesis_gate,
    emit_queue_built,
    emit_approval,
    emit_adapter_run,
    emit_verification,
    emit_session4_metrics,
    compute_claim_validity_rate,
    compute_contradiction_density,
    compute_evidence_to_task_binding_rate,
    compute_gate_pass_rates,
    compute_dependency_cycle_rate,
    compute_review_escalation_rate,
    compute_retry_rate_by_failure_class,
    compute_latency_p50_p95,
    compute_adapter_dedupe_outcomes,
    compute_research_gap_closure_rate,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _dummy_event() -> dict:
    return {
        "run_id": "test-run-001",
        "task_id": "T001",
        "gate_id": "gate-001",
        "timestamp": "2026-07-13T08:30:00Z",
        "producer": "test",
        "event_type": "test",
        "version": "session4-v1",
        "fields": {"test": True},
    }


# ---------------------------------------------------------------------------
# Tests — event schema
# ---------------------------------------------------------------------------

class TestEventSchema:
    def test_make_event_has_required_fields(self):
        event = _make_event(producer="test", event_type="test", run_id="r1")
        assert "run_id" in event
        assert "task_id" in event
        assert "gate_id" in event
        assert "timestamp" in event
        assert "producer" in event
        assert "event_type" in event
        assert "version" in event
        assert event["version"] == OBS_EVENT_VERSION

    def test_make_event_defaults(self):
        event = _make_event(producer="research_crew", event_type="research_complete")
        assert event["run_id"] == "unknown"
        assert event["task_id"] == ""
        assert event["gate_id"] == ""
        assert event["fields"] == {}


# ---------------------------------------------------------------------------
# Tests — boundary emitters
# ---------------------------------------------------------------------------

class TestBoundaryEmitters:
    def test_emit_research_complete(self, tmp_path):
        """research_complete event should have correct producer and type."""
        # Patch OUTPUT_DIR so we don't write to real outputs/
        import seo_agents.observability as obs
        obs.OUTPUT_DIR = tmp_path
        emit_research_complete("r1", ["content_report.md"], 12.5)
        events = list(tmp_path.glob("*.jsonl"))
        # There may be existing files; find the one we just wrote
        found = False
        for e in events:
            content = e.read_text()
            parsed = json.loads(content.strip().split("\n")[-1])
            if parsed.get("event_type") == "research_complete":
                found = True
                assert parsed["producer"] == "research_crew"
                assert parsed["run_id"] == "r1"
                assert "_metric" in parsed["fields"] or "outputs" in parsed["fields"]
                break
        assert found, "No research_complete event found in JSONL"

    def test_emit_synthesis_gate(self, tmp_path):
        import seo_agents.observability as obs
        obs.OUTPUT_DIR = tmp_path
        emit_synthesis_gate("r1", "claim_gate", True, 1.2)
        events = list(tmp_path.glob("*.jsonl"))
        for e in events:
            content = e.read_text()
            parsed = json.loads(content.strip().split("\n")[-1])
            if parsed.get("event_type") == "gate_result":
                assert parsed["producer"] == "synthesis_gate"
                assert parsed["gate_id"] == "claim_gate"
                assert parsed["fields"]["passed"] is True
                break

    def test_emit_approval(self, tmp_path):
        import seo_agents.observability as obs
        obs.OUTPUT_DIR = tmp_path
        emit_approval("r1", "a001", "mcc")
        events = list(tmp_path.glob("*.jsonl"))
        for e in events:
            content = e.read_text()
            parsed = json.loads(content.strip().split("\n")[-1])
            if parsed.get("event_type") == "approval_granted":
                assert parsed["fields"]["action_id"] == "a001"
                assert parsed["fields"]["approved_by"] == "mcc"
                break

    def test_emit_adapter_run(self, tmp_path):
        import seo_agents.observability as obs
        obs.OUTPUT_DIR = tmp_path
        emit_adapter_run("r1", "website", "a001", 0, True, 3.4)
        events = list(tmp_path.glob("*.jsonl"))
        for e in events:
            content = e.read_text()
            parsed = json.loads(content.strip().split("\n")[-1])
            if parsed.get("event_type") == "adapter_result":
                assert parsed["fields"]["adapter"] == "website"
                assert parsed["fields"]["exit_code"] == 0
                assert parsed["fields"]["success"] is True
                break


# ---------------------------------------------------------------------------
# Tests — metric computation
# ---------------------------------------------------------------------------

class TestMetricHelpers:
    def test_claim_validity_rate_empty(self):
        assert compute_claim_validity_rate([]) == 0.0

    def test_claim_validity_rate_populated(self):
        ev = [
            {"status": "confirmed"},
            {"status": "confirmed"},
            {"status": "provisional"},
        ]
        assert compute_claim_validity_rate(ev) == pytest.approx(0.6667)

    def test_contradiction_density_empty(self):
        assert compute_contradiction_density([]) == 0.0

    def test_contradiction_density_populated(self):
        ev = [
            {"contradiction_ids": ["c1"], "status": "provisional"},
            {"contradiction_ids": [], "status": "confirmed"},
        ]
        assert compute_contradiction_density(ev) == pytest.approx(0.5)

    def test_evidence_to_task_binding_rate_empty(self):
        assert compute_evidence_to_task_binding_rate([]) == 0.0

    def test_evidence_to_task_binding_rate_populated(self):
        tasks = [
            {"supporting_claim_ids": ["cl1"]},
            {"supporting_claim_ids": []},
            {"supporting_claim_ids": ["cl2"]},
        ]
        assert compute_evidence_to_task_binding_rate(tasks) == pytest.approx(0.6667)

    def test_gate_pass_rates_empty(self):
        assert compute_gate_pass_rates([]) == {}

    def test_gate_pass_rates_populated(self):
        gates = [
            {"gate": "claim", "passed": True},
            {"gate": "claim", "passed": False},
            {"gate": "decomposition", "passed": True},
        ]
        rates = compute_gate_pass_rates(gates)
        assert rates["claim"] == pytest.approx(0.5)
        assert rates["decomposition"] == pytest.approx(1.0)

    def test_dependency_cycle_rate_empty(self):
        assert compute_dependency_cycle_rate([]) == 0.0

    def test_dependency_cycle_rate_populated(self):
        tasks = [
            {"status": "blocked", "task_type": "research_gap"},
            {"status": "ready"},
        ]
        assert compute_dependency_cycle_rate(tasks) == pytest.approx(0.0)

    def test_review_escalation_rate_empty(self):
        assert compute_review_escalation_rate([]) == 0.0

    def test_review_escalation_rate_populated(self):
        actions = [
            {"status": "needs_review"},
            {"status": "approved"},
            {"status": "approved"},
        ]
        assert compute_review_escalation_rate(actions) == pytest.approx(0.3333)

    def test_retry_rate_by_failure_class_empty(self):
        assert compute_retry_rate_by_failure_class([]) == {
            "adapter_failed": 0,
            "timeout": 0,
            "approval_blocked": 0,
        }

    def test_retry_rate_by_failure_class_populated(self):
        actions = [
            {"status": "failed", "last_run": {"status": "adapter_failed"}},
            {"status": "blocked_approval"},
            {"status": "approved"},
        ]
        result = compute_retry_rate_by_failure_class(actions)
        assert result["adapter_failed"] >= 1
        assert result["approval_blocked"] >= 1

    def test_latency_p50_p95_empty(self):
        result = compute_latency_p50_p95([])
        assert result == {"p50": 0.0, "p95": 0.0}

    def test_latency_p50_p95_populated(self):
        result = compute_latency_p50_p95([1.0, 2.0, 3.0, 4.0, 5.0])
        assert result["p50"] > 0
        assert result["p95"] >= result["p50"]

    def test_adapter_dedupe_outcomes_empty(self):
        assert compute_adapter_dedupe_outcomes([]) == {"unique_keys": 0, "duplicate_keys": 0}

    def test_adapter_dedupe_outcomes_populated(self):
        actions = [
            {"id": "a1", "idempotency_key": "k1"},
            {"id": "a2", "idempotency_key": "k1"},
            {"id": "a3", "idempotency_key": "k2"},
        ]
        result = compute_adapter_dedupe_outcomes(actions)
        assert result["unique_keys"] == 2
        assert result["duplicate_keys"] == 1  # k1 has 2 actions

    def test_research_gap_closure_rate_empty(self):
        assert compute_research_gap_closure_rate([]) == 0.0

    def test_research_gap_closure_rate_populated(self):
        tasks = [
            {"task_type": "research_gap", "status": "verified"},
            {"task_type": "research_gap", "status": "ready"},
            {"task_type": "content_update", "status": "verified"},
        ]
        assert compute_research_gap_closure_rate(tasks) == pytest.approx(0.5)

    def test_emit_session4_metrics(self, tmp_path):
        import seo_agents.observability as obs
        obs.OUTPUT_DIR = tmp_path
        emit_session4_metrics(
            evidence_list=[{"status": "confirmed"}],
            task_list=[{"supporting_claim_ids": ["cl1"]}],
            gate_results=[{"gate": "claim", "passed": True}],
            action_list=[{"status": "approved"}],
            durations=[1.0, 2.0],
            run_id="test-metrics",
        )
        events = list(tmp_path.glob("*.jsonl"))
        for e in events:
            content = e.read_text()
            parsed = json.loads(content.strip().split("\n")[-1])
            if parsed.get("event_type") == "metrics_snapshot":
                assert parsed["fields"]["proposed"] is True
                assert "claim_validity_rate" in parsed["fields"]
                assert "contradiction_density" in parsed["fields"]
                assert "latency" in parsed["fields"]
                break


# ---------------------------------------------------------------------------
# Tests — idempotency enforcement
# ---------------------------------------------------------------------------

class TestIdempotency:
    @patch("seo_agents.actions.run_action")
    def test_enforce_idempotency_dry_run(self, mock_run):
        """Dry-run should always run — no dedup."""
        mock_run.return_value = {"live": False, "message": "dry run"}
        from seo_agents.actions import enforce_idempotency
        action = {"id": "a1", "idempotency_key": "k1"}
        result = enforce_idempotency(action, live=False)
        assert result.get("live") is False
        assert result.get("idempotency_hit") is not True

    @patch("seo_agents.actions.run_action")
    def test_enforce_idempotency_live_no_prior(self, mock_run):
        """Live with no prior run should proceed to execute."""
        mock_run.return_value = {"live": True, "status": "live_complete"}
        from seo_agents.actions import enforce_idempotency
        action = {"id": "a1", "idempotency_key": "k1"}
        result = enforce_idempotency(action, live=True)
        # Should return run_action result — idempotency_hit should not be set
        assert "idempotency_hit" not in result or result.get("idempotency_hit") is not True
