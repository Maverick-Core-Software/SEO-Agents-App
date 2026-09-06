#!/usr/bin/env python3
"""Weekly SEO runner for Grizzly Electrical Solutions.

Queries Google Trends for the most-searched electrical service topic in Texas
this week, then kicks off the full SEO research + scheduling pipeline.
Run by Windows Task Scheduler every Friday at 8:30 AM.
"""

import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

# Load .env before anything else so DEEPSEEK_API_KEY, ANTHROPIC_API_KEY etc. are available to the crew
PROJECT_ROOT = Path(__file__).parent.parent
env_file = PROJECT_ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ[key.strip()] = val.strip()  # force override (system env may have wrong key)

OUTPUTS_DIR = PROJECT_ROOT / "outputs"
# Start/finish marker the SEO monitor keys off to detect a "no-show" run.
# Written the moment this wrapper starts, so a run that never fires is detectable
# even before any Supabase row exists.
RUNNER_HEALTH_FILE = OUTPUTS_DIR / "weekly-runner-health.json"
RUNNER_LOG_FILE = OUTPUTS_DIR / f"weekly-runner-{date.today().isoformat()}.log"
# The crew's own stdout/stderr. Without this the child wrote to a console that Task
# Scheduler throws away, so a crash left no reason anywhere — that is how the 7/24
# run died on an LLM 402 with nothing recorded but "crew exit 1".
CREW_LOG_FILE = OUTPUTS_DIR / f"weekly-crew-{date.today().isoformat()}.log"
# Hard ceiling on one crew attempt. A healthy run is ~40 min; the Task Scheduler
# limit is 16 h, and until 2026-09-05 the child had no timeout at all, so a hung
# crew sat at "started" until the watchdog's 90-minute rule happened to look.
CREW_TIMEOUT_S = int(os.environ.get("SEO_CREW_TIMEOUT_MIN", "150")) * 60
RUN_LOCK_FILE = OUTPUTS_DIR / "lock.lock.json"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log_line(msg: str) -> None:
    """Print to console (captured by Task Scheduler) and append to the day log."""
    print(msg, flush=True)
    try:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        with RUNNER_LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(msg.rstrip("\n") + "\n")
    except Exception:
        pass


def write_runner_health(status: str, topic: str = "", returncode=None, error: str = "") -> None:
    """Record the wrapper's own status so the monitor can alarm on a no-show.

    status: 'started' | 'success' | 'failed'
    """
    try:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "status": status,
            "at": _now_iso(),
            "date": date.today().isoformat(),
            "topic": topic or None,
            "returncode": returncode,
            "error": error or None,
            "log_file": str(RUNNER_LOG_FILE),
            "crew_log_file": str(CREW_LOG_FILE),
        }
        RUNNER_HEALTH_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[run-weekly-seo] WARNING: could not write runner health: {e}", flush=True)


def tail_crew_log(lines: int = 40) -> list:
    """Last N non-blank lines of the crew log, for the failure report."""
    try:
        text = CREW_LOG_FILE.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    return [ln.rstrip() for ln in text.splitlines() if ln.strip()][-lines:]


def _venv_python() -> Path:
    """The interpreter that has the crew installed: the venv first, else this one."""
    for cand in (
        PROJECT_ROOT / ".venv" / "Scripts" / "python.exe",  # Windows venv
        PROJECT_ROOT / ".venv" / "bin" / "python",           # POSIX venv
    ):
        if cand.exists():
            return cand
    return Path(sys.executable)


def resolve_seo_agents_cmd() -> list:
    """Launch the crew as ``python -m seo_agents.main`` with the venv interpreter.

    Deliberately not the ``seo-agents.exe`` console script. That .exe is a
    launcher that spawns a second python.exe, so a timeout kill from here would
    orphan the real crew process, and its interpreter could differ from the one
    preflight() just verified. One interpreter for preflight and launch makes a
    passing preflight evidence about the actual run.
    """
    return [str(_venv_python()), "-m", "seo_agents.main"]

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


