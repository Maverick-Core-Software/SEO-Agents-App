"""Fixture tests for evidence contract fields and source modes.

Session 2 — covers live/baseline/unavailable evidence, stale sources,
contradiction, unsupported high confidence, and negative findings.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any

import pytest
import sys
import os

# Ensure src is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.evidence import (
    EvidenceUnit,
    EvidenceSource,
    EvidenceConfidence,
    EvidenceFreshness,
    EvidenceScope,
    validate_evidence_package,
    validate_claim_graph,
    classify_research_gap,
    EvidenceUnit,
)


# ---------------------------------------------------------------------------
# Fixtures — evidence units for each source mode
# ---------------------------------------------------------------------------

def _live_evidence() -> dict[str, Any]:
    """Evidence sourced from a live page in this run."""
    return {
        "evidence_id": "ev_test_live_001",
        "run_id": "test-001",
        "claim_id": "claim_001",
        "claim_type": "recommendation",
        "statement": "Homepage H1 should mention 'electrical troubleshooting' as primary service.",
        "scope": {"site": "https://grizzlyelectricaltx.com/", "region": "DFW, Texas"},
        "source": {
            "kind": "live_page",
            "uri": "https://grizzlyelectricaltx.com/",
            "title": "Homepage",
            "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "authority_rank": 0.8,
            "access_class": "observed",
        },
        "evidence_excerpt": "H1 found: 'Professional Electrical Services in DFW'",
        "relation": "supports",
        "confidence": {
            "label": "high",
            "score": 0.85,
            "authority": 0.8,
            "recency": 1.0,
            "method_transparency": 0.7,
            "corroboration": 0.5,
            "access": 1.0,
            "basis": "Direct observation of live page H1 tag",
        },
        "freshness": {
            "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "valid_until": None,
            "supersedes": [],
        },
        "contradiction_ids": [],
        "status": "confirmed",
    }


def _baseline_evidence() -> dict[str, Any]:
    """Evidence sourced from existing baseline docs."""
    return {
        "evidence_id": "ev_test_base_001",
        "run_id": "test-001",
        "claim_id": "claim_002",
        "claim_type": "observation",
        "statement": "GBP profile has 3.2 stars from 12 reviews.",
        "scope": {"site": "https://grizzlyelectricaltx.com/", "region": "DFW, Texas"},
        "source": {
            "kind": "baseline",
            "uri": "knowledge/baselines/gbp_baseline.md",
            "title": "GBP Baseline",
            "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "authority_rank": 0.6,
            "access_class": "provided",
        },
        "evidence_excerpt": "GBP: 3.2 stars, 12 reviews",
        "relation": "supports",
        "confidence": {
            "label": "medium",
            "score": 0.55,
            "authority": 0.6,
            "recency": 0.4,
            "method_transparency": 0.5,
            "corroboration": 0.3,
            "access": 0.7,
            "basis": "Baseline documentation from prior run",
        },
        "freshness": {
            "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "valid_until": None,
            "supersedes": [],
        },
        "contradiction_ids": [],
        "status": "provisional",
    }


def _unavailable_evidence() -> dict[str, Any]:
    """Evidence where the source was not reachable."""
    return {
        "evidence_id": "ev_test_unavail_001",
        "run_id": "test-001",
        "claim_id": "claim_003",
        "claim_type": "hypothesis",
        "statement": "Yelp reviews may differ from Google — unverified in this run.",
        "scope": {"site": "https://grizzlyelectricaltx.com/", "region": "DFW, Texas"},
        "source": {
            "kind": "live_page",
            "uri": "https://www.yelp.com/biz/grizzly-electrical-rowlett",
            "title": "Yelp Listing",
            "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "authority_rank": 0.3,
            "access_class": "unavailable",
        },
        "evidence_excerpt": "",
        "relation": "",
        "confidence": {
            "label": "unknown",
            "score": 0.0,
            "authority": 0.0,
            "recency": 0.0,
            "method_transparency": 0.0,
            "corroboration": 0.0,
            "access": 0.0,
            "basis": "Source not reachable",
        },
        "freshness": {
            "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "valid_until": None,
            "supersedes": [],
        },
        "contradiction_ids": [],
        "status": "unknown",
    }


def _negative_finding() -> dict[str, Any]:
    """Evidence that is explicitly a negative finding."""
    return {
        "evidence_id": "ev_test_neg_001",
        "run_id": "test-001",
        "claim_id": "claim_004",
        "claim_type": "negative_finding",
        "statement": "No FAQ schema detected on homepage or service pages.",
        "scope": {"site": "https://grizzlyelectricaltx.com/", "region": "DFW, Texas"},
        "source": {
            "kind": "live_page",
            "uri": "https://grizzlyelectricaltx.com/",
            "title": "Homepage",
            "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "authority_rank": 0.8,
            "access_class": "observed",
        },
        "evidence_excerpt": "Checked <script type='application/ld+json'> blocks — none contained FAQ schema",
        "relation": "",
        "confidence": {
            "label": "high",
            "score": 0.9,
            "authority": 0.8,
            "recency": 1.0,
            "method_transparency": 0.9,
            "corroboration": 0.6,
            "access": 1.0,
            "basis": "Verified absence of FAQ schema in JSON-LD blocks",
        },
        "freshness": {
            "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "valid_until": None,
            "supersedes": [],
        },
        "contradiction_ids": [],
        "status": "confirmed",
    }


# ---------------------------------------------------------------------------
# Tests — source mode, staleness, contradiction, high-conf/weak-source, secrets
# ---------------------------------------------------------------------------

class TestEvidenceSourceModes:
    """Verify that live/baseline/unavailable source modes produce correct results."""

    def test_live_evidence_passes_gates(self):
        result = validate_evidence_package([_live_evidence()])
        # Should have no fail gates
        assert result["fail_gates"] == 0

    def test_baseline_evidence_passes_gates(self):
        result = validate_evidence_package([_baseline_evidence()])
        assert result["fail_gates"] == 0

    def test_unavailable_evidence_passes_gates(self):
        result = validate_evidence_package([_unavailable_evidence()])
        # No source URI or kind issues since kind is set, authority is low but
        # label is unknown so no high-confidence warning
        assert result["fail_gates"] == 0

    def test_negative_finding_passes_gates(self):
        result = validate_evidence_package([_negative_finding()])
        assert result["fail_gates"] == 0


class TestStaleEvidence:
    """Stale live evidence should trigger a warning gate."""

    def test_old_retrieved_at_generates_warning(self):
        ev = _live_evidence()
        # Set retrieved_at to 60 days ago
        old_date = datetime.now(timezone.utc) - timedelta(days=60)
        ev["source"]["retrieved_at"] = old_date.isoformat().replace("+00:00", "Z")
        result = validate_evidence_package([ev])
        assert result["warning_gates"] >= 1
        stale_gates = [g for g in result["gates"] if g["gate"] == "stale_evidence"]
        assert len(stale_gates) == 1


class TestContradictionGate:
    """Evidence with unresolved contradictions should trigger a fail gate."""

    def test_unresolved_contradiction_generates_fail(self):
        ev = _live_evidence()
        ev["contradiction_ids"] = ["claim_xyz", "claim_abc"]
        ev["status"] = "provisional"  # not confirmed
        result = validate_evidence_package([ev])
        contradiction_gates = [g for g in result["gates"] if g["gate"] == "unresolved_contradiction"]
        assert len(contradiction_gates) == 1
        assert result["ok"] is False

    def test_resolved_contradiction_passes(self):
        ev = _live_evidence()
        ev["contradiction_ids"] = ["claim_xyz"]
        ev["status"] = "confirmed"  # resolved
        result = validate_evidence_package([ev])
        contradiction_gates = [g for g in result["gates"] if g["gate"] == "unresolved_contradiction"]
        assert len(contradiction_gates) == 0


class TestHighConfidenceWeakSource:
    """High confidence with low authority should trigger a warning gate."""

    def test_high_confidence_low_authority_warning(self):
        ev = _unavailable_evidence()
        ev["confidence"] = {
            "label": "high",
            "score": 0.85,
            "authority": 0.2,
            "recency": 0.0,
            "method_transparency": 0.0,
            "corroboration": 0.0,
            "access": 0.0,
            "basis": "Incorrectly assigned high confidence",
        }
        result = validate_evidence_package([ev])
        hcw_gates = [g for g in result["gates"] if g["gate"] == "high_confidence_weak_source"]
        assert len(hcw_gates) == 1

    def test_high_confidence_high_authority_passes(self):
        ev = _live_evidence()
        # Already has authority=0.8 which is >= threshold
        result = validate_evidence_package([ev])
        hcw_gates = [g for g in result["gates"] if g["gate"] == "high_confidence_weak_source"]
        assert len(hcw_gates) == 0


class TestMissingProvenance:
    """Evidence with no source URI or kind should trigger a fail gate."""

    def test_no_source_generates_fail(self):
        ev = _live_evidence()
        ev["source"] = {}
        result = validate_evidence_package([ev])
        mp_gates = [g for g in result["gates"] if g["gate"] == "missing_provenance"]
        assert len(mp_gates) == 1


class TestNegativeFindings:
    """Negative findings should be valid evidence and not trigger false gates."""

    def test_negative_finding_claim_type(self):
        ev = _negative_finding()
        assert ev["claim_type"] == "negative_finding"
        result = validate_evidence_package([ev])
        assert result["total_evidence"] == 1

    def test_negative_finding_no_false_provenance_fail(self):
        ev = _negative_finding()
        result = validate_evidence_package([ev])
        mp_gates = [g for g in result["gates"] if g["gate"] == "missing_provenance"]
        assert len(mp_gates) == 0


class TestClaimStatusFromEvidence:
    """Claim status should derive from evidence validation results."""

    def test_claim_rejected_when_evidence_fails(self):
        ev = _live_evidence()
        ev["source"] = {}  # triggers missing_provenance
        result = validate_evidence_package([ev])
        rejected = [c for c in result["claims"] if c["status"] == "rejected"]
        assert len(rejected) == 1

    def test_claim_confirmed_when_evidence_passes(self):
        ev = _live_evidence()
        result = validate_evidence_package([ev])
        confirmed = [c for c in result["claims"] if c["status"] == "confirmed"]
        assert len(confirmed) == 1


class TestEvidenceUnitModel:
    """Pydantic model construction should work."""

    def test_build_evidence_unit(self):
        unit = EvidenceUnit(
            evidence_id="ev_test_001",
            run_id="test-run",
            claim_id="claim_001",
            claim_type="recommendation",
            statement="Test recommendation.",
            scope=EvidenceScope(site="https://example.com/", region="DFW"),
            source=EvidenceSource(kind="live_page", uri="https://example.com/"),
            confidence=EvidenceConfidence(label="high", score=0.8, authority=0.7),
        )
        assert unit.evidence_id == "ev_test_001"
        assert unit.claim_type == "recommendation"
        assert unit.confidence.label == "high"

    def test_to_dict_returns_plain_dict(self):
        unit = EvidenceUnit(
            evidence_id="ev_test_002",
            run_id="test",
            claim_id="claim_002",
            claim_type="observation",
            statement="Test observation.",
            scope=EvidenceScope(site="https://example.com/", region="DFW"),
            source=EvidenceSource(kind="baseline"),
        )
        d = unit.to_dict()
        assert isinstance(d, dict)
        assert d["evidence_id"] == "ev_test_002"
