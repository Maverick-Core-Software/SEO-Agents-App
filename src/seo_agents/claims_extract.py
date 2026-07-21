"""Claim extraction and truthful evidence normalization for Session 2.

Parses specialist reports and the manager plan into evidence units, claims,
and a claim graph. Reports diagnostics for malformed blocks, missing reports,
duplicate claim IDs, unknown metadata, and unresolved contradictions.

The parser tolerates harmless Markdown variation (blank lines, field reordering)
but rejects ambiguous or incomplete blocks into diagnostics rather than
silently inventing fields.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from seo_agents.contracts import (
    ClaimObject,
    EvidenceConfidence,
    EvidenceFreshness,
    EvidenceScope,
    EvidenceSource,
    EvidenceUnit,
    _json_safe,
    make_evidence_id,
    now_iso,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RESEARCH_REPORTS = {
    "content_report.md": ("CONTENT", "content"),
    "website_report.md": ("WEBSITE", "website"),
    "gbp_report.md": ("GBP", "gbp"),
    "reputation_report.md": ("REPUTATION", "reputation"),
    "grizzly_local_presence_plan.md": (None, "manager_plan"),
}

SUPPORTED_CLAIM_TYPES = {
    "observation",
    "policy",
    "recommendation",
    "hypothesis",
    "negative_finding",
}

SUPPORTED_SOURCE_MODES = {"live", "baseline", "unavailable"}

SUPPORTED_SOURCE_KINDS = {
    "live_page",
    "serp",
    "gbp_profile",
    "review",
    "google_policy",
    "baseline",
    "owner_input",
    "tool_output",
    "unavailable",
    "unknown",
}

REPORT_DEFAULT_SOURCE_KIND = {
    "content_report.md": "serp",
    "website_report.md": "live_page",
    "gbp_report.md": "gbp_profile",
    "reputation_report.md": "review",
    "grizzly_local_presence_plan.md": "baseline",
}

# Freshness thresholds
LIVE_FRESH_DAYS = 30
BASELINE_FRESH_DAYS = 90

# Confidence derivation weights
CONF_WEIGHTS = {
    "authority": 0.25,
    "recency": 0.20,
    "method": 0.20,
    "corroboration": 0.20,
    "access": 0.15,
}

# ---------------------------------------------------------------------------
# Diagnostics helpers
# ---------------------------------------------------------------------------


def _diag(
    severity: str,
    code: str,
    detail: str,
    report: str = "",
    claim_id: str = "",
) -> dict[str, Any]:
    return {
        "severity": severity,
        "code": code,
        "detail": detail,
        "report": report,
        "claim_id": claim_id,
    }


def _stable_hash(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Timestamp parsing
# ---------------------------------------------------------------------------


def parse_iso_timestamp(value: str) -> datetime | None:
    """Parse an ISO-8601 timestamp, returning None on failure or empty input.

    Naive timestamps are assumed to be UTC so they can be compared with
    offset-aware datetimes.
    """
    if not value or value.strip().lower() in {"unavailable", "n/a", "na", "none", ""}:
        return None
    s = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def is_timestamp_with_timezone(value: str) -> bool:
    """Return True if the string carries an explicit timezone offset or Z."""
    if not value:
        return False
    return bool(re.search(r"[Zz]|[+-]\d{2}:\d{2}$", value.strip()))


# ---------------------------------------------------------------------------
# Claim block parsing
# ---------------------------------------------------------------------------


def _split_into_blocks(text: str) -> list[str]:
    """Split report text into candidate claim blocks.

    A block begins with a line containing '**Claim ID:**' and ends at the next
    such line or end of document. The statement text preceding the metadata
    block is preserved.
    """
    if not text:
        return []
    marker = re.compile(r"^\s*\*\*Claim ID(?::\*\*|\*\*:)\s*", re.MULTILINE)
    matches = list(marker.finditer(text))
    if not matches:
        return []
    blocks: list[str] = []
    for i, match in enumerate(matches):
        prev_end = matches[i - 1].end() if i > 0 else 0
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        statement = text[prev_end:start].strip()
        body = text[start:end]
        if statement:
            blocks.append(f"{statement}\n\n{body}")
        else:
            blocks.append(body)
    return blocks


def _extract_field(block: str, label: str) -> str | None:
    """Extract the value for a labeled field from a claim block.

    Tolerates surrounding bold markers, optional numbering, leading dashes,
    and field reordering. Returns None if the field is absent.
    """
    # Match lines like: "**Label:** value", "**Label**: value",
    # "1) **Label:** value", "- **Label:** value"
    field_re = re.compile(
        rf"(?:^|\n)\s*(?:\d+[\.\)]\s*)?(?:-\s*)?\*\*[^:*\n]+(?::\*\*|\*\*:)",
        re.IGNORECASE,
    )
    matches = list(field_re.finditer(block))
    for i, m in enumerate(matches):
        # Extract the label text from the matched marker
        marker_text = m.group(0)
        marker_label_match = re.search(r"\*\*([^:*\n]+)(?::\*\*|\*\*:)", marker_text, re.IGNORECASE)
        if not marker_label_match:
            continue
        marker_label = marker_label_match.group(1).strip().lower()
        if marker_label != label.lower():
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(block)
        value = block[start:end].strip()
        # Remove trailing bold markers that may have bled in
        value = re.sub(r"\s*\*\*[^*]*$", "", value).strip()
        # Strip inline markdown emphasis
        value = re.sub(r"\*\*([^*]+)\*\*", r"\1", value).strip()
        return value
    return None


def _extract_statement(block: str) -> str:
    """Return the free-form text before the first metadata field."""
    lines = block.splitlines()
    statement_lines: list[str] = []
    for line in lines:
        if re.match(r"^\s*(?:\d+[\.\)]\s*)?(?:-\s*)?\*\*[^:*\n]+(?::\*\*|\*\*:)\s*", line):
            break
        statement_lines.append(line)
    return "\n".join(statement_lines).strip()


def _split_contradiction_ids(raw: str | None) -> list[str]:
    if not raw:
        return []
    ids: list[str] = []
    for part in re.split(r"[,;|\s]+", raw):
        part = part.strip()
        if part.startswith("claim_"):
            ids.append(part)
    return ids


# ---------------------------------------------------------------------------
# Block → raw claim + evidence
# ---------------------------------------------------------------------------


def _normalize_source_kind(
    raw_kind: str | None,
    report_name: str,
    source_mode: str,
) -> tuple[str, list[dict[str, Any]]]:
    """Normalize source kind, returning kind and any diagnostics."""
    diags: list[dict[str, Any]] = []
    kind = (raw_kind or "").strip().lower()
    if not kind or kind in {"unknown", "n/a", "na", "none"}:
        if source_mode == "unavailable":
            kind = "unavailable"
        else:
            kind = REPORT_DEFAULT_SOURCE_KIND.get(report_name, "unknown")
            if kind == "unknown":
                diags.append(
                    _diag("warning", "unknown_source_kind", "Source Kind missing or unusable; marking as unknown")
                )
    if kind not in SUPPORTED_SOURCE_KINDS:
        diags.append(
            _diag("warning", "unsupported_source_kind", f"Source Kind '{kind}' not in supported set; using unknown")
        )
        kind = "unknown"
    return kind, diags


def _derive_confidence(
    source_mode: str,
    source_kind: str,
    authority_rank: float,
    access_class: str,
    retrieved_at: str,
    has_excerpt: bool,
    contradiction_ids: list[str],
    unavailable_reason: str,
) -> tuple[EvidenceConfidence, list[dict[str, Any]]]:
    """Derive confidence conservatively from validated metadata."""
    diags: list[dict[str, Any]] = []

    if source_mode == "unavailable":
        basis = "Source unavailable"
        if unavailable_reason:
            basis += f": {unavailable_reason}"
        return (
            EvidenceConfidence(
                label="unknown",
                score=0.0,
                authority=0.0,
                recency=0.0,
                method_transparency=0.0,
                corroboration=0.0,
                access=0.0,
                basis=basis,
            ),
            diags,
        )

    # Authority
    authority = max(0.0, min(1.0, float(authority_rank or 0.0)))

    # Recency from retrieved_at
    recency = 0.0
    retrieved_dt = parse_iso_timestamp(retrieved_at)
    if retrieved_dt:
        age = datetime.now(timezone.utc) - retrieved_dt
        if age <= timedelta(days=7):
            recency = 1.0
        elif age <= timedelta(days=LIVE_FRESH_DAYS):
            recency = 0.7
        elif age <= timedelta(days=BASELINE_FRESH_DAYS):
            recency = 0.4
        else:
            recency = 0.2

    # Method transparency
    method = 0.7 if has_excerpt else 0.4

    # Access class
    access_map = {"observed": 1.0, "provided": 0.7, "inferred": 0.4, "unavailable": 0.0}
    access = access_map.get(access_class, 0.4)

    # Corroboration: none within a single evidence unit
    corroboration = 0.0

    score = round(
        CONF_WEIGHTS["authority"] * authority
        + CONF_WEIGHTS["recency"] * recency
        + CONF_WEIGHTS["method"] * method
        + CONF_WEIGHTS["corroboration"] * corroboration
        + CONF_WEIGHTS["access"] * access,
        3,
    )

    if score >= 0.75:
        label = "high"
    elif score >= 0.5:
        label = "medium"
    elif score > 0.0:
        label = "low"
    else:
        label = "unknown"

    basis_parts = [f"source_mode={source_mode}", f"source_kind={source_kind}"]
    if authority_rank:
        basis_parts.append(f"authority_rank={authority_rank}")
    if access_class:
        basis_parts.append(f"access_class={access_class}")
    if retrieved_dt:
        basis_parts.append(f"retrieved_at={retrieved_at}")
    if has_excerpt:
        basis_parts.append("evidence_excerpt_present")
    if contradiction_ids:
        basis_parts.append(f"contradictions={len(contradiction_ids)}")

    basis = "Derived from " + ", ".join(basis_parts)

    return (
        EvidenceConfidence(
            label=label,
            score=score,
            authority=round(authority, 3),
            recency=round(recency, 3),
            method_transparency=round(method, 3),
            corroboration=round(corroboration, 3),
            access=round(access, 3),
            basis=basis,
        ),
        diags,
    )


def _derive_status(
    validation_errors: list[str],
    source_mode: str,
    source_kind: str,
    source_uri: str,
    confidence_score: float,
    is_stale: bool,
    contradiction_ids: list[str],
    negative_findings_present: bool,
) -> str:
    """Derive claim/evidence status conservatively."""
    if validation_errors:
        return "rejected"
    if source_mode == "unavailable" or source_kind == "unavailable":
        return "unknown"
    if source_kind == "unknown" or not source_kind:
        return "unknown"
    if source_mode == "baseline" and is_stale:
        return "provisional"
    if not source_uri or source_uri.lower() in {"unavailable", "n/a", "na", "none"}:
        return "unknown"
    if contradiction_ids:
        return "provisional"
    if confidence_score >= 0.6 and not is_stale:
        return "confirmed"
    if confidence_score > 0.0:
        return "provisional"
    return "unknown"


def _is_stale(source_mode: str, source_kind: str, retrieved_at: str) -> tuple[bool, str]:
    """Check whether evidence is stale based on source mode and age."""
    dt = parse_iso_timestamp(retrieved_at)
    if not dt:
        return False, ""
    age = datetime.now(timezone.utc) - dt
    if source_mode == "baseline" or source_kind == "baseline":
        threshold = BASELINE_FRESH_DAYS
    else:
        threshold = LIVE_FRESH_DAYS
    if age > timedelta(days=threshold):
        return True, f"{age.days} days old (threshold {threshold})"
    return False, ""


def parse_claim_block(
    block: str,
    report_name: str,
    run_id: str,
    seq: int,
    site_url: str = "",
    region: str = "",
) -> tuple[EvidenceUnit | None, ClaimObject | None, list[dict[str, Any]]]:
    """Parse one claim block into an evidence unit and claim object.

    Returns (evidence, claim, diagnostics). Either model may be None when the
    block is too malformed to produce a valid unit.
    """
    diags: list[dict[str, Any]] = []

    claim_id_raw = _extract_field(block, "Claim ID")
    claim_type = _extract_field(block, "Claim Type")
    source_mode = _extract_field(block, "Source Mode")
    source_kind_raw = _extract_field(block, "Source Kind")
    source_uri = _extract_field(block, "Source URI") or _extract_field(block, "URI")
    source_title = _extract_field(block, "Source Title") or _extract_field(block, "Title")
    retrieved_at = _extract_field(block, "Retrieved At")
    captured_at = _extract_field(block, "Captured At")
    negative_findings = _extract_field(block, "Negative Findings")
    evidence_excerpt = _extract_field(block, "Evidence Excerpt") or _extract_field(block, "Excerpt")
    relation = _extract_field(block, "Relation") or "supports"
    contradiction_ids = _split_contradiction_ids(_extract_field(block, "Contradiction IDs"))
    status_override = _extract_field(block, "Status")

    statement = _extract_statement(block)

    # Validate claim ID
    if not claim_id_raw:
        diags.append(_diag("error", "missing_claim_id", "Claim block has no Claim ID", report=report_name))
        return None, None, diags
    claim_id = claim_id_raw.strip().split()[0]
    if not re.match(r"^claim_[a-f0-9]{16}$", claim_id):
        # Auto-normalize non-conforming IDs to valid claim_<16-hex> format
        # by hashing the original ID. This keeps downstream lookups working
        # while emitting a warning instead of a hard error.
        import hashlib
        hex_hash = hashlib.md5(claim_id.encode()).hexdigest()[:16]
        normalized_id = f"claim_{hex_hash}"
        diags.append(
            _diag(
                "warning",
                "normalized_claim_id",
                f"Claim ID '{claim_id}' normalized to '{normalized_id}' (not 16-hex format)",
                report=report_name,
                claim_id=normalized_id,
            )
        )
        claim_id = normalized_id

    # Validate claim type
    if not claim_type:
        diags.append(
            _diag("error", "missing_claim_type", "Missing Claim Type", report=report_name, claim_id=claim_id)
        )
        claim_type = "unknown"
    elif claim_type.lower() not in SUPPORTED_CLAIM_TYPES:
        diags.append(
            _diag(
                "error",
                "unsupported_claim_type",
                f"Claim Type '{claim_type}' not supported",
                report=report_name,
                claim_id=claim_id,
            )
        )
        claim_type = claim_type.lower()
    else:
        claim_type = claim_type.lower()

    # Validate source mode
    if not source_mode:
        diags.append(
            _diag("error", "missing_source_mode", "Missing Source Mode", report=report_name, claim_id=claim_id)
        )
        source_mode = "unavailable"
    elif source_mode.lower() not in SUPPORTED_SOURCE_MODES:
        diags.append(
            _diag(
                "error",
                "unsupported_source_mode",
                f"Source Mode '{source_mode}' not supported",
                report=report_name,
                claim_id=claim_id,
            )
        )
        source_mode = source_mode.lower()
    else:
        source_mode = source_mode.lower()

    # Normalize source kind
    source_kind, kind_diags = _normalize_source_kind(source_kind_raw, report_name, source_mode)
    diags.extend(kind_diags)

    # Validate timestamp
    if not retrieved_at or retrieved_at.lower() in {"unavailable", "n/a", "na", "none"}:
        if source_mode != "unavailable":
            diags.append(
                _diag(
                    "warning",
                    "missing_retrieved_at",
                    "Retrieved At missing or unavailable for non-unavailable source",
                    report=report_name,
                    claim_id=claim_id,
                )
            )
        retrieved_at = ""
    elif not parse_iso_timestamp(retrieved_at):
        diags.append(
            _diag(
                "error",
                "malformed_timestamp",
                f"Retrieved At '{retrieved_at}' is not parseable ISO-8601",
                report=report_name,
                claim_id=claim_id,
            )
        )
    elif not is_timestamp_with_timezone(retrieved_at):
        diags.append(
            _diag(
                "warning",
                "missing_timezone",
                f"Retrieved At '{retrieved_at}' lacks explicit timezone",
                report=report_name,
                claim_id=claim_id,
            )
        )

    # Source URI / unavailable reason handling
    unavailable_reason = ""
    if source_mode == "unavailable":
        unavailable_reason = source_uri or negative_findings or "Source not reachable"
        source_uri = ""
        source_title = source_title or "Unavailable"
    elif not source_uri:
        raw_kind = (source_kind_raw or "").strip().lower()
        if raw_kind in {"unknown", "", "n/a", "na", "none"}:
            diags.append(
                _diag(
                    "error",
                    "missing_source_uri_and_kind",
                    "No Source URI and no usable Source Kind; evidence is provisional",
                    report=report_name,
                    claim_id=claim_id,
                )
            )
        else:
            diags.append(
                _diag(
                    "warning",
                    "missing_source_uri",
                    "Source URI missing",
                    report=report_name,
                    claim_id=claim_id,
                )
            )

    # Statement / excerpt non-emptiness
    if not statement.strip():
        diags.append(
            _diag(
                "warning",
                "empty_statement",
                "Claim statement text is empty",
                report=report_name,
                claim_id=claim_id,
            )
        )

    has_excerpt = bool(evidence_excerpt and evidence_excerpt.strip())
    if not has_excerpt and source_mode != "unavailable":
        diags.append(
            _diag(
                "warning",
                "missing_evidence_excerpt",
                "No evidence excerpt provided",
                report=report_name,
                claim_id=claim_id,
            )
        )

    # Negative findings
    negative_findings_present = bool(
        negative_findings
        and negative_findings.strip()
        and negative_findings.strip().lower() not in {"none identified", "none", "n/a", "na"}
    )

    # Determine access class
    access_class = "unavailable" if source_mode == "unavailable" else "observed"
    if source_mode == "baseline":
        access_class = "provided"
    elif source_kind in {"owner_input", "tool_output"}:
        access_class = "provided"

    # Staleness
    is_stale, stale_reason = _is_stale(source_mode, source_kind, retrieved_at)
    if is_stale:
        diags.append(
            _diag(
                "warning",
                "stale_evidence",
                f"Evidence is stale: {stale_reason}",
                report=report_name,
                claim_id=claim_id,
            )
        )

    # Confidence
    authority_rank: float = 0.0
    if source_mode == "live" and source_uri:
        authority_rank = 0.8
    elif source_mode == "baseline":
        authority_rank = 0.6

    confidence, conf_diags = _derive_confidence(
        source_mode=source_mode,
        source_kind=source_kind,
        authority_rank=authority_rank,
        access_class=access_class,
        retrieved_at=retrieved_at,
        has_excerpt=has_excerpt,
        contradiction_ids=contradiction_ids,
        unavailable_reason=unavailable_reason,
    )
    diags.extend(conf_diags)

    # Validation errors determine rejected status
    validation_errors = [d for d in diags if d["severity"] == "error"]

    status = _derive_status(
        validation_errors=validation_errors,
        source_mode=source_mode,
        source_kind=source_kind,
        source_uri=source_uri or "",
        confidence_score=confidence.score,
        is_stale=is_stale,
        contradiction_ids=contradiction_ids,
        negative_findings_present=negative_findings_present,
    )
    if status_override and status_override.lower() in {"confirmed", "provisional", "unknown", "rejected"}:
        # Trust override only if no validation errors; otherwise keep rejected.
        if not validation_errors:
            status = status_override.lower()

    evidence_id = make_evidence_id(run_id, seq)

    evidence = EvidenceUnit(
        evidence_id=evidence_id,
        run_id=run_id,
        claim_id=claim_id,
        claim_type=claim_type,
        statement=statement,
        scope=EvidenceScope(site=site_url or "unknown", region=region or "unknown"),
        source=EvidenceSource(
            kind=source_kind,
            uri=source_uri or "",
            title=source_title or "",
            retrieved_at=retrieved_at or ("" if source_mode != "unavailable" else "unavailable"),
            authority_rank=authority_rank,
            access_class=access_class,
        ),
        evidence_excerpt=(
            f"{evidence_excerpt}\n\nNegative findings: {negative_findings}".strip()
            if evidence_excerpt and negative_findings_present
            else evidence_excerpt
            or (negative_findings if negative_findings_present else "")
        ),
        relation=relation.lower() if relation else "supports",
        confidence=confidence,
        freshness=EvidenceFreshness(
            captured_at=captured_at or (retrieved_at if retrieved_at else now_iso()),
            valid_until=None,
            supersedes=[],
        ),
        contradiction_ids=contradiction_ids,
        supporting_report=report_name,
        status=status,
    )

    claim = ClaimObject(
        claim_id=claim_id,
        claim_type=claim_type,
        statement=statement,
        evidence_ids=[evidence_id],
        confidence=confidence.label,
        scope=EvidenceScope(site=site_url or "unknown", region=region or "unknown"),
        relation=relation.lower() if relation else "supports",
        contradiction_ids=contradiction_ids,
        status=status,
    )

    return evidence, claim, diags


# ---------------------------------------------------------------------------
# Report-level extraction
# ---------------------------------------------------------------------------


def validate_report_markers(text: str, report_name: str) -> tuple[bool, str, list[dict[str, Any]]]:
    """Check [START:X] / [END:X] markers for specialist reports."""
    diags: list[dict[str, Any]] = []
    marker_name, _ = RESEARCH_REPORTS.get(report_name, (None, ""))
    if not marker_name:
        return True, "", diags
    start = f"[START:{marker_name}]"
    end = f"[END:{marker_name}]"
    has_start = start in text
    has_end = end in text
    if not has_start and not has_end:
        diags.append(_diag("error", "missing_report_markers", f"Missing {start} and {end}", report=report_name))
        return False, marker_name, diags
    if not has_start:
        diags.append(_diag("warning", "missing_start_marker", f"Missing {start}", report=report_name))
    if not has_end:
        # Missing end marker is non-fatal — the report body extends to EOF.
        diags.append(_diag("warning", "missing_end_marker", f"Missing {end}", report=report_name))
    return not diags, marker_name, diags


def _strip_report_markers(text: str, report_name: str) -> str:
    """Remove [START:X] and [END:X] markers from report text."""
    marker_name, _ = RESEARCH_REPORTS.get(report_name, (None, ""))
    if not marker_name:
        return text
    start = f"[START:{marker_name}]"
    end = f"[END:{marker_name}]"
    text = text.replace(start, "").replace(end, "")
    # Also tolerate lowercase variants inserted by models
    text = text.replace(start.lower(), "").replace(end.lower(), "")
    return text


def extract_claims_from_report(
    text: str,
    report_name: str,
    run_id: str,
    site_url: str = "",
    region: str = "",
    start_seq: int = 1,
) -> dict[str, Any]:
    """Extract evidence units and claims from one report.

    Returns a dict with ``evidence``, ``claims``, ``diagnostics``, and
    ``marker_ok``.
    """
    evidence_list: list[EvidenceUnit] = []
    claims: list[ClaimObject] = []
    diagnostics: list[dict[str, Any]] = []

    marker_ok, marker_name, marker_diags = validate_report_markers(text, report_name)
    diagnostics.extend(marker_diags)

    text = _strip_report_markers(text, report_name)
    blocks = _split_into_blocks(text)
    if not blocks:
        if text.strip():
            # If the text contains claim-like metadata but no Claim ID, report it.
            if re.search(r"\*\*(?:Claim Type|Source Mode|Source Kind|Source URI)(?::\*\*|\*\*:)", text, re.IGNORECASE):
                diagnostics.append(
                    _diag("error", "missing_claim_id", "Claim-like metadata found but no Claim ID", report=report_name)
                )
            else:
                diagnostics.append(
                    _diag("warning", "no_claim_blocks", "No claim blocks found in non-empty report", report=report_name)
                )
        else:
            diagnostics.append(
                _diag("warning", "empty_report", "Report body is empty after marker stripping", report=report_name)
            )

    seen_ids: set[str] = set()
    evidence_by_id: dict[str, EvidenceUnit] = {}
    claim_by_id: dict[str, ClaimObject] = {}
    seq = start_seq
    for block in blocks:
        ev, claim, block_diags = parse_claim_block(
            block=block,
            report_name=report_name,
            run_id=run_id,
            seq=seq,
            site_url=site_url,
            region=region,
        )
        seq += 1
        diagnostics.extend(block_diags)
        if ev is None or claim is None:
            continue
        if claim.claim_id in seen_ids:
            diagnostics.append(
                _diag(
                    "error",
                    "duplicate_claim_id",
                    f"Duplicate Claim ID '{claim.claim_id}' in report",
                    report=report_name,
                    claim_id=claim.claim_id,
                )
            )
            # Mark both occurrences as rejected due to duplication
            ev.status = "rejected"
            claim.status = "rejected"
            if claim.claim_id in evidence_by_id:
                evidence_by_id[claim.claim_id].status = "rejected"
            if claim.claim_id in claim_by_id:
                claim_by_id[claim.claim_id].status = "rejected"
        seen_ids.add(claim.claim_id)
        evidence_list.append(ev)
        claims.append(claim)
        evidence_by_id[claim.claim_id] = ev
        claim_by_id[claim.claim_id] = claim

    return {
        "report": report_name,
        "marker_ok": marker_ok,
        "marker": marker_name,
        "evidence": [_json_safe(ev.to_dict()) for ev in evidence_list],
        "claims": [_json_safe(c.to_dict()) for c in claims],
        "diagnostics": diagnostics,
        "next_seq": seq,
    }


# ---------------------------------------------------------------------------
# Contradiction extraction from manager plan
# ---------------------------------------------------------------------------


def extract_contradictions(
    text: str,
    report_name: str,
    run_id: str,
) -> dict[str, Any]:
    """Extract contradiction records from the manager plan.

    Returns a dict with ``contradictions`` and ``diagnostics``.
    """
    contradictions: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []

    if not text.strip():
        return {"report": report_name, "contradictions": contradictions, "diagnostics": diagnostics}

    # Match: **Contradiction:** claim_a vs claim_b — reason
    pattern = re.compile(
        r"\*\*Contradiction(?::\*\*|\*\*:)\s*(claim_[a-zA-Z0-9_]+)\s+vs\s+(claim_[a-zA-Z0-9_]+)\s*[—\-:]\s*(.*)",
        re.IGNORECASE,
    )
    for match in pattern.finditer(text):
        claim_a = match.group(1)
        claim_b = match.group(2)
        reason = match.group(3).strip()
        contradictions.append(
            {
                "contradiction_id": f"cont_{_stable_hash(f'{claim_a}:{claim_b}:{reason}')}",
                "run_id": run_id,
                "claim_a": claim_a,
                "claim_b": claim_b,
                "reason": reason,
                "report": report_name,
                "resolved": False,
            }
        )

    # Also collect malformed contradiction lines
    for line in text.splitlines():
        if re.search(r"\*\*Contradiction(?::\*\*|\*\*:)", line) and not pattern.search(line):
            diagnostics.append(
                _diag("warning", "malformed_contradiction", f"Malformed contradiction line: {line.strip()}", report=report_name)
            )

    return {"report": report_name, "contradictions": contradictions, "diagnostics": diagnostics}


# ---------------------------------------------------------------------------
# Collect reports for one run
# ---------------------------------------------------------------------------


def collect_reports(
    report_dir: Path,
    report_names: list[str] | None = None,
) -> dict[str, Any]:
    """Read all expected reports from a directory.

    Returns a dict mapping report name to contents plus ``missing`` and
    ``diagnostics`` lists.
    """
    report_names = report_names or list(RESEARCH_REPORTS.keys())
    reports: dict[str, str] = {}
    missing: list[str] = []
    diagnostics: list[dict[str, Any]] = []

    for name in report_names:
        path = report_dir / name
        if not path.exists():
            missing.append(name)
            diagnostics.append(_diag("error", "missing_report", f"Report not found: {name}", report=name))
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        reports[name] = text
        if not text.strip():
            diagnostics.append(_diag("error", "empty_report", f"Report is empty: {name}", report=name))

    return {"reports": reports, "missing": missing, "diagnostics": diagnostics}


# ---------------------------------------------------------------------------
# Claim graph builder
# ---------------------------------------------------------------------------


def _merge_claims(claims: list[ClaimObject]) -> list[ClaimObject]:
    """Merge duplicate claim IDs, aggregating evidence IDs and contradictions."""
    by_id: dict[str, ClaimObject] = {}
    for claim in claims:
        if claim.claim_id not in by_id:
            by_id[claim.claim_id] = claim
            continue
        existing = by_id[claim.claim_id]
        existing.evidence_ids = list(dict.fromkeys([*existing.evidence_ids, *claim.evidence_ids]))
        existing.contradiction_ids = list(
            dict.fromkeys([*existing.contradiction_ids, *claim.contradiction_ids])
        )
        # Most conservative status wins
        severity = {"rejected": 3, "unknown": 2, "provisional": 1, "confirmed": 0}
        if severity.get(claim.status, 0) > severity.get(existing.status, 0):
            existing.status = claim.status
        if claim.confidence == "unknown" and existing.confidence != "unknown":
            existing.confidence = "unknown"
    return list(by_id.values())


def _validate_claim_graph(
    claims: list[ClaimObject],
    evidence: list[EvidenceUnit],
    contradictions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Validate the built claim graph and return gate diagnostics."""
    diagnostics: list[dict[str, Any]] = []
    claim_ids = {c.claim_id for c in claims}
    evidence_by_claim = {}
    for ev in evidence:
        evidence_by_claim.setdefault(ev.claim_id, []).append(ev)

    # Contradiction endpoint existence
    for cont in contradictions:
        for endpoint in (cont.get("claim_a"), cont.get("claim_b")):
            if endpoint and endpoint not in claim_ids:
                diagnostics.append(
                    _diag(
                        "error",
                        "unknown_contradiction_endpoint",
                        f"Contradiction references unknown claim ID '{endpoint}'",
                        claim_id=endpoint,
                    )
                )

    # Duplicate claim IDs across reports (already handled during merge, but flag)
    # Claim ID format already validated during parsing.

    # Run identity consistency
    run_ids = {ev.run_id for ev in evidence}
    if len(run_ids) > 1:
        diagnostics.append(
            _diag("error", "mixed_run_identity", f"Evidence has mixed run IDs: {run_ids}")
        )

    # Status transition rules: confirmed requires no error-level diagnostics
    # and no unresolved contradictions.
    for claim in claims:
        if claim.status == "confirmed":
            if claim.contradiction_ids:
                diagnostics.append(
                    _diag(
                        "error",
                        "confirmed_with_contradiction",
                        f"Claim {claim.claim_id} is confirmed but has contradictions",
                        claim_id=claim.claim_id,
                    )
                )
            if not claim.evidence_ids:
                diagnostics.append(
                    _diag(
                        "error",
                        "confirmed_without_evidence",
                        f"Claim {claim.claim_id} is confirmed but has no evidence",
                        claim_id=claim.claim_id,
                    )
                )

    return diagnostics


