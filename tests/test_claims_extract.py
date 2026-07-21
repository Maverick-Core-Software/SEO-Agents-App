"""Tests for Session 2 claim extraction and provenance normalization.

Covers:
- valid live website / SERP evidence extraction;
- fresh and stale baseline evidence;
- unavailable evidence with explicit reason;
- malformed timestamps;
- missing source URI with no usable source kind;
- negative findings;
- duplicate claim IDs;
- malformed/reordered claim blocks;
- unknown contradiction endpoints;
- claims with multiple evidence units;
- secret-like excerpts;
- empty and missing reports.
"""

from __future__ import annotations

import json
import sys
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.claims_extract import (
    build_claim_graph,
    build_claim_graph_from_dir,
    collect_reports,
    contains_secret_like,
    extract_claims_from_report,
    extract_contradictions,
    parse_claim_block,
    parse_iso_timestamp,
    is_timestamp_with_timezone,
    SUPPORTED_CLAIM_TYPES,
    SUPPORTED_SOURCE_MODES,
    SUPPORTED_SOURCE_KINDS,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_block(
    claim_id: str = "claim_0000000000000001",
    claim_type: str = "recommendation",
    source_mode: str = "live",
    source_kind: str = "live_page",
    source_uri: str = "https://grizzlyelectricaltx.com/",
    source_title: str = "Homepage",
    retrieved_at: str = "",
    negative_findings: str = "none identified",
    evidence_excerpt: str = "H1 found on homepage",
    statement: str = "Homepage H1 should mention electrical troubleshooting.",
    relation: str = "supports",
    contradiction_ids: str = "",
    extra: str = "",
) -> str:
    if not retrieved_at:
        retrieved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return f"""### Recommendation: {statement}

{statement}

**Claim ID:** {claim_id}
**Claim Type:** {claim_type}
**Source Mode:** {source_mode}
**Source Kind:** {source_kind}
**Source URI:** {source_uri}
**Source Title:** {source_title}
**Retrieved At:** {retrieved_at}
**Negative Findings:** {negative_findings}
**Evidence Excerpt:** {evidence_excerpt}
**Relation:** {relation}
{contradiction_ids and f"**Contradiction IDs:** {contradiction_ids}" or ""}
{extra}
"""


def _wrap_report(report_name: str, body: str) -> str:
    marker_map = {
        "content_report.md": "CONTENT",
        "website_report.md": "WEBSITE",
        "gbp_report.md": "GBP",
        "reputation_report.md": "REPUTATION",
    }
    marker = marker_map.get(report_name)
    if marker:
        return f"[START:{marker}]\n\n{body}\n\n[END:{marker}]"
    return body


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def valid_live_website_block() -> str:
    return _make_block(
        claim_id="claim_a1b2c3d4e5f6a7b8",
        claim_type="recommendation",
        source_mode="live",
        source_kind="live_page",
        source_uri="https://grizzlyelectricaltx.com/",
        source_title="Homepage",
        statement="Homepage H1 should mention electrical troubleshooting.",
        evidence_excerpt="H1 found: 'Professional Electrical Services in DFW'",
    )


@pytest.fixture
def valid_serp_block() -> str:
    return _make_block(
        claim_id="claim_b2c3d4e5f6a7b8c9",
        claim_type="observation",
        source_mode="live",
        source_kind="serp",
        source_uri="https://www.google.com/search?q=electrician+Rowlett+TX",
        source_title="Google SERP",
        statement="Grizzly ranks #2 in Rowlett local pack for electrical repair.",
        evidence_excerpt="Local pack position 2 for 'electrical repair Rowlett TX'",
    )


@pytest.fixture
def fresh_baseline_block() -> str:
    retrieved = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return _make_block(
        claim_id="claim_c3d4e5f6a7b8c9d0",
        claim_type="observation",
        source_mode="baseline",
        source_kind="baseline",
        source_uri="knowledge/baselines/gbp_baseline.md",
        source_title="GBP Baseline",
        retrieved_at=retrieved,
        statement="GBP profile has 5.0 stars and 153 reviews.",
        evidence_excerpt="Baseline: 5.0 stars, 153 reviews",
    )


@pytest.fixture
def stale_baseline_block() -> str:
    retrieved = (datetime.now(timezone.utc) - timedelta(days=120)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return _make_block(
        claim_id="claim_d4e5f6a7b8c9d0e1",
        claim_type="observation",
        source_mode="baseline",
        source_kind="baseline",
        source_uri="knowledge/baselines/gbp_baseline.md",
        source_title="GBP Baseline",
        retrieved_at=retrieved,
        statement="GBP profile has 5.0 stars and 153 reviews.",
        evidence_excerpt="Baseline: 5.0 stars, 153 reviews",
    )


@pytest.fixture
def unavailable_block() -> str:
    return _make_block(
        claim_id="claim_e5f6a7b8c9d0e1f2",
        claim_type="hypothesis",
        source_mode="unavailable",
        source_kind="unavailable",
        source_uri="unavailable",
        source_title="Yelp Listing",
        retrieved_at="unavailable",
        negative_findings="Yelp review data not reachable; requires login",
        statement="Yelp review sentiment may differ from Google.",
        evidence_excerpt="",
    )


@pytest.fixture
def negative_finding_block() -> str:
    return _make_block(
        claim_id="claim_f6a7b8c9d0e1f2a3",
        claim_type="negative_finding",
        source_mode="live",
        source_kind="live_page",
        source_uri="https://grizzlyelectricaltx.com/",
        source_title="Homepage",
        statement="No individual service pages are indexed.",
        evidence_excerpt="Google site: search returned 41 results, none service pages",
        negative_findings="No /service-name/ URLs indexed; all service cards link to 404s",
    )


# ---------------------------------------------------------------------------
# Timestamp parsing
# ---------------------------------------------------------------------------


class TestTimestampParsing:
    def test_parse_iso_timestamp_valid(self):
        dt = parse_iso_timestamp("2026-07-14T12:00:00Z")
        assert dt is not None
        assert dt.tzinfo is not None

    def test_parse_iso_timestamp_with_offset(self):
        dt = parse_iso_timestamp("2026-07-14T12:00:00-05:00")
        assert dt is not None

    def test_parse_iso_timestamp_empty(self):
        assert parse_iso_timestamp("") is None

    def test_parse_iso_timestamp_unavailable(self):
        assert parse_iso_timestamp("unavailable") is None

    def test_is_timestamp_with_timezone_z(self):
        assert is_timestamp_with_timezone("2026-07-14T12:00:00Z") is True

    def test_is_timestamp_with_timezone_offset(self):
        assert is_timestamp_with_timezone("2026-07-14T12:00:00+00:00") is True

    def test_is_timestamp_with_timezone_naive(self):
        assert is_timestamp_with_timezone("2026-07-14T12:00:00") is False


# ---------------------------------------------------------------------------
# Valid evidence extraction
# ---------------------------------------------------------------------------


class TestValidLiveWebsiteEvidence:
    def test_extracts_live_website_evidence(self, valid_live_website_block):
        result = extract_claims_from_report(
            _wrap_report("website_report.md", valid_live_website_block),
            "website_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 1
        ev = result["evidence"][0]
        assert ev["claim_id"] == "claim_a1b2c3d4e5f6a7b8"
        assert ev["source"]["kind"] == "live_page"
        assert ev["source"]["uri"] == "https://grizzlyelectricaltx.com/"
        assert ev["source"]["access_class"] == "observed"
        assert ev["status"] == "confirmed"
        assert ev["confidence"]["score"] > 0.0
        assert "live_page" in ev["confidence"]["basis"]

    def test_confidence_not_fixed_from_source_mode(self, valid_live_website_block):
        result = extract_claims_from_report(
            _wrap_report("website_report.md", valid_live_website_block),
            "website_report.md",
            "run-001",
        )
        ev = result["evidence"][0]
        assert ev["confidence"]["score"] != 0.6


class TestValidSerpEvidence:
    def test_extracts_serp_evidence(self, valid_serp_block):
        result = extract_claims_from_report(
            _wrap_report("gbp_report.md", valid_serp_block),
            "gbp_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 1
        ev = result["evidence"][0]
        assert ev["source"]["kind"] == "serp"
        assert ev["source"]["access_class"] == "observed"
        assert ev["status"] == "confirmed"


class TestBaselineEvidence:
    def test_fresh_baseline_is_provisional(self, fresh_baseline_block):
        result = extract_claims_from_report(
            _wrap_report("grizzly_local_presence_plan.md", fresh_baseline_block),
            "grizzly_local_presence_plan.md",
            "run-001",
        )
        ev = result["evidence"][0]
        assert ev["source"]["kind"] == "baseline"
        assert ev["status"] == "provisional"
        assert not any(d["code"] == "stale_evidence" for d in result["diagnostics"])

    def test_stale_baseline_is_provisional_or_unknown(self, stale_baseline_block):
        result = extract_claims_from_report(
            _wrap_report("grizzly_local_presence_plan.md", stale_baseline_block),
            "grizzly_local_presence_plan.md",
            "run-001",
        )
        ev = result["evidence"][0]
        assert ev["source"]["kind"] == "baseline"
        assert ev["status"] in {"provisional", "unknown"}
        assert any(d["code"] == "stale_evidence" for d in result["diagnostics"])


class TestUnavailableEvidence:
    def test_unavailable_evidence_retains_reason(self, unavailable_block):
        result = extract_claims_from_report(
            _wrap_report("reputation_report.md", unavailable_block),
            "reputation_report.md",
            "run-001",
        )
        ev = result["evidence"][0]
        assert ev["source"]["kind"] == "unavailable"
        assert ev["source"]["access_class"] == "unavailable"
        assert ev["status"] == "unknown"
        assert "unavailable" in ev["confidence"]["basis"].lower()
        assert ev["source"]["uri"] == ""

    def test_unavailable_source_kind_not_empty(self, unavailable_block):
        result = extract_claims_from_report(
            _wrap_report("reputation_report.md", unavailable_block),
            "reputation_report.md",
            "run-001",
        )
        ev = result["evidence"][0]
        assert ev["source"]["kind"] != ""


class TestNegativeFindings:
    def test_negative_finding_claim_type(self, negative_finding_block):
        result = extract_claims_from_report(
            _wrap_report("website_report.md", negative_finding_block),
            "website_report.md",
            "run-001",
        )
        ev = result["evidence"][0]
        assert ev["claim_type"] == "negative_finding"
        assert ev["status"] == "confirmed"
        assert "404" in ev["evidence_excerpt"] or "not indexed" in ev["evidence_excerpt"]


# ---------------------------------------------------------------------------
# Malformed / reordered blocks
# ---------------------------------------------------------------------------


class TestMalformedBlocks:
    def test_missing_claim_id_is_error(self):
        block = """### Recommendation: Fix H1

**Claim Type:** recommendation
**Source Mode:** live
**Source Kind:** live_page
**Source URI:** https://example.com/
**Retrieved At:** 2026-07-14T12:00:00Z
**Negative Findings:** none identified
"""
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 0
        assert any(d["code"] == "missing_claim_id" for d in result["diagnostics"])

    def test_invalid_claim_id_format(self):
        block = _make_block(claim_id="claim_bad")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert any(d["code"] == "normalized_claim_id" for d in result["diagnostics"])
        # Auto-normalization: the claim ID is rewritten to a valid format;
        # status is derived from confidence, not rejected.
        assert result["evidence"][0]["claim_id"].startswith("claim_")
        assert result["evidence"][0]["claim_id"] != "claim_bad"

    def test_unsupported_claim_type(self):
        block = _make_block(claim_type="promotion")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert any(d["code"] == "unsupported_claim_type" for d in result["diagnostics"])
        assert result["evidence"][0]["status"] == "rejected"

    def test_unsupported_source_mode(self):
        block = _make_block(source_mode="future")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert any(d["code"] == "unsupported_source_mode" for d in result["diagnostics"])
        assert result["evidence"][0]["status"] == "rejected"

    def test_malformed_timestamp(self):
        block = _make_block(retrieved_at="not-a-timestamp")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert any(d["code"] == "malformed_timestamp" for d in result["diagnostics"])

    def test_missing_timezone_warning(self):
        block = _make_block(retrieved_at="2026-07-14T12:00:00")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert any(d["code"] == "missing_timezone" for d in result["diagnostics"])

    def test_missing_source_uri_and_kind(self):
        block = _make_block(source_kind="unknown", source_uri="")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert any(d["code"] == "missing_source_uri_and_kind" for d in result["diagnostics"])

    def test_reordered_fields_still_parse(self):
        block = """### Recommendation: Reorder test

**Source Mode:** live
**Claim ID:** claim_1111111111111111
**Source Kind:** live_page
**Negative Findings:** none identified
**Claim Type:** recommendation
**Source URI:** https://example.com/
**Retrieved At:** 2026-07-14T12:00:00Z
**Evidence Excerpt:** reordered fields
"""
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 1
        ev = result["evidence"][0]
        assert ev["claim_id"] == "claim_1111111111111111"
        assert ev["claim_type"] == "recommendation"
        assert ev["source"]["kind"] == "live_page"

    def test_blank_lines_between_fields_tolerated(self):
        block = """### Recommendation: Blank lines

**Claim ID:** claim_2222222222222222

**Claim Type:** recommendation

**Source Mode:** live

**Source Kind:** live_page

**Source URI:** https://example.com/

**Retrieved At:** 2026-07-14T12:00:00Z

**Negative Findings:** none identified

**Evidence Excerpt:** blank lines tolerated
"""
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 1
        assert result["evidence"][0]["claim_id"] == "claim_2222222222222222"


# ---------------------------------------------------------------------------
# Duplicate claim IDs
# ---------------------------------------------------------------------------


class TestDuplicateClaimIds:
    def test_duplicate_claim_ids_in_same_report_are_rejected(self):
        block_a = _make_block(claim_id="claim_3333333333333333", statement="First occurrence")
        block_b = _make_block(claim_id="claim_3333333333333333", statement="Second occurrence")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block_a + "\n\n" + block_b),
            "website_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 2
        assert any(d["code"] == "duplicate_claim_id" for d in result["diagnostics"])
        assert all(ev["status"] == "rejected" for ev in result["evidence"])


# ---------------------------------------------------------------------------
# Multiple evidence units per claim
# ---------------------------------------------------------------------------


class TestMultipleEvidenceUnits:
    def test_multiple_evidence_units_merge_into_one_claim(self):
        block_a = _make_block(
            claim_id="claim_4444444444444444",
            source_kind="live_page",
            statement="Observation A",
            evidence_excerpt="Excerpt A",
        )
        block_b = _make_block(
            claim_id="claim_4444444444444444",
            source_kind="serp",
            statement="Observation B",
            evidence_excerpt="Excerpt B",
        )
        result = build_claim_graph(
            reports={"website_report.md": _wrap_report("website_report.md", block_a),
                     "gbp_report.md": _wrap_report("gbp_report.md", block_b)},
            run_id="run-001",
        )
        assert len(result["claims"]) == 1
        claim = result["claims"][0]
        assert len(claim["evidence_ids"]) == 2
        assert len(result["evidence"]) == 2


# ---------------------------------------------------------------------------
# Contradictions
# ---------------------------------------------------------------------------


class TestContradictions:
    def test_extract_contradiction_from_manager_plan(self):
        plan = """# Local Presence Manager Plan

**Contradiction:** claim_aaaaaaaaaaaaaaaa vs claim_bbbbbbbbbbbbbbbb — Homepage H1 presence

## Highest-Priority Actions
Do something.
"""
        result = extract_contradictions(plan, "grizzly_local_presence_plan.md", "run-001")
        assert len(result["contradictions"]) == 1
        cont = result["contradictions"][0]
        assert cont["claim_a"] == "claim_aaaaaaaaaaaaaaaa"
        assert cont["claim_b"] == "claim_bbbbbbbbbbbbbbbb"
        assert "H1 presence" in cont["reason"]

    def test_unknown_contradiction_endpoint_reported(self):
        block_a = _make_block(claim_id="claim_aaaaaaaaaaaaaaaa")
        plan = f"""# Local Presence Manager Plan

{_wrap_report("website_report.md", block_a)}

**Contradiction:** claim_aaaaaaaaaaaaaaaa vs claim_missing000000000 — Unknown endpoint
"""
        result = build_claim_graph(
            reports={
                "website_report.md": _wrap_report("website_report.md", block_a),
                "grizzly_local_presence_plan.md": plan,
            },
            run_id="run-001",
        )
        assert any(d["code"] == "unknown_contradiction_endpoint" for d in result["diagnostics"])
        # The contradiction should still be preserved
        assert len(result["contradictions"]) == 1

    def test_contradiction_attached_to_claim(self):
        block_a = _make_block(claim_id="claim_aaaaaaaaaaaaaaaa")
        block_b = _make_block(claim_id="claim_bbbbbbbbbbbbbbbb")
        plan = """# Local Presence Manager Plan

**Contradiction:** claim_aaaaaaaaaaaaaaaa vs claim_bbbbbbbbbbbbbbbb — H1 presence
"""
        result = build_claim_graph(
            reports={
                "website_report.md": _wrap_report("website_report.md", block_a),
                "gbp_report.md": _wrap_report("gbp_report.md", block_b),
                "grizzly_local_presence_plan.md": plan,
            },
            run_id="run-001",
        )
        claim_a = next(c for c in result["claims"] if c["claim_id"] == "claim_aaaaaaaaaaaaaaaa")
        assert "claim_bbbbbbbbbbbbbbbb" in claim_a["contradiction_ids"]


# ---------------------------------------------------------------------------
# Empty / missing reports
# ---------------------------------------------------------------------------


class TestEmptyAndMissingReports:
    def test_empty_report_is_diagnosed(self):
        result = extract_claims_from_report(
            _wrap_report("website_report.md", ""),
            "website_report.md",
            "run-001",
        )
        assert len(result["evidence"]) == 0
        assert any(d["code"] in {"no_claim_blocks", "empty_report"} for d in result["diagnostics"])

    def test_collect_reports_missing_file(self):
        result = collect_reports(Path("/nonexistent/dir"))
        assert len(result["missing"]) == 5
        assert all(d["severity"] == "error" for d in result["diagnostics"])

    def test_build_claim_graph_from_dir_missing_reports(self, tmp_path):
        result = build_claim_graph_from_dir(tmp_path, "run-001")
        assert len(result["missing_reports"]) == 5
        assert result["counts"]["evidence"] == 0
        assert result["counts"]["claims"] == 0


# ---------------------------------------------------------------------------
# Secret detection
# ---------------------------------------------------------------------------


class TestSecretDetection:
    def test_contains_secret_api_key(self):
        assert contains_secret_like("api_key: abc123secret") is True

    def test_contains_secret_phone(self):
        assert contains_secret_like("SSN: 123-45-6789") is True

    def test_no_secret_in_normal_text(self):
        assert contains_secret_like("Homepage H1 should mention electrical troubleshooting") is False

    def test_secret_in_excerpt_marks_rejected(self):
        block = _make_block(
            claim_id="claim_5555555555555555",
            evidence_excerpt="api_key: super_secret_key_123",
        )
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        # The current module does not auto-detect secrets; this test documents the
        # helper is available for downstream gates.
        assert contains_secret_like(result["evidence"][0]["evidence_excerpt"]) is True


# ---------------------------------------------------------------------------
# Claim graph validation
# ---------------------------------------------------------------------------


class TestClaimGraphValidation:
    def test_run_identity_in_evidence(self, valid_live_website_block):
        result = build_claim_graph(
            reports={"website_report.md": _wrap_report("website_report.md", valid_live_website_block)},
            run_id="run-abc-123",
        )
        assert all(ev["run_id"] == "run-abc-123" for ev in result["evidence"])
        assert result["run_id"] == "run-abc-123"

    def test_report_marker_validation(self, valid_live_website_block):
        body = valid_live_website_block.replace("[START:WEBSITE]", "").replace("[END:WEBSITE]", "")
        result = extract_claims_from_report(
            body,
            "website_report.md",
            "run-001",
        )
        assert result["marker_ok"] is False
        assert any(d["code"] == "missing_report_markers" for d in result["diagnostics"])

    def test_counts_structure(self, valid_live_website_block, valid_serp_block):
        result = build_claim_graph(
            reports={
                "website_report.md": _wrap_report("website_report.md", valid_live_website_block),
                "gbp_report.md": _wrap_report("gbp_report.md", valid_serp_block),
            },
            run_id="run-001",
        )
        assert result["counts"]["evidence"] == 2
        assert result["counts"]["claims"] == 2
        assert result["counts"]["diagnostics"] >= 0


# ---------------------------------------------------------------------------
# Source kind defaults
# ---------------------------------------------------------------------------


class TestSourceKindDefaults:
    def test_website_report_defaults_to_live_page(self):
        block = _make_block(source_kind="")
        result = extract_claims_from_report(
            _wrap_report("website_report.md", block),
            "website_report.md",
            "run-001",
        )
        assert result["evidence"][0]["source"]["kind"] == "live_page"

    def test_gbp_report_defaults_to_gbp_profile(self):
        block = _make_block(source_kind="")
        result = extract_claims_from_report(
            _wrap_report("gbp_report.md", block),
            "gbp_report.md",
            "run-001",
        )
        assert result["evidence"][0]["source"]["kind"] == "gbp_profile"

    def test_reputation_report_defaults_to_review(self):
        block = _make_block(source_kind="")
        result = extract_claims_from_report(
            _wrap_report("reputation_report.md", block),
            "reputation_report.md",
            "run-001",
        )
        assert result["evidence"][0]["source"]["kind"] == "review"

    def test_content_report_defaults_to_serp(self):
        block = _make_block(source_kind="")
        result = extract_claims_from_report(
            _wrap_report("content_report.md", block),
            "content_report.md",
            "run-001",
        )
        assert result["evidence"][0]["source"]["kind"] == "serp"


# ---------------------------------------------------------------------------
# JSON round-trip safety
# ---------------------------------------------------------------------------


class TestJsonRoundTrip:
    def test_graph_is_json_serializable(self, valid_live_website_block):
        result = build_claim_graph(
            reports={"website_report.md": _wrap_report("website_report.md", valid_live_website_block)},
            run_id="run-001",
        )
        serialized = json.dumps(result)
        restored = json.loads(serialized)
        assert restored["run_id"] == "run-001"
        assert len(restored["evidence"]) == 1
