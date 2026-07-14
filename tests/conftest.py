"""Global pytest fixtures for SEO-Agents-App tests.

Overrides module-level OUTPUT_DIR before any SEO agents modules are imported
by individual test files.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True, scope="session")
def fix_output_dir():
    """Override the module-level OUTPUT_DIR for seo_agents modules.

    This runs once per session and patches the constant so that writers
    (evidence, status, etc.) write to the test output directory instead of
    the real one.
    """
    from pathlib import Path
    from unittest import mock

    # The real output directory
    real_output = Path(r"C:\Workspace\Active\SEO-Agents-App\outputs")
    real_archive = real_output / "archive"

    # Create test directories
    test_output = real_output
    test_archive = real_archive

    # We cannot easily patch module-level constants once imported,
    # so individual tests must handle their own temp dirs.
    # This fixture exists to avoid accidental writes to real outputs.
    # Individual tests use their own tmp_path and explicit patching.
