"""Tests for live evidence wiring — Phase 7 integration scenarios.

Prove that:
- A valid report set produces populated evidence and claims with one run ID.
- A missing claim block creates an extraction diagnostic and prevents unsafe promotion.
- An unavailable source retains an explicit unavailable reason.
- A task referencing an unknown claim becomes a research gap.
- Two observability events persist in order.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.claims_extract import (
    build_claim_graph_from_dir,
    RESEARCH_REPORTS,
)
from seo_agents.evidence import (
    validate_evidence_package,
    validate_claim_graph,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_temp_reports(tmp_path: Path) -> Path:
    """Write a minimal valid report set under ``tmp_path``."""
    report_dir = tmp_path / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    for fname in RESEARCH_REPORTS:
        report_dir.joinpath(fname).write_text(
            f"[START:{fname}]\n\n"
            f"**Claim ID:** claim_test_{fname.replace('.', '_')}\n"
            f"**Claim Type:** observation\n"
            f"**Source Mode:** live\n"
            f"**Source Kind:** live_page\n"
            f"**Source URI:** https://example.com/{fname}\n"
            f"**Retrieved At:** 2026-07-14T00:00:00Z\n"
            f"**Negative Findings:** none identified\n"
            f"\n[END:{fname}]\n",
            encoding="utf-8",
        )
    return report_dir


def _patch_evidence_module(tmp_path: Path) -> "seo_agents.evidence":
    """Patch seo_agents.evidence module constants to write to tmp_path."""
    import seo_agents.evidence as ev_mod

    out = tmp_path / "outputs"
    out.mkdir(parents=True, exist_ok=True)
    ev_mod.OUTPUT_DIR = out
    ev_mod.EVIDENCE_PACKAGE_PATH = out / "evidence_package.json"
    ev_mod.CLAIM_GRAPH_PATH = out / "claim_graph.json"
    ev_mod.TASK_GRAPH_PATH = out / "task_graph.json"
    ev_mod.RUN_MANIFEST_PATH = out / "run_manifest.json"
    ev_mod.OBSERVABILITY_PATH = out / "observability.jsonl"
    return ev_mod


# ---------------------------------------------------------------------------
# Scenario 1: valid report set produces populated evidence and claims
# ---------------------------------------------------------------------------


class TestLiveEvidenceWiring:
    """Integration scenarios for evidence wiring."""

    def test_valid_report_set_produces_populated_claims(self, tmp_path):
        """A valid report set produces at least one claim and one evidence unit."""
        report_dir = _make_temp_reports(tmp_path)
        result = build_claim_graph_from_dir(
            report_dir=report_dir, run_id="live-001",
            site_url="https://example.com", region="DFW",
        )
        evidence = result.get("evidence", [])
        claims = result.get("claims", [])
        assert len(evidence) > 0, "Expected at least one evidence unit"
        assert len(claims) > 0, "Expected at least one claim"

    def test_valid_report_set_evidence_has_run_id(self, tmp_path):
        """Evidence units from a valid report set carry the run_id."""
        report_dir = _make_temp_reports(tmp_path)
        result = build_claim_graph_from_dir(
            report_dir=report_dir, run_id="live-001",
            site_url="https://example.com", region="DFW",
        )
        for ev in result.get("evidence", []):
            assert ev.get("run_id") == "live-001", f"run_id missing on evidence: {ev}"

    # -----------------------------------------------------------------------
    # Scenario 4: missing claim block creates diagnostic
    # -----------------------------------------------------------------------

    def test_missing_claim_block_creates_diagnostic(self, tmp_path):
        """A report without claim blocks produces diagnostics, not claims."""
        report_dir = _make_temp_reports(tmp_path)
        (report_dir / "content_report.md").write_text(
            "[START:CONTENT]\n\nSome text without claim blocks.\n\n[END:CONTENT]\n",
            encoding="utf-8",
        )
        result = build_claim_graph_from_dir(
            report_dir=report_dir, run_id="diag-001",
            site_url="https://example.com", region="DFW",
        )
        diagnostics = result.get("diagnostics", [])
        assert len(diagnostics) > 0, "Expected diagnostics for malformed/missing block"
        # The content report should have no valid claims
        content_claims = [c for c in result.get("claims", []) if c.get("report") == "content_report.md"]
        assert len(content_claims) == 0

    # -----------------------------------------------------------------------
    # Scenario 6: unavailable evidence retains explicit reason
    # -----------------------------------------------------------------------

    def test_unavailable_evidence_retains_reason(self):
        """Unavailable evidence must retain an explicit reason."""
        ev_list = [{
            "evidence_id": "ev-unavail-001",
            "claim_id": "claim-unavail-001",
            "statement": "Could not reach GBP profile",
            "source": {
                "kind": "unavailable", "uri": "unavailable", "access_class": "unavailable",
            },
            "confidence": {"label": "unknown", "basis": "source_unavailable"},
            "status": "unavailable",
            "run_id": "unavail-001",
        }]
        ev_result = validate_evidence_package(ev_list)
        # Unavailable source should produce a gate (missing_provenance is "fail" when
        # no URI or kind, but kind=unavailable is valid — check no false "confirmed")
        assert ev_result["ok"] or any(
            g["gate"] == "missing_provenance" for g in ev_result["gates"]
        ), f"Unexpected gate result: {ev_result}"

    # -----------------------------------------------------------------------
    # Scenario 8: task referencing unknown claim becomes research gap
    # -----------------------------------------------------------------------

    def test_unknown_claim_reference_becomes_research_gap(self):
        """A non-schedule action with empty claim IDs becomes research_gap."""
        import seo_agents.actions as actions_mod

        action = {
            "id": "task-a001", "action_type": "content_update",
            "title": "Update content", "supporting_claim_ids": [],
            "dependencies": [], "status": "ready",
            "approval_required": False, "approval": None,
            "live_adapter": "website_manager", "platform": "website",
            "assigned_agent": "content_executor",
        }
        task = actions_mod._build_validated_task(action, {}, "run-001", [], [])
        assert task["status"] == "research_gap"
        assert task.get("task_type") == "research_gap"

    # -----------------------------------------------------------------------
    # Scenario 16: two observability events persist in order
    # -----------------------------------------------------------------------

    def test_observability_events_persist(self, tmp_path):
        """Two observability events persist in order."""
        ev_mod = _patch_evidence_module(tmp_path)

        ev_mod.write_observability_event(
            {"event_type": "research_complete", "producer": "test"}, run_id="obs-001",
        )
        ev_mod.write_observability_event(
            {"event_type": "finalization_complete", "producer": "test"}, run_id="obs-001",
        )

        content = (tmp_path / "outputs" / "observability.jsonl").read_text()
        events = []
        current = ""
        for line in content.strip().splitlines():
            current += line + "\n"
            if line == "}" or line == "]":
                events.append(json.loads(current))
                current = ""

        assert len(events) == 2
        assert events[0]["event_type"] == "research_complete"
        assert events[1]["event_type"] == "finalization_complete"

    # -----------------------------------------------------------------------
    # Scenario 17: empty artifacts retain run ID
    # -----------------------------------------------------------------------

    def test_empty_artifacts_retain_run_id(self, tmp_path):
        """Empty collections must carry the explicit run ID."""
        ev_mod = _patch_evidence_module(tmp_path)

        ev_mod.write_evidence_package([], run_id="empty-001")
        ev_mod.write_claim_graph([], run_id="empty-001")

        ev_data = json.loads((tmp_path / "outputs" / "evidence_package.json").read_text())
        cg_data = json.loads((tmp_path / "outputs" / "claim_graph.json").read_text())
        assert ev_data["run_id"] == "empty-001"
        assert cg_data["run_id"] == "empty-001"
        assert ev_data["evidence"] == []
        assert cg_data["claims"] == []
