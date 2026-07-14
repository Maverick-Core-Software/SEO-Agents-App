"""Tests for synthesis gate logic added in Session 2.

Covers gate logic in evidence.py and wiring into status.py:
- Missing provenance causes gate failure
- Stale evidence triggers warnings
- High confidence on weak sources triggers warnings
- Unresolved contradictions cause gate failure
- Secrets detection triggers gate failure
- Research gap classification
- Claim graph gates (promoted without evidence, high-conf with contradictions)
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.evidence import (
    validate_evidence_package,
    validate_claim_graph,
    classify_research_gap,
    research_gap_result,
)
from seo_agents.status import _add_evidence_gate_issues


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_evidence(**kw) -> dict:
    defaults = {
        "evidence_id": "ev_test_001",
        "run_id": "test-001",
        "claim_id": "claim_001",
        "claim_type": "recommendation",
        "statement": "Test statement.",
        "scope": {"site": "https://example.com/", "region": "DFW"},
        "source": {
            "kind": "live_page",
            "uri": "https://example.com/",
            "title": "Test",
            "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "authority_rank": 0.8,
            "access_class": "observed",
        },
        "evidence_excerpt": "",
        "relation": "supports",
        "confidence": {
            "label": "high", "score": 0.85, "authority": 0.8,
            "recency": 1.0, "method_transparency": 0.7,
            "corroboration": 0.5, "access": 1.0, "basis": "Direct observation",
        },
        "freshness": {
            "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "valid_until": None, "supersedes": [],
        },
        "contradiction_ids": [],
        "status": "confirmed",
    }
    defaults.update(kw)
    return defaults


def _make_claim(**kw) -> dict:
    defaults = {
        "claim_id": "claim_001",
        "claim_type": "recommendation",
        "statement": "Test.",
        "evidence_ids": ["ev_test_001"],
        "confidence": "high",
        "status": "confirmed",
        "contradiction_ids": [],
    }
    defaults.update(kw)
    return defaults


# ---------------------------------------------------------------------------
# Evidence package gate tests
# ---------------------------------------------------------------------------

class TestEvidencePackageGates:

    def test_missing_provenance_gate(self):
        ev = _make_evidence(source={})
        result = validate_evidence_package([ev])
        assert any(g["gate"] == "missing_provenance" and g["severity"] == "fail" for g in result["gates"])
        assert result["ok"] is False

    def test_stale_evidence_warning(self):
        ev = _make_evidence()
        old = datetime.now(timezone.utc) - timedelta(days=60)
        ev["source"]["retrieved_at"] = old.isoformat().replace("+00:00", "Z")
        result = validate_evidence_package([ev])
        assert any(g["gate"] == "stale_evidence" and g["severity"] == "warning" for g in result["gates"])

    def test_high_conf_weak_source(self):
        ev = _make_evidence(confidence={"label": "high", "score": 0.9, "authority": 0.1, "recency": 0.0, "method_transparency": 0.0, "corroboration": 0.0, "access": 0.0, "basis": "Bad"})
        result = validate_evidence_package([ev])
        assert any(g["gate"] == "high_confidence_weak_source" and g["severity"] == "warning" for g in result["gates"])

    def test_unresolved_contradiction_gate(self):
        ev = _make_evidence(contradiction_ids=["claim_xyz"], status="provisional")
        result = validate_evidence_package([ev])
        assert any(g["gate"] == "unresolved_contradiction" and g["severity"] == "fail" for g in result["gates"])

    def test_secrets_in_excerpt(self):
        ev = _make_evidence(evidence_excerpt="api_key: abc123def456secret")
        result = validate_evidence_package([ev])
        assert any(g["gate"] == "potential_secrets" and g["severity"] == "fail" for g in result["gates"])

    def test_clean_evidence_ok(self):
        ev = _make_evidence()
        result = validate_evidence_package([ev])
        assert result["ok"] is True
        assert result["fail_gates"] == 0


# ---------------------------------------------------------------------------
# Claim graph gate tests
# ---------------------------------------------------------------------------

class TestClaimGraphGates:

    def test_promoted_claim_no_evidence(self):
        claim = _make_claim(status="confirmed", evidence_ids=[], claim_id="claim_no_ev")
        result = validate_claim_graph([claim])
        assert any(g["gate"] == "promoted_claim_no_evidence" and g["severity"] == "fail" for g in result["gates"])
        assert result["ok"] is False

    def test_high_conf_with_contradiction(self):
        claim = _make_claim(confidence="high", contradiction_ids=["claim_xyz", "claim_abc"])
        result = validate_claim_graph([claim])
        assert any(g["gate"] == "high_confidence_with_contradiction" and g["severity"] == "fail" for g in result["gates"])
        assert result["ok"] is False

    def test_clean_claim_graph_ok(self):
        claim = _make_claim()
        result = validate_claim_graph([claim])
        assert result["ok"] is True


# ---------------------------------------------------------------------------
# Research gap classification tests
# ---------------------------------------------------------------------------

class TestResearchGapClassification:

    def test_unknown_claim_is_gap(self):
        claims = [
            {"claim_id": "claim_unknown", "status": "unknown", "claim_type": "hypothesis", "contradiction_ids": []},
        ]
        gaps = classify_research_gap([], claims)
        assert len(gaps) == 1
        assert gaps[0]["claim_id"] == "claim_unknown"

    def test_rejected_claim_is_gap(self):
        claims = [
            {"claim_id": "claim_rejected", "status": "rejected", "claim_type": "recommendation", "contradiction_ids": ["claim_xyz"]},
        ]
        gaps = classify_research_gap([], claims)
        assert len(gaps) == 1
        assert gaps[0]["blocked_by"] == ["claim_xyz"]

    def test_confirmed_claim_not_gap(self):
        claims = [
            {"claim_id": "claim_ok", "status": "confirmed", "claim_type": "recommendation", "contradiction_ids": []},
        ]
        gaps = classify_research_gap([], claims)
        assert len(gaps) == 0


class TestResearchGapResult:
    """research_gap_result should return True when there are enough failures."""

    def test_no_failures_returns_false(self):
        ev = _make_evidence()
        assert research_gap_result([ev]) is False

    def test_rejected_evidence_returns_true(self):
        ev = _make_evidence(source={})  # triggers fail gate
        assert research_gap_result([ev]) is True