TOPIC_HISTORY_FILE = PROJECT_ROOT / "state" / "topic-history.json"
TOPIC_HISTORY_WINDOW = 4  # avoid repeating a topic used in the last 4 weeks


def load_topic_history() -> list:
    try:
        data = json.loads(TOPIC_HISTORY_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_topic_history(history: list, topic: str) -> None:
    history.append(topic)
    history = history[-(TOPIC_HISTORY_WINDOW * 2):]
    TOPIC_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOPIC_HISTORY_FILE.write_text(json.dumps(history, indent=2), encoding="utf-8")


def pick_trending_topic() -> str:
    """Choose this week's topic. Does NOT record it: main() appends to the
    history only after the crew exits 0, so failed attempts no longer consume
    a rotation slot (2026-09-04's seven launches pushed the same topic twice)."""
    history = load_topic_history()
    recent_topics = set(history[-TOPIC_HISTORY_WINDOW:])

    # Filter candidates to avoid recently used topics
    fresh_keywords = [kw for kw in CANDIDATE_KEYWORDS if TOPIC_MAP.get(kw, kw) not in recent_topics]
    if not fresh_keywords:
        fresh_keywords = CANDIDATE_KEYWORDS
        print("[auto-topic] All topics used recently — resetting history")

    try:
        from pytrends.request import TrendReq
        pytrends = TrendReq(hl="en-US", tz=360)  # CST (UTC-6)
        scores: dict = {}

        # pytrends only accepts 5 keywords per payload — batch them
        batches = [fresh_keywords[i:i+5] for i in range(0, len(fresh_keywords), 5)]
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
            topic = TOPIC_MAP.get(best, f"{best} Dallas DFW")
            return topic

    except Exception as e:
        print(f"[auto-topic] pytrends unavailable: {e}")

    # Fallback: rotate through fresh topics by ISO week number
    week = date.today().isocalendar()[1]
    fallback_kw = fresh_keywords[week % len(fresh_keywords)]
    fallback_topic = TOPIC_MAP.get(fallback_kw, f"{fallback_kw} Dallas DFW")
    print(f"[auto-topic] Fallback (week {week}, {len(fresh_keywords)} fresh topics): '{fallback_topic}'")
    return fallback_topic


def preflight() -> list[str]:
    """Fail closed before the crew if the Friday host cannot import or ping.

    Returns a list of fatal errors. Empty list = ok to launch.
    """
    errors: list[str] = []
    py = _venv_python()
    src_pkg = str(PROJECT_ROOT / "src" / "seo_agents").replace("\\", "/")
    # Same interpreter and same env (no PYTHONPATH; editable install) as the
    # launch below, so this exercises what Friday will actually run:
    #   1. byte-compile the package   — a half-edited crew.py raised SyntaxError
    #      mid-morning on 2026-09-04;
    #   2. parse the real CLI shape   — a root `topic` positional silently
    #      blanked the research topic for three months;
    #   3. construct both LLM tiers   — the missing anthropic SDK died here.
    # None of this touches the network, Supabase, or an LLM.
    probe = "\n".join([
        "import compileall, sys",
        f"assert compileall.compile_dir(r'{src_pkg}', quiet=1), 'syntax error in seo_agents (see above)'",
        "import pydantic_core",
        "from seo_agents.main import parse_args",
        "sys.argv = ['seo-agents', 'research', 'preflight probe topic', '--dry-run']",
        "a = parse_args()",
        "assert a.command == 'research' and a.topic == 'preflight probe topic', f'CLI dropped the topic: {vars(a)}'",
        "from seo_agents.crew import build_research_llm, build_exec_llm",
        "build_research_llm(); build_exec_llm()",
        "print('preflight ok')",
    ])
    try:
        r = subprocess.run(
            [str(py), "-c", probe],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=180,
            env={**os.environ, "PYTHONPATH": "", "PYTHONUNBUFFERED": "1"},
        )
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or f"exit {r.returncode}").strip().splitlines()
            errors.append("crew preflight failed: " + " | ".join(tail[-4:])[:600])
        else:
            log_line("[run-weekly-seo] preflight ok: compile, CLI parse, LLM construction")
    except subprocess.TimeoutExpired:
        errors.append("crew preflight timed out after 180s")
    except Exception as e:
        errors.append(f"crew preflight could not run: {e}")

    if not (os.environ.get("SUPABASE_URL") or "").strip() or not (
        os.environ.get("SUPABASE_SERVICE_KEY") or ""
    ).strip():
        errors.append("SUPABASE_URL / SUPABASE_SERVICE_KEY missing")

    hermes = Path(
        os.environ.get("HERMES_CLI")
        or r"C:\Users\carte\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
    )
    smtp = (os.environ.get("SMTP_APP_PASSWORD") or "").strip()
    if not hermes.exists() and not smtp:
        errors.append(
            f"both alert channels dead: hermes missing ({hermes}) and SMTP_APP_PASSWORD empty"
        )

    gbp_dir = os.environ.get("GBP_BROWSER_SESSION_DIR", "").strip()
    if gbp_dir and not Path(gbp_dir).exists():
        log_line(f"[run-weekly-seo] WARNING: GBP_BROWSER_SESSION_DIR does not exist: {gbp_dir}")

    return errors


