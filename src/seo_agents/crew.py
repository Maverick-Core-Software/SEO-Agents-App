from __future__ import annotations

import os
from pathlib import Path

from crewai import Agent, Crew, LLM, Process, Task
from crewai_tools import ScrapeWebsiteTool, SerperDevTool
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROMPT_DIR = PROJECT_ROOT / "prompts" / "agents"
BASELINE_DIR = PROJECT_ROOT / "knowledge" / "baselines"
DEFAULT_SITE_URL = "https://www.grizzlyelectricaltx.com/"
DEFAULT_REGION = "DFW, Texas"
DEFAULT_AUDIENCE = "DFW homeowners and light commercial customers"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def read_prompt(name: str) -> str:
    return read_text(PROMPT_DIR / name)


def read_baselines() -> str:
    sections = []
    for path in sorted(BASELINE_DIR.glob("*.md")):
        sections.append(f"## {path.name}\n\n{read_text(path)}")
    return "\n\n---\n\n".join(sections)


def build_llm() -> LLM:
    load_dotenv()
    temperature = float(os.getenv("CREWAI_TEMPERATURE", "0.2"))
    return LLM(
        model=os.getenv("CREWAI_MODEL", "openai/gpt-4o-mini"),
        temperature=temperature,
    )


def build_tools() -> list:
    tools = [ScrapeWebsiteTool()]
    if os.getenv("SERPER_API_KEY"):
        tools.insert(0, SerperDevTool())
    return tools


def is_verbose() -> bool:
    return os.getenv("CREWAI_VERBOSE", "false").lower() in {"1", "true", "yes", "on"}


def agent_backstory(prompt_file: str) -> str:
    return (
        f"{read_prompt(prompt_file)}\n\n"
        "Use the baseline knowledge supplied in each task. Do not invent missing facts. "
        "Separate confirmed evidence, recommendations, drafts, and owner approval items."
    )


