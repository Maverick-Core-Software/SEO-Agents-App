from __future__ import annotations

import argparse
from pathlib import Path
import sys

from dotenv import load_dotenv

from seo_agents.crew import DEFAULT_AUDIENCE, DEFAULT_REGION, DEFAULT_SITE_URL, build_seo_crew


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Grizzly CrewAI local SEO agent crew.")
    parser.add_argument("topic", help="Grizzly SEO focus, service page, report type, or campaign topic.")
    parser.add_argument("--site-url", default="", help=f"Website URL to inspect. Default: {DEFAULT_SITE_URL}")
    parser.add_argument("--audience", default="", help=f"Target audience. Default: {DEFAULT_AUDIENCE}")
    parser.add_argument("--region", default="", help=f"Target search region. Default: {DEFAULT_REGION}")
    parser.add_argument("--keywords", default="", help="Comma-separated seed keywords.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build the crew and show the configuration without calling the LLM.",
    )
    return parser.parse_args()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    load_dotenv()
    args = parse_args()
    Path("outputs").mkdir(exist_ok=True)

    crew = build_seo_crew(
        topic=args.topic,
        site_url=args.site_url,
        audience=args.audience,
        region=args.region,
        keywords=args.keywords,
    )

    if args.dry_run:
        print(f"Ready: {crew.name}")
        print(f"Agents: {len(crew.agents)}")
        print(f"Tasks: {len(crew.tasks)}")
        for agent in crew.agents:
            print(f"- {agent.role}")
        return

    try:
        result = crew.kickoff()
        print(result)
    except Exception as e:
        print(f"\n❌ Crew execution failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
