"""Run finalizer for Session 3.

Freezes the current run reports, extracts evidence and claims, validates the
result, writes lineage-linked artifacts, emits gate events, and returns a
structured result with counts, failures, warnings, and run ID.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from seo_agents.claims_extract import RESEARCH_REPORTS, build_claim_graph_from_dir
from seo_agents.run_context import RunContext
from seo_agents.evidence import (
    validate_claim_graph,
    validate_evidence_package,
    write_claim_graph,
    write_evidence_package,
    write_observability_event,
)
from seo_agents.observability import _make_event


# Tool names that produce the four specialist reports.  If *all* of these are
# recorded as unavailable, a run with zero extracted claims is a justified
# research gap rather than a hard extraction failure.
RESEARCH_REPORT_TOOLS: dict[str, str] = {
    "content_report.md": "content_research",
    "website_report.md": "website_audit",
    "gbp_report.md": "gbp_audit",
    "reputation_report.md": "reputation_audit",
}


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def snapshot_reports(
    report_dir: Path,
    archive_dir: Path,
    report_names: list[str] | None = None,
) -> dict[str, Any]:
    """Copy the current run reports into an isolated archive directory."""
    report_names = report_names or list(RESEARCH_REPORTS.keys())
    archive_dir.mkdir(parents=True, exist_ok=True)
    archived: list[str] = []
    missing: list[str] = []
    for name in report_names:
        src = report_dir / name
        dst = archive_dir / name
        if src.exists():
            shutil.copy2(src, dst)
            archived.append(name)
        else:
            missing.append(name)
    return {
        "archive_dir": str(archive_dir),
        "archived": archived,
        "missing": missing,
    }


def _is_extraction_justified(
    claim_count: int,
    unavailable_tools: list[str] | None,
) -> bool:
    """Return True when zero claims is acceptable because all tools were unavailable."""
    if claim_count > 0:
        return True
    unavailable = set(unavailable_tools or [])
    required = set(RESEARCH_REPORT_TOOLS.values())
    return required.issubset(unavailable)


def evaluate_gates(
    graph_result: dict[str, Any],
    ev_result: dict[str, Any],
    claim_result: dict[str, Any],
    dry_run: bool,
    research_only: bool,
    unavailable_tools: list[str] | None,
) -> dict[str, Any]:
    """Classify diagnostics and validation gates into hard failures and warnings."""
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    # Extraction emptiness check
    claim_count = graph_result.get("counts", {}).get("claims", 0)
    evidence_count = graph_result.get("counts", {}).get("evidence", 0)
    extraction_empty = claim_count == 0 and evidence_count == 0
    extraction_justified = _is_extraction_justified(claim_count, unavailable_tools)

    if extraction_empty:
        if dry_run:
            # Dry-run intentionally produces empty evidence.
            extraction_justified = True
        elif extraction_justified:
            warnings.append({
                "gate": "empty_extraction_justified",
                "severity": "warning",
                "detail": "No claims extracted; all research tools were unavailable.",
            })
        else:
            failures.append({
                "gate": "empty_extraction",
                "severity": "fail",
                "detail": "No claims extracted and not all research tools were unavailable.",
            })

    # Claims-extract diagnostics.  In dry-run mode empty reports are expected,
    # so downgrade empty-report and missing-report errors to warnings.
    for diag in graph_result.get("diagnostics", []):
        severity = diag.get("severity", "warning")
        code = diag.get("code", "unknown")
        if dry_run and severity == "error" and code in {"empty_report", "missing_report"}:
            severity = "warning"
        entry = {
            "gate": code,
            "severity": severity,
            "detail": diag.get("detail", ""),
            "claim_id": diag.get("claim_id", ""),
            "report": diag.get("report", ""),
        }
        if severity == "error":
            failures.append(entry)
        elif severity == "warning":
            warnings.append(entry)

    # Evidence-package gates
    for gate in ev_result.get("gates", []):
        entry = {
            "gate": gate.get("gate", "unknown"),
            "severity": gate.get("severity", "warning"),
            "detail": gate.get("detail", ""),
            "claim_id": gate.get("claim_id", ""),
        }
        if gate.get("severity") == "fail":
            failures.append(entry)
        else:
            warnings.append(entry)

    # Claim-graph gates
    for gate in claim_result.get("gates", []):
        entry = {
            "gate": gate.get("gate", "unknown"),
            "severity": gate.get("severity", "warning"),
            "detail": gate.get("detail", ""),
            "claim_id": gate.get("claim_id", ""),
        }
        if gate.get("severity") == "fail":
            failures.append(entry)
        else:
            warnings.append(entry)

    hard_fail = bool(failures)

    # Claims remain non-promotable when validation fails.
    if hard_fail or (not dry_run and extraction_empty and not extraction_justified):
        promotable = False
    else:
        promotable = not any(g.get("severity") == "fail" for g in ev_result.get("gates", []))

    return {
        "hard_fail": hard_fail,
        "promotable": promotable,
        "extraction_empty": extraction_empty,
        "extraction_justified": extraction_justified,
        "failures": failures,
        "warnings": warnings,
    }


def _write_extraction_diagnostics(
    output_dir: Path,
    result: dict[str, Any],
) -> Path:
    """Write extraction diagnostics to a lineage-linked JSON file."""
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "extraction_diagnostics.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def _emit_gate_events(run_id: str, gate_result: dict[str, Any]) -> None:
    """Emit observability events for finalization and each hard gate."""
    write_observability_event(_make_event(
        producer="run_finalizer",
        event_type="finalization_complete",
        run_id=run_id,
        fields={
            "hard_fail": gate_result["hard_fail"],
            "extraction_empty": gate_result["extraction_empty"],
            "extraction_justified": gate_result["extraction_justified"],
            "failure_count": len(gate_result["failures"]),
            "warning_count": len(gate_result["warnings"]),
        },
    ))
    for failure in gate_result["failures"]:
        write_observability_event(_make_event(
            producer="run_finalizer",
            event_type="gate_result",
            run_id=run_id,
            gate_id=failure.get("gate", "unknown"),
            fields={
                "passed": False,
                "severity": "fail",
                "detail": failure.get("detail", ""),
                "claim_id": failure.get("claim_id", ""),
                "report": failure.get("report", ""),
            },
        ))
    for warning in gate_result["warnings"]:
        write_observability_event(_make_event(
            producer="run_finalizer",
            event_type="gate_result",
            run_id=run_id,
            gate_id=warning.get("gate", "unknown"),
            fields={
                "passed": True,
                "severity": "warning",
                "detail": warning.get("detail", ""),
                "claim_id": warning.get("claim_id", ""),
                "report": warning.get("report", ""),
            },
        ))


def finalize_run(
    ctx: "RunContext",
    report_dir: Path,
    output_dir: Path,
    dry_run: bool = False,
    research_only: bool = False,
    unavailable_tools: list[str] | None = None,
    write_artifacts: bool = True,
) -> dict[str, Any]:
    """Finalize one research run.

    Returns a structured result with counts, gate evaluation, diagnostics, and
    artifact paths.  The caller decides whether to continue to task generation
    and execution based on ``gate_result.hard_fail``.
    """
    run_id = ctx.run_id
    invocation_id = ctx.invocation_id

    # 1. Snapshot reports into the isolated run archive.
    snapshot = snapshot_reports(report_dir, ctx.archive_dir)

    # 2. Extract evidence and claims.
    graph_result = build_claim_graph_from_dir(
        report_dir=report_dir,
        run_id=run_id,
        site_url=ctx.site_url,
        region=ctx.region,
    )

    evidence_list = graph_result.get("evidence", [])
    claims = graph_result.get("claims", [])

    # 3. Validate evidence and claim graphs.
    ev_result = validate_evidence_package(evidence_list)
    claim_result = validate_claim_graph(claims)

    # 4. Evaluate gates.
    gate_result = evaluate_gates(
        graph_result=graph_result,
        ev_result=ev_result,
        claim_result=claim_result,
        dry_run=dry_run,
        research_only=research_only,
        unavailable_tools=unavailable_tools,
    )

    # 5. Write lineage-linked artifacts.
    artifact_paths: dict[str, str | None] = {}
    if write_artifacts:
        artifact_paths["evidence_package"] = str(write_evidence_package(evidence_list, run_id=run_id))
        artifact_paths["claim_graph"] = str(write_claim_graph(claims, run_id=run_id))

    # 6. Write extraction diagnostics.
    diagnostics_payload = {
        "run_id": run_id,
        "invocation_id": invocation_id,
        "finalized_at": _now_iso(),
        "dry_run": dry_run,
        "research_only": research_only,
        "unavailable_tools": unavailable_tools or [],
        "snapshot": snapshot,
        "counts": graph_result.get("counts", {}),
        "gate_result": gate_result,
        "evidence_validation": {
            "ok": ev_result.get("ok", False),
            "fail_gates": ev_result.get("fail_gates", 0),
            "warning_gates": ev_result.get("warning_gates", 0),
        },
        "claim_validation": {
            "ok": claim_result.get("ok", False),
            "failed_gates": claim_result.get("failed_gates", 0),
        },
        "diagnostics": graph_result.get("diagnostics", []),
    }
    artifact_paths["extraction_diagnostics"] = str(_write_extraction_diagnostics(output_dir, diagnostics_payload))

    # 7. Emit gate events.
    _emit_gate_events(run_id, gate_result)

    return {
        "run_id": run_id,
        "invocation_id": invocation_id,
        "dry_run": dry_run,
        "research_only": research_only,
        "counts": graph_result.get("counts", {}),
        "evidence": evidence_list,
        "claims": claims,
        "contradictions": graph_result.get("contradictions", []),
        "gate_result": gate_result,
        "evidence_validation": ev_result,
        "claim_validation": claim_result,
        "diagnostics": graph_result.get("diagnostics", []),
        "artifact_paths": artifact_paths,
        "snapshot": snapshot,
    }
