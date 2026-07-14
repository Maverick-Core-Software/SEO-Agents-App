"""Serialization helpers for evidence, claim, and run-lineage JSON writers.

Session 1 additive layer — preserves existing Markdown outputs and action/status
consumers.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
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

def write_evidence_package(evidence_list: list[dict[str, Any]]) -> Path:
    """Write all evidence units collected this run."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"run_id": evidence_list[0].get("run_id", "") if evidence_list else "", "evidence": evidence_list}
    tmp = EVIDENCE_PACKAGE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(EVIDENCE_PACKAGE_PATH)
    return EVIDENCE_PACKAGE_PATH


# ---------------------------------------------------------------------------
# Claim graph writer
# ---------------------------------------------------------------------------

def write_claim_graph(claims: list[dict[str, Any]]) -> Path:
    """Write the claim graph — a directed graph of claims with relations."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"run_id": claims[0].get("run_id", "") if claims else "", "claims": claims}
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
    tmp = OBSERVABILITY_PATH.with_suffix(".jsonl.tmp")
    with open(tmp, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, indent=2) + "\n")
    tmp.replace(OBSERVABILITY_PATH)