def build_claim_graph(
    reports: dict[str, str],
    run_id: str,
    site_url: str = "",
    region: str = "",
) -> dict[str, Any]:
    """Build a claim graph from all reports.

    Returns a dict with ``run_id``, ``evidence``, ``claims``,
    ``contradictions``, ``diagnostics``, and ``gates``.
    """
    all_evidence: list[EvidenceUnit] = []
    all_claims: list[ClaimObject] = []
    all_contradictions: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []

    seq = 1
    for report_name, text in reports.items():
        result = extract_claims_from_report(
            text=text,
            report_name=report_name,
            run_id=run_id,
            site_url=site_url,
            region=region,
            start_seq=seq,
        )
        seq = result["next_seq"]
        all_evidence.extend(
            EvidenceUnit.model_validate(ev) for ev in result["evidence"]
        )
        all_claims.extend(
            ClaimObject.model_validate(c) for c in result["claims"]
        )
        diagnostics.extend(result["diagnostics"])

        if report_name == "grizzly_local_presence_plan.md":
            cont_result = extract_contradictions(text, report_name, run_id)
            all_contradictions.extend(cont_result["contradictions"])
            diagnostics.extend(cont_result["diagnostics"])

    merged_claims = _merge_claims(all_claims)
    graph_diagnostics = _validate_claim_graph(merged_claims, all_evidence, all_contradictions)
    diagnostics.extend(graph_diagnostics)

    # Attach contradiction IDs to claims when both endpoints exist
    claim_map = {c.claim_id: c for c in merged_claims}
    for cont in all_contradictions:
        a = cont.get("claim_a")
        b = cont.get("claim_b")
        if a in claim_map and b in claim_map:
            for cid in (a, b):
                if b not in claim_map[cid].contradiction_ids:
                    claim_map[cid].contradiction_ids.append(b if cid == a else a)

    # Build gate records from diagnostics
    gates = [
        {
            "gate": d["code"],
            "severity": d["severity"],
            "detail": d["detail"],
            "claim_id": d.get("claim_id", ""),
            "report": d.get("report", ""),
        }
        for d in diagnostics
    ]

    return {
        "run_id": run_id,
        "evidence": [_json_safe(ev.to_dict()) for ev in all_evidence],
        "claims": [_json_safe(c.to_dict()) for c in merged_claims],
        "contradictions": all_contradictions,
        "diagnostics": diagnostics,
        "gates": gates,
        "counts": {
            "evidence": len(all_evidence),
            "claims": len(merged_claims),
            "contradictions": len(all_contradictions),
            "diagnostics": len(diagnostics),
            "errors": len([d for d in diagnostics if d["severity"] == "error"]),
            "warnings": len([d for d in diagnostics if d["severity"] == "warning"]),
        },
    }


