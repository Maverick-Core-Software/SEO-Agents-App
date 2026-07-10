"""Website Manager for the Grizzly Electrical static site.

The live site is a static HTML repo (index.html + /blog/ pages) deployed by
Vercel whenever main is pushed. This module does every deterministic step of a
website change: section extraction/splicing, blog page rendering, validation,
preview, and git commit/push. LLM content generation lives in
crew.build_website_crew — this module never calls an LLM.

ponytail: regex/tag-count HTML handling instead of a DOM library. Ceiling: if
the site stops being one hand-written flat HTML file, swap parse_sections /
validate_index for a real parser (beautifulsoup4) behind the same signatures.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from seo_agents.crew import OUTPUT_DIR, PROJECT_ROOT

WEBSITE_REPO_DIR = Path(os.getenv("WEBSITE_REPO_DIR", r"C:\Workspace\Active\Grizzly Launch\grizzly-website"))
WEBSITE_BRANCH = os.getenv("WEBSITE_BRANCH", "master")
WEBSITE_SITE_URL = os.getenv("WEBSITE_SITE_URL", "https://www.grizzlyelectricaltx.com/").rstrip("/") + "/"
WEBSITE_GIT_TIMEOUT_S = int(os.getenv("WEBSITE_GIT_TIMEOUT_S", "120"))
WEBSITE_STRUCTURE_FILE = PROJECT_ROOT / "knowledge" / "website-structure.md"
PREVIEW_DIR = OUTPUT_DIR / "website_preview"
INDEX_FILE = "index.html"

WEBSITE_ACTION_TYPES = {
    "website_blog_post",
    "website_service_page_update",
    "website_gallery_update",
    "website_hours_update",
    "website_faq_update",
    "website_contact_form_update",
    "website_copy_update",
    "website_layout_update",
}

# Where each action type usually lands in index.html. website_copy_update and
# website_layout_update have no fixed home — the agent picks the target.
DEFAULT_SECTION_FOR_ACTION = {
    "website_service_page_update": "services",
    "website_gallery_update": "gallery",
    "website_faq_update": "faq",
    "website_hours_update": "contact",
    "website_contact_form_update": "contact",
}

_BLOCK_OPEN = re.compile(r"<(section|footer)\b[^>]*>", re.IGNORECASE)
_BLOCK_TAG = re.compile(r"</?(section|footer)\b[^>]*>", re.IGNORECASE)


def load_index() -> str:
    path = WEBSITE_REPO_DIR / INDEX_FILE
    if not path.exists():
        raise FileNotFoundError(f"Website index.html not found: {path}")
    return path.read_text(encoding="utf-8")


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _section_key(open_tag: str, block: str, ordinal: int) -> str:
    id_match = re.search(r'id="([^"]+)"', open_tag)
    if id_match:
        return id_match.group(1)
    heading = re.search(r"<h[12][^>]*>(.*?)</h[12]>", block, re.IGNORECASE | re.DOTALL)
    if heading:
        text = " ".join(re.sub(r"<[^>]+>", " ", heading.group(1)).split())
        slug = _slugify(text[:40])
        if slug:
            return slug
    return f"section-{ordinal}"


def parse_sections(html_text: str) -> dict[str, tuple[int, int]]:
    """Map every top-level <section>/<footer> block to its (start, end) span.

    Keys: the tag's id, else a slug of its first h1/h2 text, else section-<n>.
    Spans include the opening and closing tags.
    """
    sections: dict[str, tuple[int, int]] = {}
    pos = 0
    ordinal = 0
    while True:
        open_match = _BLOCK_OPEN.search(html_text, pos)
        if not open_match:
            return sections
        tag_name = open_match.group(1).lower()
        depth = 1
        scan = open_match.end()
        while depth:
            tag = _BLOCK_TAG.search(html_text, scan)
            if not tag:
                scan = len(html_text)
                break
            if tag.group(1).lower() == tag_name:
                depth += -1 if tag.group(0).startswith("</") else 1
            scan = tag.end()
        ordinal += 1
        block = html_text[open_match.start():scan]
        key = _section_key(open_match.group(0), block, ordinal)
        sections[key] = (open_match.start(), scan)
        pos = scan


def extract_section(html_text: str, key: str) -> str:
    sections = parse_sections(html_text)
    if key not in sections:
        raise KeyError(f"Section '{key}' not found. Known sections: {', '.join(sections)}")
    start, end = sections[key]
    return html_text[start:end]


def replace_section(html_text: str, key: str, new_block: str) -> str:
    sections = parse_sections(html_text)
    if key not in sections:
        raise KeyError(f"Section '{key}' not found. Known sections: {', '.join(sections)}")
    start, end = sections[key]
    return html_text[:start] + new_block.strip() + html_text[end:]


def strip_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", stripped)
        stripped = re.sub(r"\s*```\s*$", "", "", stripped)
    return stripped.strip()


def _tag_balance(html_text: str, tag: str) -> int:
    opens = len(re.findall(rf"<{tag}\b", html_text, re.IGNORECASE))
    closes = len(re.findall(rf"</{tag}\s*>", html_text, re.IGNORECASE))
    return opens - closes


def validate_index(new_html: str, original_html: str) -> list[str]:
    """Cheap sanity gate before anything reaches git. Not a real HTML parser —
    it catches the ways an LLM edit typically destroys a page. Balances are
    compared against the ORIGINAL so pre-existing quirks never false-positive."""
    problems: list[str] = []
    if "```" in new_html:
        problems.append("markdown code fence left in HTML")
    if len(new_html) < len(original_html) * 0.5:
        problems.append(
            f"new HTML is suspiciously small ({len(new_html)} chars vs {len(original_html)} original)"
        )
    for tag in ("section", "footer", "div", "form", "ul"):
        if _tag_balance(new_html, tag) != _tag_balance(original_html, tag):
            problems.append(f"<{tag}> open/close balance changed vs original")
    missing = set(parse_sections(original_html)) - set(parse_sections(new_html))
    if missing:
        problems.append(f"sections disappeared: {', '.join(sorted(missing))}")
    return problems


BLOG_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__ | Grizzly Electrical Solutions</title>
<meta name="description" content="__META__">
<link rel="canonical" href="__CANONICAL__">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Barlow:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; background:#090909; color:#e0dbd4; font-family:Barlow,Arial,sans-serif; font-weight:300; line-height:1.8; }
  .wrap { max-width:760px; margin:0 auto; padding:44px 24px 90px; }
  h1, h2 { font-family:Oswald,sans-serif; font-weight:700; color:#f0ebe4; line-height:1.1; }
  h1 { font-size:clamp(34px,5vw,54px); margin:20px 0 8px; }
  h2 { font-size:clamp(22px,3vw,30px); margin:36px 0 12px; }
  a { color:#cc2200; }
  p, li { font-size:16px; }
  .home { font-family:Oswald,sans-serif; font-size:13px; letter-spacing:2px; text-transform:uppercase; text-decoration:none; color:#f0ebe4; }
  .meta { font-size:13px; color:#777; letter-spacing:1px; text-transform:uppercase; margin-bottom:30px; }
  .cta { margin-top:52px; padding:26px; background:#181818; border-left:3px solid #cc2200; }
</style>
</head>
<body>
<div class="wrap">
  <a class="home" href="/">&larr; Grizzly Electrical Solutions</a>
  <h1>__TITLE__</h1>
  <p class="meta">__DATE__ &middot; DFW, Texas</p>
  __BODY__
  <div class="cta">
    <strong style="font-family:Oswald,sans-serif; color:#f0ebe4;">Need an electrician in DFW?</strong>
    <p style="margin:8px 0 0;">Grizzly Electrical Solutions serves Rowlett, Garland, Plano, Richardson, and the greater Dallas&ndash;Fort Worth area. <a href="/#contact">Get a quote</a> or call for 24/7 emergency service.</p>
  </div>
</div>
</body>
</html>
"""

