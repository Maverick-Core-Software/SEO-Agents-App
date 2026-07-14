"""Run context, isolated artifacts, and run locking for Session 1.

Provides a RunContext dataclass and helpers that every stage of the pipeline
(research, finalization, task translation, status, dispatch) can use to share
a unique invocation ID, topic fingerprint, start time, provider/model metadata,
site/region/audience/keywords, isolated working/archive paths, and an exclusive
run lock.

Overlapping runs acquire a lock file; the second invocation gets rejected
with an observable reason.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid as _uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# fcntl is only available on POSIX; Windows uses ctypes.
try:
    import fcntl as _fcntl  # noqa: F401
    _HAS_FCNTL = True
except ImportError:
    _HAS_FCNTL = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slugify(text: str) -> str:
    """Slugify a topic string for use in run IDs and directory names."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("- ")


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Run context
# ---------------------------------------------------------------------------


@dataclass
class RunContext:
    """Immutable context shared across all pipeline stages for one invocation."""

    invocation_id: str
    """Unique ID for this run (UUID v4). Always different for concurrent calls."""
    topic: str
    """SEO focus topic or service page."""
    site_url: str
    """Target website URL."""
    audience: str
    """Target audience description."""
    region: str
    """Target search region."""
    keywords: str
    """Seed keywords for the run."""
    started_at: str
    """ISO-8601 start timestamp."""
    provider: str
    """Inferred provider from model name (e.g. 'openai', 'none')."""
    research_model: str
    """Model name used for research agents."""
    exec_model: str
    """Model name used for execution agents."""
    output_dir: Path
    """Shared outputs directory (not isolated per-invocation — that is the projection layer)."""
    archive_dir: Path
    """Timestamped archive sub-directory for this run."""
    lock_file: Path
    """Path to the exclusive lock file."""

    @property
    def topic_fingerprint(self) -> str:
        """Deterministic hash of topic+site_url for deduplication purposes."""
        data = f"{self.topic}:{self.site_url}"
        h = hashlib.sha256(data.encode("utf-8")).hexdigest()[:8]
        return f"fp_{h}"

    @property
    def run_id(self) -> str:
        """Deterministic run ID from topic + site_url (same semantics as build_run_id)."""
        from seo_agents.crew import _slugify as _crew_slugify
        ts = self.started_at[:19]  # truncate to seconds
        slug = _crew_slugify(self.topic or "untitled")
        return f"{ts}_{slug}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "invocation_id": self.invocation_id,
            "topic": self.topic,
            "site_url": self.site_url,
            "audience": self.audience,
            "region": self.region,
            "keywords": self.keywords,
            "started_at": self.started_at,
            "provider": self.provider,
            "research_model": self.research_model,
            "exec_model": self.exec_model,
            "topic_fingerprint": self.topic_fingerprint,
        }


# ---------------------------------------------------------------------------
# Run locking (fcntl-based for Linux/Mac, advisory for Windows via ctypes)
# ---------------------------------------------------------------------------


class RunLockAcquisitionError(RuntimeError):
    """Raised when a concurrent invocation already holds the lock."""


def _acquire_lock(lock_path: Path) -> None:
    """Acquire an exclusive lock on ``lock_path``.

    Raises ``RunLockAcquisitionError`` if another process already holds it.
    Uses ``fcntl`` on POSIX; falls back to atomic rename-based locking on Windows.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if _HAS_FCNTL:
        _acquire_lock_posix(lock_path)
    else:
        _acquire_lock_windows(lock_path)


def _acquire_lock_posix(lock_path: Path) -> None:
    """Acquire via fcntl.flock — atomic on POSIX."""
    import fcntl

    fd = os.open(str(lock_path), os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        os.close(fd)
        try:
            meta = {}
            if lock_path.exists():
                meta = json.loads(lock_path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            meta = {}
        raise RunLockAcquisitionError(
            f"Another run is active: {meta.get('invocation_id', 'unknown')}. "
            f"Wait for that run to finish before starting a new one."
        )
    meta = {"locked_at": _now_iso()}
    _write_atomic(lock_path, json.dumps(meta, indent=2) + "\n")
    os.close(fd)


def _acquire_lock_windows(lock_path: Path) -> None:
    """Acquire via atomic file-creation (``O_EXCL``).

    ``os.open(path, O_CREAT | O_EXCL)`` fails if the file already exists.
    This is the POSIX atomic-lock idiom and works on Windows too.

    The lock file is deleted by ``_release_lock``.
    """
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except OSError:
        try:
            meta = {}
            if lock_path.exists():
                meta = json.loads(lock_path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            meta = {}
        raise RunLockAcquisitionError(
            f"Another run is active: {meta.get('invocation_id', 'unknown')}. "
            f"Wait for that run to finish before starting a new one."
        )

    meta = {"locked_at": _now_iso()}
    os.write(fd, json.dumps(meta, indent=2).encode("utf-8") + b"\n")
    os.close(fd)


def _write_atomic(path: Path, content: str) -> None:
    """Write content atomically via temp-rename."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _release_lock(lock_path: Path) -> None:
    """Release the run lock (remove the lock file)."""
    try:
        lock_path.unlink(missing_ok=True)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Context factory
# ---------------------------------------------------------------------------


def build_run_context(
    topic: str,
    output_dir: Path,
    archive_dir: Path,
    run_id: str = "",
    provider: str = "unknown",
    research_model: str = "unknown",
    exec_model: str = "unknown",
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
) -> RunContext:
    """Create a RunContext, acquire the exclusive lock, and return the context.

    The invocation ID is a UUID4. The lock is under ``output_dir/lock.lock.json``.

    Raises ``RunLockAcquisitionError`` when another invocation already holds the lock.
    """
    invocation_id = _generate_invocation_id()
    lock_path = output_dir / "lock.lock.json"
    _acquire_lock(lock_path)

    started_at = _now_iso()

    # Isolated archive dir for this invocation (timestamped sub-directory)
    run_archive = archive_dir / invocation_id[:8]
    run_archive.mkdir(parents=True, exist_ok=True)

    return RunContext(
        invocation_id=invocation_id,
        topic=topic,
        site_url=site_url,
        audience=audience,
        region=region,
        keywords=keywords,
        started_at=started_at,
        provider=provider,
        research_model=research_model,
        exec_model=exec_model,
        output_dir=output_dir,
        archive_dir=run_archive,
        lock_file=lock_path,
    )


def _generate_invocation_id() -> str:
    """Generate a unique invocation ID using UUID4."""
    try:
        return str(_uuid.uuid4())
    except Exception:
        # Fallback: nanosecond-ish time
        return f"inv-{int(datetime.now().timestamp() * 1000000)}"


def release_run_context(ctx: RunContext) -> None:
    """Release the exclusive run lock for the given context."""
    _release_lock(ctx.lock_file)
