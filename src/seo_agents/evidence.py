"""Serialization helpers for evidence, claim, and run-lineage JSON writers.

Session 1 additive layer — preserves existing Markdown outputs and action/status
consumers.
Session 2 adds validation gates for provenance, staleness, contradictions, and confidence.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from seo_agents.contracts import (
    ClaimObject,
    EvidenceConfidence,
    EvidenceFreshness,
    EvidenceScope,
    EvidenceSource,
    EvidenceUnit,
    ExecutionTask,
    RunManifest,
    TaskConfidence,
    TaskPriority,
    TaskUncertainty,
    _json_safe,
    now_iso,
)

# ---------------------------------------------------------------------------
# Synthesis gates — Session 2 additions
# ---------------------------------------------------------------------------

# Maximum age for "live" evidence before it's considered stale (30 days)
LIVE_EVIDENCE_MAX_AGE_DAYS = 30

# Minimum confidence score required for "high" confidence
HIGH_CONFIDENCE_THRESHOLD = 0.75

# Minimum authority score to justify "high" confidence
MIN_AUTHORITY_FOR_HIGH = 0.5


def _parse_iso(date_str: str) -> datetime | None:
    """Parse an ISO-8601 string, returning None on failure."""
    if not date_str:
        return None
    try:
        s = date_str.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def validate_evidence_package(
    evidence_list: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate an evidence package against provenance, staleness, and confidence rules.

    Returns a dict with:
      - ok: bool — True when no gate failures exist
      - gates: list of gate dicts with name, severity, detail
      - claims: list of claim dicts with status derived from evidence
    """
    gates: list[dict[str, Any]] = []
    claims: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)

    for ev in evidence_list:
        # Gate 1: Missing provenance
        source = ev.get("source", {})
        if not source.get("uri") and not source.get("kind"):
            gates.append({
                "gate": "missing_provenance",
                "severity": "fail",
                "detail": f"Evidence {ev.get('evidence_id', 'unknown')} has no source URI or kind",
                "claim_id": ev.get("claim_id", ""),
            })

        # Gate 2: Stale live evidence
        if source.get("kind") == "live_page" or source.get("access_class") == "observed":
            retrieved = _parse_iso(source.get("retrieved_at", ""))
            if retrieved and (now - retrieved) > timedelta(days=LIVE_EVIDENCE_MAX_AGE_DAYS):
                gates.append({
                    "gate": "stale_evidence",
                    "severity": "warning",
                    "detail": f"Evidence {ev.get('evidence_id', 'unknown')} retrieved {((now - retrieved).days)} days ago (>={LIVE_EVIDENCE_MAX_AGE_DAYS} day threshold)",
                    "claim_id": ev.get("claim_id", ""),
                })

        # Gate 3: High confidence on weak source
        conf = ev.get("confidence", {})
        if isinstance(conf, dict):
            score = conf.get("score", 0.0)
            authority = conf.get("authority", 0.0)
            label = conf.get("label", "unknown")
            if label == "high" and authority < MIN_AUTHORITY_FOR_HIGH:
                gates.append({
                    "gate": "high_confidence_weak_source",
                    "severity": "warning",
                    "detail": f"Evidence {ev.get('evidence_id', 'unknown')} has high confidence (score={score}) but low authority ({authority})",
                    "claim_id": ev.get("claim_id", ""),
                })

        # Gate 4: Unresolved material contradictions
        contradiction_ids = ev.get("contradiction_ids", [])
        if contradiction_ids and ev.get("status") != "confirmed":
            gates.append({
                "gate": "unresolved_contradiction",
                "severity": "fail",
                "detail": f"Evidence {ev.get('evidence_id', 'unknown')} has {len(contradiction_ids)} contradiction(s) but status is {ev.get('status')}",
                "claim_id": ev.get("claim_id", ""),
            })

        # Gate 5: Secrets or sensitive data in excerpts
        excerpt = ev.get("evidence_excerpt", "")
        if excerpt:
            for pattern in [r"(\d{3}-?\d{4,6})", r"\b[A-Z]{2}\d{9}\b", r"api[_\-]?key\s*[=:\s]+[\w-]+"]:
                if re.search(pattern, excerpt):
                    gates.append({
                        "gate": "potential_secrets",
                        "severity": "fail",
                        "detail": f"Evidence {ev.get('evidence_id', 'unknown')} excerpt may contain sensitive data",
                        "claim_id": ev.get("claim_id", ""),
                    })
                    break

        # Build claim from evidence
        claim = {
            "claim_id": ev.get("claim_id", ""),
            "claim_type": ev.get("claim_type", ""),
            "statement": ev.get("statement", ""),
            "evidence_ids": [ev.get("evidence_id", "")],
            "confidence": ev.get("confidence", {}).get("label", "unknown") if isinstance(ev.get("confidence"), dict) else "unknown",
            "status": ev.get("status", "unknown"),
            "gate_failures": sum(1 for g in gates if g.get("claim_id") == ev.get("claim_id") and g.get("severity") == "fail"),
        }
        claims.append(claim)

    # Aggregate: if any claim has gate failures, mark it as rejected
    for c in claims:
        if c["gate_failures"] > 0:
            c["status"] = "rejected"

    return {
        "ok": len(gates) == 0 or all(g["severity"] == "warning" for g in gates),
        "gates": gates,
        "claims": claims,
        "total_evidence": len(evidence_list),
        "failed_claims": sum(1 for c in claims if c["status"] == "rejected"),
        "total_gates": len(gates),
        "fail_gates": sum(1 for g in gates if g["severity"] == "fail"),
        "warning_gates": sum(1 for g in gates if g["severity"] == "warning"),
    }


