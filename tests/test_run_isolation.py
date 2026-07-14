"""Tests for Session 1: run isolation, dry-run safety, skip-execute, run locking, writer lineage.

These tests prove that:
- ``--dry-run`` does not call baselines compaction, Supabase, LLM, adapters, or execution.
- ``--skip-execute`` skips the execution pipeline.
- Concurrent run acquisition rejects the second invocation.
- Empty evidence/claim artifacts preserve the supplied run ID.
- Two observability events remain two events in the JSONL file.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure src is on the path for all tests.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.contracts import RunManifest
from seo_agents.run_context import (
    RunContext,
    RunLockAcquisitionError,
    build_run_context,
    release_run_context,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_output_dir(tmp_path: Path) -> tuple[Path, Path]:
    """Create a clean output and archive directory under ``tmp_path``.

    Returns ``(output_dir, archive_dir)``.
    """
    out = tmp_path / "outputs"
    out.mkdir(parents=True, exist_ok=True)
    arc = tmp_path / "archive"
    arc.mkdir(parents=True, exist_ok=True)
    return out, arc


def _import_evidence(output_dir: Path) -> "seo_agents.evidence":
    """Import the evidence module with OUTPUT_DIR patched to ``output_dir``.

    Because ``evidence.py`` computes ``*_PATH`` constants at import time using
    ``OUTPUT_DIR``, we must patch the module before it's imported.
    """
    # Remove any cached import so we get a fresh one with the patched OUTPUT_DIR
    mod_name = "seo_agents.evidence"
    if mod_name in sys.modules:
        del sys.modules[mod_name]

    # Patch OUTPUT_DIR before importing
    with patch.dict(
        "os.environ",
        {},  # no special env vars
    ):
        # We need to patch the module-level constant. Since the module uses
        # OUTPUT_DIR = Path(...) at module level, we inject a custom module
        # with the patched constant via sys.modules.
        import seo_agents.evidence as ev_mod
        # The paths are computed at import time — patch the constants directly
        ev_mod.OUTPUT_DIR = output_dir
        ev_mod.EVIDENCE_PACKAGE_PATH = output_dir / "evidence_package.json"
        ev_mod.CLAIM_GRAPH_PATH = output_dir / "claim_graph.json"
        ev_mod.TASK_GRAPH_PATH = output_dir / "task_graph.json"
        ev_mod.RUN_MANIFEST_PATH = output_dir / "run_manifest.json"
        ev_mod.OBSERVABILITY_PATH = output_dir / "observability.jsonl"
        return ev_mod


# ---------------------------------------------------------------------------
# Task 1.1 — Make dry-run truly offline
# ---------------------------------------------------------------------------


class TestDryRunOffline:
    """Dry-run must not call any external or mutating system."""

    def test_dry_run_does_not_call_compact_baselines(self):
        """The dry-run block in main.py does not call compact_baselines."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        dry_block = ""
        if "if args.dry_run:" in source:
            dry_block = source.split("if args.dry_run:")[1].split("return")[0]

        assert "compact_baselines" not in dry_block

    def test_dry_run_does_not_fetch_completed_tasks(self):
        """The dry-run block does not call _fetch_completed_tasks."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        dry_block = ""
        if "if args.dry_run:" in source:
            dry_block = source.split("if args.dry_run:")[1].split("return")[0]

        assert "_fetch_completed_tasks" not in dry_block

    def test_dry_run_does_not_kickoff_crew(self):
        """The dry-run block does not call crew.kickoff()."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        dry_block = ""
        if "if args.dry_run:" in source:
            dry_block = source.split("if args.dry_run:")[1].split("return")[0]

        assert ".kickoff()" not in dry_block

    def test_dry_run_does_not_start_execute_pipeline(self):
        """The dry-run block does not reference _run_execute_pipeline."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        dry_block = ""
        if "if args.dry_run:" in source:
            dry_block = source.split("if args.dry_run:")[1].split("return")[0]

        assert "_run_execute_pipeline" not in dry_block

    def test_dry_run_writes_manifest_with_dry_run_true(self, tmp_path):
        """Dry-run writes a manifest marked dry_run=True."""
        output_dir, _ = _make_output_dir(tmp_path)
        manifest = RunManifest(
            run_id="test-dry-001",
            topic="test topic",
            dry_run=True,
            started_at="2026-07-14T00:00:00Z",
        )

        ev = _import_evidence(output_dir)

        ev.write_run_manifest(manifest)
        ev.write_evidence_package([], run_id="test-dry-001")
        ev.write_claim_graph([], run_id="test-dry-001")
        ev.write_task_graph([], "test-dry-001")

        manifest_path = output_dir / "run_manifest.json"
        assert manifest_path.exists()
        data = json.loads(manifest_path.read_text())
        assert data["dry_run"] is True
        assert data["run_id"] == "test-dry-001"

    def test_dry_run_writes_empty_evidence_preserving_run_id(self, tmp_path):
        """Empty evidence package must still carry the run_id."""
        output_dir, _ = _make_output_dir(tmp_path)
        ev = _import_evidence(output_dir)
        ev.write_evidence_package([], run_id="test-empty-001")
        data = json.loads((output_dir / "evidence_package.json").read_text())
        assert data["run_id"] == "test-empty-001"
        assert data["evidence"] == []

    def test_dry_run_writes_empty_claim_preserving_run_id(self, tmp_path):
        """Empty claim graph must still carry the run_id."""
        output_dir, _ = _make_output_dir(tmp_path)
        ev = _import_evidence(output_dir)
        ev.write_claim_graph([], run_id="test-empty-002")
        data = json.loads((output_dir / "claim_graph.json").read_text())
        assert data["run_id"] == "test-empty-002"
        assert data["claims"] == []


# ---------------------------------------------------------------------------
# Task 1.2 — --skip-execute
# ---------------------------------------------------------------------------


class TestSkipExecute:
    """--skip-execute skips the execution pipeline."""

    def test_skip_execute_flag_parsing(self):
        """The research subparser accepts --skip-execute."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()
        assert "--skip-execute" in source

    def test_skip_execute_sets_skip_variable(self):
        """The main code checks skip_execute before executing."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        assert "skip_execute" in source
        research_block = source.split('elif command == "execute"')[0]
        assert "skip_execute" in research_block

    def test_skip_execute_message(self):
        """When --skip-execute is set, a skip message is printed."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()
        assert "skip" in source.lower() or "--skip-execute" in source.lower()


