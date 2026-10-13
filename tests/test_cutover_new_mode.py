"""Phase C cutover: scripts/run-weekly-seo.py with SEO_PIPELINE=new.

The wrapper must run `node scripts/weekly/run.mjs --mode new --notify` as the
primary Friday run and never touch the CrewAI research/execute/schedule crews
or supabase-sync, while the top-level health fields the watchdog/monitor read
(status/date/error) and the attempt-derived `shadow` block both land.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest


def _load_run_weekly_seo():
    """Load scripts/run-weekly-seo.py as a standalone module (same seam as test_friday_fixes)."""
    script = Path(__file__).resolve().parents[1] / "scripts" / "run-weekly-seo.py"
    spec = importlib.util.spec_from_file_location("run_weekly_seo_cutover", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _isolate(module, monkeypatch, tmp_path: Path) -> Path:
    """Point every file the wrapper writes at tmp_path."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    monkeypatch.setattr(module, "OUTPUTS_DIR", outputs)
    monkeypatch.setattr(module, "RUNNER_HEALTH_FILE", outputs / "weekly-runner-health.json")
    monkeypatch.setattr(module, "RUNNER_LOG_FILE", outputs / "runner.log")
    monkeypatch.setattr(module, "CREW_LOG_FILE", outputs / "crew.log")
    monkeypatch.setattr(module, "APPROVAL_NOTIFY_FILE", outputs / "approval-notify.json")
    monkeypatch.setattr(module, "RUN_LOCK_FILE", outputs / "lock.lock.json")
    monkeypatch.setattr(module, "TOPIC_HISTORY_FILE", tmp_path / "topic-history.json")
    return outputs


def _new_mode_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SEO_PIPELINE", "new")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key-for-the-test")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-key-for-the-test")
    monkeypatch.setenv("SMTP_APP_PASSWORD", "smtp-for-the-test")
    monkeypatch.setenv("HERMES_CLI", str(tmp_path / "no-such-hermes.exe"))
    monkeypatch.delenv("GBP_BROWSER_SESSION_DIR", raising=False)


def _forbid_crew(module, monkeypatch) -> list:
    """Every crew-side seam raises; the recorded calls prove none was reached."""
    launched: list = []

    def no_subprocess(*args, **kwargs):
        launched.append(args[0] if args else kwargs.get("args"))
        raise AssertionError(f"subprocess.run reached in new mode: {args[:1]}")

    monkeypatch.setattr(module.subprocess, "run", no_subprocess)
    monkeypatch.setattr(module, "pick_trending_topic", lambda: (_ for _ in ()).throw(AssertionError("topic selection reached")))
    monkeypatch.setattr(module, "resolve_seo_agents_cmd", lambda: (_ for _ in ()).throw(AssertionError("crew command built")))
    monkeypatch.setattr(module, "run_shadow_pipeline", lambda: (_ for _ in ()).throw(AssertionError("post-crew shadow hook reached")))
    return launched


