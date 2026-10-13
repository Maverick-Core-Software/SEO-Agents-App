"""F2 (rc1 review): the repo-relative default flip is posix-only.

On the PC (win32) `GBP_POSTER_SCRIPT` / `GBP_POSTER_CONFIG` / `WEBSITE_REPO_DIR` must
resolve exactly as before the cutover unless the env overrides them; on the LXC the
repo-relative layout is the default.
"""

from __future__ import annotations

from pathlib import Path

from seo_agents.paths import resolve_default


LEGACY = r"C:\Users\carte\.codex\plugins\grizzly-gbp-poster\config.local.json"


class TestResolveDefault:
    def test_win32_keeps_the_legacy_default_even_when_the_repo_copy_exists(self, tmp_path, monkeypatch):
        monkeypatch.delenv("PROBE_PATH", raising=False)
        repo_copy = tmp_path / "config.json"
        repo_copy.write_text("{}", encoding="utf-8")
        assert resolve_default("PROBE_PATH", repo_copy, legacy_win=LEGACY, platform="win32") == Path(LEGACY)

    def test_win32_keeps_the_legacy_default_when_it_does_not_exist(self, tmp_path, monkeypatch):
        """A missing legacy config fails closed (poster inert), exactly as before the cutover."""
        monkeypatch.delenv("PROBE_PATH", raising=False)
        assert resolve_default("PROBE_PATH", tmp_path / "config.json", legacy_win=LEGACY, platform="win32") == Path(LEGACY)

    def test_posix_uses_the_repo_relative_path(self, tmp_path, monkeypatch):
        monkeypatch.delenv("PROBE_PATH", raising=False)
        repo_copy = tmp_path / "config.json"
        assert resolve_default("PROBE_PATH", repo_copy, legacy_win=LEGACY, platform="linux") == repo_copy

    def test_env_override_wins_on_both_platforms(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PROBE_PATH", str(tmp_path / "override.json"))
        for platform in ("win32", "linux"):
            assert resolve_default("PROBE_PATH", tmp_path / "config.json", legacy_win=LEGACY, platform=platform) \
                == tmp_path / "override.json"

    def test_no_legacy_path_means_repo_relative_everywhere(self, tmp_path, monkeypatch):
        monkeypatch.delenv("PROBE_PATH", raising=False)
        for platform in ("win32", "linux"):
            assert resolve_default("PROBE_PATH", tmp_path / "x", platform=platform) == tmp_path / "x"
