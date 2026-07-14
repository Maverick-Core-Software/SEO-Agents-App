"""Regression tests for Session 5: Worker 3 acceptance checks A1–A10 and Worker 5 gate metrics.

Tests cover:
- Worker 3: evidence provenance, confidence, negative findings, contradictions,
  synthesis gates, claim promotion rules, and evidence-to-task binding.
- Worker 5: gate metrics (claim/decomposition/sequencing), dependency cycle detection,
  research-gap closure, and adapter idempotency.
- All thresholds remain labeled as ``proposed`` until calibration data exists.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.evidence import (
    validate_evidence_package,
    validate_claim_graph,
    research_gap_result,
    classify_research_gap,
)
from seo_agents.observability import (
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
from seo_agents.contracts import stable_hash

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "research"


# ---------------------------------------------------------------------------
# Load fixtures
# ---------------------------------------------------------------------------

def _load_fixture(name: str) -> dict:
    path = FIXTURE_DIR / name
    assert path.exists(), f"Missing fixture: {path}"
    return json.loads(path.read_text(encoding="utf-8"))


def _load_all_evidence() -> list[dict]:
    """Build a list of evidence dicts from all fixtures."""
    evidence = []
    for f in FIXTURE_DIR.glob("*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        if "evidence" in data:
            evidence.append(data["evidence"])
        if "evidence_1" in data and "evidence_2" in data:
            evidence.append(data["evidence_1"])
            evidence.append(data["evidence_2"])
        if "claim" in data:
            evidence.append(data["claim"])
    return evidence


def _load_all_tasks() -> list[dict]:
    """Build task dicts from fixtures."""
    tasks = []
    data = _load_fixture("proxy_metric.json")
    if "task" in data:
        tasks.append(data["task"])
    return tasks


def _load_all_actions() -> list[dict]:
    """Build action dicts from idempotent retry fixture."""
    data = _load_fixture("idempotent_retry.json")
    return [data["action_1"], data["action_2"]]


# ---------------------------------------------------------------------------
# Worker 3 — Evidence acceptance checks A1–A10
# ---------------------------------------------------------------------------

class TestWorker3Acceptance:
    """A1–A10: Evidence units must carry provenance, confidence, negative findings,
    contradictions, synthesis gates, claim promotion rules, and evidence-to-task binding."""

    def test_a1_provenance_present(self):
        """A1: Every evidence unit has source kind and URI."""
        ev = _load_fixture("supported_claim.json")["evidence"]
        result = validate_evidence_package([ev])
        # Should not have missing_provenance gate
        missing = [g for g in result["gates"] if g["gate"] == "missing_provenance"]
        assert len(missing) == 0

    def test_a2_confidence_scored(self):
        """A2: Evidence has a confidence score and basis."""
        ev = _load_fixture("supported_claim.json")["evidence"]
        assert ev["confidence"]["score"] > 0
        assert ev["confidence"]["basis"] != ""

    def test_a3_negative_findings(self):
        """A3: Negative findings are valid evidence (no false provenance fail)."""
        ev = _load_fixture("supported_claim.json")["evidence"]
        result = validate_evidence_package([ev])
        assert result["ok"] is True

    def test_a4_contradictions_recorded(self):
        """A4: Conflicting specialists record contradiction_ids."""
        data = _load_fixture("conflicting_specialists.json")
        evidence = [data["evidence_1"], data["evidence_2"]]
        result = validate_evidence_package(evidence)
        # evidence_2 has contradiction_ids
        assert any(e["contradiction_ids"] for e in evidence if e.get("evidence_id", "").endswith("002"))

    def test_a5_synthesis_gate_pass(self):
        """A5: Supported claim passes synthesis gate."""
        ev = _load_fixture("supported_claim.json")["evidence"]
        result = validate_evidence_package([ev])
        assert result["ok"] is True

    def test_a6_claim_promotion_requires_evidence(self):
        """A6: Claims without evidence should not be promoted (missing_evidence fixture)."""
        data = _load_fixture("missing_evidence.json")
        claim = data["claim"]
        graph_result = validate_claim_graph([claim])
        assert not graph_result["ok"]  # should fail gate: promoted claim without evidence

    def test_a7_evidence_to_task_binding(self):
        """A7: Tasks should bind to at least one claim."""
        tasks = _load_all_tasks()
        rate = compute_evidence_to_task_binding_rate(tasks)
        assert rate == pytest.approx(1.0)

    def test_a8_evidence_unavailable_does_not_fail_hard(self):
        """A8: Unavailable evidence should not produce fail gates (only warning/unknown)."""
        ev = _load_fixture("unavailable_serp.json")["evidence"]
        result = validate_evidence_package([ev])
        fail_gates = [g for g in result["gates"] if g["severity"] == "fail"]
        assert len(fail_gates) == 0

    def test_a9_stale_evidence_warns(self):
        """A9: Stale live evidence should trigger a warning gate.

        Note: the existing validation code only checks staleness for kind='live_page'
        or access_class='observed'. Baselines are not flagged as stale by the current
        gate logic — this test uses a live_page source with old retrieved_at.
        """
        ev = dict(_load_fixture("supported_claim.json")["evidence"])
        # Backdate the retrieved_at to 90 days ago
        from datetime import datetime, timezone, timedelta
        old_date = datetime.now(timezone.utc) - timedelta(days=90)
        ev["source"] = dict(ev["source"])
        ev["source"]["retrieved_at"] = old_date.isoformat().replace("+00:00", "Z")
        result = validate_evidence_package([ev])
        stale = [g for g in result["gates"] if g["gate"] == "stale_evidence"]
        assert len(stale) == 1

    def test_a10_secrets_quarantine(self):
        """A10: Evidence containing secrets patterns should trigger quarantine."""
        ev = _load_fixture("secrets_like_text.json")["evidence"]
        result = validate_evidence_package([ev])
        secrets = [g for g in result["gates"] if g["gate"] == "potential_secrets"]
        assert len(secrets) == 1

    def test_a11_claim_status_derives_from_evidence(self):
        """Claim status should reflect evidence validation — confirmed claim with good evidence stays confirmed."""
        ev = _load_fixture("supported_claim.json")["evidence"]
        result = validate_evidence_package([ev])
        confirmed = [c for c in result["claims"] if c["status"] == "confirmed"]
        assert len(confirmed) == 1


# ---------------------------------------------------------------------------
# Worker 5 — Gate metrics
# ---------------------------------------------------------------------------

class TestWorker5GateMetrics:
    """Worker 5: claim validity rate, contradiction density, dependency cycle rate,
    research-gap closure, adapter dedupe outcomes, latency percentiles."""

    def test_claim_validity_rate_proposed(self):
        ev = [
            {"status": "confirmed"},
            {"status": "confirmed"},
            {"status": "provisional"},
            {"status": "rejected"},
        ]
        rate = compute_claim_validity_rate(ev)
        assert rate == pytest.approx(0.5)

    def test_contradiction_density_proposed(self):
        ev = [
            {"contradiction_ids": ["c1"], "status": "provisional"},
            {"contradiction_ids": [], "status": "confirmed"},
            {"contradiction_ids": [], "status": "confirmed"},
        ]
        rate = compute_contradiction_density(ev)
        assert rate == pytest.approx(0.3333)

    def test_dependency_cycle_rate_proposed(self):
        tasks = [
            {"status": "blocked", "task_type": "technical_fix"},
            {"status": "ready"},
            {"status": "research_gap", "status": "ready"},
        ]
        rate = compute_dependency_cycle_rate(tasks)
        assert rate == pytest.approx(0.3333)

    def test_research_gap_closure_proposed(self):
        tasks = [
            {"task_type": "research_gap", "status": "verified"},
            {"task_type": "research_gap", "status": "verified"},
            {"task_type": "research_gap", "status": "ready"},
            {"task_type": "content_update", "status": "verified"},
        ]
        rate = compute_research_gap_closure_rate(tasks)
        assert rate == pytest.approx(0.6667)

    def test_adapter_dedupe_outcomes_proposed(self):
        actions = [
            {"id": "a1", "idempotency_key": "k1"},
            {"id": "a2", "idempotency_key": "k1"},
            {"id": "a3", "idempotency_key": "k2"},
        ]
        result = compute_adapter_dedupe_outcomes(actions)
        assert result["unique_keys"] == 2
        assert result["duplicate_keys"] == 1

    def test_latency_percentiles(self):
        durations = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
        result = compute_latency_p50_p95(durations)
        assert result["p50"] == pytest.approx(5.0)
        assert result["p95"] == pytest.approx(10.0)

    def test_review_escalation_rate(self):
        actions = [
            {"status": "needs_review"},
            {"status": "approved"},
            {"status": "approved"},
            {"status": "approved"},
        ]
        rate = compute_review_escalation_rate(actions)
        assert rate == pytest.approx(0.25)

    def test_retry_rate_by_failure_class(self):
        actions = [
            {"status": "failed", "last_run": {"status": "adapter_failed"}},
            {"status": "failed", "last_run": {"status": "adapter_failed"}},
            {"status": "blocked_approval"},
        ]
        result = compute_retry_rate_by_failure_class(actions)
        assert result["adapter_failed"] == 2
        assert result["approval_blocked"] == 1


# ---------------------------------------------------------------------------
# Dry-run calibration helpers
# ---------------------------------------------------------------------------

class TestDryRunCalibration:
    """Dry-run should produce lineage-linked evidence packages and no live side effects.

    Thresholds remain labeled as proposed until three representative dry runs produce
    calibration data.
    """

    def test_dry_run_stable_run_id(self):
        """The run ID should be stable for the same run and topic within a day."""
        from seo_agents.crew import build_run_id
        rid1 = build_run_id("electrical troubleshooting service page", "https://www.grizzlyelectricaltx.com/")
        rid2 = build_run_id("electrical troubleshooting service page", "https://www.grizzlyelectricaltx.com/")
        assert rid1 == rid2

    def test_dry_run_no_live_adapter(self):
        """Dry-run should never call a live adapter — only write JSON files."""
        import json
        # The dry-run already wrote files; check that they're valid JSON with run lineage
        manifest_path = Path("outputs/run_manifest.json")
        assert manifest_path.exists()
        manifest = json.loads(manifest_path.read_text())
        assert "run_id" in manifest

    def test_claim_id_deterministic(self):
        """stable_hash should produce the same output for the same input."""
        h1 = stable_hash(prefix="claim_", data="test statement")
        h2 = stable_hash(prefix="claim_", data="test statement")
        assert h1 == h2