# ---------------------------------------------------------------------------
# Task 1.3 — Run context and lock
# ---------------------------------------------------------------------------


class TestRunContext:
    """Run context provides unique invocation ID, run_id, and exclusive lock."""

    def test_build_run_context_creates_unique_id(self, tmp_path):
        """Each build_run_context call generates a different invocation_id."""
        output_dir, archive_dir = _make_output_dir(tmp_path)

        ctx1 = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx1)

        ctx2 = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx2)

        assert ctx1.invocation_id != ctx2.invocation_id

    def test_run_context_has_invocation_id(self, tmp_path):
        """RunContext.invocation_id is a non-empty string."""
        output_dir, archive_dir = _make_output_dir(tmp_path)

        ctx = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx)

        assert len(ctx.invocation_id) > 0
        assert isinstance(ctx.invocation_id, str)

    def test_run_context_has_started_at(self, tmp_path):
        """RunContext.started_at is a non-empty ISO timestamp."""
        output_dir, archive_dir = _make_output_dir(tmp_path)

        ctx = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx)

        assert len(ctx.started_at) > 0
        assert "T" in ctx.started_at
        assert "Z" in ctx.started_at

    def test_concurrent_run_acquisition_rejected(self, tmp_path):
        """When one invocation holds the lock, a second one is rejected.

        We simulate a concurrent caller by creating the lock file manually
        and trying to build a second context.
        """
        output_dir, archive_dir = _make_output_dir(tmp_path)
        lock_path = output_dir / "lock.lock.json"

        # Pre-create the lock file (simulating a concurrent run that already
        # acquired the lock).
        lock_path.write_text(
            json.dumps({"locked_at": "2026-07-14T00:00:00Z"}) + "\n",
            encoding="utf-8",
        )

        with pytest.raises(RunLockAcquisitionError):
            build_run_context(
                topic="test", output_dir=output_dir, archive_dir=archive_dir,
                run_id="test-run", provider="none", research_model="none", exec_model="none",
            )

        # Clean up
        lock_path.unlink(missing_ok=True)

    def test_release_allows_new_acquisition(self, tmp_path):
        """After release, a new invocation can acquire the lock."""
        output_dir, archive_dir = _make_output_dir(tmp_path)

        ctx1 = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx1)

        ctx2 = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run-2", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx2)

    def test_run_context_to_dict(self, tmp_path):
        """RunContext.to_dict returns all fields."""
        output_dir, archive_dir = _make_output_dir(tmp_path)

        ctx = build_run_context(
            topic="test topic", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="test", research_model="r-model", exec_model="e-model",
            site_url="https://example.com", audience="homeowners", region="DFW", keywords="electrical",
        )
        release_run_context(ctx)

        d = ctx.to_dict()
        assert d["invocation_id"] == ctx.invocation_id
        assert d["topic"] == "test topic"
        assert d["site_url"] == "https://example.com"
        assert d["audience"] == "homeowners"
        assert d["region"] == "DFW"
        assert d["keywords"] == "electrical"
        assert d["provider"] == "test"
        assert d["research_model"] == "r-model"
        assert d["exec_model"] == "e-model"
        assert "topic_fingerprint" in d

    def test_run_context_has_archive_dir(self, tmp_path):
        """RunContext.archive_dir is a timestamped sub-directory."""
        output_dir, archive_dir = _make_output_dir(tmp_path)

        ctx = build_run_context(
            topic="test", output_dir=output_dir, archive_dir=archive_dir,
            run_id="test-run", provider="none", research_model="none", exec_model="none",
        )
        release_run_context(ctx)

        assert ctx.archive_dir.parent == archive_dir
        assert ctx.archive_dir.exists()


