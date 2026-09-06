"""Regression tests for the 2026-09-05 Friday-run fixes.

Covers:
- parse_args keeps the research topic (no hidden root positional blanking it).
- main() fails closed (exit 2) when the research topic is empty/whitespace.
- RunContext honors an explicit run_id and otherwise matches build_run_id.
- executor_skip_reason() / crew.task_graph_tasks() handle missing, empty,
  invalid, fully-blocked, and partially-executable task graphs.
- write_executor_skip_outputs() writes "skipped" artifacts that downstream
  parsers read as zero tasks.
- run-weekly-seo topic selection does not write history on pick; resolution
  returns ``python -m seo_agents.main``.

No network, LLM, or Supabase calls. Writes go to tmp_path only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

# Ensure src is on the path for all tests.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.run_context import (
    build_run_context,
    release_run_context,
)


# ---------------------------------------------------------------------------
# 1. parse_args keeps the research topic
# ---------------------------------------------------------------------------


class TestParseArgsKeepsTopic:
    def test_research_topic_and_dry_run_kept(self, monkeypatch):
        import seo_agents.main as main_mod

        monkeypatch.setattr(
            sys, "argv", ["seo-agents", "research", "audit probe", "--dry-run"]
        )
        args = main_mod.parse_args()
        assert args.command == "research"
        assert args.topic == "audit probe"
        assert args.dry_run is True

    def test_research_options_survive(self, monkeypatch):
        import seo_agents.main as main_mod

        monkeypatch.setattr(
            sys,
            "argv",
            [
                "seo-agents",
                "research",
                "audit probe",
                "--site-url",
                "https://example.com",
                "--keywords",
                "electrical, panel",
            ],
        )
        args = main_mod.parse_args()
        assert args.command == "research"
        assert args.topic == "audit probe"
        assert args.site_url == "https://example.com"
        assert args.keywords == "electrical, panel"


# ---------------------------------------------------------------------------
# 2. Empty topic fails closed
# ---------------------------------------------------------------------------


class TestMainEmptyTopicFailsClosed:
    def test_exits_2_and_never_builds_context(self, monkeypatch):
        import seo_agents.main as main_mod

        def _boom(*args, **kwargs):
            raise AssertionError("build_run_context must not run for an empty topic")

        monkeypatch.setattr(
            main_mod,
            "parse_args",
            lambda: argparse.Namespace(
                command="research",
                topic="   ",
                dry_run=True,
                skip_execute=False,
                site_url="",
                audience="",
                region="",
                keywords="",
            ),
        )
        monkeypatch.setattr(main_mod, "load_dotenv", lambda *a, **k: None)
        monkeypatch.setattr(main_mod, "ensure_dirs", lambda: None)
        monkeypatch.setattr(main_mod, "build_run_context", _boom)

        with pytest.raises(SystemExit) as exc_info:
            main_mod.main()
        assert exc_info.value.code == 2


# ---------------------------------------------------------------------------
# 3. Run-id consistency
# ---------------------------------------------------------------------------


class TestRunIdConsistency:
    def test_explicit_run_id_round_trips(self, tmp_path):
        output_dir = tmp_path / "outputs"
        archive_dir = tmp_path / "archive"
        output_dir.mkdir()
        archive_dir.mkdir()

        ctx = build_run_context(
            topic="x",
            output_dir=output_dir,
            archive_dir=archive_dir,
            run_id="2026-09-05T10:00:00Z_x",
        )
        try:
            assert ctx.run_id == "2026-09-05T10:00:00Z_x"
            assert ctx.to_dict()["run_id"] == "2026-09-05T10:00:00Z_x"
        finally:
            release_run_context(ctx)

    def test_computed_run_id_matches_build_run_id_shape(self, tmp_path):
        from seo_agents.crew import build_run_id

        output_dir = tmp_path / "outputs"
        archive_dir = tmp_path / "archive"
        output_dir.mkdir()
        archive_dir.mkdir()

        ctx = build_run_context(topic="x", output_dir=output_dir, archive_dir=archive_dir)
        try:
            assert ctx.run_id.endswith("Z_x")
            ts_part = ctx.run_id.removesuffix("_x")
            crew_ts_part = build_run_id("x").removesuffix("_x")
            assert len(ts_part) == len(crew_ts_part)
        finally:
            release_run_context(ctx)


# ---------------------------------------------------------------------------
# 4. executor_skip_reason() and crew.task_graph_tasks()
# ---------------------------------------------------------------------------


def _write_task_graph(path: Path, tasks: list[dict]) -> None:
    path.write_text(json.dumps({"tasks": tasks}, indent=2), encoding="utf-8")


class TestExecutorSkipReason:
    def test_missing_task_graph_means_run(self, monkeypatch, tmp_path):
        import seo_agents.crew as crew_mod
        import seo_agents.evidence as evidence_mod
        import seo_agents.main as main_mod

        monkeypatch.setattr(
            evidence_mod, "TASK_GRAPH_PATH", tmp_path / "does-not-exist.json"
        )
        assert main_mod.executor_skip_reason() is None
        assert crew_mod.task_graph_tasks() is None

    def test_all_blocked_tasks_gives_skip_reason(self, monkeypatch, tmp_path):
        import seo_agents.evidence as evidence_mod
        import seo_agents.main as main_mod

        graph = tmp_path / "task_graph.json"
        _write_task_graph(
            graph,
            [
                {"task_id": "T-001", "status": "waiting_on_owner", "title": "a"},
                {"task_id": "T-002", "status": "blocked", "title": "b"},
                {"task_id": "T-003", "status": "research_gap", "title": "c"},
            ],
        )
        monkeypatch.setattr(evidence_mod, "TASK_GRAPH_PATH", graph)

        reason = main_mod.executor_skip_reason()
        assert reason is not None
        assert "0 of 3" in reason
        for task_id in ("T-001", "T-002", "T-003"):
            assert task_id in reason

    def test_ready_task_among_blocked_runs(self, monkeypatch, tmp_path):
        import seo_agents.evidence as evidence_mod
        import seo_agents.main as main_mod

        graph = tmp_path / "task_graph.json"
        _write_task_graph(
            graph,
            [
                {"task_id": "T-001", "status": "blocked", "title": "a"},
                {"task_id": "T-002", "status": "ready", "title": "b"},
            ],
        )
        monkeypatch.setattr(evidence_mod, "TASK_GRAPH_PATH", graph)

        assert main_mod.executor_skip_reason() is None

    def test_empty_tasks_list_gives_skip_reason(self, monkeypatch, tmp_path):
        import seo_agents.evidence as evidence_mod
        import seo_agents.main as main_mod

        graph = tmp_path / "task_graph.json"
        _write_task_graph(graph, [])
        monkeypatch.setattr(evidence_mod, "TASK_GRAPH_PATH", graph)

        reason = main_mod.executor_skip_reason()
        assert reason is not None
        assert "empty" in reason

    def test_task_graph_tasks_invalid_json_returns_none(self, monkeypatch, tmp_path):
        import seo_agents.crew as crew_mod
        import seo_agents.evidence as evidence_mod

        graph = tmp_path / "task_graph.json"
        graph.write_text("this is {not json", encoding="utf-8")
        monkeypatch.setattr(evidence_mod, "TASK_GRAPH_PATH", graph)

        assert crew_mod.task_graph_tasks() is None


# ---------------------------------------------------------------------------
# 5. write_executor_skip_outputs()
# ---------------------------------------------------------------------------


class TestWriteExecutorSkipOutputs:
    def test_skipped_outputs_and_stale_files_overwritten(self, monkeypatch, tmp_path):
        import seo_agents.main as main_mod
        import seo_agents.status as status_mod

        monkeypatch.setattr(main_mod, "OUTPUT_DIR", tmp_path)

        # Stale artifacts from last week's real executor run.
        (tmp_path / "content_completion.md").write_text(
            "COMPLETION REPORT\n### Task ID: T-9\n", encoding="utf-8"
        )
        (tmp_path / "final_report.md").write_text(
            "### Task 1: old\n", encoding="utf-8"
        )

        main_mod.write_executor_skip_outputs("why")

        final_report = (tmp_path / "final_report.md").read_text(encoding="utf-8")
        assert "why" in final_report
        assert "Total Tasks Checked: 0" in final_report
        assert "### Task" not in final_report

        delegation = (tmp_path / "delegation_verification.md").read_text(
            encoding="utf-8"
        )
        assert "Total Tasks Checked: 0" in delegation

        for stem in (
            "content_completion",
            "assets_completion",
            "technical_completion",
            "website_completion",
        ):
            payload = json.loads((tmp_path / f"{stem}.json").read_text(encoding="utf-8"))
            assert isinstance(payload, dict)
            assert payload["completions"] == []

        stale_md = (tmp_path / "content_completion.md").read_text(encoding="utf-8")
        assert "COMPLETION REPORT" not in stale_md

        # status.py must extract zero completed tasks from the overwritten report.
        monkeypatch.setattr(status_mod, "OUTPUT_DIR", tmp_path)
        assert (
            status_mod._extract_int(final_report, "Total Tasks Checked") == 0
        )


# ---------------------------------------------------------------------------
# 6. run-weekly-seo: topic history + launch command
# ---------------------------------------------------------------------------


def _load_run_weekly_seo():
    """Load scripts/run-weekly-seo.py as a standalone module named run_weekly_seo."""
    script = Path(__file__).resolve().parents[1] / "scripts" / "run-weekly-seo.py"
    spec = importlib.util.spec_from_file_location("run_weekly_seo", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestRunWeeklySeo:
    def test_pick_trending_topic_does_not_write_history(self, monkeypatch, tmp_path):
        run_weekly_seo = _load_run_weekly_seo()
        history_file = tmp_path / "h.json"
        monkeypatch.setattr(run_weekly_seo, "TOPIC_HISTORY_FILE", history_file)
        # Force the pytrends import to fail so selection falls back offline.
        monkeypatch.setitem(sys.modules, "pytrends.request", None)
        monkeypatch.setitem(sys.modules, "pytrends", None)

        topic = run_weekly_seo.pick_trending_topic()
        assert isinstance(topic, str) and topic.strip()
        assert not history_file.exists()

    def test_save_topic_history_writes_file(self, monkeypatch, tmp_path):
        run_weekly_seo = _load_run_weekly_seo()
        history_file = tmp_path / "h.json"
        monkeypatch.setattr(run_weekly_seo, "TOPIC_HISTORY_FILE", history_file)

        run_weekly_seo.save_topic_history([], "t")
        assert json.loads(history_file.read_text(encoding="utf-8")) == ["t"]

    def test_resolve_seo_agents_cmd_uses_python_dash_m(self):
        run_weekly_seo = _load_run_weekly_seo()
        cmd = run_weekly_seo.resolve_seo_agents_cmd()
        assert cmd[1:] == ["-m", "seo_agents.main"]