def validate_claim_graph(
    claims: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate claim graph for contradictions and promotion readiness.

    Returns gate results indicating which claims are safe to promote.
    """
    gates: list[dict[str, Any]] = []
    for claim in claims:
        # Gate: promoted claim without supporting evidence
        if claim.get("status") == "confirmed" and not claim.get("evidence_ids"):
            gates.append({
                "gate": "promoted_claim_no_evidence",
                "severity": "fail",
                "detail": f"Claim {claim.get('claim_id', '')} is confirmed but has no evidence IDs",
            })

        # Gate: high-confidence claim with contradictions
        if claim.get("confidence") == "high" and claim.get("contradiction_ids"):
            gates.append({
                "gate": "high_confidence_with_contradiction",
                "severity": "fail",
                "detail": f"Claim {claim.get('claim_id', '')} has high confidence but {len(claim['contradiction_ids'])} contradiction(s)",
            })

    return {
        "ok": len(gates) == 0,
        "gates": gates,
        "total_claims": len(claims),
        "failed_gates": sum(1 for g in gates if g.get("severity") == "fail"),
    }


def classify_research_gap(
    evidence_list: list[dict[str, Any]],
    claims: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Identify research gaps from evidence and claim validation."""
    gaps: list[dict[str, Any]] = []
    for claim in claims:
        if claim.get("status") in ("unknown", "rejected"):
            gaps.append({
                "claim_id": claim.get("claim_id", ""),
                "gap_reason": f"Claim status is {claim['status']} — {claim.get('claim_type', 'unknown')}",
                "blocked_by": claim.get("contradiction_ids", []),
            })
    return gaps


def research_gap_result(
    evidence_list: list[dict[str, Any]],
) -> bool:
    """Determine if the overall research should be flagged as a gap.

    Returns True when there are enough gate failures to warrant a research gap.
    """
    result = validate_evidence_package(evidence_list)
    return result["failed_claims"] > 0 or result["fail_gates"] >= 3

# ---------------------------------------------------------------------------
# Output paths (must match PLAN.md target contract)
# ---------------------------------------------------------------------------

OUTPUT_DIR = Path(r"C:\Workspace\Active\SEO-Agents-App\outputs")

EVIDENCE_PACKAGE_PATH = OUTPUT_DIR / "evidence_package.json"
CLAIM_GRAPH_PATH = OUTPUT_DIR / "claim_graph.json"
TASK_GRAPH_PATH = OUTPUT_DIR / "task_graph.json"
RUN_MANIFEST_PATH = OUTPUT_DIR / "run_manifest.json"
OBSERVABILITY_PATH = OUTPUT_DIR / "observability.jsonl"


# ---------------------------------------------------------------------------
# Run manifest writer
# ---------------------------------------------------------------------------

def write_run_manifest(manifest: RunManifest) -> Path:
    """Write the deterministic run manifest and return the path."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = _json_safe(manifest.to_dict())
    tmp = RUN_MANIFEST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(RUN_MANIFEST_PATH)
    return RUN_MANIFEST_PATH


# ---------------------------------------------------------------------------
# Evidence package writer
# ---------------------------------------------------------------------------

def write_evidence_package(
    evidence_list: list[dict[str, Any]],
    run_id: str = "",
) -> Path:
    """Write all evidence units collected this run.

    If ``evidence_list`` is empty, ``run_id`` is explicitly required so the
    writer does not silently lose the invocation identity.
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    rid = run_id or (evidence_list[0].get("run_id", "") if evidence_list else "")
    payload = {"run_id": rid, "evidence": evidence_list}
    tmp = EVIDENCE_PACKAGE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(EVIDENCE_PACKAGE_PATH)
    return EVIDENCE_PACKAGE_PATH


# ---------------------------------------------------------------------------
# Claim graph writer
# ---------------------------------------------------------------------------

def write_claim_graph(
    claims: list[dict[str, Any]],
    run_id: str = "",
) -> Path:
    """Write the claim graph — a directed graph of claims with relations.

    If ``claims`` is empty, ``run_id`` is explicitly required so the writer
    does not silently lose the invocation identity.
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    rid = run_id or (claims[0].get("run_id", "") if claims else "")
    payload = {"run_id": rid, "claims": claims}
    tmp = CLAIM_GRAPH_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(CLAIM_GRAPH_PATH)
    return CLAIM_GRAPH_PATH


# ---------------------------------------------------------------------------
# Task graph writer
# ---------------------------------------------------------------------------

def write_task_graph(tasks: list[dict[str, Any]], run_id: str = "") -> Path:
    """Write the task graph with dependencies and status."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"run_id": run_id, "tasks": tasks}
    tmp = TASK_GRAPH_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(TASK_GRAPH_PATH)
    return TASK_GRAPH_PATH


# ---------------------------------------------------------------------------
# Observability writer (JSONL append)
# ---------------------------------------------------------------------------

def write_observability_event(
    event: dict[str, Any],
    run_id: str = "",
) -> None:
    """Append one structured event to the JSONL observability log."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    event["run_id"] = run_id or event.get("run_id", "unknown")
    if "timestamp" not in event or not event["timestamp"]:
        event["timestamp"] = now_iso()

    # Append atomically: read existing content, write tmp, replace.
    tmp = OBSERVABILITY_PATH.with_suffix(
        f".jsonl.tmp-{uuid.uuid4().hex[:8]}"
    )
    existing = ""
    if OBSERVABILITY_PATH.exists():
        existing = OBSERVABILITY_PATH.read_text(encoding="utf-8")
    content = existing.rstrip("\n")
    if content:
        content += "\n"
    content += json.dumps(event, indent=2) + "\n"
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(OBSERVABILITY_PATH)
