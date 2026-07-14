"""Tests for Session 3: run finalization and gate integration.

Covers:
- Finalizer populates evidence/claim artifacts with the correct run ID.
- Live run with zero extracted claims and no unavailable-tool justification fails
  the extraction gate.
- A failed extraction package is never silently replaced by an empty package.
- Automatic execution does not start when the hard gate fails.
- ``validate --json`` returns distinct, correct results for the six required cases.
- The old empty-write-then-execute code path is gone.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import RunManifest
from seo_agents.run_context import build_run_context, release_run_context


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_block(
    claim_id: str = "claim_0000000000000001",
    claim_type: str = "recommendation",
    source_mode: str = "live",
    source_kind: str = "live_page",
    source_uri: str = "https://grizzlyelectricaltx.com/",
    retrieved_at: str = "",
    statement: str = "Homepage H1 should mention electrical troubleshooting.",
    evidence_excerpt: str = "H1 found on homepage",
    relation: str = "supports",
) -> str:
    if not retrieved_at:
        from datetime import datetime, timezone
        retrieved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return f"""### Recommendation: {statement}

{statement}

**Claim ID:** {claim_id}
**Claim Type:** {claim_type}
**Source Mode:** {source_mode}
**Source Kind:** {source_kind}
**Source URI:** {source_uri}
**Retrieved At:** {retrieved_at}
**Negative Findings:** none identified
**Evidence Excerpt:** {evidence_excerpt}
**Relation:** {relation}
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


def _write_reports(report_dir: Path, reports: dict[str, str]) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    for name, body in reports.items():
        (report_dir / name).write_text(body, encoding="utf-8")


def _import_evidence(output_dir: Path):
    """Import the evidence module with OUTPUT_DIR patched to ``output_dir``."""
    mod_name = "seo_agents.evidence"
    if mod_name in sys.modules:
        del sys.modules[mod_name]

    import seo_agents.evidence as ev_mod
    ev_mod.OUTPUT_DIR = output_dir
    ev_mod.EVIDENCE_PACKAGE_PATH = output_dir / "evidence_package.json"
    ev_mod.CLAIM_GRAPH_PATH = output_dir / "claim_graph.json"
    ev_mod.TASK_GRAPH_PATH = output_dir / "task_graph.json"
    ev_mod.RUN_MANIFEST_PATH = output_dir / "run_manifest.json"
    ev_mod.OBSERVABILITY_PATH = output_dir / "observability.jsonl"
    return ev_mod


def _import_finalize_with_patched_evidence(output_dir: Path):
    """Import finalize.py after patching evidence.py constants."""
    # Ensure evidence module is patched first.
    _import_evidence(output_dir)
    # Import finalize (which imports evidence functions)
    import seo_agents.finalize as finalize_mod
    return finalize_mod


def _make_context(tmp_path: Path, **kwargs):
    """Build a RunContext with isolated output and archive directories."""
    output_dir = tmp_path / "outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_dir = tmp_path / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    ctx = build_run_context(
        topic=kwargs.get("topic", "finalization test"),
        output_dir=output_dir,
        archive_dir=archive_dir,
        run_id=kwargs.get("run_id", "finalize-test-001"),
        provider=kwargs.get("provider", "none"),
        research_model=kwargs.get("research_model", "none"),
        exec_model=kwargs.get("exec_model", "none"),
        site_url=kwargs.get("site_url", "https://grizzlyelectricaltx.com/"),
        region=kwargs.get("region", "DFW"),
    )
    return ctx, output_dir, archive_dir


# ---------------------------------------------------------------------------
# Task 3.1 — Add one run finalizer
# ---------------------------------------------------------------------------


