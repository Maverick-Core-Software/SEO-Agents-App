"""Contract guard (rc1 seam): crew.OUTPUT_DIR must honour SEO_OUTPUT_DIR exactly like
evidence.OUTPUT_DIR does, so the crew and the evidence writer never land a run in two
different folders on AIWA.

Run in a subprocess so the import cannot leak module state into other tests.
"""

import os
import subprocess
import sys
from pathlib import Path


def _output_dirs(env: dict) -> tuple[str, str]:
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "from seo_agents.crew import OUTPUT_DIR as c; from seo_agents.evidence import OUTPUT_DIR as e; print(c); print(e)",
        ],
        capture_output=True,
        text=True,
        env=env,
        check=True,
        timeout=180,
    ).stdout.strip().splitlines()[-2:]
    return out[0], out[1]


def test_crew_output_dir_follows_seo_output_dir(tmp_path):
    env = dict(os.environ)
    env["SEO_OUTPUT_DIR"] = str(tmp_path / "aiwa-outputs")
    crew_dir, evidence_dir = _output_dirs(env)
    assert Path(crew_dir) == tmp_path / "aiwa-outputs"
    assert Path(crew_dir) == Path(evidence_dir)


def test_crew_output_dir_default_matches_evidence():
    env = {k: v for k, v in os.environ.items() if k != "SEO_OUTPUT_DIR"}
    crew_dir, evidence_dir = _output_dirs(env)
    assert Path(crew_dir).name == "outputs"
    assert Path(crew_dir) == Path(evidence_dir)
