"""Default filesystem locations that work on the Windows PC and on the Linux LXC.

Resolution order for every default:
  1. the environment variable (always wins, even when the path does not exist);
  2. on win32, the legacy PC path when one applies: the PC keeps exactly the
     default it had before the cutover (rc1 review F2 — the repo copy of the
     GBP poster driver/config must not silently become live on the PC);
  3. otherwise the repo-relative path (the Linux LXC layout).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Legacy PC locations. Used only as win32 last-resort candidates.
LEGACY_WIN_GBP_PHOTO_DIR = r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos"
LEGACY_WIN_WEBSITE_REPO = r"C:\Workspace\Active\Grizzly Launch\grizzly-website"

# AIWA layout (docs/cutover CUTOVERPLAN B5). Override with GBP_PHOTO_PATH.
POSIX_GBP_PHOTO_DIR = "/srv/seo/photos"


def resolve_default(
    env_name: str,
    repo_relative: Path,
    legacy_win: str | None = None,
    platform: str = sys.platform,
) -> Path:
    """Env override; else on win32 the legacy PC path (unchanged pre-cutover default,
    whether or not it exists); else the repo-relative path.

    The repo-relative preference is posix-only on purpose: on the PC it would have
    pointed `run-action publish_gbp_post` at the repo Playwright driver with the real
    config, next to gbp-worker's own posting (F2). `platform` is injectable for tests.
    """
    env = (os.getenv(env_name) or "").strip()
    if env:
        return Path(env)
    if legacy_win and platform == "win32":
        return Path(legacy_win)
    return repo_relative


def default_gbp_photo_dir() -> Path:
    """GBP_PHOTO_PATH default. The photo library is external media, so it is not repo-relative."""
    if sys.platform == "win32":
        return Path(LEGACY_WIN_GBP_PHOTO_DIR)
    return Path(POSIX_GBP_PHOTO_DIR)