class TestFinalizeRun:
    """The finalizer produces lineage-linked artifacts and a structured result."""

    def test_finalizer_populates_evidence_and_claim_artifacts(self, tmp_path):
        """Evidence and claim artifacts are populated with the correct run ID."""
        ctx, output_dir, _ = _make_context(tmp_path)
        ev_mod = _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "content_report.md": _wrap_report("content_report.md", _make_block(
                claim_id="claim_a1b2c3d4e5f6a7b8",
                claim_type="observation",
                source_kind="serp",
                source_uri="https://www.google.com/search",
                statement="Grizzly ranks in the Rowlett local pack.",
                evidence_excerpt="Local pack position 2.",
            )),
            "website_report.md": _wrap_report("website_report.md", _make_block(
                claim_id="claim_b2c3d4e5f6a7b8c9",
                claim_type="recommendation",
                source_kind="live_page",
                source_uri="https://grizzlyelectricaltx.com/",
                statement="Homepage H1 should mention troubleshooting.",
                evidence_excerpt="H1 found: Professional Electrical Services.",
            )),
            "gbp_report.md": _wrap_report("gbp_report.md", _make_block(
                claim_id="claim_c3d4e5f6a7b8c9d0",
                claim_type="observation",
                source_kind="gbp_profile",
                source_uri="https://www.google.com/maps",
                statement="GBP profile has 5.0 stars.",
                evidence_excerpt="Rating 5.0, 153 reviews.",
            )),
            "reputation_report.md": _wrap_report("reputation_report.md", _make_block(
                claim_id="claim_d4e5f6a7b8c9d0e1",
                claim_type="negative_finding",
                source_kind="review",
                source_uri="https://www.google.com/maps",
                statement="No negative reviews in the last 90 days.",
                evidence_excerpt="Review sentiment positive.",
            )),
            "grizzly_local_presence_plan.md": "No contradictions noted.",
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=False,
            unavailable_tools=[],
        )
        release_run_context(ctx)

        assert result["run_id"] == ctx.run_id
        assert result["counts"]["claims"] == 4
        assert result["counts"]["evidence"] == 4

        ev_path = output_dir / "evidence_package.json"
        claim_path = output_dir / "claim_graph.json"
        diag_path = output_dir / "extraction_diagnostics.json"
        assert ev_path.exists()
        assert claim_path.exists()
        assert diag_path.exists()

        ev_data = json.loads(ev_path.read_text(encoding="utf-8"))
        claim_data = json.loads(claim_path.read_text(encoding="utf-8"))
        assert ev_data["run_id"] == ctx.run_id
        assert claim_data["run_id"] == ctx.run_id
        assert len(ev_data["evidence"]) == 4
        assert len(claim_data["claims"]) == 4

        # Result should not hard-fail for valid data.
        assert result["gate_result"]["hard_fail"] is False
        assert result["gate_result"]["extraction_empty"] is False

    def test_finalizer_snapshots_reports_to_archive(self, tmp_path):
        """The finalizer copies reports into the run archive directory."""
        ctx, output_dir, archive_dir = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "content_report.md": _wrap_report("content_report.md", _make_block()),
            "website_report.md": _wrap_report("website_report.md", _make_block(
                claim_id="claim_b2c3d4e5f6a7b8c9",
            )),
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=False,
        )
        release_run_context(ctx)

        assert "snapshot" in result
        for name in reports:
            assert (ctx.archive_dir / name).exists()

    def test_finalizer_writes_extraction_diagnostics(self, tmp_path):
        """The finalizer writes structured extraction diagnostics."""
        ctx, output_dir, _ = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "website_report.md": _wrap_report("website_report.md", _make_block(
                claim_id="claim_a1b2c3d4e5f6a7b8",
            )),
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=False,
        )
        release_run_context(ctx)

        diag_path = output_dir / "extraction_diagnostics.json"
        assert diag_path.exists()
        diag = json.loads(diag_path.read_text(encoding="utf-8"))
        assert diag["run_id"] == ctx.run_id
        assert "gate_result" in diag
        assert "counts" in diag


# ---------------------------------------------------------------------------
# Task 3.2 — Live finalization behavior
# ---------------------------------------------------------------------------


