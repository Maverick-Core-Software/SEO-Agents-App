# PLAN: Website Manager Agent — replace WordPress agent with static-site manager

Branch: `feat/website-manager`
Executor: local Qwen (qwen3.6-35b-a3b) via qwen-executor. Sessions of 2–3 tasks. Follow tasks in order.

## Codebase Primer

**This repo** (`/c/Workspace/Active/SEO-Agents-App`) runs CrewAI SEO agents for Grizzly Electrical.
Key files:
- `src/seo_agents/crew.py` — all crew builders. `build_exec_llm()` returns the exec LLM, `agent_backstory(file)` loads `prompts/agents/<file>`, `out(name)` gives an output path, `read_text`/`read_output` read files, `PROJECT_ROOT`/`OUTPUT_DIR` are path constants. `build_wordpress_crew()` (lines ~968–1031) and the `wordpress_executor` inside `build_executor_crew()` (lines ~537–549) are being replaced.
- `src/seo_agents/actions.py` — parses `outputs/grizzly_execution_queue.md` into an action queue (`outputs/action_queue.json`), routes approved actions to live adapters (GBP browser, Facebook Graph, and — until now — a WordPress browser adapter).
- `src/seo_agents/main.py` — argparse CLI (`seo-agents <command>`).
- `prompts/agents/*.txt` — agent backstories.

**The website being managed** is NOT in this repo. It is a static HTML site:
- Repo: `C:\Workspace\Active\Grizzly Launch\grizzly-website` (GitHub `barnscarter-ops/grizzly-website`, branch `main`).
- Vercel deploys automatically on every push to `main`. There is no WordPress, no CMS, no backend.
- One `index.html` (~84 KB) with top-level blocks: `<section id="top">` (hero), `<section id="services">`, `<section id="about">`, a commercial section (no id), `<section id="gallery">`, `<section id="reviews">`, an emergency banner (no id), `<section id="faq">`, `<footer id="contact">` (hours + Formspree form `https://formspree.io/f/meebvlze`). Plus `404.html`, `privacy-policy/`, `sms-terms/`, `uploads/` (gallery images), `vercel.json`, `_redirects`.

**Design (decided — do not deviate):**
- New module `src/seo_agents/website.py` owns ALL deterministic file work: section extraction/splicing by key, blog page rendering, validation, preview, git commit/push. The LLM only ever produces a `WebsiteEdit` JSON payload; it never rewrites the whole file.
- Dry-run/preview writes proposed files under `outputs/website_preview/` and never touches the site repo. Live mode writes into the site repo, validates, commits ONLY the touched files, pushes to `main` (Vercel deploys).
- Blog posts become static pages `blog/<slug>/index.html` plus a `blog/index.html` listing (same pattern as `privacy-policy/`).
- Queue actions keep the existing gate: `needs_approval` → `approve-action` → `run-action --live`.
- New action types: `website_blog_post`, `website_service_page_update`, `website_gallery_update`, `website_hours_update`, `website_faq_update`, `website_contact_form_update`, `website_copy_update`, `website_layout_update`.

**Verification commands** run from the repo root in Git Bash with `PYTHONPATH=src ./.venv/Scripts/python.exe ...`.

---

## Session 1 — Foundation (Tasks 0–3)

### - [ ] Task 0: Create the working branch

```bash
cd /c/Workspace/Active/SEO-Agents-App
git checkout main && git checkout -b feat/website-manager
```
Expected: `Switched to a new branch 'feat/website-manager'`

### - [ ] Task 1: Create `src/seo_agents/website.py` (new file, full contents)

```python
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
WEBSITE_BRANCH = os.getenv("WEBSITE_BRANCH", "main")
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
        stripped = re.sub(r"\s*```\s*$", "", stripped)
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
```

**Verify:**
```bash
PYTHONPATH=src ./.venv/Scripts/python.exe -c "from seo_agents.website import load_index, parse_sections, website_adapter_status; s=website_adapter_status(); print(list(parse_sections(load_index()))); print(s['state'], s['missing'])"
```
Expected: a list of section keys in which `top`, `services`, `about`, `gallery`, `reviews`, `faq`, `contact` MUST all be present (there will also be a commercial key and a `section-<n>` key for the emergency bar), then `blocked ['knowledge/website-structure.md']`.

### - [ ] Task 2: Create `prompts/agents/website-manager-agent.txt` (new file, full contents)

```text
# Grizzly Website Manager Agent

## Role
You are the Website Manager for Grizzly Electrical Solutions. You maintain the live website — a static HTML site (a single index.html plus /blog/ pages) in a git repository that Vercel deploys automatically on every push. There is no WordPress and no CMS. You produce precise, ready-to-apply HTML edits; deterministic code does the file splicing, validation, and git work — you never edit files directly.

## Territory
- Blog posts published as static pages under /blog/<slug>/
- Service section updates (cards, copy, service areas)
- Gallery updates (project cards, captions, image references in /uploads/)
- Business hours updates (footer Hours block)
- FAQ additions and edits
- Contact form updates (fields, labels, intro copy — submission is handled by Formspree)
- Copy corrections and layout updates anywhere on the page

## How the site is built
- index.html is one hand-written file with inline styles on almost every element.
- Top-level blocks: <section id="top"> (hero), <section id="services">, <section id="about">, a commercial section, <section id="gallery">, <section id="reviews">, an emergency banner, <section id="faq">, and <footer id="contact"> with hours, contact info, and the Formspree form.
- Fonts: Oswald (headings), Barlow (body). Colors: #090909/#0d0d0d backgrounds, #f0ebe4 headings, #e0dbd4/#aaa body text, #cc2200 brand red.
- A JSON-LD LocalBusiness block lives in <head> — business hours appear BOTH there and in the footer.