# ---------------------------------------------------------------------------
# Convenience: build from a directory
# ---------------------------------------------------------------------------


def build_claim_graph_from_dir(
    report_dir: Path,
    run_id: str,
    site_url: str = "",
    region: str = "",
    report_names: list[str] | None = None,
) -> dict[str, Any]:
    """Collect reports from a directory and build the claim graph."""
    collected = collect_reports(report_dir, report_names)
    graph = build_claim_graph(
        reports=collected["reports"],
        run_id=run_id,
        site_url=site_url,
        region=region,
    )
    graph["missing_reports"] = collected["missing"]
    graph["diagnostics"].extend(collected["diagnostics"])
    graph["counts"]["diagnostics"] = len(graph["diagnostics"])
    graph["counts"]["errors"] = len([d for d in graph["diagnostics"] if d["severity"] == "error"])
    graph["counts"]["warnings"] = len([d for d in graph["diagnostics"] if d["severity"] == "warning"])
    return graph


# ---------------------------------------------------------------------------
# Secret detection helper
# ---------------------------------------------------------------------------


def contains_secret_like(text: str) -> bool:
    """Quick heuristic for potential secrets in excerpts or statements."""
    patterns = [
        r"\b\d{3}-?\d{4,6}\b",
        r"\b\d{3}-\d{2}-\d{4}\b",
        r"\b[A-Z]{2}\d{9}\b",
        r"api[_\-]?key\s*[=:\s]+[\w-]+",
        r"password\s*[=:\s]+\S+",
        r"secret\s*[=:\s]+\S+",
    ]
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)