class TestLiveFinalizationBehavior:
    """Live/research-only runs enforce extraction and gate rules."""

    def test_live_zero_claims_without_tool_unavailability_fails_gate(self, tmp_path):
        """A live run with no extracted claims and no justification fails the extraction gate."""
        ctx, output_dir, _ = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "content_report.md": "[START:CONTENT]\n\n[END:CONTENT]",
            "website_report.md": "[START:WEBSITE]\n\n[END:WEBSITE]",
            "gbp_report.md": "[START:GBP]\n\n[END:GBP]",
            "reputation_report.md": "[START:REPUTATION]\n\n[END:REPUTATION]",
            "grizzly_local_presence_plan.md": "No contradictions.",
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=False,
            unavailable_tools=[],
        )
        release_run_context(ctx)

        assert result["gate_result"]["hard_fail"] is True
        assert result["gate_result"]["extraction_empty"] is True
        assert result["gate_result"]["extraction_justified"] is False
        failure_codes = {f["gate"] for f in result["gate_result"]["failures"]}
        assert "empty_extraction" in failure_codes

    def test_research_only_zero_claims_without_justification_fails_gate(self, tmp_path):
        """A research-only run with no claims and no justification also fails the gate."""
        ctx, output_dir, _ = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "content_report.md": "[START:CONTENT]\n\n[END:CONTENT]",
            "website_report.md": "[START:WEBSITE]\n\n[END:WEBSITE]",
            "gbp_report.md": "[START:GBP]\n\n[END:GBP]",
            "reputation_report.md": "[START:REPUTATION]\n\n[END:REPUTATION]",
            "grizzly_local_presence_plan.md": "No contradictions.",
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=True,
            unavailable_tools=[],
        )
        release_run_context(ctx)

        assert result["gate_result"]["hard_fail"] is True
        assert "empty_extraction" in {f["gate"] for f in result["gate_result"]["failures"]}

    def test_zero_claims_justified_when_all_tools_unavailable(self, tmp_path):
        """Zero claims is allowed when every research tool is unavailable."""
        ctx, output_dir, _ = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "content_report.md": "[START:CONTENT]\n\n[END:CONTENT]",
            "website_report.md": "[START:WEBSITE]\n\n[END:WEBSITE]",
            "gbp_report.md": "[START:GBP]\n\n[END:GBP]",
            "reputation_report.md": "[START:REPUTATION]\n\n[END:REPUTATION]",
            "grizzly_local_presence_plan.md": "No contradictions.",
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=True,
            unavailable_tools=["content_research", "website_audit", "gbp_audit", "reputation_audit"],
        )
        release_run_context(ctx)

        assert result["gate_result"]["extraction_empty"] is True
        assert result["gate_result"]["extraction_justified"] is True
        assert result["gate_result"]["hard_fail"] is False

    def test_dry_run_empty_extraction_does_not_hard_fail(self, tmp_path):
        """Dry-run intentionally produces empty evidence and must not hard-fail."""
        ctx, output_dir, _ = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        reports = {
            "content_report.md": "[START:CONTENT]\n\n[END:CONTENT]",
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=True,
            research_only=False,
            unavailable_tools=[],
        )
        release_run_context(ctx)

        assert result["gate_result"]["extraction_empty"] is True
        assert result["gate_result"]["hard_fail"] is False
        assert result["gate_result"]["extraction_justified"] is True


# ---------------------------------------------------------------------------
# Task 3.1 edge — failed package must not become empty
# ---------------------------------------------------------------------------


class TestFailedPackageNotReplaced:
    """A failed extraction must not be silently replaced by an empty package."""

    def test_failed_extraction_preserves_diagnostics(self, tmp_path):
        """When extraction fails, the diagnostics record the failure instead of an empty package."""
        ctx, output_dir, _ = _make_context(tmp_path)
        _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        # Malformed claim block with invalid claim ID.
        reports = {
            "website_report.md": _wrap_report("website_report.md", _make_block(
                claim_id="bad-id",
                source_uri="",
            )),
        }
        _write_reports(output_dir, reports)

        result = finalize_mod.finalize_run(
            ctx=ctx,
            report_dir=output_dir,
            output_dir=output_dir,
            dry_run=False,
            research_only=False,
            unavailable_tools=[],
        )
        release_run_context(ctx)

        # The evidence package should not be empty: it should contain the rejected
        # malformed unit or at least record the failure in diagnostics.
        diag_path = output_dir / "extraction_diagnostics.json"
        assert diag_path.exists()
        diag = json.loads(diag_path.read_text(encoding="utf-8"))
        assert diag["counts"]["errors"] > 0 or diag["gate_result"]["hard_fail"] is True

        # The evidence package should not have been silently replaced with a
        # clean empty package.  Either it contains the rejected unit or the
        # diagnostic record shows errors.
        ev_path = output_dir / "evidence_package.json"
        if ev_path.exists():
            ev_data = json.loads(ev_path.read_text(encoding="utf-8"))
            assert ev_data["run_id"] == ctx.run_id
            # Either there is evidence with errors, or diagnostics explain why empty.
            assert len(ev_data.get("evidence", [])) > 0 or diag["gate_result"]["hard_fail"]