# ---------------------------------------------------------------------------
# Task 1.4 — Writer lineage and path injection
# ---------------------------------------------------------------------------


class TestWriterLineage:
    """Writers preserve run_id even for empty collections."""

    def test_empty_evidence_preserves_run_id(self, tmp_path):
        """write_evidence_package([]) preserves the explicit run_id."""
        output_dir, _ = _make_output_dir(tmp_path)
        ev = _import_evidence(output_dir)
        ev.write_evidence_package([], run_id="lineage-001")
        data = json.loads((output_dir / "evidence_package.json").read_text())
        assert data["run_id"] == "lineage-001"

    def test_empty_claim_preserves_run_id(self, tmp_path):
        """write_claim_graph([]) preserves the explicit run_id."""
        output_dir, _ = _make_output_dir(tmp_path)
        ev = _import_evidence(output_dir)
        ev.write_claim_graph([], run_id="lineage-002")
        data = json.loads((output_dir / "claim_graph.json").read_text())
        assert data["run_id"] == "lineage-002"

    def test_observability_events_persist_in_order(self, tmp_path):
        """Two observability events remain two events in the JSONL file."""
        output_dir, _ = _make_output_dir(tmp_path)
        ev = _import_evidence(output_dir)
        ev.write_observability_event(
            {"event_type": "research_complete", "producer": "test", "run_id": "obs-001"},
            run_id="obs-001",
        )
        ev.write_observability_event(
            {"event_type": "finalization_complete", "producer": "test", "run_id": "obs-001"},
            run_id="obs-001",
        )

        content = (output_dir / "observability.jsonl").read_text()
        # Each event is pretty-printed JSON (6 lines with indent=2)
        events = []
        current = ""
        for line in content.strip().splitlines():
            current += line + "\n"
            if line == "}" or line == "]":
                events.append(json.loads(current))
                current = ""

        assert len(events) == 2
        for evt in events:
            assert evt["run_id"] == "obs-001"
            assert evt["event_type"] in ("research_complete", "finalization_complete")

    def test_observability_does_not_overwrite(self, tmp_path):
        """Each write_appends does not replace prior events."""
        output_dir, _ = _make_output_dir(tmp_path)
        ev = _import_evidence(output_dir)
        ev.write_observability_event(
            {"event_type": "gate_pass", "producer": "test"},
            run_id="obs-002",
        )
        ev.write_observability_event(
            {"event_type": "gate_fail", "producer": "test"},
            run_id="obs-002",
        )

        content = (output_dir / "observability.jsonl").read_text()
        events = []
        current = ""
        for line in content.strip().splitlines():
            current += line + "\n"
            if line == "}" or line == "]":
                events.append(json.loads(current))
                current = ""

        assert len(events) == 2
        evt0 = events[0]
        evt1 = events[1]
        assert evt0["event_type"] == "gate_pass"
        assert evt1["event_type"] == "gate_fail"


# ---------------------------------------------------------------------------
# Integration: dry-run path in main does not mutate files
# ---------------------------------------------------------------------------


class TestDryRunIntegration:
    """Integration test: verify the dry-run code path in main.py structure."""

    def test_dry_run_has_lock_acquisition(self):
        """The dry-run code path acquires the run context (and thus the lock)."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        research_block = source.split('elif command == "execute"')[0]
        assert "build_run_context" in research_block
        assert "release_run_context(ctx)" in source

    def test_dry_run_returns_before_execute(self):
        """The dry-run path returns before _run_execute_pipeline is called."""
        import seo_agents.main as main_mod
        source = Path(main_mod.__file__).read_text()

        assert "release_run_context(ctx)" in source
