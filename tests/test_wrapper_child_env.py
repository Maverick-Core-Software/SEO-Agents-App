"""F1 (rc1 review): the weekly wrapper must not hand TZ to a Python child on Windows.

Windows CPython with TZ=America/Chicago treats UTC as local time, so an accidental
TZ line in the PC .env would shift every date the crew stamps. On posix (AIWA) TZ
is the mechanism that pins Chicago time and must survive.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_run_weekly_seo():
    script = Path(__file__).resolve().parents[1] / "scripts" / "run-weekly-seo.py"
    spec = importlib.util.spec_from_file_location("run_weekly_seo_child_env", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestPythonChildEnv:
    def test_nt_child_env_has_no_tz(self):
        m = _load_run_weekly_seo()
        env = m.python_child_env({"TZ": "America/Chicago", "SEO_PIPELINE": "legacy"}, os_name="nt")
        assert "TZ" not in env
        assert env["SEO_PIPELINE"] == "legacy"

    def test_posix_child_env_keeps_tz(self):
        m = _load_run_weekly_seo()
        env = m.python_child_env({"TZ": "America/Chicago"}, os_name="posix")
        assert env["TZ"] == "America/Chicago"

    def test_defaults_to_the_wrapper_environment(self, monkeypatch):
        m = _load_run_weekly_seo()
        monkeypatch.setenv("TZ", "America/Chicago")
        monkeypatch.setenv("WRAPPER_PROBE_KEY", "1")
        env = m.python_child_env(os_name="nt")
        assert "TZ" not in env
        assert env["WRAPPER_PROBE_KEY"] == "1"
        assert m.python_child_env(os_name="posix")["TZ"] == "America/Chicago"

    def test_crew_launch_uses_the_helper(self):
        """The two subprocess sites (preflight probe, crew launch) build their env from it."""
        src = (Path(__file__).resolve().parents[1] / "scripts" / "run-weekly-seo.py").read_text(encoding="utf-8")
        assert 'env={**python_child_env(), "PYTHONPATH": ""' in src
        assert "child_env = python_child_env()" in src
        assert "child_env = os.environ.copy()" not in src