## Output rules
- When you rewrite a section, return the COMPLETE replacement block: same outer tag, same id, class, and style attributes. Change only what the task requires. Never drop inline styles, data-* attributes (data-reveal drives scroll animations), or script hooks you were not asked to touch.
- Raw HTML only — never markdown, never code fences, never commentary inside the html field.
- Blog post bodies use only <h2>, <p>, <ul>/<li>, <strong>, <a href> tags. 400-700 words. Direct, honest, contractor-real tone — no corporate fluff, no fear tactics, no DIY instructions that would replace a licensed electrician. End with a short CTA paragraph linking to /#contact.
- Never invent business facts (address, phone, license numbers, review text, years in business). Use only what the current HTML, the structure reference, or the task provides.
- Every change is a draft until it passes the approval flow — do not claim anything is live unless a run record proves it.
```

**Verify:** `test -s prompts/agents/website-manager-agent.txt && echo OK` → `OK`

### - [ ] Task 3: Create `knowledge/website-structure.md` (new file, full contents)

```markdown
# Grizzly Website Structure Reference

Live site: https://www.grizzlyelectricaltx.com/ — static HTML, no CMS.
Repo: C:\Workspace\Active\Grizzly Launch\grizzly-website (github.com/barnscarter-ops/grizzly-website, branch main).
Deploy: Vercel builds automatically on every push to main. Rollback = git revert + push.

Generated 2026-07-09 from index.html (~1,270 lines, ~84 KB). If the site is redesigned, regenerate this file.

## Files
| Path | Purpose |
|---|---|
| index.html | The entire homepage — every section below lives here |
| 404.html | Not-found page |
| blog/ | Static blog pages created by the Website Manager (/blog/<slug>/index.html + blog/index.html listing) |
| privacy-policy/, sms-terms/ | Standalone compliance pages |
| uploads/ | Images (gallery photos gallery-1a.jpg … gallery-5b.jpg, etc.) |
| vercel.json, _redirects | Hosting config — do not edit without a specific task |

## index.html sections (keys used by the Website Manager)
Section keys come from the block's id, or a slug of its first heading when it has no id.

