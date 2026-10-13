"""Silent-failure guard: with SEO_OUTPUT_DIR unset, evidence.OUTPUT_DIR must be the
package-relative outputs/ folder, not the old hardcoded Windows drive path.

Run in a subprocess so the import cannot leak module state into other tests.
"""

import os
import subprocess
import sys
from pathlib import Path


def test_evidence_output_dir_default_is_package_relative():
    env = {k: v for k, v in os.environ.items() if k != "SEO_OUTPUT_DIR"}
    out = subprocess.run(
        [sys.executable, "-c", "from seo_agents.evidence import OUTPUT_DIR; print(OUTPUT_DIR)"],
        capture_output=True,
        text=True,
        env=env,
        check=True,
        timeout=120,
    ).stdout.strip().splitlines()[-1]

    assert Path(out).name == "outputs"
    assert "C:" not in out
