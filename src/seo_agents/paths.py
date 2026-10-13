"""Default filesystem locations that work on the Windows PC and on the Linux LXC.

Resolution order for every default:
  1. the environment variable (always wins, even when the path does not exist);
  2. a repo-relative path, when it exists or when no legacy path applies;
  3. on win32 only, the legacy PC path, and only if it exists (last resort).
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


def resolve_default(env_name: str, repo_relative: Path, legacy_win: str | None = None) -> Path:
    """Env override, else the repo-relative path, else a win32 legacy path that exists."""
    env = (os.getenv(env_name) or "").strip()
    if env:
        return Path(env)
    if legacy_win and sys.platform == "win32" and not repo_relative.exists():
        legacy = Path(legacy_win)
        if legacy.exists():
            return legacy
    return repo_relative


def default_gbp_photo_dir() -> Path:
    """GBP_PHOTO_PATH default. The photo library is external media, so it is not repo-relative."""
    if sys.platform == "win32":
        return Path(LEGACY_WIN_GBP_PHOTO_DIR)
    return Path(POSIX_GBP_PHOTO_DIR)