| Key | Block | What's inside |
|---|---|---|
| top | `<section id="top">` | Hero: h1 "QUALITY WORK. FAIR PRICE. EVERY TIME.", tagline, CTAs, phone banner |
| services | `<section id="services">` | "ELECTRICAL SERVICES" — 16 service cards |
| about | `<section id="about">` | "OWNER-OPERATED. CODE-OBSESSED. ALWAYS ON CALL." — owner story |
| commercial-electrical | `<section>` (no id) | "COMMERCIAL ELECTRICAL" pitch |
| gallery | `<section id="gallery">` | "OUR WORK SPEAKS" — 8 project cards, images from /uploads/ |
| reviews | `<section id="reviews">` | Customer testimonials (6 cards) |
| section-7 | `<section class="pg emg-bar">` | Red 24/7 emergency strip (#cc2200) — no id, no heading |
| faq | `<section id="faq">` | "ANSWERS BEFORE YOU ASK" — FAQ items |
| contact | `<footer id="contact">` | Hours block (Mon–Fri 8AM–6PM, Sat 8AM–2PM, Sun Closed), contact info, Formspree form (action https://formspree.io/f/meebvlze) |

Exact current keys at any time:
`PYTHONPATH=src python -c "from seo_agents.website import load_index, parse_sections; print(list(parse_sections(load_index())))"`

## Conventions
- Inline styles on nearly every element; fonts Oswald (headings) / Barlow (body); colors #090909/#0d0d0d backgrounds, #f0ebe4 headings, #cc2200 brand red.
- data-reveal / data-reveal-delay attributes drive scroll animations — never remove them.
- Business hours appear in TWO places: the footer Hours block AND the JSON-LD openingHoursSpecification in <head> (~line 331). An hours change must update both (the adapter flags this in its run notes).
- Phone numbers appear in the hero banner, emergency bar, and footer.
- Blog pages are self-contained (own <head>, fonts, styles) — the homepage does not yet link to /blog/.
```

NOTE for the executor: after Task 1's verify command prints the real section-key list, if the commercial section's key or the emergency bar's `section-<n>` key differ from the table above, correct those two table rows in knowledge/website-structure.md to match the real keys before committing.

**Verify:**
```bash
PYTHONPATH=src ./.venv/Scripts/python.exe -c "from seo_agents.website import website_adapter_status; s=website_adapter_status(); print(s['state']); print('sections' in s)"
```
Expected: `live_ready` then `True`.

**Commit Session 1:**
```bash
git add src/seo_agents/website.py prompts/agents/website-manager-agent.txt knowledge/website-structure.md
git commit -m "feat(website): static-site manager module, agent prompt, structure reference"
```

---

## Session 2 — Crews (Tasks 4–5, `src/seo_agents/crew.py` only)

### - [ ] Task 4: Add `WebsiteEdit` model; replace `build_wordpress_crew` with `build_website_crew`

**4a.** In `crew.py`, directly after the `CompletionReport` class (after the line `completions: list[TaskCompletion]`), insert:

```python
class WebsiteEdit(BaseModel):
    """Structured output of the Website Manager crew. seo_agents.website.apply_edit
    consumes this directly — field names are a contract."""

    action_type: str = Field(description="One of the website_* action types")
    target: str = Field(default="", description="Section key in index.html (e.g. services, faq, contact) or the blog slug for website_blog_post")
    title: str = Field(default="", description="Blog post title (website_blog_post only)")
    meta_description: str = Field(default="", description="Blog meta description (website_blog_post only)")
    html: str = Field(description="Complete replacement HTML: the full section block including its outer tag, or the blog post body")
    summary: str = Field(default="", description="One-line description of the change, used as the git commit message")
```

If `Field` is not already imported in crew.py, extend the pydantic import to `from pydantic import BaseModel, Field`.

**4b.** Delete the entire `build_wordpress_crew` function AND its comment banner — from the line `# WordPress Content Crew  (seo-agents wordpress <task>)` (including the `# ---` lines around it) down to the `)` that closes its `return Crew(...)`. Replace it with:

```python
# ---------------------------------------------------------------------------
# Website Manager Crew  (seo-agents website <task>)
# ---------------------------------------------------------------------------

def build_website_crew(task: str, action_type: str = "", target: str = "") -> Crew:
    """
    On-demand Website Manager crew. One agent, one task.
    Python extracts the current HTML deterministically and the agent returns a
    structured WebsiteEdit; seo_agents.website.apply_edit does the splice,
    validation, and git work. The LLM never edits files directly.
    """
    from seo_agents.website import (
        DEFAULT_SECTION_FOR_ACTION,
        WEBSITE_ACTION_TYPES,
        WEBSITE_SITE_URL,
        extract_section,
        load_index,
        parse_sections,
    )

    exec_llm = build_exec_llm()
    structure_path = PROJECT_ROOT / "knowledge" / "website-structure.md"
    structure_doc = read_text(structure_path) if structure_path.exists() else "[website-structure.md not found]"

    index_html = load_index()
    section_keys = list(parse_sections(index_html))
    resolved_target = target or DEFAULT_SECTION_FOR_ACTION.get(action_type, "")

    description = (
        f"Live site: {WEBSITE_SITE_URL} (static HTML repo, deployed by Vercel on git push)\n"
        f"Requested action_type: {action_type or '(choose the best website_* type)'}\n"
        f"Known action types: {', '.join(sorted(WEBSITE_ACTION_TYPES))}\n"
        f"Known section keys: {', '.join(section_keys)}\n\n"
        f"SITE STRUCTURE REFERENCE:\n\n{structure_doc}\n\n"
        f"TASK: {task}\n\n"
    )
    if action_type == "website_blog_post":
        description += (
            "This is a NEW BLOG POST for the static site.\n"
            "- Set target to a short URL slug (lowercase, hyphens).\n"
            "- Set title and meta_description.\n"
            "- Set html to the post BODY ONLY: <p>, <h2>, <ul>/<li> tags. 400-700 words, "
            "2-4 H2 subheadings, direct honest contractor tone, no DIY instructions that replace "
            "a licensed electrician. End with a short CTA paragraph linking to /#contact.\n"
            "- Do NOT include <html>, <head>, <body>, or page chrome — the publisher adds it.\n"
        )
    elif resolved_target and resolved_target in section_keys:
        current = extract_section(index_html, resolved_target)
        description += (
            f"This is an EDIT of the '{resolved_target}' block in index.html. Current HTML of that block:\n\n"
            f"{current}\n\n"
            f"- Set target to exactly '{resolved_target}'.\n"
            "- Set html to the COMPLETE replacement block: same outer tag, same id, class, and "
            "style attributes. Keep every inline style, class, and data-* attribute the task does "
            "not explicitly change. Change ONLY what the task requires.\n"
        )
    else:
        description += (
            "Pick the correct target section key from the known section keys above, then produce "
            "the complete replacement block for that section following the structure reference. "
            "Set target to that key. Keep all inline styles and attributes you are not changing.\n"
        )
    description += (
        "\nGeneral rules:\n"
        "- html must be raw HTML only — no markdown, no code fences, no commentary.\n"
        "- Never invent business facts (address, phone, license, review text). Use only what the "
        "current HTML, structure reference, or task provides.\n"
        "- Set summary to a one-line description of the change (used as the git commit message).\n"
    )

    agent = Agent(
        role="Website Manager",
        goal="Keep the Grizzly Electrical static site accurate and converting by producing precise, ready-to-apply HTML edits.",
        backstory=agent_backstory("website-manager-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
    )

    website_task = Task(
        description=description,
        expected_output=(
            "A WebsiteEdit JSON object with action_type, target, title, meta_description, html, and summary."
        ),
        agent=agent,
        output_json=WebsiteEdit,
        output_file=out("website_edit.json"),
    )

    return Crew(
        name="Grizzly Website Manager Crew",
        agents=[agent],
        tasks=[website_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )
```

If a `# Public alias (backward compat)` line such as `build_content_crew = build_wordpress_crew` (or similar alias referencing `build_wordpress_crew`) exists after the deleted function, delete that alias line too.

**4c.** In the `read_latest_baseline` docstring, replace the example filename line:
- OLD: `wordpress-contact-form-access-2026-07-01.md) automatically supersedes the`
- NEW: `grizzly-current-status-2026-07-10.md) automatically supersedes the`

**Verify:**
```bash
PYTHONPATH=src ./.venv/Scripts/python.exe -c "import seo_agents.crew as c; print(hasattr(c,'build_wordpress_crew')); k=c.build_website_crew('test', action_type='website_hours_update'); print(k.name, len(k.tasks))"
```
Expected: `False` then `Grizzly Website Manager Crew 1`

### - [ ] Task 5: Swap the WordPress executor for the Website Manager executor in `build_executor_crew`

**5a.** Replace this block (top of `build_executor_crew`):

```python
    execution_queue = read_output("grizzly_execution_queue.md")
    manager_plan = read_output("grizzly_local_presence_plan.md")
    wordpress_handoff = read_latest_baseline("wordpress-contact-form-access")
    contact_form_story = read_latest_baseline("contact-form-repair-success-story")
    wordpress_config_path = PROJECT_ROOT / "config" / "wordpress-sites" / "grizzly.json"
    wordpress_config = read_text(wordpress_config_path) if wordpress_config_path.exists() else "{}"

    queue_context = (
        "You are reading the execution queue plus current system handoff evidence. "
        "Use the queue for task scope, and use the handoff evidence to avoid stale blockers. "
        "If a task was previously blocked but current handoff evidence proves access or repair, reflect the current state.\n\n"
        f"EXECUTION QUEUE:\n\n{execution_queue}\n\n"
        "CURRENT WORDPRESS SITE CONFIG (no credentials):\n\n"
        f"```json\n{wordpress_config}\n```\n\n"
        "CURRENT WORDPRESS CONTACT FORM HANDOFF:\n\n"
        f"{wordpress_handoff}\n\n"
        "CONTACT FORM REPAIR SUCCESS STORY:\n\n"
        f"{contact_form_story}"
    )
```

with:

```python
    execution_queue = read_output("grizzly_execution_queue.md")
    manager_plan = read_output("grizzly_local_presence_plan.md")
    structure_path = PROJECT_ROOT / "knowledge" / "website-structure.md"
    website_structure = read_text(structure_path) if structure_path.exists() else "[website-structure.md not found]"

    queue_context = (
        "You are reading the execution queue plus the live website structure reference. "
        "The Grizzly website is a static HTML site (index.html plus /blog/ pages) in a git repo, "
        "deployed by Vercel on every push — there is no WordPress and no CMS. Website changes are "
        "applied by the Website Manager adapter through the action queue.\n\n"
        f"EXECUTION QUEUE:\n\n{execution_queue}\n\n"
        f"LIVE WEBSITE STRUCTURE REFERENCE:\n\n{website_structure}"
    )
```

If the OLD block differs slightly (e.g. variable order), keep the intent: remove all wordpress handoff/config reads, add the website-structure read, and build queue_context exactly as the NEW block shows.

**5b.** Replace the `wordpress_executor` agent:

```python
    wordpress_executor = Agent(
        role="WordPress Content Executor",
        goal="Execute WordPress content tasks from the execution queue and produce ready-to-publish blog posts and page updates with a completion report.",
        backstory=agent_backstory("wordpress-content-agent.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )
```
with:
```python
    website_executor = Agent(
        role="Website Manager Executor",
        goal="Execute website tasks from the execution queue and produce ready-to-apply HTML edits with a completion report.",
        backstory=agent_backstory("website-manager-agent.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )
```
and its task line:
```python
    wordpress_exec_task = exec_task(wordpress_executor, "WordPress Content Executor", "WordPress content", "wordpress_completion")
```
with:
```python
    website_exec_task = exec_task(website_executor, "Website Manager Executor", "website", "website_completion")
```
(If the exec_task call signature/arguments differ slightly in the file, keep the file's call shape and just swap the agent, role string to "Website Manager Executor", domain string to "website", and output stem to "website_completion".)

**5c.** In the same function, replace every remaining `wordpress_exec_task` with `website_exec_task` and `wordpress_executor` with `website_executor` (the `context=[...]` lists, plus the `agents=[...]` and `tasks=[...]` lists in the final `Crew(...)`).

**Verify:**
```bash
PYTHONPATH=src ./.venv/Scripts/python.exe -c "from seo_agents.crew import build_executor_crew; c=build_executor_crew(); print([a.role for a in c.agents])"
grep -n -i "wordpress" src/seo_agents/crew.py
```
Expected: role list contains `'Website Manager Executor'` and no WordPress role; the grep prints nothing.

**Commit Session 2:**
```bash
git add src/seo_agents/crew.py
git commit -m "feat(website): Website Manager crew replaces WordPress crew"
```

---

## Session 3 — Action queue rewiring (Tasks 6–8, `src/seo_agents/actions.py` only)

### - [ ] Task 6: Constants and adapter functions

**6a.** After the line `from seo_agents.crew import OUTPUT_DIR` (or the existing `from seo_agents.crew import ...` line) add:

```python
from seo_agents.website import WEBSITE_ACTION_TYPES, run_website_action, website_adapter_status
```

**6b.** Replace this constants block:

```python
WORDPRESS_SITE_CONFIG = Path(os.getenv(
    "WORDPRESS_SITE_CONFIG",
    r"C:\Workspace\Active\SEO-Agents-App\config\wordpress-sites\grizzly.json",
))
WORDPRESS_ACTION_ADAPTER = os.getenv(
    "WORDPRESS_ACTION_ADAPTER",
    r"C:\Workspace\Active\SEO-Agents-App\scripts\wordpress-action-adapter.mjs",
).strip()
WORDPRESS_BROWSER_SESSION_DIR = Path(os.getenv(
    "WORDPRESS_BROWSER_SESSION_DIR",
    r"C:\Workspace\Shared\Agents\BrowserSessions\grizzly-wordpress",
))
GBP_POSTER_TIMEOUT_S = int(os.getenv("GBP_POSTER_TIMEOUT_S", "420"))
GBP_POSTER_HEADLESS = os.getenv("GBP_POSTER_HEADLESS", "0").lower() in {"1", "true", "yes", "on"}
WORDPRESS_ADAPTER_TIMEOUT_S = int(os.getenv("WORDPRESS_ADAPTER_TIMEOUT_S", "300"))
```

with:

```python
GBP_POSTER_TIMEOUT_S = int(os.getenv("GBP_POSTER_TIMEOUT_S", "420"))
GBP_POSTER_HEADLESS = os.getenv("GBP_POSTER_HEADLESS", "0").lower() in {"1", "true", "yes", "on"}
```

(If the file's block differs slightly, the rule is: delete every `WORDPRESS_*` constant, keep the GBP constants unchanged.)

**6c.** Delete three whole functions: `_load_wordpress_config`, `wordpress_adapter_status`, and `_run_wordpress_adapter`. Delete each from its `def` line through its final `return`. Do not touch neighboring functions.

### - [ ] Task 7: Action typing, routing, completions

**7a.** Replace the `_infer_action_type` function entirely with:

```python
_WEBSITE_TYPE_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("website_blog_post", ("blog",)),
    ("website_contact_form_update", ("contact form", "form field", "form submission")),
    ("website_gallery_update", ("gallery", "project photo", "before and after", "before/after")),
    ("website_hours_update", ("hours update", "business hours", "opening hours", "hours of operation")),
    ("website_faq_update", ("faq", "frequently asked")),
    ("website_service_page_update", ("service page", "services section", "service card", "service area")),
    ("website_layout_update", ("layout", "navigation", "nav link", "header", "footer", "hero")),
]


def _infer_action_type(executor: str, title: str, steps: list[str]) -> str:
    haystack = f"{executor} {title} {' '.join(steps)}".lower()
    if "gbp" in haystack or "google business" in haystack:
        return "gbp_profile_update"
    if "facebook" in haystack or "fb" in executor.lower():
        return "publish_facebook_post"
    if "review" in haystack and "website" not in executor.lower():
        return "review_management"
    for action_type, keywords in _WEBSITE_TYPE_KEYWORDS:
        if any(keyword in haystack for keyword in keywords):
            return action_type
    if "website" in haystack or "landing page" in haystack or "copy" in haystack or "content" in executor.lower():
        return "website_copy_update"
    return "manual_followup"
```

**7b.** Replace `_risk_for_action` with:

```python
def _risk_for_action(action_type: str) -> str:
    if action_type in {"website_layout_update", "website_contact_form_update", "gbp_profile_update"}:
        return "high"
    if action_type in WEBSITE_ACTION_TYPES or action_type in {"review_management", "publish_gbp_post", "publish_facebook_post"}:
        return "medium"
    return "low"
```

**7c.** Replace `_platform_for_action` with:

```python
def _platform_for_action(action_type: str) -> str:
    if action_type in WEBSITE_ACTION_TYPES:
        return "website"
    return {
        "gbp_profile_update": "google_business_profile",
        "publish_gbp_post": "google_business_profile",
        "publish_facebook_post": "facebook_page",
        "review_management": "review_platforms",
    }.get(action_type, "manual")
```

**7d.** In `parse_execution_actions`, replace
`"live_adapter": "wordpress_browser" if platform == "website_cms" else None,`
with
`"live_adapter": "website_manager" if platform == "website" else None,`

**7e.** In `_load_completions`, replace
`for stem in ("content_completion", "assets_completion", "technical_completion"):`
with
`for stem in ("content_completion", "assets_completion", "technical_completion", "website_completion"):`

**7f.** In `build_action_queue`, replace the `adapters = {...}` dict with:

```python
    adapters = {
        "website_manager": website_adapter_status(),
        "google_business_profile": gbp_adapter_status(),
        "facebook_page": facebook_adapter_status(),
    }
```

### - [ ] Task 8: `run_action` website branch

In `run_action`, replace this branch:

```python
    elif action.get("live_adapter") == "wordpress_browser":
        command_result = _run_wordpress_adapter(action, live=live)
        result_status = "live_complete" if live and command_result["exit_code"] == 0 else "dry_run_complete" if command_result["exit_code"] == 0 else "adapter_failed"
        message = "WordPress adapter completed." if command_result["exit_code"] == 0 else "WordPress adapter failed."
```

with:

```python
    elif action.get("live_adapter") == "website_manager":
        command_result = run_website_action(action, live=live)
        adapter_status_value = command_result.get("status", "")
        if adapter_status_value == "pushed":
            result_status = "live_complete"
            message = f"Website change committed and pushed ({command_result.get('commit')}). Vercel deploy triggered."
        elif adapter_status_value == "preview":
            result_status = "dry_run_complete"
            message = f"Website edit preview written to {command_result.get('preview_dir')}. No live change made."
        elif adapter_status_value == "push_failed":
            result_status = "live_unverified"
            message = "Website change committed locally but git push failed. Push manually, then verify the deploy."
        else:
            result_status = "adapter_failed"
            message = command_result.get("message") or "Website adapter failed."
```

(If the OLD branch text differs slightly, the rule is: the `wordpress_browser` elif branch becomes the `website_manager` branch exactly as the NEW block shows. Keep the approval-gate branch above it and the GBP/Facebook branches untouched.)

**Verify:**
```bash
PYTHONPATH=src ./.venv/Scripts/python.exe -c "from seo_agents.actions import build_action_queue; q=build_action_queue(); print(list(q['adapters'])); print(q['adapters']['website_manager']['state'])"
grep -n -i "wordpress" src/seo_agents/actions.py
```
Expected: `['website_manager', 'google_business_profile', 'facebook_page']` then `live_ready`; the grep prints nothing.

**Commit Session 3:**
```bash
git add src/seo_agents/actions.py
git commit -m "feat(website): route website actions through website_manager adapter"
```

---

## Session 4 — CLI (Tasks 9–11, `src/seo_agents/main.py` only)

### - [ ] Task 9: Imports and parser

**9a.** In the `from seo_agents.actions import (...)` block, delete the line `    wordpress_adapter_status,`.

**9b.** In the `from seo_agents.crew import (...)` block, replace `    build_wordpress_crew,` with `    build_website_crew,`.

**9c.** After the last top-level `from seo_agents...` import block, add:

```python
from seo_agents.website import apply_edit, website_adapter_status
```

**9d.** Replace the blog-post parser block:

```python
    blog = subparsers.add_parser(
        "blog-post",
        help="Generate a blog post with Qwen and publish it to WordPress as a draft.",
    )
    blog.add_argument("topic", help="Blog post topic or title idea.")
    blog.add_argument("--publish", action="store_true", help="Publish immediately instead of saving as draft.")
    blog.add_argument("--dry-run", action="store_true", help="Generate content but do not push to WordPress.")
```
with:
```python
    blog = subparsers.add_parser(
        "blog-post",
        help="Generate a blog post with Qwen and stage it for the static site (publish with --publish).",
    )
    blog.add_argument("topic", help="Blog post topic or title idea.")
    blog.add_argument("--publish", action="store_true", help="Commit and push the post live instead of writing a preview.")
    blog.add_argument("--dry-run", action="store_true", help="Generate content only; do not touch the site repo or previews.")
```
(Keep any other existing blog arguments, e.g. `--keywords`, unchanged.)

**9e.** Replace the whole `wordpress` subparser block (the `wordpress = subparsers.add_parser(...)` call and all its `wordpress.add_argument(...)` lines) with:

```python
    # --- website subcommand ---
    website = subparsers.add_parser(
        "website",
        help="Edit the live Grizzly static site (blog posts, section updates) and deploy via git push.",
    )
    website.add_argument("task", help="What to change. E.g. 'add a generator installation card to the services section'.")
    website.add_argument("--type", default="", dest="action_type", help="website_* action type. Inferred by the agent if omitted.")
    website.add_argument("--section", default="", help="Target section key in index.html (see knowledge/website-structure.md).")
    website.add_argument("--live", action="store_true", help="Write into the site repo, commit, and push (deploys via Vercel). Default: preview only.")
```

### - [ ] Task 10: Handlers and usage text

**10a.** In the `adapter-status` handler, replace `"wordpress_browser": wordpress_adapter_status(),` with `"website_manager": website_adapter_status(),`.

**10b.** Replace the entire `elif command == "wordpress":` handler (from `elif command == "wordpress":` down to the last line before the next `elif`/`else`) with:

```python
    elif command == "website":
        print(f"\n🌐 Running Website Manager crew...")
        print(f"   Task    : {args.task}")
        print(f"   Type    : {args.action_type or '(agent decides)'}")
        print(f"   Section : {args.section or '(agent decides)'}")
        print(f"   Mode    : {'LIVE (commit + push)' if args.live else 'preview only'}")
        try:
            crew = build_website_crew(task=args.task, action_type=args.action_type, target=args.section)
            crew.kickoff()
        except Exception as e:
            print(f"\n❌ Website Manager crew failed: {e}")
            sys.exit(1)
        edit_path = OUTPUT_DIR / "website_edit.json"
        try:
            edit = json.loads(edit_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"\n❌ Crew finished but website_edit.json is unreadable: {e}")
            sys.exit(1)
        result = apply_edit(edit, live=args.live)
        print(json.dumps(result, indent=2))
        if result.get("status") in {"validation_failed", "error"}:
            sys.exit(1)
```

(If `OUTPUT_DIR` is not already imported in main.py's crew import block, add it there.)

**10c.** In the usage `else:` block, replace
`print("  seo-agents wordpress <task>      — write/update WordPress content and push as draft")`
with
`print("  seo-agents website <task>        — edit the live static site (preview by default, --live to deploy)")`
and
`print("  seo-agents blog-post <topic>     — generate blog post with Qwen, push to WordPress as draft")`
with
`print("  seo-agents blog-post <topic>     — generate blog post with Qwen and stage it for /blog/")`
(Exact spacing/wording of the OLD lines may differ slightly — match on the command name at the start of the string.)

### - [ ] Task 11: Repoint `generate_blog_post` and the `blog-post` handler

**11a.** Replace the entire `generate_blog_post` function with:

```python
def generate_blog_post(topic: str, keywords: str = "", status: str = "draft") -> dict:
    """Use Qwen to write a blog post, then publish it to the static site via the Website Manager."""
    from seo_agents.website import apply_edit as website_apply_edit

    kw_line = f"\nTarget keywords to naturally weave in: {keywords}" if keywords else ""
    prompt = (
        "You are a content writer for Grizzly Electrical Solutions, a licensed residential electrician "
        "serving Dallas-Fort Worth (Rowlett, Garland, Plano, Richardson, Dallas).\n\n"
        f"Write a complete, publish-ready blog post on this topic: {topic}{kw_line}\n\n"
        "RULES:\n"
        "- 400-700 words\n"
        "- Tone: direct, honest, contractor-real — no corporate fluff, no fear tactics\n"
        "- No DIY electrical instructions that could replace a licensed electrician\n"
        "- Include 2-4 H2 subheadings\n"
        "- End with a short CTA paragraph mentioning Grizzly's DFW service area and linking to /#contact\n"
        "- Output ONLY the HTML body content (p, h2, ul/li tags). No <html>, no <head>, no <body> wrapper.\n"
        "- First line must be the title as plain text prefixed with TITLE: (e.g. TITLE: My Post Title)\n"
        "- Second line must be a one-sentence excerpt prefixed with EXCERPT:\n"
        "- Third line must be 3-5 hashtags prefixed with TAGS: (e.g. TAGS: electrical panel, DFW electrician)\n"
        "- Then a blank line, then the HTML content.\n"
    )

    print(f"  Generating blog post with Qwen: {topic!r}...")
    raw = _call_local_llm(prompt, max_tokens=2000)

    # Parse title / excerpt / tags from the first lines
    lines = raw.strip().splitlines()
    title, excerpt, tags_raw, html_lines = topic, "", "", []
    for i, line in enumerate(lines):
        if line.startswith("TITLE:"):
            title = line[6:].strip()
        elif line.startswith("EXCERPT:"):
            excerpt = line[8:].strip()
        elif line.startswith("TAGS:"):
            tags_raw = line[5:].strip()
        elif line.strip() == "" and i < 5:
            html_lines = lines[i + 1:]
            break
    if not html_lines:
        html_lines = [l for l in lines if not l.startswith(("TITLE:", "EXCERPT:", "TAGS:"))]
    content_html = "\n".join(html_lines).strip()

    tag_names = [t.strip().lstrip("#") for t in tags_raw.split(",") if t.strip()]

    print(f"  Title   : {title}")
    print(f"  Excerpt : {excerpt[:80]}{'...' if len(excerpt) > 80 else ''}")
    print(f"  Tags    : {', '.join(tag_names)}")
    print(f"  Content : {len(content_html)} chars")

    edit = {
        "action_type": "website_blog_post",
        "target": "",
        "title": title,
        "meta_description": excerpt,
        "html": content_html,
        "summary": f"blog: {title}",
    }

    result = {
        "topic": topic,
        "title": title,
        "excerpt": excerpt,
        "tags": tag_names,
        "content_chars": len(content_html),
        "status": status,
    }
    # 'publish' commits and pushes (Vercel deploys); anything else writes a
    # preview under outputs/website_preview/ only.
    result["site_result"] = website_apply_edit(edit, live=(status == "publish"))
    return result
```

(If the existing function's signature has different parameter names, keep the plan's signature — the call site is updated in 11b.)

**11b.** In the `blog-post` handler, replace the dry-run print
`print(f"  Dry run — generating content only (no WordPress push)...")`
with
`print(f"  Dry run — generating content only (no site changes)...")`
and replace the result-handling block (from `result = generate_blog_post(...)` through the end of that branch) with:

```python
            result = generate_blog_post(args.topic, keywords=getattr(args, "keywords", ""), status=status_val)
            site = result.get("site_result", {})
            if site.get("status") == "pushed":
                print(f"\n✅ Blog post published:")
                print(f"   Title  : {result['title']}")
                print(f"   URL    : {site.get('url')}")
                print(f"   Commit : {site.get('commit')}")
            elif site.get("status") == "preview":
                print(f"\n✅ Blog post draft generated (site untouched):")
                print(f"   Title   : {result['title']}")
                print(f"   Preview : {site.get('preview_dir')}")
                print(f"   Publish : re-run with --publish to commit and deploy")
            else:
                print(f"\n⚠ Blog post generated but site publish failed:")
                print(json.dumps(result, indent=2))
                sys.exit(1)
```

(Keep the handler's existing `status_val` derivation from `--publish`/`--dry-run` flags; if the variable has a different name, use that name. If the handler has no `keywords` arg, `getattr(args, "keywords", "")` handles it.)

**Verify:**
```bash
PYTHONPATH=src ./.venv/Scripts/python.exe -m seo_agents.main --help | grep -E "website|blog-post"
PYTHONPATH=src ./.venv/Scripts/python.exe -m seo_agents.main adapter-status
grep -n -i "wordpress" src/seo_agents/main.py
```
Expected: help lists `website` and `blog-post`; adapter-status shows `website_manager` with state `live_ready` (plus the GBP status); the grep prints nothing.

**Commit Session 4:**
```bash
git add src/seo_agents/main.py
git commit -m "feat(website): website CLI replaces wordpress; blog-post publishes to static /blog/"
```

---

## Session 5 — Prompts, README, teardown (Tasks 12–14)

### - [ ] Task 12: Update the four remaining agent prompts

**12a. `prompts/agents/delegation-scheduling-agent.txt`** — replace:
```
- Technical SEO and CRO Executor
  - Territory: technical SEO fixes, schema/meta/heading updates, site structure/internal links, conversion UX updates.
```
with:
```
- Technical SEO and CRO Executor
  - Territory: technical SEO fixes, schema/meta/heading updates, site structure/internal links, conversion UX updates.
- Website Manager Executor
  - Territory: live website changes on the static site — service section updates, gallery updates, hours, FAQ, contact form, layout/copy fixes, and publishing blog posts to /blog/.
```
and replace:
```
- Exact Action Steps must include: "Format the deliverable with TITLE:/EXCERPT:/TAGS: headers followed by HTML body content for WordPress publishing (see executor prompt for exact format)"
```
with:
```
- Exact Action Steps must include: "Format the deliverable with TITLE:/EXCERPT:/TAGS: headers followed by HTML body content for static-site publishing to /blog/ (see executor prompt for exact format)"
```

**12b. `prompts/agents/content-production-executor.txt`** — replace:
```
**For blog post tasks** (action_type: `website_blog_post` or `wordpress_blog_draft`):
Format the deliverable EXACTLY as follows — the WordPress adapter parses this format to publish the post:
```
with:
```
**For blog post tasks** (action_type: `website_blog_post`):
Format the deliverable EXACTLY as follows — the Website Manager publishes it as a static page under /blog/:
```
and replace:
```
<p>CTA paragraph ending with a link to https://www.grizzlyelectricaltx.com/contact-us/</p>
```
with:
```
<p>CTA paragraph ending with a link to https://www.grizzlyelectricaltx.com/#contact</p>
```
(Match on similar text if the OLD lines differ slightly; the goal is: no WordPress mentions, CTA points at /#contact.)

**12c. `prompts/agents/technical-seo-cro-executor.txt`** — replace:
```
- WordPress draft/update action payloads for approved website repairs
- Contact Form 7 inspection and repair action payloads
```
with:
```
- Website update action payloads for approved static-site repairs (index.html sections)
- Contact form and JSON-LD schema inspection and repair action payloads
```
replace:
```
For WordPress/Contact Form 7 repairs:
- Use known site config and baseline handoffs when available.
```
with:
```
For website repairs (static site):
- Use the website structure reference (knowledge/website-structure.md) when available.
```
and replace the JSON action payload example (the whole ```json fenced block containing `"adapter": "wordpress_browser"`) with:
```json
{
  "action_type": "website_contact_form_update",
  "platform": "website",
  "adapter": "website_manager",
  "target": {
    "site_id": "grizzly",
    "section": "contact"
  },
  "change": {
    "field": "form intro copy",
    "before": "known current value or unknown",
    "after": "proposed value"
  },
  "approval_required": true,
  "verification": [
    "Preview diff in outputs/website_preview/.",
    "Confirm Vercel deploy succeeded after push.",
    "Load the live page and verify the change."
  ]
}
```
Then check the rest of the file for any remaining "WordPress"/"CF7"/"Contact Form 7" mentions and reword them to the static-site equivalents.

**12d. `prompts/agents/website-seo-agent.txt`** — replace the suggested-action-type list:
```
  - `website_technical_change`
  - `website_content_publish`
  - `cf7_sender_domain_repair`
  - `wordpress_page_update`
  - `wordpress_blog_draft`
```
with:
```
  - `website_blog_post`
  - `website_service_page_update`
  - `website_gallery_update`
  - `website_hours_update`
  - `website_faq_update`
  - `website_contact_form_update`
  - `website_copy_update`
  - `website_layout_update`
```
replace the `## WordPress / Website Action Layer` section heading and its stack list:
```
## WordPress / Website Action Layer
When backend access evidence is available, you may recommend website actions that can be executed by the MCC Website Action Agent.

Use the WordPress handoff and contact form success story baselines when relevant. Current known stack:
- WordPress CMS
- Contact Form 7
- CF7 Redirection
- Yoast SEO
- Genesis
- Advanced Custom Fields
```
with:
```
## Website Action Layer
The Grizzly site is a static HTML site (single index.html plus /blog/ pages) in a git repo, deployed by Vercel on push. Website actions are executed by the Website Manager agent through the action queue.

Current known stack:
- Static HTML (index.html sections: top, services, about, gallery, reviews, faq, contact footer)
- Formspree contact form
- Vercel hosting with auto-deploy on git push
- JSON-LD LocalBusiness schema in <head>
```
and replace:
```
- Target URL or WordPress area
```
with:
```
- Target URL or index.html section key
```
Then check the rest of the file for any remaining WordPress mentions and reword to static-site equivalents.

### - [ ] Task 13: Update README

In `README.md`, replace the entire `## Website / WordPress Action Adapter` section (from that heading down to, but not including, the next `##` heading) with:

```markdown
## Website Manager Adapter

The Grizzly website is a static HTML repo (index.html + /blog/ pages) deployed by Vercel on every push to main:

    C:\Workspace\Active\Grizzly Launch\grizzly-website   (github.com/barnscarter-ops/grizzly-website)

Current adapter behavior:

- Website actions are routed to `website_manager` in `outputs/action_queue.json`.
- Dry-runs generate the proposed files under `outputs/website_preview/` and never touch the site repo.
- Live runs require owner approval, then write the files, validate them, commit only those files, and push (Vercel deploys automatically).
- The HTML structure reference lives in `knowledge/website-structure.md`.
- Optional env overrides: `WEBSITE_REPO_DIR`, `WEBSITE_BRANCH`, `WEBSITE_SITE_URL`.

Useful commands:

    $env:PYTHONPATH='src'
    .\.venv\Scripts\python.exe -m seo_agents.main adapter-status
    .\.venv\Scripts\python.exe -m seo_agents.main website "update Saturday hours to 8AM - 4PM"
    .\.venv\Scripts\python.exe -m seo_agents.main website "update Saturday hours to 8AM - 4PM" --live
    .\.venv\Scripts\python.exe -m seo_agents.main blog-post "surge protection for DFW storm season" --publish

Approved live website action flow:

    $env:PYTHONPATH='src'
    .\.venv\Scripts\python.exe -m seo_agents.main approve-action task-t002 --by MCC --note "Approved website update"
    .\.venv\Scripts\python.exe -m seo_agents.main run-action task-t002 --live
```

Then check the rest of README.md for any remaining WordPress mentions and reword or remove them.

### - [ ] Task 14: Delete the WordPress files

```bash
git rm scripts/wordpress-action-adapter.mjs
git rm -r config/wordpress-sites
git rm prompts/agents/wordpress-content-agent.txt
```

**Verify (whole feature):**
```bash
grep -rn -i "wordpress" src/ prompts/ README.md ; echo "exit=$?"
PYTHONPATH=src ./.venv/Scripts/python.exe -m seo_agents.main adapter-status
PYTHONPATH=src ./.venv/Scripts/python.exe -m seo_agents.main actions | head -8
```
Expected: grep finds nothing (`exit=1`); adapter-status shows `website_manager` state `live_ready`; actions prints the queue summary without errors.

**Commit Session 5:**
```bash
git add prompts/agents/delegation-scheduling-agent.txt prompts/agents/content-production-executor.txt prompts/agents/technical-seo-cro-executor.txt prompts/agents/website-seo-agent.txt README.md
git commit -m "chore(website): retire WordPress prompts, config, and adapter"
```
(The `git rm` deletions from Task 14 are already staged and are included in this commit.)

---

## Post-plan notes (for Carter / orchestrator — not the Qwen executor)
- Merge `feat/website-manager` to `main` after Phase B verification.
- MCC dashboard: `action_queue.json` adapters key renamed `wordpress_browser` → `website_manager`; check the SEO Approval page for a hardcoded key.
- Remove `WORDPRESS_*` vars from `.env` if present.
- First live smoke test: `seo-agents website "fix a typo"` (preview) → inspect `outputs/website_preview/index.html` diff vs the live repo before ever running `--live`.
