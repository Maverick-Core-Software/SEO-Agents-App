#!/usr/bin/env python3
"""Weekly SEO runner for Grizzly Electrical Solutions.

Queries Google Trends for the most-searched electrical service topic in Texas
this week, then kicks off the full SEO research + scheduling pipeline.
Run by Windows Task Scheduler every Friday at 8:30 AM.
"""

import os
import subprocess
import sys
from datetime import date
from pathlib import Path

# Load .env before anything else so OPENAI_API_KEY etc. are available to the crew
PROJECT_ROOT = Path(__file__).parent.parent
env_file = PROJECT_ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())

SEO_AGENTS_EXE = Path(sys.executable).parent / "Scripts" / "seo-agents.exe"

# Candidate service topics — pytrends compares these and picks the hottest this week.
# Keep phrases short (1–3 words); geo is scoped to Texas below.
CANDIDATE_KEYWORDS = [
    "panel upgrade",
    "EV charger installation",
    "generator installation",
    "electrical troubleshooting",
    "recessed lighting",
    "electrical repair",
    "home rewiring",
    "circuit breaker",
    "electrical inspection",
    "outlet installation",
]

# Maps a short keyword back to a full research topic for the crew
TOPIC_MAP = {
    "panel upgrade":              "electrical panel upgrade Dallas DFW",
    "EV charger installation":    "home EV charger installation Rowlett DFW",
    "generator installation":     "home generator installation Dallas DFW",
    "electrical troubleshooting": "electrical troubleshooting services Rowlett DFW",
    "recessed lighting":          "recessed lighting installation Dallas DFW",
    "electrical repair":          "residential electrical repair DFW",
    "home rewiring":              "home rewiring services Dallas DFW",
    "circuit breaker":            "circuit breaker repair and replacement DFW",
    "electrical inspection":      "home electrical inspection Dallas DFW",
    "outlet installation":        "outlet and GFCI installation Rowlett DFW",
}


def pick_trending_topic() -> str:
    try:
        from pytrends.request import TrendReq
        pytrends = TrendReq(hl="en-US", tz=360)  # CST (UTC-6)
        scores: dict[str, float] = {}

        # pytrends only accepts 5 keywords per payload — batch them
        batches = [CANDIDATE_KEYWORDS[i:i+5] for i in range(0, len(CANDIDATE_KEYWORDS), 5)]
        for batch in batches:
            try:
                pytrends.build_payload(batch, timeframe="now 7-d", geo="US-TX")
                df = pytrends.interest_over_time()
                if df.empty:
                    continue
                for kw in batch:
                    if kw in df.columns:
                        scores[kw] = float(df[kw].mean())
            except Exception as batch_err:
                print(f"[auto-topic] batch error: {batch_err}")

        if scores:
            best = max(scores, key=scores.get)
            ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            print(f"[auto-topic] Trend scores (Texas, last 7d): {ranked}")
            print(f"[auto-topic] Winner: '{best}' ({scores[best]:.1f})")
            return TOPIC_MAP.get(best, f"{best} Dallas DFW")

    except Exception as e:
        print(f"[auto-topic] pytrends unavailable: {e}")

    # Fallback: rotate through topics by ISO week number so each week is different
    week = date.today().isocalendar()[1]
    fallback_kw = CANDIDATE_KEYWORDS[week % len(CANDIDATE_KEYWORDS)]
    fallback_topic = TOPIC_MAP.get(fallback_kw, f"{fallback_kw} Dallas DFW")
    print(f"[auto-topic] Fallback (week {week}): '{fallback_topic}'")
    return fallback_topic


def main() -> None:
    print(f"[run-weekly-seo] Starting — {date.today().isoformat()} (Friday run)")
    topic = pick_trending_topic()
    print(f"[run-weekly-seo] Launching research: \"{topic}\"")

    if not SEO_AGENTS_EXE.exists():
        print(f"[run-weekly-seo] ERROR: seo-agents not found at {SEO_AGENTS_EXE}")
        sys.exit(1)

    result = subprocess.run(
        [str(SEO_AGENTS_EXE), "research", topic],
        cwd=str(PROJECT_ROOT),
    )
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