def run_shadow_pipeline() -> None:
    """Run the rebuilt pipeline (scripts/weekly) in shadow mode after a successful
    legacy run, when SEO_PIPELINE=shadow. Shadow mode writes only to the new
    Supabase tables and outputs/shadow/; it never touches weekly_posts,
    website_tasks, or the legacy outputs, so a failure here is logged and
    reported but never changes this wrapper's exit code or health status.
    See docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md."""
    mode = (os.environ.get("SEO_PIPELINE") or "legacy").strip().lower()
    if mode != "shadow":
        return
    runner = PROJECT_ROOT / "scripts" / "weekly" / "run.mjs"
    if not runner.exists():
        log_line(f"[run-weekly-seo] SEO_PIPELINE=shadow but {runner} is missing; skipping shadow run")
        return
    cmd = ["node", str(runner), "--mode", "shadow"]
    week_spec = OUTPUTS_DIR / "week_spec.json"
    try:
        week_of = json.loads(week_spec.read_text(encoding="utf-8")).get("week_of")
        if week_of:
            cmd += ["--week-of", week_of]
    except Exception:
        pass  # run.mjs computes the same WeekSpec itself
    shadow_log = OUTPUTS_DIR / f"weekly-shadow-{date.today().isoformat()}.log"
    log_line(f"[run-weekly-seo] Shadow pipeline -> {shadow_log}")
    try:
        with shadow_log.open("a", encoding="utf-8") as fh:
            fh.write(f"\n=== {_now_iso()} launching: {cmd}\n")
            fh.flush()
            r = subprocess.run(cmd, cwd=str(PROJECT_ROOT), env=os.environ.copy(),
                               stdout=fh, stderr=subprocess.STDOUT, timeout=30 * 60)
        status = "success" if r.returncode == 0 else f"failed (exit {r.returncode})"
    except subprocess.TimeoutExpired:
        status = "failed (timeout 30 min)"
    except Exception as e:  # never let the shadow run break the legacy result
        status = f"failed ({e})"
    log_line(f"[run-weekly-seo] Shadow pipeline {status}")
    try:
        payload = json.loads(RUNNER_HEALTH_FILE.read_text(encoding="utf-8"))
        payload["shadow"] = {"status": status, "at": _now_iso(), "log_file": str(shadow_log)}
        RUNNER_HEALTH_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass


def main() -> None:
    # Mark "started" immediately so the monitor can tell a real run from a no-show,
    # even if topic selection or the crew launch fails below.
    write_runner_health("started")
    log_line(f"[run-weekly-seo] Starting — {date.today().isoformat()} (Friday run)")

    fatal = preflight()
    if fatal:
        msg = "; ".join(fatal)
        log_line(f"[run-weekly-seo] PREFLIGHT FAILED: {msg}")
        write_runner_health("failed", error=f"preflight: {msg}")
        sys.exit(1)

    try:
        topic = pick_trending_topic()
    except Exception as e:
        log_line(f"[run-weekly-seo] ERROR: topic selection failed: {e}")
        write_runner_health("failed", error=f"topic selection: {e}")
        sys.exit(1)

    log_line(f"[run-weekly-seo] Launching research: \"{topic}\"")
    cmd = resolve_seo_agents_cmd() + ["research", topic]
    log_line(f"[run-weekly-seo] Command: {cmd}")

    # Pass our env (which now includes the parsed .env) explicitly, and make sure the
    # package is importable when we fall back to `-m seo_agents.main`.
    child_env = os.environ.copy()
    # Clear PYTHONPATH to prevent module pollution from system env.
    # The package is installed editable (pip install -e .) so no path needed.
    child_env["PYTHONPATH"] = ""
    # Redirecting stdout to a file makes Python block-buffer it while stderr stays
    # unbuffered, so the whole run's output lands *after* the traceback and the tail
    # below shows progress chatter instead of the error. Force line ordering.
    child_env["PYTHONUNBUFFERED"] = "1"

    # Stream the crew's output to disk rather than capture=True — a research run takes
    # ~20 minutes and buffering all of it in memory to inspect only on failure is waste.
    log_line(f"[run-weekly-seo] Crew output -> {CREW_LOG_FILE}")
    try:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        with CREW_LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"\n=== {_now_iso()} launching: {cmd}\n")
            fh.flush()
            result = subprocess.run(cmd, cwd=str(PROJECT_ROOT), env=child_env,
                                    stdout=fh, stderr=subprocess.STDOUT,
                                    timeout=CREW_TIMEOUT_S)
    except FileNotFoundError as e:
        log_line(f"[run-weekly-seo] ERROR: could not launch crew ({e}). "
                 f"Check that the .venv exists and `pip install -e .` has been run.")
        write_runner_health("failed", topic=topic, error=str(e))
        sys.exit(1)
    except subprocess.TimeoutExpired:
        # subprocess.run has already killed the child. Because the child is
        # python.exe itself (not the .exe launcher) the kill reached the crew,
        # so the run lock it held is stale by construction; clear it so the
        # next attempt is not refused with "Another run is active".
        msg = f"crew timed out after {CREW_TIMEOUT_S // 60} min and was killed (SEO_CREW_TIMEOUT_MIN)"
        log_line(f"[run-weekly-seo] ERROR: {msg}")
        try:
            if RUN_LOCK_FILE.exists():
                RUN_LOCK_FILE.unlink()
                log_line(f"[run-weekly-seo] cleared stale run lock {RUN_LOCK_FILE}")
        except OSError as e:
            log_line(f"[run-weekly-seo] WARNING: could not clear run lock: {e}")
        write_runner_health("failed", topic=topic, error=msg)
        sys.exit(1)

    if result.returncode == 0:
        log_line(f"[run-weekly-seo] Research launch completed (exit 0).")
        # Only a successful run occupies a slot in the 4-week topic rotation.
        save_topic_history(load_topic_history(), topic)
        write_runner_health("success", topic=topic, returncode=0)
        run_shadow_pipeline()
    else:
        log_line(f"[run-weekly-seo] Research crew exited non-zero: {result.returncode}")
        tail = tail_crew_log()
        if tail:
            log_line(f"[run-weekly-seo] --- last {len(tail)} lines of crew output ---")
            for ln in tail:
                log_line(f"[crew] {ln}")
            log_line("[run-weekly-seo] --- end crew output ---")
        else:
            log_line(f"[run-weekly-seo] (crew produced no output; see {CREW_LOG_FILE})")
        # Keep the health payload small — the monitor emails it. Last few lines only.
        reason = " | ".join(tail[-3:])[:600] if tail else "no crew output captured"
        write_runner_health("failed", topic=topic, returncode=result.returncode,
                            error=f"crew exit {result.returncode}: {reason}")
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