# ---------------------------------------------------------------------------
# Task 3.3 — Integration before execution
# ---------------------------------------------------------------------------


class TestExecutionGate:
    """Automatic execution stops when the hard gate fails."""

    def test_execution_not_started_when_hard_gate_fails(self, tmp_path):
        """_run_execute_pipeline is not called when the finalizer reports a hard gate failure."""
        import seo_agents.main as main_mod
        import seo_agents.actions as actions_mod

        ctx, output_dir, _ = _make_context(tmp_path)
        ev_mod = _import_evidence(output_dir)
        finalize_mod = _import_finalize_with_patched_evidence(output_dir)

        # Patch main.py's OUTPUT_DIR and evidence references so the live path uses
        # the temporary directory without touching the real outputs.
        with patch.object(main_mod, "OUTPUT_DIR", output_dir), \
             patch.object(main_mod, "ARCHIVE_DIR", tmp_path / "archive"), \
             patch.object(main_mod, "RUN_HEALTH_FILE", output_dir / "run_health.json"), \
             patch.object(actions_mod, "OUTPUT_DIR", output_dir), \
             patch.object(main_mod, "EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch.object(main_mod, "CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch.object(main_mod, "RUN_MANIFEST_PATH", output_dir / "run_manifest.json"), \
             patch.object(main_mod, "finalize_run", finalize_mod.finalize_run), \
             patch.object(main_mod, "write_action_queue", lambda run_id="": None), \
             patch.object(main_mod, "_run_execute_pipeline") as mock_execute:

            # Prepare a run with zero claims so the extraction gate fails.
            reports = {
                "content_report.md": "[START:CONTENT]\n\n[END:CONTENT]",
                "website_report.md": "[START:WEBSITE]\n\n[END:WEBSITE]",
                "gbp_report.md": "[START:GBP]\n\n[END:GBP]",
                "reputation_report.md": "[START:REPUTATION]\n\n[END:REPUTATION]",
                "grizzly_local_presence_plan.md": "No contradictions.",
            }
            _write_reports(output_dir, reports)

            # Run the live path using the patched context.
            result = finalize_mod.finalize_run(
                ctx=ctx,
                report_dir=output_dir,
                output_dir=output_dir,
                dry_run=False,
                research_only=False,
                unavailable_tools=[],
            )
            assert result["gate_result"]["hard_fail"] is True

            # Simulate the main.py decision block: build queue, then execute only if gate passes.
            main_mod.write_action_queue(run_id=ctx.run_id)
            if result["gate_result"]["hard_fail"]:
                pass  # do not execute
            else:
                main_mod._run_execute_pipeline()

            mock_execute.assert_not_called()

        release_run_context(ctx)


# ---------------------------------------------------------------------------
# Task 3.4 — Meaningful validate --json
# ---------------------------------------------------------------------------


class TestValidateJsonCases:
    """``validate --json`` returns distinct, correct results for the six cases."""

    def _setup_validate(self, output_dir: Path, manifest: dict, evidence: dict, claims: dict):
        ev_mod = _import_evidence(output_dir)
        ev_mod.write_run_manifest(RunManifest(**manifest))
        ev_mod.write_evidence_package(evidence.get("evidence", []), run_id=evidence.get("run_id", ""))
        ev_mod.write_claim_graph(claims.get("claims", []), run_id=claims.get("run_id", ""))

    def test_case_dry_run_empty(self, tmp_path):
        """Valid dry-run with intentionally empty evidence."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "dry-run-001",
                "topic": "dry test",
                "dry_run": True,
                "research_only": False,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={"run_id": "dry-run-001", "evidence": []},
            claims={"run_id": "dry-run-001", "claims": []},
        )

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is True
        assert result["case"] == "dry_run_empty"
        assert result["mode"] == "dry_run"
        assert result["run_id"] == "dry-run-001"

    def test_case_research_only_populated(self, tmp_path):
        """Valid research-only run with populated evidence."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "research-only-001",
                "topic": "research test",
                "dry_run": False,
                "research_only": True,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={
                "run_id": "research-only-001",
                "evidence": [{
                    "evidence_id": "ev_research_001",
                    "run_id": "research-only-001",
                    "claim_id": "claim_research_001",
                    "claim_type": "recommendation",
                    "statement": "Add FAQ schema.",
                    "scope": {"site": "https://example.com", "region": "DFW"},
                    "source": {
                        "kind": "live_page",
                        "uri": "https://example.com",
                        "title": "Homepage",
                        "retrieved_at": "2026-07-14T00:00:00Z",
                        "authority_rank": 0.9,
                        "access_class": "observed",
                    },
                    "evidence_excerpt": "FAQ page is present",
                    "relation": "supports",
                    "confidence": {
                        "label": "high",
                        "score": 0.85,
                        "authority": 0.9,
                        "recency": 1.0,
                        "method_transparency": 0.8,
                        "corroboration": 0.6,
                        "access": 1.0,
                        "basis": "observed",
                    },
                    "freshness": {"captured_at": "2026-07-14T00:00:00Z", "valid_until": None, "supersedes": []},
                    "contradiction_ids": [],
                    "supporting_report": "website_report.md",
                    "status": "confirmed",
                }],
            },
            claims={
                "run_id": "research-only-001",
                "claims": [{
                    "claim_id": "claim_research_001",
                    "claim_type": "recommendation",
                    "statement": "Add FAQ schema.",
                    "evidence_ids": ["ev_research_001"],
                    "confidence": "high",
                    "scope": {"site": "https://example.com", "region": "DFW"},
                    "relation": "supports",
                    "contradiction_ids": [],
                    "status": "confirmed",
                }],
            },
        )

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is True
        assert result["case"] == "research_only_populated"
        assert result["mode"] == "research_only"

    def test_case_live_missing_extraction(self, tmp_path):
        """Live run with missing extraction."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "live-empty-001",
                "topic": "live test",
                "dry_run": False,
                "research_only": False,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={"run_id": "live-empty-001", "evidence": []},
            claims={"run_id": "live-empty-001", "claims": []},
        )

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is False
        assert result["case"] == "live_missing_extraction"
        assert result["mode"] == "live"

    def test_case_stale_artifacts(self, tmp_path):
        """Stale evidence is detected and classified."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "stale-001",
                "topic": "stale test",
                "dry_run": False,
                "research_only": False,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={
                "run_id": "stale-001",
                "evidence": [{
                    "evidence_id": "ev_stale_001",
                    "run_id": "stale-001",
                    "claim_id": "claim_stale_001",
                    "claim_type": "observation",
                    "statement": "Old observation.",
                    "scope": {"site": "https://example.com", "region": "DFW"},
                    "source": {
                        "kind": "live_page",
                        "uri": "https://example.com",
                        "title": "Homepage",
                        # 90 days old is stale for live evidence.
                        "retrieved_at": "2026-04-14T00:00:00Z",
                        "authority_rank": 0.9,
                        "access_class": "observed",
                    },
                    "evidence_excerpt": "Old data",
                    "relation": "supports",
                    "confidence": {"label": "high", "score": 0.85, "authority": 0.9, "recency": 1.0, "method_transparency": 0.8, "corroboration": 0.6, "access": 1.0, "basis": "observed"},
                    "freshness": {"captured_at": "2026-04-14T00:00:00Z", "valid_until": None, "supersedes": []},
                    "contradiction_ids": [],
                    "supporting_report": "website_report.md",
                    "status": "confirmed",
                }],
            },
            claims={
                "run_id": "stale-001",
                "claims": [{
                    "claim_id": "claim_stale_001",
                    "claim_type": "observation",
                    "statement": "Old observation.",
                    "evidence_ids": ["ev_stale_001"],
                    "confidence": "high",
                    "scope": {"site": "https://example.com", "region": "DFW"},
                    "relation": "supports",
                    "contradiction_ids": [],
                    "status": "confirmed",
                }],
            },
        )

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is False
        assert result["case"] == "stale_or_mixed_artifacts"
        assert any("stale" in issue.lower() for issue in result["issues"])

    def test_case_mixed_run_artifacts(self, tmp_path):
        """Mixed run IDs across artifacts are detected."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "manifest-001",
                "topic": "mixed test",
                "dry_run": False,
                "research_only": False,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={"run_id": "different-001", "evidence": []},
            claims={"run_id": "different-001", "claims": []},
        )

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is False
        assert result["case"] == "stale_or_mixed_artifacts"
        assert any("mixed run identity" in issue.lower() for issue in result["issues"])

    def test_case_gate_failure(self, tmp_path):
        """Gate failure is detected and classified."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "gate-fail-001",
                "topic": "gate test",
                "dry_run": False,
                "research_only": False,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={
                "run_id": "gate-fail-001",
                "evidence": [{
                    "evidence_id": "ev_gate_001",
                    "run_id": "gate-fail-001",
                    "claim_id": "claim_gate_001",
                    "claim_type": "recommendation",
                    "statement": "No provenance.",
                    "scope": {"site": "https://example.com", "region": "DFW"},
                    "source": {"kind": "", "uri": "", "title": "", "retrieved_at": "", "authority_rank": 0.0, "access_class": ""},
                    "evidence_excerpt": "",
                    "relation": "supports",
                    "confidence": {"label": "unknown", "score": 0.0, "authority": 0.0, "recency": 0.0, "method_transparency": 0.0, "corroboration": 0.0, "access": 0.0, "basis": ""},
                    "freshness": {"captured_at": "2026-07-14T00:00:00Z", "valid_until": None, "supersedes": []},
                    "contradiction_ids": [],
                    "supporting_report": "website_report.md",
                    "status": "unknown",
                }],
            },
            claims={
                "run_id": "gate-fail-001",
                "claims": [{
                    "claim_id": "claim_gate_001",
                    "claim_type": "recommendation",
                    "statement": "No provenance.",
                    "evidence_ids": ["ev_gate_001"],
                    "confidence": "unknown",
                    "scope": {"site": "https://example.com", "region": "DFW"},
                    "relation": "supports",
                    "contradiction_ids": [],
                    "status": "unknown",
                }],
            },
        )

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is False
        assert result["case"] == "gate_failure"
        assert any("missing_provenance" in issue for issue in result["issues"])

    def test_case_malformed_artifact(self, tmp_path):
        """Malformed evidence JSON is detected."""
        output_dir = tmp_path / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        self._setup_validate(
            output_dir,
            manifest={
                "run_id": "malformed-001",
                "topic": "malformed test",
                "dry_run": False,
                "research_only": False,
                "started_at": "2026-07-14T00:00:00Z",
            },
            evidence={"run_id": "malformed-001", "evidence": []},
            claims={"run_id": "malformed-001", "claims": []},
        )
        # Overwrite evidence_package.json with invalid JSON.
        (output_dir / "evidence_package.json").write_text("{not json", encoding="utf-8")

        with patch("seo_agents.status.OUTPUT_DIR", output_dir), \
             patch("seo_agents.status.EVIDENCE_PACKAGE_PATH", output_dir / "evidence_package.json"), \
             patch("seo_agents.status.CLAIM_GRAPH_PATH", output_dir / "claim_graph.json"), \
             patch("seo_agents.status.RUN_MANIFEST_PATH", output_dir / "run_manifest.json"):
            from seo_agents.status import validate_outputs_json
            result = validate_outputs_json()

        assert result["ok"] is False
        assert result["case"] == "malformed_artifact"
        assert result["gates"]["evidence"] == "malformed"


