"""Evidence, claim, and execution-task Pydantic contracts for Session 1.

These models and helpers are additive — they extend existing outputs without
removing the Markdown projections or the current action/status consumers.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Evidence unit
# ---------------------------------------------------------------------------

class EvidenceScope(BaseModel):
    site: str
    region: str


class EvidenceSource(BaseModel):
    kind: str = Field(
        description="live_page|google_policy|serp|baseline|owner_input|tool_output"
    )
    uri: str = ""
    title: str = ""
    retrieved_at: str = Field(default="", description="ISO-8601 timestamp")
    authority_rank: float = 0.0
    access_class: str = Field(
        default="",
        description="observed|provided|inferred|unavailable",
    )


class EvidenceConfidence(BaseModel):
    label: str = Field(
        default="unknown",
        description="high|medium|low|unknown",
    )
    score: float = 0.0
    authority: float = 0.0
    recency: float = 0.0
    method_transparency: float = 0.0
    corroboration: float = 0.0
    access: float = 0.0
    basis: str = ""


class EvidenceFreshness(BaseModel):
    captured_at: str = Field(default="", description="ISO-8601 timestamp")
    valid_until: Optional[str] = None
    supersedes: list[str] = Field(default_factory=list)


class EvidenceUnit(BaseModel):
    """One atomic piece of evidence with provenance, confidence, and freshness."""

    evidence_id: str = Field(default="", description="ev_<run_id>_<sequence>")
    run_id: str = Field(default="", description="Shared lineage ID for this run")
    claim_id: str = Field(default="", description="claim_<stable_hash>")
    claim_type: str = Field(
        default="",
        description="observation|policy|recommendation|hypothesis|negative_finding",
    )
    statement: str = ""
    scope: EvidenceScope = Field(default_factory=EvidenceScope)
    source: EvidenceSource = Field(default_factory=EvidenceSource)
    evidence_excerpt: str = ""
    relation: str = Field(
        default="",
        description="supports|weakens|contradicts|insufficient",
    )
    confidence: EvidenceConfidence = Field(default_factory=EvidenceConfidence)
    freshness: EvidenceFreshness = Field(default_factory=EvidenceFreshness)
    contradiction_ids: list[str] = Field(default_factory=list)
    reproducibility_key: str = ""
    supporting_report: str = ""
    status: str = Field(
        default="unknown",
        description="confirmed|provisional|unknown|rejected",
    )

    @field_validator("confidence")
    @classmethod
    def _set_confidence_from_scores(cls, v: "EvidenceConfidence") -> "EvidenceConfidence":
        """Derive the convenience label from score when the caller only provides score."""
        if v.label == "unknown" and v.score > 0:
            if v.score >= 0.75:
                v.label = "high"
            elif v.score >= 0.5:
                v.label = "medium"
            else:
                v.label = "low"
        return v

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Claim object
# ---------------------------------------------------------------------------

class ClaimObject(BaseModel):
    """Stable claim derived from one or more evidence units."""

    claim_id: str = Field(default="", description="claim_<stable_hash>")
    claim_type: str = Field(
        default="",
        description="observation|policy|recommendation|hypothesis|negative_finding",
    )
    statement: str = ""
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: str = Field(
        default="unknown",
        description="high|medium|low|unknown",
    )
    scope: EvidenceScope = Field(default_factory=EvidenceScope)
    relation: str = Field(
        default="",
        description="supports|weakens|contradicts|insufficient",
    )
    contradiction_ids: list[str] = Field(default_factory=list)
    status: str = Field(
        default="unknown",
        description="confirmed|provisional|unknown|rejected",
    )

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Execution task object
# ---------------------------------------------------------------------------

class TaskPriority(BaseModel):
    tier: str = Field(default="P3", description="P0|P1|P2|P3")
    score: float = 0.0
    formula_version: str = "priority-v1"


class TaskConfidence(BaseModel):
    label: str = "unknown"
    score: float = 0.0


class TaskUncertainty(BaseModel):
    proxy_metrics_used: list[str] = Field(default_factory=list)
    gap_reason: Optional[str] = None
    blocked_by: list[str] = Field(default_factory=list)


class ExecutionTask(BaseModel):
    """One actionable task linked to supporting claims."""

    task_id: str = Field(default="", description="T-<run_id>-<seq>")
    run_id: str = ""
    title: str = ""
    task_type: str = Field(
        default="",
        description="technical_fix|content_update|local_update|review_work|research_gap|monitoring_alert_check",
    )
    supporting_claim_ids: list[str] = Field(default_factory=list)
    owner: str = Field(
        default="",
        description="website_manager|content_executor|local_presence_assets|owner_review",
    )
    priority: TaskPriority = Field(default_factory=TaskPriority)
    confidence: TaskConfidence = Field(default_factory=TaskConfidence)
    dependencies: list[str] = Field(default_factory=list)
    preconditions: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    verification: dict[str, Any] = Field(default_factory=dict)
    rollback: str = ""
    approval_class: str = Field(
        default="none",
        description="none|sampled|mandatory",
    )
    uncertainty: TaskUncertainty = Field(default_factory=TaskUncertainty)
    idempotency_key: str = ""
    status: str = Field(
        default="research_gap",
        description="research_gap|ready|waiting_on_owner|waiting_on_tool_access|approved|executing|verified|blocked",
    )

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Run manifest (metadata baked into every run)
# ---------------------------------------------------------------------------

class RunManifest(BaseModel):
    """Deterministic run metadata for lineage tracking."""

    run_id: str = ""
    topic: str = ""
    provider: str = "unknown"
    model: str = "unknown"
    research_model: str = "unknown"
    exec_model: str = "unknown"
    started_at: str = ""
    site_url: str = ""
    region: str = ""
    audience: str = ""
    keywords: str = ""
    dry_run: bool = False
    research_only: bool = False
    outputs: list[str] = Field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def stable_hash(*, prefix: str = "claim_", data: str = "") -> str:
    """Deterministic hash for claim IDs and idempotency keys."""
    h = hashlib.sha256(data.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}{h}"


def make_evidence_id(run_id: str, seq: int) -> str:
    return f"ev_{run_id}_{seq:03d}"


def make_task_id(run_id: str, seq: int) -> str:
    return f"T-{run_id}-{seq:03d}"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json_safe(obj: Any) -> Any:
    """Ensure Pydantic model outputs are plain dicts (no BaseModel wrappers)."""
    if isinstance(obj, BaseModel):
        return _json_safe(obj.model_dump(mode="json"))
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(item) for item in obj]
    return obj
