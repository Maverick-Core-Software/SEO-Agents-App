"""website_adapter_status() must never raise — it is called from build_action_queue()
inside write_workflow_status(), so an exception there aborts an already-successful run.

Regression for 2026-07-28: the live index.html gained a `<section class="hero">` with
no id on 7/18. parse_sections() raised, write_workflow_status() propagated it, the
exception handler called write_workflow_status() again and raised identically, and the
weekly run exited 1 *after* the research crew had completed — losing finalization and
the entire downstream GBP/Facebook scheduling chain.
"""
import pytest

from seo_agents import website

GOOD_HTML = """<html><body>
<section class="hero" id="hero">h</section>
<section class="sec" id="services">s</section>
<footer class="site-foot" id="site-footer">f</footer>
</body></html>"""

# The shape that actually broke: hero and footer carry no id.
BAD_HTML = """<html><body>
<section class="hero" aria-label="Introduction">h</section>
<section class="sec" id="services">s</section>
<footer class="site-foot">f</footer>
</body></html>"""


@pytest.fixture
def website_repo(tmp_path, monkeypatch):
    """Point the adapter at a throwaway repo that passes every other check."""
    def _make(html: str):
        (tmp_path / "index.html").write_text(html, encoding="utf-8")
        structure = tmp_path / "website-structure.md"
        structure.write_text("# structure", encoding="utf-8")
        monkeypatch.setattr(website, "WEBSITE_REPO_DIR", tmp_path)
        monkeypatch.setattr(website, "WEBSITE_STRUCTURE_FILE", structure)
        monkeypatch.setattr(website, "_current_branch", lambda: website.WEBSITE_BRANCH)
        return website.website_adapter_status()
    return _make


def test_missing_section_id_does_not_raise(website_repo):
    status = website_repo(BAD_HTML)  # must not raise
    assert status["state"] == "blocked"
    assert any("not parseable" in m for m in status["missing"])
    assert any("missing an 'id'" in m for m in status["missing"])


def test_well_formed_index_still_reports_live_ready(website_repo):
    status = website_repo(GOOD_HTML)
    assert status["state"] == "live_ready"
    assert status["missing"] == []
    assert "hero" in status["sections"] and "services" in status["sections"]


def test_parse_sections_itself_still_raises():
    """The strict contract is intact for real edit paths — only the status report is
    tolerant. run_website_action() must keep failing loudly on an untargetable block."""
    with pytest.raises(ValueError, match="missing an 'id'"):
        website.parse_sections(BAD_HTML)