class TestNewModeWrapper:
    def test_new_mode_runs_the_pipeline_as_primary_and_never_the_crews(self, monkeypatch, tmp_path):
        m = _load_run_weekly_seo()
        outputs = _isolate(m, monkeypatch, tmp_path)
        _new_mode_env(monkeypatch, tmp_path)
        launched = _forbid_crew(m, monkeypatch)
        # A fresh week_spec.json pins --week-of; the engine's exports land in --out (outputs/).
        monday = date.today() + timedelta(days=(7 - date.today().weekday()) % 7)
        (outputs / "week_spec.json").write_text(json.dumps({"week_of": monday.isoformat()}), encoding="utf-8")

        calls: list = []

        def fake_run_pipeline(mode, paths=None, week_of=None, *, cmd=None, timeout_s=None):
            calls.append({"mode": mode, "paths": paths, "week_of": week_of, "cmd": cmd, "timeout_s": timeout_s})
            cmd = m.pipeline_cmd(mode, paths, week_of)
            calls[-1]["resolved_cmd"] = cmd
            out = Path(paths["out"])
            out.mkdir(parents=True, exist_ok=True)
            (out / "plan.json").write_text(json.dumps({"topic": {"service_label": "Panel Upgrade", "city": "Rockwall"}}), encoding="utf-8")
            (out / "projection.json").write_text(json.dumps({
                "runId": "run-9", "posts": 11, "tasks": 1, "linked": 12, "approved": {"ok": True, "count": 11},
                "attempt_id": "att-1", "week_of": week_of, "auto_approve": True,
            }), encoding="utf-8")
            block = {
                "status": "succeeded", "mode": mode, "source": "attempt", "attempt_id": "att-1", "week_of": week_of,
                "launched_at": m._now_iso(), "at": m._now_iso(), "log_file": str(paths["log"]),
                "child": {"returncode": 0, "error": None, "timed_out": False},
                "notify_expected": True,
                "notify": {"event": "succeeded", "sent": True, "status": "ok", "channel": "hermes", "at": m._now_iso(), "error": None},
            }
            m._merge_shadow_block(paths, block)
            return block

        monkeypatch.setattr(m, "run_pipeline", fake_run_pipeline)
        monkeypatch.setattr(sys, "argv", ["run-weekly-seo.py"])

        with pytest.raises(SystemExit) as exc:
            m.main()
        assert exc.value.code == 0
        assert launched == [], "no crew preflight, no crew launch, no supabase-sync"

        assert len(calls) == 1
        call = calls[0]
        assert call["mode"] == "new"
        assert call["week_of"] == monday.isoformat()
        assert call["timeout_s"] == m.PIPELINE_TIMEOUT_S == 30 * 60
        assert call["paths"]["out"] == outputs, "new-mode exports go to outputs/ (the legacy schedule consumers read there)"
        assert call["paths"]["health"] == outputs / "weekly-runner-health.json"
        cmd = call["resolved_cmd"]
        assert cmd[0] == "node" and cmd[1].endswith("run.mjs")
        assert cmd[cmd.index("--mode") + 1] == "new"
        assert "--notify" in cmd
        assert cmd[cmd.index("--week-of") + 1] == monday.isoformat()
        assert cmd[cmd.index("--out") + 1] == str(outputs)
        assert not any("seo_agents" in str(c) or "supabase-sync" in str(c) for c in cmd)

        health = json.loads((outputs / "weekly-runner-health.json").read_text(encoding="utf-8"))
        # Top-level fields the legacy watchdog/monitor rules read (NO-SHOW / FAILED / HUNG / STALE).
        assert health["status"] == "success"
        assert health["date"] == date.today().isoformat()
        assert health["error"] is None
        assert health["returncode"] == 0
        assert health["topic"] == "Panel Upgrade / Rockwall"
        # ... and the attempt-derived block the pipeline watchdog reads, in the same file.
        assert health["shadow"]["mode"] == "new"
        assert health["shadow"]["status"] == "succeeded"
        assert health["shadow"]["notify"]["sent"] is True
        # The legacy NOTIFY MISS / AUTO-APPROVE checks read approval-notify.json; the wrapper writes it from the receipt.
        notify = json.loads((outputs / "approval-notify.json").read_text(encoding="utf-8"))
        assert notify["sent"] is True
        assert notify["channel"] == "hermes"
        assert notify["autoApprove"] is True
        assert notify["runId"] == "run-9"
        assert notify["weekOf"] == monday.isoformat()
        assert notify["source"] == "attempt"

    def test_new_mode_failed_attempt_is_a_failed_run(self, monkeypatch, tmp_path):
        m = _load_run_weekly_seo()
        outputs = _isolate(m, monkeypatch, tmp_path)
        _new_mode_env(monkeypatch, tmp_path)
        _forbid_crew(m, monkeypatch)

        def fake_run_pipeline(mode, paths=None, week_of=None, *, cmd=None, timeout_s=None):
            block = {
                "status": "failed", "mode": mode, "attempt_id": "att-2", "week_of": week_of, "error": "ValidationFailed: 3 error(s)",
                "at": m._now_iso(), "launched_at": m._now_iso(), "log_file": str(paths["log"]),
                "child": {"returncode": 1, "error": None, "timed_out": False},
                "notify_expected": True, "notify": m.notify_receipt(None),
            }
            m._merge_shadow_block(paths, block)
            return block

        monkeypatch.setattr(m, "run_pipeline", fake_run_pipeline)
        monkeypatch.setattr(sys, "argv", ["run-weekly-seo.py"])
        with pytest.raises(SystemExit) as exc:
            m.main()
        assert exc.value.code == 1
        health = json.loads((outputs / "weekly-runner-health.json").read_text(encoding="utf-8"))
        assert health["status"] == "failed"
        assert health["returncode"] == 1
        assert "ValidationFailed" in health["error"]
        assert health["shadow"]["status"] == "failed"
        notify = json.loads((outputs / "approval-notify.json").read_text(encoding="utf-8"))
        assert notify["sent"] is False and notify["autoApprove"] is False

    def test_new_mode_preflight_refuses_without_supabase_or_deepseek_and_skips_the_crew_probe(self, monkeypatch, tmp_path):
        m = _load_run_weekly_seo()
        outputs = _isolate(m, monkeypatch, tmp_path)
        _new_mode_env(monkeypatch, tmp_path)
        launched = _forbid_crew(m, monkeypatch)
        monkeypatch.delenv("DEEPSEEK_API_KEY")
        monkeypatch.setenv("SUPABASE_SERVICE_KEY", "")
        monkeypatch.setattr(m, "run_pipeline", lambda *a, **k: (_ for _ in ()).throw(AssertionError("pipeline launched despite preflight")))
        monkeypatch.setattr(sys, "argv", ["run-weekly-seo.py"])
        with pytest.raises(SystemExit) as exc:
            m.main()
        assert exc.value.code == 1
        assert launched == []
        health = json.loads((outputs / "weekly-runner-health.json").read_text(encoding="utf-8"))
        assert health["status"] == "failed"
        assert "SUPABASE_URL / SUPABASE_SERVICE_KEY missing" in health["error"]
        assert "DEEPSEEK_API_KEY missing" in health["error"]
        assert "crew preflight" not in health["error"]

    def test_legacy_mode_still_launches_the_crew(self, monkeypatch, tmp_path):
        """The `new` branch in main() must not disturb the legacy path."""
        m = _load_run_weekly_seo()
        outputs = _isolate(m, monkeypatch, tmp_path)
        monkeypatch.delenv("SEO_PIPELINE", raising=False)
        monkeypatch.setattr(m, "preflight", lambda crew=True: [])
        monkeypatch.setattr(m, "pick_trending_topic", lambda: "panel upgrade Dallas DFW")
        monkeypatch.setattr(m, "run_shadow_pipeline", lambda: None)
        launched: list = []

        class Done:
            returncode = 0

        def fake_run(cmd, **kwargs):
            launched.append(cmd)
            return Done()

        monkeypatch.setattr(m.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", ["run-weekly-seo.py"])
        with pytest.raises(SystemExit) as exc:
            m.main()
        assert exc.value.code == 0
        assert len(launched) == 1
        assert launched[0][1:4] == ["-m", "seo_agents.main", "research"]
        assert json.loads((outputs / "weekly-runner-health.json").read_text(encoding="utf-8"))["status"] == "success"

    def test_fresh_week_of_ignores_a_stale_spec(self, tmp_path):
        m = _load_run_weekly_seo()
        spec = tmp_path / "week_spec.json"
        today = date(2026, 10, 9)  # a Friday
        spec.write_text(json.dumps({"week_of": "2026-10-12"}), encoding="utf-8")
        assert m.fresh_week_of(spec, today) == "2026-10-12"
        spec.write_text(json.dumps({"week_of": "2026-10-05"}), encoding="utf-8")
        assert m.fresh_week_of(spec, today) is None, "a Monday already past is last week's crew output"
        spec.write_text(json.dumps({"week_of": "2026-10-26"}), encoding="utf-8")
        assert m.fresh_week_of(spec, today) is None
        spec.write_text("garbage", encoding="utf-8")
        assert m.fresh_week_of(spec, today) is None
        assert m.fresh_week_of(tmp_path / "missing.json", today) is None

    def test_pipeline_cmd_and_paths_are_unchanged_for_shadow(self):
        m = _load_run_weekly_seo()
        shadow = m.pipeline_paths("shadow")
        assert shadow["out"] == m.OUTPUTS_DIR / "shadow"
        cmd = m.pipeline_cmd("shadow", shadow, "2026-10-12")
        assert "--notify" in cmd and cmd[cmd.index("--mode") + 1] == "shadow"
        offline = m.pipeline_cmd("offline", m.pipeline_paths("offline"))
        assert "--notify" not in offline
        assert m.PIPELINE_MODES == ("shadow", "new", "offline")
        assert m.NOTIFY_MODES == ("shadow", "new")


class TestNewModeHealthLift:
    """V2 in new mode: run_pipeline lifts the engine's notify receipt into the block
    the same way it does for shadow (the attempt record is the only source)."""

    def test_notify_receipt_from_a_new_mode_attempt_record(self, tmp_path):
        m = _load_run_weekly_seo()
        paths = {
            "store": tmp_path / "state", "out": tmp_path / "outputs",
            "health": tmp_path / "health.json", "log": tmp_path / "new.log",
        }
        attempt_id = "2026-10-12-20261009T133714Z-974f54"
        child_script = (
            "import json, pathlib\n"
            "from datetime import datetime, timezone, timedelta\n"
            f"attempts = pathlib.Path({str(paths['store'] / 'attempts')!r})\n"
            f"out = pathlib.Path({str(paths['out'])!r})\n"
            "attempts.mkdir(parents=True, exist_ok=True)\n"
            "out.mkdir(parents=True, exist_ok=True)\n"
            "now = datetime.now(timezone.utc)\n"
            f"attempt_id = {attempt_id!r}\n"
            "started = now.isoformat().replace('+00:00', 'Z')\n"
            "finished = (now + timedelta(seconds=198)).isoformat().replace('+00:00', 'Z')\n"
            "record = {'id': attempt_id, 'week_of': '2026-10-12', 'mode': 'new',\n"
            "    'status': 'succeeded', 'error': None, 'spent_usd': 0.24, 'budget_usd': 5,\n"
            "    'started_at': started, 'finished_at': finished, 'stages': {\n"
            "        'project': {'started_at': started, 'finished_at': finished, 'status': 'ok', 'error': None},\n"
            "        'notify:succeeded': {'started_at': finished, 'finished_at': finished,\n"
            "                             'status': 'ok', 'error': 'via hermes'}}}\n"
            "(out / 'attempt.json').write_text(json.dumps(record), encoding='utf-8')\n"
            "(out / 'current-attempt.json').write_text(json.dumps({\n"
            "    'attempt_id': attempt_id, 'week_of': '2026-10-12', 'mode': 'new',\n"
            "    'status': 'succeeded', 'started_at': started, 'finished_at': finished}),\n"
            "    encoding='utf-8')\n"
        )
        block = m.run_pipeline("new", paths, week_of="2026-10-12",
                               cmd=[sys.executable, "-c", child_script], timeout_s=60)
        assert block["mode"] == "new"
        assert block["status"] == "succeeded"
        assert block["attempt_id"] == attempt_id
        assert block["budget_usd"] == 5
        assert block["notify_expected"] is True
        assert block["notify"] == {
            "event": "succeeded", "sent": True, "status": "ok", "channel": "hermes",
            "at": block["notify"]["at"], "error": None,
        }
        health = json.loads(paths["health"].read_text(encoding="utf-8"))
        assert health["shadow"]["notify"]["sent"] is True

    def test_subprocess_module_is_the_real_one(self):
        m = _load_run_weekly_seo()
        assert m.subprocess is subprocess


def test_refusal_line_lifts_the_engine_refusal_from_the_log(tmp_path):
    """V4: a refused `--mode new` (exit 2) writes no attempt record, so the health
    error must carry the engine's `[weekly] refused: ...` reason, not just
    'failed (no attempt written)'."""
    m = _load_run_weekly_seo()
    log = tmp_path / "pipeline.log"
    log.write_text(
        "[weekly] attempt lookup\n"
        "[weekly] refused: seo_runs run-1 for week 2026-10-19 already exists (pending_approval, 11 pending_approval row(s)); pass --force-replan to replace the pending rows\n"
        "[run-weekly-seo] new pipeline: attempt status failed (no attempt written)\n",
        encoding="utf-8",
    )
    assert m._refusal_line(log).startswith("seo_runs run-1 for week 2026-10-19 already exists")
    assert m._refusal_line(tmp_path / "missing.log") is None
    (tmp_path / "clean.log").write_text("[weekly] attempt ok\n", encoding="utf-8")
    assert m._refusal_line(tmp_path / "clean.log") is None
