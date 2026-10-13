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


# ---------------------------------------------------------------------------
# 7. Wrapper shadow health (T2) and killed-attempt finalization (T6)
# ---------------------------------------------------------------------------


class TestWrapperShadowHealth:
    """The health `shadow` block states what the attempt record says, never what
    the child's exit code was, and a killed child's attempt is finalized."""

    def _paths(self, tmp_path: Path) -> dict:
        run_weekly_seo = _load_run_weekly_seo()
        return {
            **run_weekly_seo.pipeline_paths("offline"),
            "store": tmp_path / "state",
            "out": tmp_path / "shadow",
            "health": tmp_path / "health.json",
            "log": tmp_path / "rehearsal.log",
        }

    def test_no_op_child_reads_failed_no_attempt_written(self, tmp_path):
        run_weekly_seo = _load_run_weekly_seo()
        paths = self._paths(tmp_path)
        # Legacy keys the monitor/watchdog already read must survive the merge.
        paths["health"].write_text(
            json.dumps({"status": "success", "date": "2026-09-25", "crew_log_file": "crew.log"}),
            encoding="utf-8",
        )

        block = run_weekly_seo.run_pipeline(
            "offline", paths, week_of="2026-09-21",
            cmd=[sys.executable, "-c", ""], timeout_s=60,
        )

        assert block["status"] == "failed (no attempt written)"
        health = json.loads(paths["health"].read_text(encoding="utf-8"))
        assert health["shadow"]["status"] == "failed (no attempt written)"
        assert health["status"] == "success"
        assert health["crew_log_file"] == "crew.log"

    def test_running_marker_then_fresh_record_sets_status(self, tmp_path):
        run_weekly_seo = _load_run_weekly_seo()
        paths = self._paths(tmp_path)
        seen = tmp_path / "child-saw.json"
        attempts_dir = paths["store"] / "attempts"
        attempt_id = "2026-09-21T120000Z-abcdef"
        child_script = (
            "import json, pathlib\n"
            "from datetime import datetime, timezone, timedelta\n"
            f"health = pathlib.Path({str(paths['health'])!r})\n"
            f"seen = pathlib.Path({str(seen)!r})\n"
            "seen.write_text(health.read_text(encoding='utf-8'), encoding='utf-8')\n"
            f"attempts = pathlib.Path({str(attempts_dir)!r})\n"
            f"out = pathlib.Path({str(paths['out'])!r})\n"
            "attempts.mkdir(parents=True, exist_ok=True)\n"
            "out.mkdir(parents=True, exist_ok=True)\n"
            "now = datetime.now(timezone.utc)\n"
            f"attempt_id = {attempt_id!r}\n"
            "started = now.isoformat().replace('+00:00', 'Z')\n"
            "record = {\n"
            "    'id': attempt_id, 'week_of': '2026-09-21', 'mode': 'offline',\n"
            "    'status': 'succeeded', 'error': None, 'spent_usd': 0.42, 'budget_usd': 20,\n"
            "    'started_at': started,\n"
            "    'finished_at': (now + timedelta(seconds=61)).isoformat().replace('+00:00', 'Z'),\n"
            "    'stages': {},\n"
            "}\n"
            "(attempts / (attempt_id + '.json')).write_text(json.dumps(record), encoding='utf-8')\n"
            "(out / 'current-attempt.json').write_text(json.dumps({\n"
            "    'attempt_id': attempt_id, 'week_of': '2026-09-21', 'mode': 'offline',\n"
            "    'status': 'succeeded', 'started_at': started, 'finished_at': record['finished_at']}),\n"
            "    encoding='utf-8')\n"
        )

        block = run_weekly_seo.run_pipeline(
            "offline", paths, week_of="2026-09-21",
            cmd=[sys.executable, "-c", child_script], timeout_s=60,
        )

        assert json.loads(seen.read_text(encoding="utf-8"))["shadow"]["status"] == "running"
        assert block["status"] == "succeeded"
        assert block["attempt_id"] == attempt_id
        assert block["week_of"] == "2026-09-21"
        assert block["runtime_s"] == 61
        assert block["spent_usd"] == 0.42 and block["budget_usd"] == 20

    def test_notify_receipt_surfaces_in_health_block(self, tmp_path):
        """T1: the wrapper reports the attempt's `notify:<event>` receipt (outcome and
        channel) in the health block, and reports an absent receipt as not sent — the
        watchdog's notify-miss signal — never as a delivered alert."""
        run_weekly_seo = _load_run_weekly_seo()
        paths = self._paths(tmp_path)
        attempts_dir = paths["store"] / "attempts"
        attempt_id = "2026-09-21T120000Z-abcdef"
        child_script = (
            "import json, pathlib\n"
            "from datetime import datetime, timezone, timedelta\n"
            f"attempts = pathlib.Path({str(attempts_dir)!r})\n"
            f"out = pathlib.Path({str(paths['out'])!r})\n"
            "attempts.mkdir(parents=True, exist_ok=True)\n"
            "out.mkdir(parents=True, exist_ok=True)\n"
            "now = datetime.now(timezone.utc)\n"
            f"attempt_id = {attempt_id!r}\n"
            "started = now.isoformat().replace('+00:00', 'Z')\n"
            "finished = (now + timedelta(seconds=42)).isoformat().replace('+00:00', 'Z')\n"
            "record = {'id': attempt_id, 'week_of': '2026-09-21', 'mode': 'offline',\n"
            "    'status': 'succeeded', 'error': None, 'spent_usd': 0.1, 'budget_usd': 20,\n"
            "    'started_at': started, 'finished_at': finished, 'stages': {\n"
            "        'notify:succeeded': {'started_at': finished, 'finished_at': finished,\n"
            "                             'status': 'ok', 'error': 'via hermes+smtp'}}}\n"
            "(attempts / (attempt_id + '.json')).write_text(json.dumps(record), encoding='utf-8')\n"
            "(out / 'current-attempt.json').write_text(json.dumps({\n"
            "    'attempt_id': attempt_id, 'week_of': '2026-09-21', 'mode': 'offline',\n"
            "    'status': 'succeeded', 'started_at': started, 'finished_at': finished}),\n"
            "    encoding='utf-8')\n"
        )

        block = run_weekly_seo.run_pipeline(
            "offline", paths, week_of="2026-09-21",
            cmd=[sys.executable, "-c", child_script], timeout_s=60,
        )

        assert block["status"] == "succeeded"
        assert block["notify"]["sent"] is True
        assert block["notify"]["event"] == "succeeded"
        assert block["notify"]["channel"] == "hermes+smtp"
        assert block["notify"]["error"] is None
        # A rehearsal sends no alert; only shadow/new notify.
        assert block["notify_expected"] is False
        # Absent and undelivered receipts both read as not sent, with a reason.
        assert run_weekly_seo.notify_receipt({"status": "succeeded", "stages": {}})["sent"] is False
        undelivered = run_weekly_seo.notify_receipt({
            "status": "failed",
            "stages": {"notify:failed": {"status": "failed", "error": "all channels failed"}},
        })
        assert undelivered["sent"] is False
        assert undelivered["error"] == "all channels failed"

    def test_earlier_same_week_record_reads_stale(self, tmp_path):
        run_weekly_seo = _load_run_weekly_seo()
        paths = self._paths(tmp_path)
        attempts_dir = paths["store"] / "attempts"
        attempts_dir.mkdir(parents=True)
        (attempts_dir / "old.json").write_text(
            json.dumps({
                "id": "old", "week_of": "2026-09-21", "mode": "offline",
                "status": "succeeded", "started_at": "2020-01-01T00:00:00Z",
                "finished_at": "2020-01-01T00:01:00Z", "stages": {},
            }),
            encoding="utf-8",
        )

        block = run_weekly_seo.run_pipeline(
            "offline", paths, week_of="2026-09-21",
            cmd=[sys.executable, "-c", ""], timeout_s=60,
        )

        assert block["status"] == "failed (stale attempt)"

    @pytest.mark.parametrize("tail,timeout_s", [("time.sleep(30)", 2), ("raise SystemExit(1)", 60)],
                             ids=["timeout", "nonzero-exit"])
    def test_child_that_does_not_finish_is_finalized(self, tmp_path, tail, timeout_s):
        """A child killed at the deadline, or one that dies without finishing, leaves
        its attempt running with the lease held; the wrapper finalizes exactly the
        attempt the engine published, so health never reports a stuck run."""
        run_weekly_seo = _load_run_weekly_seo()
        paths = self._paths(tmp_path)
        attempts_dir = paths["store"] / "attempts"
        leases_dir = paths["store"] / "leases"
        attempt_id = "2026-09-21T120000Z-abcdef"
        child_script = (
            "import json, pathlib, time\n"
            "from datetime import datetime, timezone\n"
            f"attempts = pathlib.Path({str(attempts_dir)!r})\n"
            f"leases = pathlib.Path({str(leases_dir)!r})\n"
            f"out = pathlib.Path({str(paths['out'])!r})\n"
            "attempts.mkdir(parents=True, exist_ok=True)\n"
            "leases.mkdir(parents=True, exist_ok=True)\n"
            "out.mkdir(parents=True, exist_ok=True)\n"
            "now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')\n"
            f"attempt_id = {attempt_id!r}\n"
            "record = {'id': attempt_id, 'week_of': '2026-09-21', 'mode': 'offline',\n"
            "    'status': 'running', 'error': None, 'spent_usd': 0.1, 'budget_usd': 20,\n"
            "    'started_at': now, 'finished_at': None, 'lease_until': now,\n"
            "    'stages': {'collect': {'started_at': now, 'finished_at': None, 'status': 'running', 'error': None}}}\n"
            "(attempts / (attempt_id + '.json')).write_text(json.dumps(record), encoding='utf-8')\n"
            "(leases / '2026-09-21.json').write_text(json.dumps({\n"
            "    'attempt_id': attempt_id, 'lease_until': '2099-01-01T00:00:00Z', 'acquired_at': now}), encoding='utf-8')\n"
            "(out / 'current-attempt.json').write_text(json.dumps({\n"
            "    'attempt_id': attempt_id, 'week_of': '2026-09-21', 'mode': 'offline',\n"
            "    'status': 'running', 'started_at': now, 'finished_at': None}), encoding='utf-8')\n"
            f"{tail}\n"
        )

        block = run_weekly_seo.run_pipeline(
            "offline", paths, week_of="2026-09-21",
            cmd=[sys.executable, "-c", child_script], timeout_s=timeout_s,
        )

        assert block["status"] == "failed"
        assert block["attempt_id"] == attempt_id
        patched = json.loads((attempts_dir / f"{attempt_id}.json").read_text(encoding="utf-8"))
        assert patched["status"] == "failed"
        assert patched["finished_at"] and patched["lease_until"] is None
        assert patched["stages"]["collect"]["status"] == "failed"
        assert not (leases_dir / "2026-09-21.json").exists()

    def test_kill_without_identity_patches_nothing(self, tmp_path):
        """A kill with no published identity reports the kill and leaves the store
        alone — an earlier same-week record is never patched or claimed as ours."""
        run_weekly_seo = _load_run_weekly_seo()
        paths = self._paths(tmp_path)
        attempts_dir = paths["store"] / "attempts"
        attempts_dir.mkdir(parents=True)
        foreign = attempts_dir / "foreign.json"
        foreign.write_text(json.dumps({
            "id": "foreign", "week_of": "2026-09-21", "mode": "offline", "status": "running",
            "started_at": "2020-01-01T00:00:00Z", "finished_at": None, "stages": {},
        }), encoding="utf-8")

        block = run_weekly_seo.run_pipeline(
            "offline", paths, week_of="2026-09-21",
            cmd=[sys.executable, "-c", "import time; time.sleep(30)"], timeout_s=2,
        )

        assert block["status"] == "failed (killed at the deadline)"
        assert json.loads(foreign.read_text(encoding="utf-8"))["status"] == "running"