BLOG_INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blog | Grizzly Electrical Solutions</title>
<meta name="description" content="Electrical tips, safety guides, and news from Grizzly Electrical Solutions — licensed DFW electricians.">
<link rel="canonical" href="__CANONICAL__">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Barlow:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; background:#090909; color:#e0dbd4; font-family:Barlow,Arial,sans-serif; font-weight:300; line-height:1.8; }
  .wrap { max-width:760px; margin:0 auto; padding:44px 24px 90px; }
  h1 { font-family:Oswald,sans-serif; font-weight:700; color:#f0ebe4; font-size:clamp(34px,5vw,54px); line-height:1.05; margin:20px 0 34px; }
  a { color:#cc2200; }
  .home { font-family:Oswald,sans-serif; font-size:13px; letter-spacing:2px; text-transform:uppercase; text-decoration:none; color:#f0ebe4; }
  ul.posts { list-style:none; padding:0; margin:0; }
  ul.posts li { margin:0 0 26px; }
  ul.posts a { font-family:Oswald,sans-serif; font-size:20px; color:#f0ebe4; text-decoration:none; }
  ul.posts a:hover { color:#cc2200; }
  ul.posts p { margin:6px 0 0; font-size:15px; color:#999; }
</style>
</head>
<body>
<div class="wrap">
  <a class="home" href="/">&larr; Grizzly Electrical Solutions</a>
  <h1>ELECTRICAL TIPS &amp; NEWS</h1>
  <ul class="posts">
<!-- BLOG-LIST -->
  </ul>
</div>
</body>
</html>
"""

BLOG_LIST_ITEM = (
    '    <li><a href="/blog/__SLUG__/">__TITLE__</a>\n'
    "    <p>__META__</p></li>"
)


def build_blog_files(title: str, meta_description: str, body_html: str, slug: str = "") -> dict[str, Any]:
    """Render the blog post page and updated blog index. Returns the file map
    without writing anything — apply_edit decides preview vs repo."""
    problems: list[str] = []
    title = " ".join(title.split())
    if not title:
        problems.append("blog post has no title")
    body = strip_fences(body_html)
    if "<p" not in body.lower():
        problems.append("blog body has no <p> paragraphs")
    if re.search(r"<(html|head|body)\b", body, re.IGNORECASE):
        problems.append("blog body must not contain <html>/<head>/<body> wrappers")
    slug = _slugify(slug or title)[:60].strip("-")
    if not slug:
        problems.append("could not derive a slug")

    index_path = WEBSITE_REPO_DIR / "blog" / "index.html"
    if index_path.exists():
        blog_index = index_path.read_text(encoding="utf-8")
        if "<!-- BLOG-LIST -->" not in blog_index:
            problems.append("existing blog/index.html has no <!-- BLOG-LIST --> marker")
    else:
        blog_index = BLOG_INDEX_TEMPLATE.replace("__CANONICAL__", f"{WEBSITE_SITE_URL}blog/")

    if problems:
        return {"files": {}, "slug": slug, "url": "", "problems": problems}

    now = datetime.now(UTC)
    date_str = f"{now.strftime('%B')} {now.day}, {now.year}"
    canonical = f"{WEBSITE_SITE_URL}blog/{slug}/"
    meta = (" ".join(meta_description.split()) or title).replace('"', "&quot;")

    page = BLOG_PAGE_TEMPLATE
    for token, value in (
        ("__TITLE__", title),
        ("__META__", meta),
        ("__CANONICAL__", canonical),
        ("__DATE__", date_str),
        ("__BODY__", body),
    ):
        page = page.replace(token, value)

    if f"/blog/{slug}/" not in blog_index:
        item = (
            BLOG_LIST_ITEM
            .replace("__SLUG__", slug)
            .replace("__TITLE__", title)
            .replace("__META__", meta)
        )
        blog_index = blog_index.replace("<!-- BLOG-LIST -->", f"<!-- BLOG-LIST -->\n{item}", 1)

    return {
        "files": {f"blog/{slug}/index.html": page, "blog/index.html": blog_index},
        "slug": slug,
        "url": canonical,
        "problems": [],
    }


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(WEBSITE_REPO_DIR), *args],
        capture_output=True,
        text=True,
        timeout=WEBSITE_GIT_TIMEOUT_S,
    )


def _current_branch() -> str:
    result = _git("rev-parse", "--abbrev-ref", "HEAD")
    return result.stdout.strip() if result.returncode == 0 else ""


def commit_and_push(relpaths: list[str], message: str) -> dict[str, Any]:
    branch = _current_branch()
    if branch != WEBSITE_BRANCH:
        return {
            "status": "error",
            "message": f"Website repo is on branch '{branch or 'unknown'}', expected '{WEBSITE_BRANCH}'. Not committing.",
        }
    add = _git("add", "--", *relpaths)
    if add.returncode != 0:
        return {"status": "error", "message": f"git add failed: {add.stderr.strip()}"}
    commit = _git("commit", "-m", f"{message}\n\nAutomated by SEO Agents Website Manager", "--", *relpaths)
    if commit.returncode != 0:
        return {"status": "error", "message": f"git commit failed: {(commit.stdout + commit.stderr).strip()}"}
    sha = _git("rev-parse", "--short", "HEAD").stdout.strip()
    push = _git("push", "origin", WEBSITE_BRANCH)
    if push.returncode != 0:
        return {
            "status": "push_failed",
            "commit": sha,
            "message": f"Committed {sha} locally but push failed: {push.stderr.strip()}. Push manually to deploy.",
        }
    return {"status": "pushed", "commit": sha, "message": f"Committed {sha} and pushed — Vercel deploy triggered."}


def apply_edit(edit: dict[str, Any], live: bool = False) -> dict[str, Any]:
    """Apply a WebsiteEdit payload from the website crew.

    live=False: write the proposed files under outputs/website_preview/ and
    leave the site repo untouched. live=True: write into the repo, then commit
    and push only the touched files (Vercel deploys on push).
    """
    action_type = str(edit.get("action_type", "")).strip()
    if action_type not in WEBSITE_ACTION_TYPES:
        return {"status": "error", "message": f"Unknown website action_type: {action_type!r}"}
    html_value = strip_fences(str(edit.get("html", "")))
    if not html_value:
        return {"status": "error", "message": "Edit payload has empty html."}
    summary = " ".join(str(edit.get("summary", "")).split()) or f"{action_type} via SEO agents"
    notes: list[str] = []

    if action_type == "website_blog_post":
        built = build_blog_files(
            title=str(edit.get("title", "")),
            meta_description=str(edit.get("meta_description", "")),
            body_html=html_value,
            slug=str(edit.get("target", "")),
        )
        if built["problems"]:
            return {"status": "validation_failed", "problems": built["problems"]}
        files = built["files"]
        url = built["url"]
        if not (WEBSITE_REPO_DIR / "blog" / "index.html").exists():
            notes.append(
                "First blog post: /blog/ index page was created. Nothing on the homepage links "
                "to /blog/ yet — add a nav link with a website_layout_update when ready."
            )
    else:
        target = str(edit.get("target", "")).strip() or DEFAULT_SECTION_FOR_ACTION.get(action_type, "")
        if not target:
            return {"status": "error", "message": f"No target section for {action_type} — set 'target' to a section key."}
        original = load_index()
        try:
            new_index = replace_section(original, target, html_value)
        except KeyError as error:
            return {"status": "error", "message": str(error)}
        problems = validate_index(new_index, original)
        if problems:
            return {"status": "validation_failed", "problems": problems}
        files = {INDEX_FILE: new_index}
        url = WEBSITE_SITE_URL + (f"#{target}" if target != "top" else "")
        if action_type == "website_hours_update":
            notes.append(
                "Hours also live in the JSON-LD openingHoursSpecification block in <head> — "
                "verify it still matches after this change."
            )

    if not live:
        for relpath, content in files.items():
            preview_path = PREVIEW_DIR / relpath
            preview_path.parent.mkdir(parents=True, exist_ok=True)
            preview_path.write_text(content, encoding="utf-8")
        return {
            "status": "preview",
            "action_type": action_type,
            "files": sorted(files),
            "preview_dir": str(PREVIEW_DIR),
            "url": url,
            "notes": notes,
            "message": f"Preview written to {PREVIEW_DIR}. Re-run live to commit and deploy.",
        }

    for relpath, content in files.items():
        target_path = WEBSITE_REPO_DIR / relpath
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(content, encoding="utf-8")
    result = commit_and_push(sorted(files), summary)
    result.update({"action_type": action_type, "files": sorted(files), "url": url, "notes": notes})
    return result


def website_adapter_status() -> dict[str, Any]:
    status: dict[str, Any] = {
        "name": "website-manager",
        "repo": str(WEBSITE_REPO_DIR),
        "branch": WEBSITE_BRANCH,
        "site_url": WEBSITE_SITE_URL,
        "structure_reference": str(WEBSITE_STRUCTURE_FILE),
        "state": "blocked",
        "capabilities": sorted(WEBSITE_ACTION_TYPES),
        "missing": [],
    }
    if not (WEBSITE_REPO_DIR / INDEX_FILE).exists():
        status["missing"].append(f"index.html not found in {WEBSITE_REPO_DIR}")
        return status
    branch = _current_branch()
    if not branch:
        status["missing"].append("website repo is not a git repository (or git failed)")
    elif branch != WEBSITE_BRANCH:
        status["missing"].append(f"website repo is on branch '{branch}', expected '{WEBSITE_BRANCH}'")
    if not WEBSITE_STRUCTURE_FILE.exists():
        status["missing"].append("knowledge/website-structure.md")
    if not status["missing"]:
        status["state"] = "live_ready"
        status["sections"] = list(parse_sections(load_index()))
    return status


def run_website_action(action: dict[str, Any], live: bool) -> dict[str, Any]:
    """Adapter entry point for actions.run_action.

    Queue actions carry intent (title + steps), not HTML — so this generates
    the edit with the website crew, then applies it. Dry runs still call the
    LLM (to produce a reviewable preview) but never touch the site repo.
    """
    # Deferred import: crew.build_website_crew imports back into this module.
    from seo_agents.crew import build_website_crew

    steps = action.get("steps") or []
    completion = action.get("completion") or {}
    task_lines = [f"Task: {action.get('title', '')}"]
    if steps:
        task_lines.append("Steps:\n" + "\n".join(f"- {step}" for step in steps))
    deliverable = str(completion.get("deliverable", "")).strip()
    if deliverable:
        task_lines.append(f"Draft deliverable from the executor crew (reuse and adapt it):\n{deliverable}")
    action_type = str(action.get("action_type", ""))
    try:
        crew = build_website_crew(task="\n\n".join(task_lines), action_type=action_type)
        crew.kickoff()
    except Exception as error:
        return {"status": "error", "message": f"Website crew failed: {error}"}
    edit_path = OUTPUT_DIR / "website_edit.json"
    try:
        edit = json.loads(edit_path.read_text(encoding="utf-8"))
    except Exception as error:
        return {"status": "error", "message": f"website_edit.json unreadable after crew run: {error}"}
    if action_type and not str(edit.get("action_type", "")).strip():
        edit["action_type"] = action_type
    return apply_edit(edit, live=live)
