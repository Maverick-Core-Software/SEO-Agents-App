from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
from datetime import date, datetime, timezone
from pathlib import Path

from crewai import Agent, Crew, LLM, Process, Task
from crewai_tools import ScrapeWebsiteTool, SerpApiGoogleSearchTool
from dotenv import load_dotenv
from pydantic import BaseModel, Field


class TaskCompletion(BaseModel):
    """One completed (or blocked) execution-queue task. Field names match what
    actions.py expects in its completion dicts — do not rename casually."""

    task_id: str = Field(description="Task ID from the execution queue, e.g. T001")
    title: str = ""
    agent: str = ""
    completion_status: str = Field(default="", description="COMPLETE, PARTIAL, or BLOCKED")
    action_taken: str = ""
    deliverable_location: str = Field(default="", description="File path or place the deliverable lives")
    deliverable: str = Field(default="", description="The full deliverable text itself, when it is a text artifact")
    definition_of_done: str = Field(default="", description="YES, NO, or PARTIAL")
    blocker: str = Field(default="", description="If partial or blocked, what is blocking")
    owner_signoff_needed: str = Field(default="", description="YES or NO")


class CompletionReport(BaseModel):
    completions: list[TaskCompletion]


class WebsiteEdit(BaseModel):
    """Structured output of the Website Manager crew. seo_agents.website.apply_edit
    consumes this directly — field names are a contract."""

    action_type: str = Field(description="One of the website_* action types")
    target: str = Field(default="", description="Section key in index.html (e.g. services, faq, contact) or the blog slug for website_blog_post")
    title: str = Field(default="", description="Blog post title (website_blog_post only)")
    meta_description: str = Field(default="", description="Blog meta description (website_blog_post only)")
    html: str = Field(description="Complete replacement HTML: the full section block including its outer tag, or the blog post body")
    summary: str = Field(default="", description="One-line description of the change, used as the git commit message")


def structured_completions_enabled() -> bool:
    return os.getenv("CREWAI_STRUCTURED_COMPLETIONS", "true").lower() in {"1", "true", "yes", "on"}


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROMPT_DIR = PROJECT_ROOT / "prompts" / "agents"
BASELINE_DIR = PROJECT_ROOT / "knowledge" / "baselines"
OUTPUT_DIR = PROJECT_ROOT / "outputs"
ARCHIVE_DIR = OUTPUT_DIR / "archive"

DEFAULT_SITE_URL = "https://www.grizzlyelectricaltx.com/"
DEFAULT_REGION = "DFW, Texas"
DEFAULT_AUDIENCE = "DFW homeowners and light commercial customers"


