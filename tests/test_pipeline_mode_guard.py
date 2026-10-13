"""F5 (rc1 review): SEO_PIPELINE is normalised and an unknown value fails closed.

The wrapper's .env parser keeps quotes, so `SEO_PIPELINE="new"` used to read as
the unknown string `"new"` and fall through to the legacy CrewAI path. Now the
value is stripped of whitespace and one pair of matching quotes and lower-cased;
anything outside {legacy, shadow, new, offline} logs, writes health `failed` and
exits 2 before any crew, probe or sync is reached.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


def _load_run_weekly_seo():
    script = Path(__file__).resolve().parents[1] / "scripts" / "run-weekly-seo.py"
    spec = importlib.util.spec_from_file_location("run_weekly_seo_mode_guard", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _isolate(module, monkeypatch, tmp_path: Path) -> Path:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    monkeypatch.setattr(module, "OUTPUTS_DIR", outputs)
    monkeypatch.setattr(module, "RUNNER_HEALTH_FILE", outputs / "weekly-runner-health.json")
    monkeypatch.setattr(module, "RUNNER_LOG_FILE", outputs / "runner.log")
    monkeypatch.setattr(module, "CREW_LOG_FILE", outputs / "crew.log")
    monkeypatch.setattr(module, "APPROVAL_NOTIFY_FILE", outputs / "approval-notify.json")
    monkeypatch.setattr(module, "RUN_LOCK_FILE", outputs / "lock.lock.json")
    monkeypatch.setattr(module, "TOPIC_HISTORY_FILE", tmp_path / "topic-history.json")
    monkeypatch.setattr(sys, "argv", ["run-weekly-seo.py"])
    return outputs


def _forbid_crew(module, monkeypatch) -> list:
    reached: list = []

    def no_subprocess(*args, **kwargs):
        reached.append(("subprocess.run", args[:1]))
        raise AssertionError(f"subprocess.run reached: {args[:1]}")

    def no_preflight():
        reached.append(("preflight", ()))
        raise AssertionError("preflight reached")

    monkeypatch.setattr(module.subprocess, "run", no_subprocess)
    monkeypatch.setattr(module, "preflight", no_preflight)
    monkeypatch.setattr(module, "pick_trending_topic", lambda: (_ for _ in ()).throw(AssertionError("topic reached")))
    return reached


class TestPipelineModeNormalisation:
    @pytest.mark.parametrize("raw,expected", [
        ('"new"', "new"),
        ("'shadow'", "shadow"),
        ('  "New"  ', "new"),
        ("SHADOW", "shadow"),
        (" offline ", "offline"),
        ("", "legacy"),
        ("''", "legacy"),
    ])
    def test_strips_quotes_and_whitespace_and_lowercases(self, monkeypatch, raw, expected):
        m = _load_run_weekly_seo()
        monkeypatch.setenv("SEO_PIPELINE", raw)
        assert m.pipeline_mode() == expected

    def test_unset_is_legacy(self, monkeypatch):
        m = _load_run_weekly_seo()
        monkeypatch.delenv("SEO_PIPELINE", raising=False)
        assert m.pipeline_mode() == "legacy"

    def test_known_modes_cover_legacy_and_the_rebuilt_modes(self):
        m = _load_run_weekly_seo()
        assert set(m.KNOWN_PIPELINE_MODES) == {"legacy", "shadow", "new", "offline"}


class TestUnknownModeFailsClosed:
    @pytest.mark.parametrize("raw", ["bogus", '"nwe"', "new # live", "legacy,shadow"])
    def test_unknown_mode_exits_2_and_never_reaches_a_crew(self, monkeypatch, tmp_path, raw):
        m = _load_run_weekly_seo()
        outputs = _isolate(m, monkeypatch, tmp_path)
        reached = _forbid_crew(m, monkeypatch)
        monkeypatch.setenv("SEO_PIPELINE", raw)

        with pytest.raises(SystemExit) as exc_info:
            m.main()

        assert exc_info.value.code == 2
        assert reached == [], "an unknown SEO_PIPELINE must never fall through to the legacy crews"
        health = json.loads((outputs / "weekly-runner-health.json").read_text(encoding="utf-8"))
        assert health["status"] == "failed"
        assert "SEO_PIPELINE" in health["error"]
        assert raw in health["error"]
        assert "REFUSED" in (outputs / "runner.log").read_text(encoding="utf-8")

    def test_quoted_new_reaches_the_new_mode_launcher(self, monkeypatch, tmp_path):
        """The normalised value drives dispatch: `"new"` is new mode, not legacy."""
        m = _load_run_weekly_seo()
        _isolate(m, monkeypatch, tmp_path)
        reached = _forbid_crew(m, monkeypatch)
        launched: list = []
        monkeypatch.setattr(m, "run_new_pipeline", lambda: launched.append("new") or 0)
        monkeypatch.setenv("SEO_PIPELINE", '"new"')

        with pytest.raises(SystemExit) as exc_info:
            m.main()

        assert exc_info.value.code == 0
        assert launched == ["new"]
        assert reached == []