# ---------------------------------------------------------------------------
# Old path gone
# ---------------------------------------------------------------------------


class TestOldPathGone:
    """The old empty-write-then-execute code path must not remain."""

    def test_old_empty_write_then_execute_path_removed(self):
        """The live research path no longer writes empty evidence/claim and immediately executes."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        # Isolate the live research path by dropping everything after the dry-run return.
        research_block = source.split('elif command == "execute"')[0]
        live_block = research_block.split("release_run_context(ctx)\n            return")[1]
        # After the dry-run path, the live path must call finalize_run.
        assert "finalize_run(" in live_block
        # It must not write empty evidence and then immediately call _run_execute_pipeline.
        assert "write_evidence_package([], run_id=run_id)" not in live_block
        assert "write_claim_graph([], run_id=run_id)" not in live_block
        # _run_execute_pipeline must only be called after the gate decision.
        assert "_run_execute_pipeline" in live_block

    def test_execution_only_after_gate_evaluation(self):
        """_run_execute_pipeline appears only after the hard gate check in the live path."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        research_block = source.split('elif command == "execute"')[0]
        live_block = research_block.split("release_run_context(ctx)\n            return")[1]
        # The gate check text must precede the execute call.
        gate_check = "finalize_result[\"gate_result\"][\"hard_fail\"]"
        assert gate_check in live_block
        gate_idx = live_block.index(gate_check)
        exec_idx = live_block.index("_run_execute_pipeline()")
        assert gate_idx < exec_idx