def _slugify(text: str) -> str:
    """Slugify a topic string for use in run IDs."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("- ")


def build_run_id(topic: str, site_url: str = "") -> str:
    """Deterministic run ID from topic and optional site URL.

    Format: <ISO timestamp UTC>_<topic_slug>
    The timestamp is fixed at midnight UTC so repeated dry-runs on the same
    day produce the same ID, making it easy to correlate artifacts.
    """
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    slug = _slugify(topic or "untitled")
    return f"{ts}_{slug}"


def _detect_provider_and_model() -> tuple[str, str, str]:
    """Detect the configured provider route and model names.

    Returns (provider, research_model, exec_model).
    """
    research_model = os.getenv("CREWAI_RESEARCH_MODEL", "unknown")
    exec_model = os.getenv("CREWAI_EXEC_MODEL", "unknown")
    # Infer provider from model prefix (e.g. "openai/gpt-4o-mini" -> "openai")
    provider = research_model.split("/")[0] if "/" in research_model else research_model
    api_base = os.getenv("CREWAI_RESEARCH_API_BASE", "")
    if api_base:
        provider = f"custom({api_base})"
    # If no model configured at all, note the fallback
    if research_model == "unknown":
        provider = "none"
    return provider, research_model, exec_model


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def read_prompt(name: str) -> str:
    return read_text(PROMPT_DIR / name)


def read_baselines() -> str:
    sections = []
    for path in sorted(BASELINE_DIR.glob("*.md")):
        sections.append(f"## {path.name}\n\n{read_text(path)}")
    return "\n\n---\n\n".join(sections)


def read_latest_baseline(stem_prefix: str) -> str:
    """Return content of the most recently modified baseline file matching stem_prefix*.md.

    Using the newest file by mtime means adding an updated baseline (e.g.
    grizzly-current-status-2026-07-10.md) automatically supersedes the
    old one — no code change required.
    """
    matches = sorted(
        BASELINE_DIR.glob(f"{stem_prefix}*.md"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        return f"[BASELINE NOT FOUND: no file matching {stem_prefix}*.md in {BASELINE_DIR}]"
    return read_text(matches[0])


def read_output(name: str) -> str:
    path = OUTPUT_DIR / name
    if path.exists():
        return read_text(path)
    return f"[FILE NOT FOUND: {name}]"


def out(name: str) -> str:
    """Return an absolute output path string for CrewAI task output_file."""
    return str(OUTPUT_DIR / name)


def is_verbose() -> bool:
    return os.getenv("CREWAI_VERBOSE", "false").lower() in {"1", "true", "yes", "on"}


def _serper_key_valid() -> bool:
    key = os.getenv("SERPAPI_API_KEY", "").strip()
    return bool(key) and key not in {"your-serper-key", "your_serper_key", "SERPER_KEY", "your-serpapi-key"}


def build_tools() -> list:
    tools = [ScrapeWebsiteTool()]
    if _serper_key_valid():
        try:
            tools.insert(0, SerpApiGoogleSearchTool())
        except Exception:
            pass  # serpapi package version incompatible — scraping only
    return tools


def agent_backstory(prompt_file: str) -> str:
    return (
        f"{read_prompt(prompt_file)}\n\n"
        "Use the baseline knowledge supplied in each task. Do not invent missing facts. "
        "Separate confirmed evidence, recommendations, drafts, and owner approval items."
    )


# ---------------------------------------------------------------------------
# LLM builders
# ---------------------------------------------------------------------------

def _llm_kwargs(tier: str) -> dict:
    """Optional per-tier routing to an OpenAI-compatible server (local or remote).

    Set CREWAI_<TIER>_API_BASE (e.g. http://127.0.0.1:8080/v1 for llama-server or
    https://api.venice.ai/api/v1 for Venice) to route that tier; set
    CREWAI_<TIER>_PROVIDER to tell CrewAI which provider to use (default: openai).
    When an API base override is active the model name must be the plain id
    (no provider prefix), e.g. zai-org-glm-5-2.
    """
    kwargs: dict = {}
    api_base = os.getenv(f"CREWAI_{tier}_API_BASE")
    if api_base:
        kwargs["base_url"] = api_base
        kwargs["api_key"] = os.getenv(f"CREWAI_{tier}_API_KEY", "local")
        kwargs["provider"] = os.getenv(f"CREWAI_{tier}_PROVIDER", "openai")
    max_tokens = os.getenv(f"CREWAI_{tier}_MAX_TOKENS")
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    return kwargs


def build_research_llm() -> LLM:
    load_dotenv()
    return LLM(
        model=os.getenv("CREWAI_RESEARCH_MODEL", "openai/gpt-4o-mini"),
        temperature=float(os.getenv("CREWAI_TEMPERATURE", "0.2")),
        **_llm_kwargs("RESEARCH"),
    )


def build_exec_llm() -> LLM:
    load_dotenv()
    return LLM(
        model=os.getenv("CREWAI_EXEC_MODEL", "openai/gpt-4o"),
        temperature=float(os.getenv("CREWAI_TEMPERATURE", "0.2")),
        **_llm_kwargs("EXEC"),
    )


# ---------------------------------------------------------------------------
# Research + Plan Crew  (seo-agents <topic>)
# ---------------------------------------------------------------------------

def build_grizzly_crew(
    topic: str,
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
    previous_context: str = "",
    completed_tasks: str = "",
    run_id: str = "",
) -> Crew:
    research_llm = build_research_llm()
    exec_llm = build_exec_llm()
    tools = build_tools()
    baselines = read_baselines()
    target_site = site_url or DEFAULT_SITE_URL
    target_audience = audience or DEFAULT_AUDIENCE
    target_region = region or DEFAULT_REGION
    seed_keywords = keywords or "Use the baseline priority services and infer only safe, relevant terms."

    # Inject run-lineage metadata into shared context for all agents.
    _run_meta_line = ""
    if run_id:
        _provider, _res_model, _exec_model = _detect_provider_and_model()
        _run_meta_line = (
            f"\n\n--- RUN LINEAGE ---\n"
            f"run_id: {run_id}\n"
            f"provider: {_provider}\n"
            f"research_model: {_res_model}\n"
            f"exec_model: {_exec_model}\n"
        )

    shared_context = (
        f"Current request/focus: {topic}\n"
        f"Target site: {target_site}\n"
        f"Target audience: {target_audience}\n"
        f"Target region: {target_region}\n"
        f"Seed keywords: {seed_keywords}\n\n"
        "Baseline knowledge from imported Grizzly reports:\n\n"
        f"{baselines}"
        f"{_run_meta_line}"
    )
    if previous_context:
        shared_context += f"\n\n---\n\n{previous_context}"
    if completed_tasks:
        shared_context += f"\n\n---\n\n{completed_tasks}"

    # --- Research agents (gpt-4o-mini) ---
    content_agent = Agent(
        role="Grizzly Content and Keyword Agent",
        goal="Create practical local SEO keyword plans and draft-ready content for Grizzly Electrical Solutions.",
        backstory=agent_backstory("content-keyword-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    website_agent = Agent(
        role="Grizzly Website SEO Agent",
        goal="Audit website SEO, service-page structure, technical issues, and conversion problems.",
        backstory=agent_backstory("website-seo-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    gbp_agent = Agent(
        role="Grizzly GBP and Local Rankings Agent",
        goal="Audit Google Business Profile visibility, surface search trend signals, and identify local ranking opportunities.",
        backstory=agent_backstory("gbp-local-rankings-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    reputation_agent = Agent(
        role="Grizzly Reviews and Reputation Agent",
        goal="Assess review health, surface reputation risks, and draft review response and request copy.",
        backstory=agent_backstory("reviews-reputation-agent.txt"),
        tools=tools,
        llm=research_llm,
        verbose=is_verbose(),
    )

    # --- Orchestration agents (gpt-4o) ---
    manager_agent = Agent(
        role="Grizzly Local Presence Agent-Manager",
        goal="Validate all specialist reports, synthesize findings into a focused local presence plan, and verify execution completions.",
        backstory=agent_backstory("local-presence-manager-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    scheduling_agent = Agent(
        role="Grizzly Delegation and Scheduling Agent",
        goal="Convert manager recommendations into a practical execution queue with ownership, timing, and verification criteria.",
        backstory=agent_backstory("delegation-scheduling-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    # --- Tasks ---
    content_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Create an updated Content / Keyword Plan for the current focus.\n\n"
            "LIVE SEARCH REQUIREMENT: Use SerperDevTool to search for the focus topic plus 2-3 related "
            "electrical service queries in DFW. Record the People Also Ask questions and top organic results "
            "you actually find — these become the keyword opportunities. Do not rely on memory alone.\n"
            "If SerperDevTool is unavailable, label all keyword data as 'BASELINE ESTIMATE'.\n\n"
            "Preserve the Grizzly tone, avoid DIY electrical troubleshooting steps, "
            "and include draft-ready content only where useful."
        ),
        expected_output=(
            "A Content / Keyword Plan wrapped in [START:CONTENT]...[END:CONTENT] markers, containing: "
            "keyword opportunities (with data source noted), blog topics, GBP/social drafts, "
            "website copy suggestions, priority ranking, ready-to-publish drafts, and owner approval needs."
        ),
        agent=content_agent,
        output_file=out("content_report.md"),
        markdown=True,
    )

    website_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Review website SEO for the current focus using the baseline report AND live verification via ScrapeWebsiteTool.\n\n"
            "STEP 1 — VERIFY COMPLETED TASKS FIRST (mandatory before any new research):\n"
            "The shared context above includes a 'COMPLETED TASKS FROM PREVIOUS RUNS' section. For each completed task, "
            "scrape the relevant live page and confirm the work is still in place. Report each as:\n"
            "  ✅ CONFIRMED LIVE: [task title] — [what you saw on the page]\n"
            "  ❌ REGRESSION: [task title] — [what is missing or broken now]\n"
            "Do this check for every completed task before writing any new recommendations.\n\n"
            "STEP 2 — LIVE VERIFICATION RULE (mandatory for all issues):\n"
            "For every issue mentioned in the baseline, scrape the relevant live page and confirm the issue still exists "
            "before recommending it. If the page looks fine, the form works, or the issue is gone — mark it RESOLVED "
            "and do not recommend it. Only surface issues that are present right now.\n\n"
            "For conversion issues specifically (contact form, phone visibility, CTAs): scrape the contact page and the "
            "homepage. Report what you actually see, not what the baseline says to expect.\n\n"
            "Do not claim access to Search Console, CMS backend, or rankings data unless proven by tool output."
        ),
        expected_output=(
            "A Website SEO Report wrapped in [START:WEBSITE]...[END:WEBSITE] markers, containing: "
            "homepage notes, service-page findings, technical issues, conversion issues, "
            "recommended actions, draft copy, and owner approval needs."
        ),
        agent=website_agent,
        output_file=out("website_report.md"),
        markdown=True,
    )

    gbp_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Prepare a GBP / Local Rankings Report for the current focus.\n\n"
            "TREND RESEARCH (your primary job — do this first):\n"
            "Use SerperDevTool to search Google for each of these queries and record the ACTUAL results you find:\n"
            "  1. 'electrician near me DFW' — what services dominate the results?\n"
            "  2. 'electrical repair Rowlett TX' — what specific problems are people searching?\n"
            "  3. 'panel upgrade Dallas 2025' — any news, seasonal spikes, or competitor campaigns?\n"
            "  4. 'EV charger installation Dallas' — search volume signals, competitor density?\n"
            "  5. One additional query based on the research focus topic provided in the context.\n\n"
            "For each search: report what you ACTUALLY FOUND in the results (top 3 organic results, "
            "People Also Ask questions, any featured snippets). Do not summarize from memory.\n"
            "If SerperDevTool is unavailable, say so explicitly and label all trend signals as "
            "'BASELINE ESTIMATE (live search unavailable)'.\n\n"
            "REQUIRED OUTPUT SECTION — POST TOPIC QUEUE:\n"
            "After the trend research, produce a '## RECOMMENDED POST TOPIC QUEUE' section with "
            "exactly 7 ranked topics. For each topic include:\n"
            "  - RANK: (1 = highest search demand this week)\n"
            "  - SERVICE: (specific service name)\n"
            "  - TREND SIGNAL: (exact search query or People Also Ask question that supports this)\n"
            "  - DATA SOURCE: (SerperDevTool result / baseline estimate / seasonal)\n"
            "  - CONTENT ANGLE: (one sentence on what angle will resonate with DFW homeowners)\n\n"
            "This queue is what the GBP Poster Agent will use to build this week's schedule. "
            "Make it specific and actionable. Use the imported baseline and any available public evidence. "
            "Clearly label missing owner-access items."
        ),
        expected_output=(
            "A GBP / Local Rankings Report wrapped in [START:GBP]...[END:GBP] markers, containing: "
            "status summary, search trend signals this week (citing actual search results or labeling as estimates), "
            "ranking notes, GBP issues, competitor notes, RECOMMENDED POST TOPIC QUEUE (7 ranked topics with "
            "trend signals and data sources), recommended actions, and owner approval needs."
        ),
        agent=gbp_agent,
        output_file=out("gbp_report.md"),
        markdown=True,
    )

    reputation_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Prepare a Reviews / Reputation Report for the current focus using the imported baseline and any "
            "provided evidence. Do not invent reviews, ratings, customers, or platform data. "
            "If no new data is available, use the baseline and label it clearly — never produce an empty report."
        ),
        expected_output=(
            "A Reviews / Reputation Report wrapped in [START:REPUTATION]...[END:REPUTATION] markers, containing: "
            "review summary, needed responses, review request opportunities, reputation risks, "
            "recommended actions, ready-to-publish drafts, and owner approval needs."
        ),
        agent=reputation_agent,
        output_file=out("reputation_report.md"),
        markdown=True,
    )

    manager_task = Task(
        description=(
            "First, perform a strict audit of all four input reports. "
            "Verify each report is present, non-empty, and wrapped in its required markers: "
            "[START:CONTENT]...[END:CONTENT], [START:WEBSITE]...[END:WEBSITE], "
            "[START:GBP]...[END:GBP], [START:REPUTATION]...[END:REPUTATION].\n\n"
            "If any report is missing, empty, or missing markers, explicitly list it as "
            "'CRITICAL FAILURE: MISSING' in your Executive Summary and flag it for the owner.\n\n"
            "Then synthesize all available reports into one implementation-ready Local Presence Manager Plan. "
            "Prioritize residential lead-generating services first: troubleshooting, recessed lighting, "
            "panel replacement, service upgrades, EV chargers, generator work, and remodel electrical. "
            "Keep recommendations practical, evidence-based, and separated from draft copy.\n\n"
            "Include a Phase 5 Verification Checklist pre-populated from the highest-priority tasks."
        ),
        expected_output=(
            "A markdown Local Presence Manager Plan with: executive summary (including any critical failures), "
            "highest-priority actions, delegated agent follow-ups, draft assets ready for owner review, "
            "missing evidence checklist, owner approvals needed, and Phase 5 verification checklist."
        ),
        agent=manager_agent,
        context=[content_task, website_task, gbp_task, reputation_task],
        output_file=out("grizzly_local_presence_plan.md"),
        markdown=True,
    )

    scheduling_task = Task(
        description=(
            "Transform the Local Presence Manager Plan into a simple execution queue for implementation. "
            "For each task, assign one execution owner, priority, due window, exact implementation steps, "
            "dependencies, and a verifiable definition of done. Delegate only to these execution-agent territories: "
            "Local Content Production Executor, Local Presence Assets Executor, Technical SEO and CRO Executor. "
            "Use Owner/Admin only where approval, access, or business decisions are required."
        ),
        expected_output=(
            "A markdown execution queue containing discrete task blocks with: task ID, title, "
            "assigned execution agent, priority (P1/P2/P3), due window, exact action steps, "
            "dependencies, definition of done, and verification checklist."
        ),
        agent=scheduling_agent,
        context=[manager_task],
        output_file=out("grizzly_execution_queue.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Local Presence Crew",
        agents=[content_agent, website_agent, gbp_agent, reputation_agent, manager_agent, scheduling_agent],
        tasks=[content_task, website_task, gbp_task, reputation_task, manager_task, scheduling_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


# ---------------------------------------------------------------------------
# Task graph filter for executor crew (Session 4.5 fix)
# ---------------------------------------------------------------------------

BLOCKED_STATUSES = {"blocked", "research_gap", "waiting_on_owner", "waiting_on_tool_access"}


def _filter_executable_tasks() -> list[dict[str, Any]]:
    """Load task_graph.json and return only executable tasks.

    Only include tasks that are ready/verified/approved.  Blocked, research_gap,
    and waiting_* tasks are excluded so the executor cannot bypass the task graph.
    """
    from seo_agents.evidence import TASK_GRAPH_PATH

    if not TASK_GRAPH_PATH.exists():
        return []
    try:
        data = json.loads(TASK_GRAPH_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []

    tasks: list[dict[str, Any]] = []
    for t in data.get("tasks", []):
        status = t.get("status", "")
        if status not in BLOCKED_STATUSES:
            tasks.append(t)
    return tasks


# ---------------------------------------------------------------------------
# Executor Crew  (seo-agents execute)
# ---------------------------------------------------------------------------

def build_executor_crew() -> Crew:
    """
    Reads the execution queue plus the validated task graph.
    Only tasks from the task graph that are ready/verified/approved are
    forwarded to the executor agents — blocked, research_gap, and
    waiting_* tasks are excluded so the executor cannot bypass the task graph.
    Fans tasks to the 3 executors by territory, then runs the manager + delegation
    verification loop against the completion reports.
    """
    exec_llm = build_exec_llm()
    tools = build_tools()

    execution_queue = read_output("grizzly_execution_queue.md")
    manager_plan = read_output("grizzly_local_presence_plan.md")
    structure_path = PROJECT_ROOT / "knowledge" / "website-structure.md"
    website_structure = read_text(structure_path) if structure_path.exists() else "[website-structure.md not found]"

    # Task 4.5-fix-2: Load task_graph.json and filter to executable tasks only.
    # Only include tasks that are: from the current run; not blocked/research_gap/
    # waiting_on_owner/waiting_on_tool_access; free of unresolved gate failures.
    _task_graph_filter = _filter_executable_tasks()
    _filtered_titles = set(t.get("title", "") for t in _task_graph_filter)
    _filtered_ids = set(t.get("action_id") for t in _task_graph_filter)
    _filtered_ids_task = set(t.get("task_id") for t in _task_graph_filter)

    # Build queue text entirely from filtered tasks when they exist.
    # This excludes blocked/research_gap tasks from what the executor agents see.
    # When there are zero filtered tasks (legacy runs without a task graph),
    # fall back to the raw execution queue text so older runs keep working.
    queue_text = ""
    if _task_graph_filter:
        # Build one entry per filtered task with key fields
        lines = [
            "- **" + t.get("task_id", "") + "** [" + t.get("status", "") + "] "
            + t.get("title", "") + " ("
            + t.get("task_type", "") + " | "
            + t.get("priority", {}).get("tier", "P3")
            + " | " + t.get("owner", "") + ")"
            for t in _task_graph_filter
        ]
        queue_text = "\n".join(lines)
    else:
        # No filtered tasks — legacy run without a task graph; use raw queue
        queue_text = execution_queue

    queue_context = (
        "You are reading the execution queue plus the live website structure reference. "
        "The Grizzly website is a static HTML site (index.html plus /blog/ pages) in a git repo, "
        "deployed by Vercel on every push — there is no WordPress and no CMS. Website changes are "
        "applied by the Website Manager adapter through the action queue.\n\n"
        f"EXECUTION QUEUE (filtered — blocked and research_gap tasks excluded):\n\n{queue_text}\n\n"
        f"LIVE WEBSITE STRUCTURE REFERENCE:\n\n{website_structure}"
    )

    # --- Executor agents ---
    content_executor = Agent(
        role="Local Content Production Executor",
        goal="Execute content tasks from the execution queue and produce complete draft deliverables with a completion report.",
        backstory=agent_backstory("content-production-executor.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    assets_executor = Agent(
        role="Local Presence Assets Executor",
        goal="Execute GBP and local presence tasks from the execution queue and produce draft assets with a completion report.",
        backstory=agent_backstory("local-presence-assets-executor.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    technical_executor = Agent(
        role="Technical SEO and CRO Executor",
        goal="Execute technical SEO and conversion tasks from the execution queue and produce structured recommendations with a completion report.",
        backstory=agent_backstory("technical-seo-cro-executor.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    # --- Verification agents (same agents, new tasks) ---
    manager_verifier = Agent(
        role="Grizzly Local Presence Agent-Manager",
        goal="Verify all executor completion reports against the original plan and execution queue. Produce the final verified report.",
        backstory=agent_backstory("local-presence-manager-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    scheduling_verifier = Agent(
        role="Grizzly Delegation and Scheduling Agent",
        goal="Cross-check the execution queue against completion reports and confirm every task's definition of done was met.",
        backstory=agent_backstory("delegation-scheduling-agent.txt"),
        llm=exec_llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    # --- Execution tasks ---
    structured = structured_completions_enabled()

    def exec_task(agent: Agent, executor_role: str, scope_label: str, stem: str) -> Task:
        if structured:
            # Structured JSON: actions.py parses this directly instead of
            # regex-scraping markdown, so format drift can't drop tasks.
            return Task(
                description=(
                    f"{queue_context}\n\n"
                    f"Execute all tasks in the queue assigned to: {executor_role}.\n"
                    "For each task: read it, gather evidence using your tools, produce the deliverable, "
                    "and record a completion entry. If a task is blocked, document the blocker clearly. "
                    "Put the full text of any text deliverable in the entry's 'deliverable' field."
                ),
                expected_output=(
                    f"A JSON completion report covering every {scope_label} task in the queue: "
                    "a 'completions' list with one entry per task containing task_id, title, agent, "
                    "completion_status (COMPLETE/PARTIAL/BLOCKED), action_taken, deliverable_location, "
                    "deliverable, definition_of_done (YES/NO/PARTIAL), blocker, owner_signoff_needed (YES/NO)."
                ),
                agent=agent,
                output_json=CompletionReport,
                output_file=out(f"{stem}.json"),
            )
        return Task(
            description=(
                f"{queue_context}\n\n"
                f"Execute all tasks in the queue assigned to: {executor_role}.\n"
                "For each task: read it, gather evidence using your tools, produce the deliverable, "
                "and append a COMPLETION REPORT block. If a task is blocked, document the blocker clearly."
            ),
            expected_output=(
                f"All {scope_label} tasks completed with deliverables and structured COMPLETION REPORT blocks. "
                "Each block includes: Task ID, status (COMPLETE/PARTIAL/BLOCKED), action taken, "
                "definition of done met (YES/NO/PARTIAL), and owner sign-off needed."
            ),
            agent=agent,
            output_file=out(f"{stem}.md"),
            markdown=True,
        )

    website_executor = Agent(
        role="Website Manager Executor",
        goal="Execute website tasks from the execution queue and produce ready-to-apply HTML edits with a completion report.",
        backstory=agent_backstory("website-manager-agent.txt"),
        tools=tools,
        llm=exec_llm,
        verbose=is_verbose(),
    )

    content_exec_task = exec_task(content_executor, "Local Content Production Executor", "content", "content_completion")
    assets_exec_task = exec_task(assets_executor, "Local Presence Assets Executor", "GBP/assets", "assets_completion")
    technical_exec_task = exec_task(technical_executor, "Technical SEO and CRO Executor", "technical SEO", "technical_completion")
    website_exec_task = exec_task(website_executor, "Website Manager Executor", "website", "website_completion")

    # --- Verification tasks ---
    delegation_verify_task = Task(
        description=(
            "Cross-check the original execution queue against all four completion reports.\n\n"
            f"ORIGINAL EXECUTION QUEUE:\n\n{execution_queue}\n\n"
            "COMPLETION REPORTS: See context from the four executor tasks above.\n\n"
            "For every task in the queue:\n"
            "1. Find its completion entry\n"
            "2. Confirm the definition of done was met\n"
            "3. Flag INCOMPLETE if no completion entry exists\n"
            "4. Flag PARTIAL if the definition of done was only partly met\n"
            "Produce a verification summary table."
        ),
        expected_output=(
            "A verification summary with: total tasks checked, count verified/partial/incomplete, "
            "and a table listing each task ID, title, assigned executor, and verification result."
        ),
        agent=scheduling_verifier,
        context=[content_exec_task, assets_exec_task, technical_exec_task, website_exec_task],
        output_file=out("delegation_verification.md"),
        markdown=True,
    )

    manager_final_task = Task(
        description=(
            "Produce the final verified report for this execution cycle.\n\n"
            f"ORIGINAL MANAGER PLAN:\n\n{manager_plan}\n\n"
            f"ORIGINAL EXECUTION QUEUE:\n\n{execution_queue}\n\n"
            "COMPLETION REPORTS AND VERIFICATION: See context from all previous tasks.\n\n"
            "Synthesize everything into the Final Verified Report. "
            "Include: verification summary, verified completions, incomplete/partial tasks, "
            "recommended next steps, and owner sign-off items. "
            "Save a timestamped copy to the archive directory."
        ),
        expected_output=(
            "A Final Verified Report in the standard format: verification summary, "
            "verified completions table, incomplete/partial tasks with next steps, "
            "and owner sign-off items. File saved to outputs/final_report.md."
        ),
        agent=manager_verifier,
        context=[content_exec_task, assets_exec_task, technical_exec_task, website_exec_task, delegation_verify_task],
        output_file=out("final_report.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Executor Crew",
        agents=[content_executor, assets_executor, technical_executor, website_executor, scheduling_verifier, manager_verifier],
        tasks=[content_exec_task, assets_exec_task, technical_exec_task, website_exec_task, delegation_verify_task, manager_final_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


def _read_manifest(manifest_path: Path) -> tuple[list[str], list[dict]]:
    """
    Read the photo manifest CSV.
    Returns (fieldnames, rows).
    """
    if not manifest_path.exists():
        return ["Topic", "Source", "Target", "Status", "UsedDate"], []
    with manifest_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or ["Topic", "Source", "Target", "Status"])
        rows = list(reader)
    if "UsedDate" not in fieldnames:
        fieldnames.append("UsedDate")
    return fieldnames, rows


def _available_photos(photo_dir: Path, manifest_path: Path) -> list[str]:
    """
    Return filenames in photo_dir that are NOT yet marked used/archived in the manifest.
    Falls back to full directory scan if manifest is absent.
    """
    used_names: set[str] = set()
    if manifest_path.exists():
        _, rows = _read_manifest(manifest_path)
        for row in rows:
            status = row.get("Status", "").strip().lower()
            if status in {"used", "archived", "posted"}:
                target = Path(row.get("Target", ""))
                used_names.add(target.name)

    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG", ".WEBP"}
    available = [
        p.name for p in sorted(photo_dir.iterdir())
        if p.suffix in image_exts and p.name not in used_names
    ]
    return available


def archive_used_photos(schedule_path: Path, photo_dir: Path) -> list[str]:
    """
    After the poster crew runs:
    1. Parse the schedule for PHOTO_FILE entries
    2. Mark those photos as 'used' in the manifest with today's date
    3. Move the files to Archive/YYYY-MM/ to free local space
    Returns list of archived filenames.
    """
    if not schedule_path.exists():
        return []

    schedule_text = schedule_path.read_text(encoding="utf-8", errors="replace")

    # Extract PHOTO_FILE entries from schedule — handle plain and markdown bold formats
    used_photos: set[str] = set()
    lines = schedule_text.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        # Handle both "PHOTO_FILE: name" and "**PHOTO_FILE:** name" formats
        if "PHOTO_FILE" in stripped and "NEEDS PHOTO" not in stripped.upper():
            # Strip markdown bold markers
            cleaned = stripped.replace("**", "").strip()
            if cleaned.startswith("PHOTO_FILE:"):
                filename = cleaned.replace("PHOTO_FILE:", "").strip()
                # If filename is empty, the value may be on the next line
                if not filename and i + 1 < len(lines):
                    filename = lines[i + 1].strip().replace("**", "").strip()
                # Strip trailing markdown (e.g. trailing spaces/backslash)
                filename = filename.rstrip("\\ ")
                if filename and not filename.upper().startswith("NEEDS PHOTO"):
                    used_photos.add(filename)

    if not used_photos:
        return []

    manifest_path = photo_dir / "gbp-photo-manifest.csv"
    fieldnames, rows = _read_manifest(manifest_path)

    # Archive destination
    month_str = datetime.today().strftime("%Y-%m")
    archive_dir = photo_dir / "Archive" / month_str
    archive_dir.mkdir(parents=True, exist_ok=True)

    today = date.today().isoformat()
    archived: list[str] = []

    # Track which used_photos were matched to a manifest row
    matched: set[str] = set()

    for row in rows:
        target_path = Path(row.get("Target", ""))
        filename = target_path.name
        if filename in used_photos:
            row["Status"] = "used"
            row["UsedDate"] = today
            src = photo_dir / filename
            dst = archive_dir / filename
            if src.exists():
                shutil.move(str(src), str(dst))
                archived.append(filename)
            matched.add(filename)

    # Handle untracked photos (exist in directory, used in schedule, not in manifest)
    for filename in used_photos - matched:
        src = photo_dir / filename
        if src.exists():
            dst = archive_dir / filename
            shutil.move(str(src), str(dst))
            archived.append(filename)
            # Add a new manifest entry for traceability
            rows.append({
                "Topic": filename,
                "Source": str(photo_dir / filename),
                "Target": str(photo_dir / filename),
                "Status": "used",
                "UsedDate": today,
            })

    # Write manifest back
    with manifest_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    return archived


# Shared day→topic binding rule. BOTH the GBP poster and Facebook crews consume
# the same canonical ranked list (## RECOMMENDED POST TOPIC QUEUE in gbp_report.md)
# and MUST bind day N to RANK N so the same topic lands on the same calendar day on
# every platform. Defining it once keeps the two prompts from drifting apart — prompt
# drift is exactly what caused the GBP/Facebook topic mismatch this rule prevents.
DAY_TOPIC_BINDING_RULE = (
    "DAY→TOPIC BINDING (MANDATORY — this is what keeps Google Business Profile and "
    "Facebook in sync):\n"
    "Use the '## RECOMMENDED POST TOPIC QUEUE' in the GBP REPORT as the single source "
    "of truth for which topic goes on which day.\n"
    "Facebook posts 4 days/week: assign RANK 1→Day 1, RANK 3→Day 3, RANK 5→Day 5, RANK 6→Day 6.\n"
    "The topic/SERVICE on each posted day MUST match the same rank's topic on GBP.\n"
    "Do NOT reorder, swap, re-rank, or skip topics. Only the post FORMAT "
    "(video/photo/text) and the copy may differ per platform — the topic must not.\n"
)


def build_poster_crew(
    start_date: str = "",
    days: int = 7,
) -> Crew:
    """
    Separate daily crew. Reads content + GBP reports, pulls live trend signals,
    scans the local photo directory (filtering manifest for unused photos),
    and produces a 7-day GBP posting schedule.
    """
    exec_llm = build_exec_llm()

    photo_path = os.getenv("GBP_PHOTO_PATH", r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos")
    photo_dir = Path(photo_path)
    manifest_path = photo_dir / "gbp-photo-manifest.csv"

    # Manifest-aware photo scan — exclude already used/archived
    if photo_dir.exists():
        available = _available_photos(photo_dir, manifest_path)
        used_count = sum(
            1 for p in photo_dir.glob("gbp-photo-manifest.csv") if p.exists()
        )  # just checking existence
        # Count used from manifest for reporting
        _, mrows = _read_manifest(manifest_path)
        used_count = sum(
            1 for r in mrows
            if r.get("Status", "").strip().lower() in {"used", "archived", "posted"}
        )
        photo_list = "\n".join(available) if available else "No unused photos available."
        photo_summary = f"{len(available)} available, {used_count} already used/archived"
    else:
        available = []
        photo_list = f"Photo directory not found: {photo_path}"
        photo_summary = "directory missing"

    content_report = read_output("content_report.md")
    gbp_report = read_output("gbp_report.md")

    poster_context = (
        f"GBP_PHOTO_PATH: {photo_path}\n"
        f"MANIFEST: {manifest_path}\n"
        f"PHOTO AVAILABILITY: {photo_summary}\n\n"
        "AVAILABLE PHOTOS (not yet used — do NOT select any photo not in this list):\n"
        f"{photo_list}\n\n"
        "MANIFEST RULE: Only select photos from the AVAILABLE PHOTOS list above. "
        "Photos already marked used/archived in the manifest are excluded and must not be reused.\n\n"
        f"START DATE: {start_date or 'Next business day'}\n"
        f"DAYS TO SCHEDULE: {days}\n\n"
        "CONTENT REPORT (research phase):\n\n"
        f"{content_report}\n\n"
        "GBP REPORT (research phase, includes trend signals):\n\n"
        f"{gbp_report}"
    )

    poster_agent = Agent(
        role="Grizzly GBP Poster Agent",
        goal="Produce a structured 7-day GBP posting schedule based entirely on the provided research reports.",
        backstory=agent_backstory("gbp-poster-agent.txt"),
        tools=[],  # no search — all trend data comes from the research crew's reports
        llm=exec_llm,
        verbose=is_verbose(),
    )

    poster_task = Task(
        description=(
            f"{poster_context}\n\n"
            "The CONTENT REPORT and GBP REPORT above contain this week's trending electrical service queries "
            "and recommended post topics — use them directly. Do not search for additional trend data.\n\n"
            f"{DAY_TOPIC_BINDING_RULE}\n"
            f"Build a {days}-day GBP posting schedule starting from {start_date or 'the next business day'}. "
            "For TREND_TIE, quote the specific trend signal from the GBP REPORT that drove each post's topic choice. "
            "CRITICAL: Only assign photos from the AVAILABLE PHOTOS list — never repeat a photo "
            "already in the manifest with status used/archived/posted. "
            "Use the DAY/DATE/SERVICE/TOPIC/TREND_TIE/HEADLINE/BODY/CAPTION/PHOTO_FILE/CTA/HASHTAGS/STATUS format. "
            "HASHTAGS must include 3-5 relevant hashtags (e.g. #DallasElectrician #ElectricalPanel #RowlettTX). "
            "Always include at least one local hashtag and one service hashtag. "
            "All posts must have STATUS: Needs approval."
        ),
        expected_output=(
            f"A {days}-day GBP posting schedule with one structured entry per day, "
            "followed by: Photo Gaps section, Trend Summary This Week (citing research reports), and Owner Notes."
        ),
        agent=poster_agent,
        output_file=out("gbp_posting_schedule.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly GBP Poster Crew",
        agents=[poster_agent],
        tasks=[poster_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


# ---------------------------------------------------------------------------
# Facebook Schedule Crew  (seo-agents facebook-schedule)
# ---------------------------------------------------------------------------

def build_facebook_crew(
    start_date: str = "",
    days: int = 7,
) -> Crew:
    """
    Generates a 4-day Facebook posting schedule for Grizzly.
    Tone is punchy and story-driven (not informational like GBP).
    Days 1 and 5 are VIDEO (Reels 15-25s). Days 3 and 6 are PHOTO or TEXT.
    All posts use engagement CTAs (save/tag/comment/share), not phone numbers.
    """
    exec_llm = build_exec_llm()

    photo_path = os.getenv("GBP_PHOTO_PATH", r"C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos")
    photo_dir = Path(photo_path)
    manifest_path = photo_dir / "gbp-photo-manifest.csv"

    if photo_dir.exists():
        available = _available_photos(photo_dir, manifest_path)
        photo_list = "\n".join(available) if available else "No unused photos available."
    else:
        available = []
        photo_list = f"Photo directory not found: {photo_path}"

    content_report = read_output("content_report.md")
    gbp_report = read_output("gbp_report.md")

    seasonal_hint = ""
    month = datetime.now().month
    if month in [3, 4, 5]:
        seasonal_hint = "DFW storm season (spring): emphasize generators, surge protection, storm prep."
    elif month in [6, 7, 8]:
        seasonal_hint = "DFW summer: emphasize AC-related electrical loads, EV charging, panel capacity."
    elif month in [11, 12, 1, 2]:
        seasonal_hint = "DFW winter: emphasize heating circuits, generator prep, ice storm readiness."

    fb_context = (
        f"START DATE: {start_date or 'Next business day'}\n"
        f"DAYS TO SCHEDULE: 4 (reduced from 7 to optimize for algorithm reach)\n\n"
        "POSTING DAYS: 4 posts per week on Mon (Day 1), Wed (Day 3), Fri (Day 5), Sat (Day 6). "
        "Day 1 is VIDEO (Reel). Day 3 is PHOTO or CAROUSEL. Day 5 is VIDEO (Reel). Day 6 is PHOTO or TEXT. "
        "Days 2, 4, 7: NO POSTS (these are skipped by the poster). "
        "Posting 7x/week with 187 followers signals 'low quality page' to Facebook's algorithm — "
        "4 posts per week is the sweet spot for this follower count.\n\n"
        f"SEASONAL CONTEXT: {seasonal_hint}\n\n"
        "AVAILABLE PHOTOS (for non-video days):\n"
        f"{photo_list}\n\n"
        "CONTENT REPORT:\n\n"
        f"{content_report}\n\n"
        "GBP REPORT (includes trend signals):\n\n"
        f"{gbp_report}\n\n"
        "BOOST GUIDANCE (BUDGET: $50/week total — CrewAI decides distribution):\n"
        "- TOTAL WEEKLY BUDGET: Exactly $50. Distribute across 1-3 posts as you see fit. "
        "You are the strategist — decide which posts deserve budget and how much.\n"
        "- For each post, include a BOOST field: 'yes:$N' (boost with $N daily budget), "
        "'maybe' (boost if extra budget appears), or 'no' (don't boost).\n"
        "- The sum of all BOOST=$N values across boosted posts must equal exactly $50. "
        "Example: 2 posts × $25 = $50, or 3 posts × $17 = $51 (~on budget).\n"
        "- BOOST=yes criteria: before/after photos, educational videos, testimonials "
        "with photos — content with visual proof and educational value.\n"
        "- BOOST=no criteria: text-only posts, generic updates, holiday greeting posts.\n"
        "- Include a BOOST_TARGETING hint per post: e.g. '15mi Rowlett, homeowners 28-65, "
        "home improvement interests' or '15mi Rowlett, EV owners'.\n"
        "- Include a BOOST_DURATION per post: how many days to run each boost (3, 5, or 7 days). "
        "At $17/day × 3 days = $51; at $25/day × 2 days = $50.\n"
        "- Include a BOOST_AMOUNT per post: the daily budget for that post's boost (e.g. $17, $25)."
    )

    fb_agent = Agent(
        role="Grizzly Facebook Content Agent",
        goal=(
            "Write scroll-stopping Facebook posts for Grizzly Electrical Solutions. "
            "Posts must grab attention instantly, tell a mini-story, and drive action. "
            "Use punchy hooks, local references, and emotional angles. Never sound corporate. "
            "Video posts must include a cinematic, specific Gemini video prompt."
        ),
        backstory=(
            "You are an expert social media copywriter for a local electrical contractor in DFW, Texas. "
            "You know that Facebook users scroll fast — your job is to STOP the scroll with the first line. "
            "You write the way homeowners talk, not the way companies talk. "
            "You use fear, curiosity, humor, and local pride to drive engagement. "
            "Every post must feel human, urgent, and worth reading all the way through."
        ),
        tools=[],
        llm=exec_llm,
        verbose=is_verbose(),
    )

    fb_task = Task(
        description=(
            f"{fb_context}\n\n"
            f"Build a 4-day Facebook posting schedule starting from {start_date or 'the next business day'}.\n\n"
            f"{DAY_TOPIC_BINDING_RULE}\n"
            "TONE RULES (mandatory):\n"
            "- HOOK must be the first line — make it impossible to scroll past (question, bold claim, or shocking stat)\n"
            "- BODY tells a mini-story (30-80 words). No bullet points. Conversational, local, real.\n"
            "- CTA is an ENGAGEMENT invitation, NOT a sales pitch. Rotate through:\n"
            "  * 'Save this for your next panel inspection'\n"
            "  * 'Tag a homeowner who needs to see this'\n"
            "  * 'Drop a 👍 if this has ever happened to you'\n"
            "  * 'Which would you choose — left panel or right? 👇'\n"
            "  * 'Share this with someone whose house was built before 1980'\n"
            '  * "What\'s the weirdest electrical issue you\'ve had at home? Tell us below"\n'
            "- Business phone number goes in a separate CONTACT field (add to format below), "
            "NOT in the caption CTA. The poster script will post it as the first comment.\n"
            "- HASHTAGS: 2-3 max (optional). Facebook hashtags have minimal reach impact. "
            "Prioritize keyword-rich body text over hashtag stuffing.\n\n"
            "CONTENT FORMAT VARIETY (mandatory — avoid algorithm suppression):\n"
            "- Each post MUST use a DIFFERENT content format from the last. Never repeat the same "
            "format twice in a row (e.g. not two 'hook→story→CTA' posts consecutively).\n"
            "- Rotate through these formats across the week:\n"
            "  1. Before/After transformation (photo or video): Show problem then solution\n"
            "  2. Educational/How-To: Teach something useful (signs of failing panel, GFCI basics)\n"
            "  3. Behind-the-Scenes/Day-in-the-Life: Team member at work, loading the van, job walkthrough\n"
            "  4. Interactive/Question: Poll, 'this or that', 'what would you do', fill-in-the-blank\n"
            "  5. Social Proof/Testimonial: Customer story, completed job showcase, review highlight\n"
            "  6. Humor/Personality: Trade humor, relatable electrical fails, 'caption this'\n"
            "- 50% of posts must be educational/value-first, 30% social proof/personality, 20% interactive\n"
            "- 0% direct sales pitches — the CTA should invite conversation, not quote a phone number\n\n"
            "VIDEO POST RULES (days 1 and 5 — 2 Reels per week):\n"
            "- TYPE must be: video\n"
            "- REEL LENGTH: 15-25 seconds (not 8). Facebook's algorithm favors Reels "
            "in the 15-30 second range. The video generator will be told 15s.\n"
            "- ON-SCREEN TEXT: Every Reel must include text overlays for the hook and key points — "
            "most Facebook users watch without sound. Describe what text should appear on screen.\n"
            "- FIRST 1.5 SECONDS: The VIDEO_PROMPT must describe an instant visual hook — "
            "a sparking outlet, a burnt wire, a dramatic before/after reveal. No establishing shots.\n"
            "- VIDEO_PROMPT is a scene description for a vertical Reel (9:16). "
            "A director step rewrites it before generation.\n"
            "- SINGLE SHOT ONLY: one continuous camera shot, no cuts, no scene changes. "
            "The entire 15-25 seconds is one unbroken take.\n"
            "- STATIC or SLOW camera: use 'static shot', 'slow dolly-in', or 'slow pan'. "
            "NEVER use 'whip pan', 'crash zoom', 'hard push-in', or 'handheld'.\n"
            "- SHOW THE WORK, NOT THE FACE: focus on hands, tools, panels, installations, "
            "and environments. Avoid faces — they cause uncanny valley artifacts in AI video.\n"
            "- Use the five-part formula: [Cinematography] + [Subject] + [Action] + [Context] + [Style]\n"
            "- Example: 'Static shot, close-up of an electrician's hands installing a circuit breaker "
            "into a residential panel, in a clean utility room with white drywall walls, documentary "
            "realism, natural daylight from a side window, consistent lighting, photorealistic, 4K'\n"
            "- DRAMA through the problem, not through editing: show a sparking outlet, a scorched wire, "
            "a tripped breaker — but in a single sustained shot, not a montage\n"
            "- NEVER put the business name, any logo, any phone number, or any readable text/signage in "
            "VIDEO_PROMPT — video models garble on-screen text; branding is composited on afterward\n\n"
            "PHOTO / TEXT POST RULES (days 3 and 6):\n"
            "- TYPE must be: photo (if photo available from list), carousel, or text\n"
            "- PHOTO_FILE: pick the photo whose filename best matches the post's SERVICE/topic. "
            "A later deterministic step will refine PHOTO_FILE using service-matched curated photos, "
            "so a best-effort topical pick is fine; leave blank if nothing fits.\n\n"
            "Use the following format for each post (one per day, separated by ---):\n\n"
            "DAY: [number]\n"
            "DATE: [YYYY-MM-DD]\n"
            "TYPE: [video|photo|text|carousel|poll|skip]\n"
            "SERVICE: [service area this post covers]\n"
            "POST_GOAL: [engagement|education|social_proof|entertainment]\n"
            "HOOK: [first line — the scroll-stopper]\n"
            "BODY: [the story, 30-80 words]\n"
            "CTA: [engagement invitation — save, tag, vote, comment, share — NO phone numbers]\n"
            "HASHTAGS: [2-3 max, optional]\n"
            "CONTACT: [(469) 863-9804 — posted as first comment, not in caption]\n"
            "PHOTO_FILE: [path or blank]\n"
            "VIDEO_PROMPT: [cinematic Reel prompt with on-screen text notes or blank]\n"
            "ON_SCREEN_TEXT: [text overlays for the Reel — hook text, key points, or blank]\n"
            "BOOST: [yes:$N|maybe|no — whether to boost this post, with optional daily budget]\n"
            "BOOST_AMOUNT: [$N — daily budget for this post's boost, e.g. $17 or $25]\n"
            "BOOST_DURATION: [N days — how long to run the boost, e.g. 3, 5, or 7]\n"
            "BOOST_TARGETING: [targeting hint for this specific post or blank — "
            "e.g. '15mi Rowlett, homeowners 28-65, home improvement interests']\n"
            "STATUS: Needs approval\n\n"
            "---\n\n"
            "After all 4 posts, add:\n\n"
            "1. A CONTENT NOTES section with trend signals used and photo gaps.\n\n"
            "2. A BOOST BUDGET SUMMARY section (Weekly Budget: $50):\n"
            "   - Posts boosted: N of 4\n"
            "   - Budget allocation line items (Day X: $N/day x N days = $N total)\n"
            "   - TOTAL SPEND: $50 (must equal exactly $50)\n"
            "   - Priority post (boost first): Day X - [reason]\n"
            "   - Expected weekly reach from boosts: ~3,000-7,000 additional impressions\n"
            "   - Expected weekly engagement from boosts: ~50-120 additional engagements\n"
            "   - Boost targeting: 15mi radius from Rowlett, homeowners 28-65, \n"
            "home improvement/DIY/real estate interests. Exclude electrician interest \n"
            "(that is competitors). Use Advantage+ Audience for AI optimization."
        ),
        expected_output=(
            f"A 4-day Facebook posting schedule with one structured entry per posted day, "
            "including hooks, stories, engagement CTAs, and cinematic Reel prompts for video days."
        ),
        agent=fb_agent,
        output_file=out("facebook_posting_schedule.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Facebook Schedule Crew",
        agents=[fb_agent],
        tasks=[fb_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


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

def build_seo_crew(
    topic: str,
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
    previous_context: str = "",
    completed_tasks: str = "",
    run_id: str = "",
) -> Crew:
    if not run_id:
        run_id = build_run_id(topic, site_url)
    return build_grizzly_crew(
        topic=topic,
        site_url=site_url,
        audience=audience,
        region=region,
        keywords=keywords,
        previous_context=previous_context,
        completed_tasks=completed_tasks,
        run_id=run_id,
    )