def build_grizzly_crew(
    topic: str,
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
) -> Crew:
    llm = build_llm()
    tools = build_tools()
    baselines = read_baselines()
    target_site = site_url or DEFAULT_SITE_URL
    target_audience = audience or DEFAULT_AUDIENCE
    target_region = region or DEFAULT_REGION
    seed_keywords = keywords or "Use the baseline priority services and infer only safe, relevant terms."

    shared_context = (
        f"Current request/focus: {topic}\n"
        f"Target site: {target_site}\n"
        f"Target audience: {target_audience}\n"
        f"Target region: {target_region}\n"
        f"Seed keywords: {seed_keywords}\n\n"
        "Baseline knowledge from imported Grizzly reports:\n\n"
        f"{baselines}"
    )

    content_agent = Agent(
        role="Grizzly Content and Keyword Agent",
        goal="Create practical local SEO keyword plans and draft-ready content for Grizzly Electrical Solutions.",
        backstory=agent_backstory("content-keyword-agent.txt"),
        tools=tools,
        llm=llm,
        verbose=is_verbose(),
    )

    website_agent = Agent(
        role="Grizzly Website SEO Agent",
        goal="Audit website SEO, service-page structure, technical issues, and conversion problems.",
        backstory=agent_backstory("website-seo-agent.txt"),
        tools=tools,
        llm=llm,
        verbose=is_verbose(),
    )

    gbp_agent = Agent(
        role="Grizzly GBP and Local Rankings Agent",
        goal="Audit Google Business Profile visibility, local ranking factors, and strategic profile optimization opportunities.",
        backstory=agent_backstory("gbp-local-rankings-agent.txt"),
        tools=tools,
        llm=llm,
        verbose=is_verbose(),
    )

    reputation_agent = Agent(
        role="Grizzly Reviews and Reputation Agent",
        goal="Assess review health, reputation risks, and review request or response opportunities.",
        backstory=agent_backstory("reviews-reputation-agent.txt"),
        tools=tools,
        llm=llm,
        verbose=is_verbose(),
    )

    manager_agent = Agent(
        role="Grizzly Local Presence Agent-Manager",
        goal="Coordinate specialist findings into a focused local presence implementation plan.",
        backstory=agent_backstory("local-presence-manager-agent.txt"),
        llm=llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    scheduling_agent = Agent(
        role="Grizzly Delegation and Scheduling Agent",
        goal="Convert manager recommendations into a practical execution queue with ownership, timing, and verification criteria.",
        backstory=agent_backstory("delegation-scheduling-agent.txt"),
        llm=llm,
        verbose=is_verbose(),
        allow_delegation=False,
    )

    content_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Create an updated Content / Keyword Plan for the current focus. Preserve the Grizzly tone, "
            "avoid DIY electrical troubleshooting steps, and include draft-ready content only where useful."
        ),
        expected_output=(
            "A Content / Keyword Plan with keyword opportunities, blog topics, GBP/social drafts, "
            "website copy suggestions, priority ranking, ready-to-publish drafts, and owner approval needs."
        ),
        agent=content_agent,
        output_file=str(Path("outputs") / "content_report.md"),
        markdown=True,
    )

    website_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Review website SEO for the current focus using the baseline report and live/public page evidence "
            "available through tools. Do not claim access to Search Console, CMS, forms, or rankings unless proven."
        ),
        expected_output=(
            "A Website SEO Report with homepage notes, service-page findings, technical issues, conversion issues, "
            "recommended actions, draft copy, and owner approval needs."
        ),
        agent=website_agent,
        output_file=str(Path("outputs") / "website_report.md"),
        markdown=True,
    )

    gbp_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Prepare a GBP / Local Rankings Report for the current focus. Use the imported baseline and any "
            "available public evidence. Clearly label missing owner-access items."
        ),
        expected_output=(
            "A GBP / Local Rankings Report with status summary, ranking notes, GBP issues, competitor notes, "
            "recommended actions, and owner approval needs."
        ),
        agent=gbp_agent,
        output_file=str(Path("outputs") / "gbp_report.md"),
        markdown=True,
    )

    reputation_task = Task(
        description=(
            f"{shared_context}\n\n"
            "Prepare a Reviews / Reputation Report for the current focus using the imported baseline and any "
            "provided evidence. Do not invent reviews, ratings, customers, or platform data."
        ),
        expected_output=(
            "A Reviews / Reputation Report with review summary, needed responses, request opportunities, "
            "reputation risks, recommended actions, reusable drafts, and owner approval needs."
        ),
        agent=reputation_agent,
        output_file=str(Path("outputs") / "reputation_report.md"),
        markdown=True,
    )

    manager_task = Task(
        description=(
            "Synthesize the four specialist reports into one implementation-ready local presence plan for Grizzly. "
            "Prioritize residential lead-generating services first, especially troubleshooting, recessed lighting, "
            "panel replacement, service upgrades, EV chargers, generator work, and remodel electrical. "
            "Keep recommendations practical, evidence-based, and separated from draft copy."
        ),
        expected_output=(
            "A markdown Local Presence Manager Plan with executive summary, highest-priority actions, delegated "
            "agent follow-ups, draft assets ready for owner review, missing evidence checklist, and owner approvals."
        ),
        agent=manager_agent,
        context=[content_task, website_task, gbp_task, reputation_task],
        output_file=str(Path("outputs") / "grizzly_local_presence_plan.md"),
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
            "A markdown execution queue containing discrete task blocks with task ID, title, assigned execution agent, "
            "priority, due window, action steps, dependencies, definition of done, and verification checklist."
        ),
        agent=scheduling_agent,
        context=[manager_task],
        output_file=str(Path("outputs") / "grizzly_execution_queue.md"),
        markdown=True,
    )

    return Crew(
        name="Grizzly Local Presence Crew",
        agents=[content_agent, website_agent, gbp_agent, reputation_agent, manager_agent, scheduling_agent],
        tasks=[content_task, website_task, gbp_task, reputation_task, manager_task, scheduling_task],
        process=Process.sequential,
        verbose=is_verbose(),
    )


def build_seo_crew(
    topic: str,
    site_url: str = "",
    audience: str = "",
    region: str = "",
    keywords: str = "",
) -> Crew:
    return build_grizzly_crew(
        topic=topic,
        site_url=site_url,
        audience=audience,
        region=region,
        keywords=keywords,
    )
