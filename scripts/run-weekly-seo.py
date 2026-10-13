#!/usr/bin/env python3
"""Weekly SEO runner for Grizzly Electrical Solutions.

Queries Google Trends for the most-searched electrical service topic in Texas
this week, then kicks off the full SEO research + scheduling pipeline.
Run by Windows Task Scheduler every Friday at 8:30 AM.
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path


def _default_hermes_cli() -> str:
    """Platform default for the `hermes` CLI when HERMES_CLI is unset: the Windows
    venv on nt, `hermes` on PATH elsewhere."""
    if os.name == "nt":
        return r"C:\Users\carte\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
    return "hermes"


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
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def python_child_env(base: dict | None = None, os_name: str = os.name) -> dict:
    """Environment for a Python child of this wrapper.

    Windows CPython reads TZ itself and, with TZ=America/Chicago set, treats UTC as
    local time (reproduced 2026-10-13: parent 15:18 CDT, child 21:18), so an
    accidental TZ in the PC .env would shift every date the crew stamps. On nt
    the child never sees TZ; on posix (AIWA) TZ is kept, it is how the units pin
    Chicago time.
    """
    env = dict(os.environ if base is None else base)
    if os_name == "nt":
        env.pop("TZ", None)
    return env


NEG_INF = float("-inf")


def _parse_stamp(text) -> float:
    """Epoch seconds for an ISO instant, ``-inf`` when it is missing or unparseable."""
    if not text:
        return NEG_INF
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return NEG_INF


def _read_json_file(path) -> object:
    """Parsed JSON, or None for a missing/corrupt file."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def log_line(msg: str, log_file=None) -> None:
    """Print to console (captured by Task Scheduler) and append to the day log.

    ``log_file`` redirects the append for the isolated rehearsal seam; the default
    stays the Friday day log.
    """
    print(msg, flush=True)
    try:
        target = Path(log_file or RUNNER_LOG_FILE)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as fh:
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
    win_venv = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"  # Windows venv
    posix_venv = PROJECT_ROOT / ".venv" / "bin" / "python"        # POSIX venv
    # The platform's own venv first; the other layout is only a fallback.
    candidates = (win_venv, posix_venv) if sys.platform == "win32" else (posix_venv, win_venv)
    for cand in candidates:
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


def preflight(crew: bool = True) -> list[str]:
    """Fail closed before the crew if the Friday host cannot import or ping.

    Returns a list of fatal errors. Empty list = ok to launch. ``crew=False``
    (SEO_PIPELINE=new) skips the CrewAI probe: the crews are not launched in that
    mode, so a broken crew package must not block the rebuilt pipeline.
    """
    errors: list[str] = []
    if not crew:
        return _preflight_shared(errors)
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
            env={**python_child_env(), "PYTHONPATH": "", "PYTHONUNBUFFERED": "1"},
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
    return _preflight_shared(errors)


def _preflight_shared(errors: list[str]) -> list[str]:
    """The checks every mode needs: Supabase env, an alert channel, the GBP session dir."""
    if not (os.environ.get("SUPABASE_URL") or "").strip() or not (
        os.environ.get("SUPABASE_SERVICE_KEY") or ""
    ).strip():
        errors.append("SUPABASE_URL / SUPABASE_SERVICE_KEY missing")

    hermes = os.environ.get("HERMES_CLI") or _default_hermes_cli()
    # An absolute CLI path is checked on disk; a bare name (posix default `hermes`)
    # is resolved on PATH.
    hermes_found = (
        Path(hermes).exists() if os.path.isabs(hermes) else shutil.which(hermes) is not None
    )
    smtp = (os.environ.get("SMTP_APP_PASSWORD") or "").strip()
    if not hermes_found and not smtp:
        errors.append(
            f"both alert channels dead: hermes missing ({hermes}) and SMTP_APP_PASSWORD empty"
        )

    gbp_dir = os.environ.get("GBP_BROWSER_SESSION_DIR", "").strip()
    if gbp_dir and not Path(gbp_dir).exists():
        log_line(f"[run-weekly-seo] WARNING: GBP_BROWSER_SESSION_DIR does not exist: {gbp_dir}")

    return errors


# ---------------------------------------------------------------------------
# Rebuilt pipeline (scripts/weekly) — launch seam and attempt-derived health
# ---------------------------------------------------------------------------

PIPELINE_MODES = ("shadow", "new", "offline")
# Modes whose attempt is expected to send one attempt-bound alert (T1); both run
# with `--notify`. A rehearsal (`offline`) never touches an alert channel.
NOTIFY_MODES = ("shadow", "new")
SHADOW_TIMEOUT_S = int(os.environ.get("SEO_SHADOW_TIMEOUT_MIN", "30")) * 60
# Cap on the live (`new`) pipeline child. SEO_PIPELINE_TIMEOUT_MIN is the
# cutover name; SEO_SHADOW_TIMEOUT_MIN is honoured so an existing deployment
# keeps its setting. Default 30 min, same as shadow.
PIPELINE_TIMEOUT_S = int(
    os.environ.get("SEO_PIPELINE_TIMEOUT_MIN") or os.environ.get("SEO_SHADOW_TIMEOUT_MIN") or "30"
) * 60
# The legacy watchdog's notify-miss check reads this file (written by
# supabase-sync in the legacy chain). In `new` mode the wrapper writes it from
# the attempt's notify receipt so the same check keeps working without the sync.
APPROVAL_NOTIFY_FILE = OUTPUTS_DIR / "approval-notify.json"
# Statuses a finished attempt may carry that count as a good run.
PIPELINE_GOOD_STATUSES = ("succeeded", "degraded")


# Every mode this wrapper knows. Anything else is refused in main() (F5): an
# unknown or mistyped SEO_PIPELINE must never fall through to the legacy crews.
KNOWN_PIPELINE_MODES = ("legacy",) + PIPELINE_MODES


def pipeline_mode() -> str:
    """SEO_PIPELINE, normalized: surrounding whitespace and one pair of matching
    quotes stripped (`"new"` / `'shadow'` as a dotenv line), lower-cased; `legacy`
    when unset or blank. Validity is checked by main(), not here."""
    raw = (os.environ.get("SEO_PIPELINE") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1].strip()
    return raw.lower() or "legacy"


def pipeline_paths(mode: str) -> dict:
    """Where one rebuilt-pipeline mode reads and writes.

    `shadow` uses the real store, exports, log and Friday health file. `new` is
    the live cutover: same store and health file, but its exports go to
    outputs/ itself (the legacy schedule consumers read
    outputs/*_posting_schedule.md) and its log is weekly-new-<date>.log.
    `offline` is the rehearsal mode and is isolated under SEO_REHEARSAL_DIR
    (default outputs/rehearsal) so a rehearsal can never touch the legacy store,
    the shadow exports, or the health marker the monitor reads.
    """
    if mode == "new":
        return {
            "store": PROJECT_ROOT / "state" / "weekly",
            "out": OUTPUTS_DIR,
            "health": RUNNER_HEALTH_FILE,
            "log": OUTPUTS_DIR / f"weekly-new-{date.today().isoformat()}.log",
        }
    if mode == "offline":
        base = Path(os.environ.get("SEO_REHEARSAL_DIR") or (OUTPUTS_DIR / "rehearsal"))
        return {
            "store": base / "state",
            "out": base / "shadow",
            "health": base / "weekly-runner-health.json",
            "log": base / f"rehearsal-{date.today().isoformat()}.log",
        }
    return {
        "store": PROJECT_ROOT / "state" / "weekly",
        "out": OUTPUTS_DIR / "shadow",
        "health": RUNNER_HEALTH_FILE,
        "log": OUTPUTS_DIR / f"weekly-shadow-{date.today().isoformat()}.log",
    }


def pipeline_cmd(mode: str, paths: dict, week_of=None) -> list:
    """The `node scripts/weekly/run.mjs` command for one mode.

    `--store`/`--out` are always explicit so a mode can never drift onto the other
    mode's directory. Rehearsal gets no `--notify`: an offline rehearsal never
    touches an alert channel.
    """
    runner = PROJECT_ROOT / "scripts" / "weekly" / "run.mjs"
    cmd = ["node", str(runner), "--mode", mode, "--store", str(paths["store"]), "--out", str(paths["out"])]
    if mode in NOTIFY_MODES:
        cmd.append("--notify")
    if week_of:
        cmd += ["--week-of", week_of]
    return cmd


def fresh_week_of(spec_file=None, today: date | None = None):
    """`week_of` from outputs/week_spec.json, only when that file describes this run.

    The legacy crews write week_spec.json; in `new` mode nothing refreshes it, so
    a stale file from an earlier Friday would pin the live run to a past week.
    The Monday is used only when it lies in the seven days from today (run.mjs
    computes the same WeekSpec itself otherwise).
    """
    today = today or date.today()
    data = _read_json_file(spec_file or (OUTPUTS_DIR / "week_spec.json"))
    week_of = (data or {}).get("week_of") if isinstance(data, dict) else None
    try:
        monday = date.fromisoformat(str(week_of))
    except (TypeError, ValueError):
        return None
    return week_of if 0 <= (monday - today).days <= 7 else None


def _spawn_pipeline(cmd: list, log_file, timeout_s: int) -> dict:
    """Run the rebuilt pipeline child with its output streamed to `log_file`.

    Returns ``{returncode, error, timed_out}``. A child killed at the deadline is
    only reported here; finalizing the attempt it was running is the caller's job.
    """
    log_file = Path(log_file)
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as fh:
            fh.write(f"\n=== {_now_iso()} launching: {cmd}\n")
            fh.flush()
            r = subprocess.run(cmd, cwd=str(PROJECT_ROOT), env=os.environ.copy(),
                               stdout=fh, stderr=subprocess.STDOUT, timeout=timeout_s)
        return {"returncode": r.returncode, "error": None, "timed_out": False}
    except subprocess.TimeoutExpired:
        return {"returncode": None, "error": f"timeout after {timeout_s // 60} min", "timed_out": True}
    except Exception as e:
        return {"returncode": None, "error": str(e), "timed_out": False}


def attempt_records(paths: dict) -> list:
    """Every attempt record this run could have written, newest first.

    Two copies exist: in the store (`<store>/attempts/<id>.json`, authoritative but
    empty in shadow mode when Supabase is the store) and at the `--out` mirror
    (`attempt.json`, written by stage.mjs and refreshed at the end). Neither is
    trusted alone; the health block filters both by mode, week_of and launch time.
    """
    records = []
    folder = Path(paths["store"]) / "attempts"
    try:
        names = sorted(folder.glob("*.json")) if folder.is_dir() else []
    except OSError:
        names = []
    for path in names:
        data = _read_json_file(path)
        if isinstance(data, dict) and data.get("id"):
            records.append(data)
    mirror = _read_json_file(Path(paths["out"]) / "attempt.json")
    if isinstance(mirror, dict) and mirror.get("id"):
        records.append(mirror)
    records.sort(key=lambda a: _parse_stamp(a.get("started_at")), reverse=True)
    return records


def read_attempt_identity(paths: dict) -> dict | None:
    """The engine's `<out>/current-attempt.json` (T6 publication, lane B).

    It names the attempt a run is on — refreshed at creation and at finish, left at
    `running` when a run is killed — so the wrapper can tell its own attempt from a
    foreign one instead of guessing from whatever record happens to be on disk.
    """
    data = _read_json_file(Path(paths["out"]) / "current-attempt.json")
    return data if isinstance(data, dict) and data.get("attempt_id") else None


def notify_receipt(record) -> dict:
    """The attempt's `notify:<event>` delivery receipt, for the health block (T1).

    Lane B's notify.mjs records one receipt per attempt event as a `notify:<event>`
    stage (`status: ok|failed`; on success the `error` field carries the channel —
    `via hermes+smtp`). The block reports it so the watchdog can raise a notify-miss
    without reading the alert body. ``sent`` is False (never null) when no receipt is
    visible in the record this launch read: an absent receipt is exactly the
    silent-failure the alert exists to catch, so it must not look like "nothing here".
    """
    stages = (record or {}).get("stages")
    if not isinstance(stages, dict):
        stages = {}
    receipts = [(key.split(":", 1)[1], stage) for key, stage in stages.items()
                if isinstance(key, str) and key.startswith("notify:") and isinstance(stage, dict)]
    if not receipts:
        return {
            "event": record.get("status") if isinstance(record, dict) else None,
            "sent": False,
            "status": "missing",
            "channel": None,
            "at": None,
            "error": "no notify:<event> receipt on the attempt record",
        }
    matching = [r for r in receipts if r[0] == (record or {}).get("status")]
    event, stage = (matching or [max(receipts, key=lambda r: _parse_stamp(r[1].get("finished_at")))])[0]
    sent = stage.get("status") == "ok"
    channel = (stage.get("error") or "").removeprefix("via ").strip() if sent else None
    return {
        "event": event,
        "sent": sent,
        "status": stage.get("status"),
        "channel": channel or None,
        "at": stage.get("finished_at"),
        "error": None if sent else (stage.get("error") or "notify failed"),
    }


def pipeline_health_block(mode: str, paths: dict, *, launched_at: str,
                          expected_week_of=None, child: dict | None = None) -> dict:
    """The structured `shadow` health block, derived from the attempt record.

    `status` is the record's own status; the child's exit code is carried only as
    context, never as the verdict. The attempt is identified by the published
    identity when this launch published one, else by a record that started after
    this launch for this mode and week. Anything else is not this run's evidence:
    ``failed (no attempt written)`` when there is nothing at all, ``failed (stale
    attempt)`` when only an earlier same-week record exists.
    """
    block = {
        "status": "failed (no attempt written)",
        "mode": mode,
        "source": "attempt",
        "launched_at": launched_at,
        "at": _now_iso(),
        "week_of": expected_week_of,
        "log_file": str(paths["log"]),
        # T1: whether an alert was expected at all (a rehearsal sends none) plus the
        # receipt itself. Set from the attempt record below, never from the child's exit.
        "notify_expected": mode in NOTIFY_MODES,
        "notify": notify_receipt(None),
    }
    if child:
        block["child"] = child
    launch_ts = _parse_stamp(launched_at)
    records = attempt_records(paths)
    identity = read_attempt_identity(paths)
    ours = bool(identity) and identity.get("mode") == mode \
        and _parse_stamp(identity.get("started_at")) >= launch_ts \
        and (not expected_week_of or identity.get("week_of") == expected_week_of)
    if ours:
        # Finalized copies first: a record the engine finished beats a mid-run mirror.
        fresh = sorted([a for a in records if a.get("id") == identity["attempt_id"]],
                       key=lambda a: a.get("status") == "running")
        if not fresh:
            fresh = [identity]  # remote store and no mirror yet: the identity is the record
    else:
        fresh = [a for a in records if a.get("mode") == mode
                 and _parse_stamp(a.get("started_at")) >= launch_ts
                 and (not expected_week_of or a.get("week_of") == expected_week_of)]
    if not fresh:
        stale = [a for a in records if a.get("mode") == mode
                 and expected_week_of and a.get("week_of") == expected_week_of]
        if identity and identity.get("week_of") == expected_week_of:
            stale.append(identity)
        if child and child.get("timed_out"):
            block["status"] = "failed (killed at the deadline)"
        elif stale:
            block["status"] = "failed (stale attempt)"
            block["attempt_id"] = stale[0].get("id") or stale[0].get("attempt_id")
        return block
    record = fresh[0]
    started = _parse_stamp(record.get("started_at"))
    finished = _parse_stamp(record.get("finished_at"))
    end = finished if finished != NEG_INF else _parse_stamp(_now_iso())
    block.update({
        "status": record.get("status"),
        "attempt_id": record.get("id") or record.get("attempt_id"),
        "week_of": record.get("week_of", expected_week_of),
        "started_at": record.get("started_at"),
        "finished_at": record.get("finished_at"),
        "runtime_s": int(max(0, end - started)) if started != NEG_INF and end != NEG_INF else None,
        "spent_usd": record.get("spent_usd"),
        "budget_usd": record.get("budget_usd"),
        "error": record.get("error"),
        "notify": notify_receipt(record),
    })
    return block


def _merge_shadow_block(paths: dict, block: dict) -> None:
    """Set `shadow` in the health file, preserving every legacy key already there."""
    health = Path(paths["health"])
    try:
        health.parent.mkdir(parents=True, exist_ok=True)
        payload = _read_json_file(health)
        if not isinstance(payload, dict):
            payload = {}
        payload["shadow"] = block
        health.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[run-weekly-seo] WARNING: could not write shadow health ({health}): {e}", flush=True)


def run_pipeline(mode: str, paths: dict | None = None, week_of=None, *,
                 cmd: list | None = None, timeout_s: int | None = None) -> dict:
    """Launch one rebuilt-pipeline mode and record what actually happened.

    Writes the pre-launch `running` marker, runs the child, then replaces the
    marker with the structured block from the attempt record. Never changes this
    wrapper's own status or exit code. `cmd` and `paths` are the injectable seam
    the offline rehearsal and its tests use.
    """
    if mode not in PIPELINE_MODES:
        raise ValueError(f"unknown pipeline mode {mode!r} (expected one of {PIPELINE_MODES})")
    paths = paths or pipeline_paths(mode)
    launched_at = _now_iso()
    _merge_shadow_block(paths, {
        "status": "running",
        "mode": mode,
        "launched_at": launched_at,
        "at": launched_at,
        "log_file": str(paths["log"]),
        "notify_expected": mode in NOTIFY_MODES,
        "notify": notify_receipt(None),
    })
    log_line(f"[run-weekly-seo] {mode} pipeline -> {paths['log']}", log_file=paths["log"])
    child = _spawn_pipeline(cmd or pipeline_cmd(mode, paths, week_of), paths["log"],
                            timeout_s or SHADOW_TIMEOUT_S)
    # A child killed at the deadline, or one that died without finishing, leaves its
    # attempt at `running` with the lease held. Finalize it (identity-guarded) before
    # the health block reads the record, so the block never reports a stuck run.
    if child["timed_out"] or child["returncode"] not in (0, None):
        finalize_killed_attempt(paths, mode, launched_at)
    block = pipeline_health_block(mode, paths, launched_at=launched_at,
                                  expected_week_of=week_of, child=child)
    _merge_shadow_block(paths, block)
    log_line(f"[run-weekly-seo] {mode} pipeline: attempt status {block['status']}", log_file=paths["log"])
    return block


def finalize_killed_attempt(paths: dict, mode: str, launched_at: str) -> bool:
    """Mark the attempt this launch left running as failed and release its lease.

    Covers a child killed at the deadline and one that died without finishing. The
    identity guard is what keeps this from touching a foreign attempt: the attempt
    must be the one named in the engine's published identity, for this mode, started
    after this launch, and still `running` in both the identity and its own store
    record. A shadow run whose store is Supabase has no local record, and an
    ambiguous or already-finished attempt is left alone; both are logged and
    reported, never patched.
    """
    attempt_id = None
    identity = read_attempt_identity(paths)
    if not identity:
        log_line("[run-weekly-seo] no published attempt identity; nothing to finalize",
                 log_file=paths["log"])
        return False
    attempt_id = identity["attempt_id"]
    store_file = Path(paths["store"]) / "attempts" / f"{attempt_id}.json"
    attempt = _read_json_file(store_file)
    if identity.get("mode") != mode or _parse_stamp(identity.get("started_at")) < _parse_stamp(launched_at):
        log_line(f"[run-weekly-seo] identity {attempt_id} is not this launch's attempt; not patching",
                 log_file=paths["log"])
        return False
    if isinstance(attempt, dict) and attempt.get("status") != "running":
        log_line(f"[run-weekly-seo] attempt {attempt_id} already {attempt.get('status')}; not patching",
                 log_file=paths["log"])
        return False
    if identity.get("status") != "running":
        log_line(f"[run-weekly-seo] identity {attempt_id} already {identity.get('status')}; not patching",
                 log_file=paths["log"])
        return False
    if not isinstance(attempt, dict) or attempt.get("id") != attempt_id:
        log_line(f"[run-weekly-seo] attempt {attempt_id} has no local store record "
                 f"(Supabase store); nothing to finalize here", log_file=paths["log"])
        return False
    now = _now_iso()
    stages = {}
    for name, stage in (attempt.get("stages") or {}).items():
        if isinstance(stage, dict) and stage.get("status") == "running":
            stages[name] = {**stage, "finished_at": now, "status": "failed",
                            "error": stage.get("error") or "wrapper killed the pipeline while this stage was running"}
        else:
            stages[name] = stage
    patched = {**attempt, "stages": stages, "finished_at": now, "status": "failed",
               "error": attempt.get("error") or "wrapper killed the pipeline at the shadow timeout",
               "lease_until": None}
    try:
        tmp = store_file.with_name(f"{store_file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(patched, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, store_file)
    except OSError as e:
        log_line(f"[run-weekly-seo] WARNING: could not finalize killed attempt {attempt_id}: {e}",
                 log_file=paths["log"])
        return False
    released = False
    lease_file = Path(paths["store"]) / "leases" / f"{attempt.get('week_of')}.json"
    lease = _read_json_file(lease_file)
    if isinstance(lease, dict) and lease.get("attempt_id") == attempt_id:
        try:
            lease_file.unlink()
            released = True
        except OSError as e:
            log_line(f"[run-weekly-seo] WARNING: could not release lease {lease_file}: {e}",
                     log_file=paths["log"])
    log_line(f"[run-weekly-seo] killed attempt {attempt_id} finalized failed; "
             f"lease {'released' if released else 'left alone (not held by this attempt)'}",
             log_file=paths["log"])
    return True


def run_rehearsal() -> int:
    """`--rehearsal`: the offline pipeline through this wrapper, in isolation.

    No preflight, no legacy crew, no network, no alert channel: store, exports, log
    and health file all live under SEO_REHEARSAL_DIR, so it proves the launch seam
    without touching Friday's state. See FRIDAY-RUNBOOK.md.
    """
    paths = pipeline_paths("offline")
    log_line(f"[run-weekly-seo] Rehearsal (offline, isolated under {paths['out'].parent})",
             log_file=paths["log"])
    block = run_pipeline("offline", paths)
    print(json.dumps(block, indent=2), flush=True)
    log_line(f"[run-weekly-seo] Rehearsal health -> {paths['health']}", log_file=paths["log"])
    return 0 if block.get("status") in ("succeeded", "degraded") else 1


def _write_approval_notify(block: dict, projection: dict | None) -> None:
    """Mirror the attempt's notify receipt into outputs/approval-notify.json.

    The legacy watchdog (`evaluateWatchdog`) still reads that file for its
    NOTIFY MISS and AUTO-APPROVE checks; in `new` mode supabase-sync no longer
    writes it, so the wrapper does, from the attempt record's receipt and the
    projection result run.mjs mirrored into `<out>/projection.json`.
    """
    notify = block.get("notify") or {}
    approved = (projection or {}).get("approved") or {}
    payload = {
        "sent": bool(notify.get("sent")),
        "reason": notify.get("error") if not notify.get("sent") else "",
        "channel": notify.get("channel"),
        "runId": (projection or {}).get("runId"),
        "weekOf": block.get("week_of") or (projection or {}).get("week_of"),
        "autoApprove": bool((projection or {}).get("auto_approve")) and bool(approved.get("ok")),
        "gbpCount": None,
        "fbCount": None,
        "source": "attempt",
        "attempt_id": block.get("attempt_id"),
        "event": notify.get("event"),
        "at": _now_iso(),
    }
    try:
        APPROVAL_NOTIFY_FILE.parent.mkdir(parents=True, exist_ok=True)
        APPROVAL_NOTIFY_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[run-weekly-seo] WARNING: could not write {APPROVAL_NOTIFY_FILE}: {e}", flush=True)


def _refusal_line(log_path) -> str | None:
    """The engine's last `[weekly] refused: ...` line from the pipeline log, if any
    (run.mjs prints it before exiting 2 for RerunRefused / StoreRefused)."""
    try:
        lines = Path(log_path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        idx = line.find("[weekly] refused:")
        if idx != -1:
            return line[idx + len("[weekly] refused:"):].strip()[:300] or None
    return None


def run_new_pipeline() -> int:
    """SEO_PIPELINE=new: the rebuilt pipeline IS the Friday run (Phase C cutover).

    No CrewAI research/execute/schedule crews and no supabase-sync: run.mjs
    stages the week, exports the legacy schedules to outputs/ and projects the
    plan into seo_runs / weekly_posts / website_tasks itself. The attempt-derived
    block is written under `shadow` as before, AND lifted into the top-level
    health fields (`status` success|failed, `date`, `error`, `returncode`,
    `topic`) the watchdog/monitor NO-SHOW / FAILED / HUNG rules read, so the
    legacy checks keep working with nothing else on disk. Returns the exit code.
    """
    paths = pipeline_paths("new")
    runner = PROJECT_ROOT / "scripts" / "weekly" / "run.mjs"
    if not runner.exists():
        msg = f"SEO_PIPELINE=new but {runner} is missing"
        log_line(f"[run-weekly-seo] ERROR: {msg}")
        write_runner_health("failed", error=msg)
        return 1
    fatal = preflight(crew=False)
    if not (os.environ.get("DEEPSEEK_API_KEY") or "").strip():
        fatal.append("DEEPSEEK_API_KEY missing (the rebuilt pipeline generates with DeepSeek)")
    if fatal:
        msg = "; ".join(fatal)
        log_line(f"[run-weekly-seo] PREFLIGHT FAILED: {msg}")
        write_runner_health("failed", error=f"preflight: {msg}")
        return 1
    log_line("[run-weekly-seo] preflight ok (new mode: Supabase env, alert channel, DeepSeek key)")

    week_of = fresh_week_of()
    log_line(f"[run-weekly-seo] SEO_PIPELINE=new: running scripts/weekly/run.mjs --mode new as the "
             f"primary run (crews and supabase-sync skipped){f', week of {week_of}' if week_of else ''}")
    block = run_pipeline("new", paths, week_of=week_of, timeout_s=PIPELINE_TIMEOUT_S)

    status = str(block.get("status") or "")
    ok = status in PIPELINE_GOOD_STATUSES
    child = block.get("child") or {}
    plan = _read_json_file(Path(paths["out"]) / "plan.json")
    topic = ""
    if isinstance(plan, dict) and isinstance(plan.get("topic"), dict):
        t = plan["topic"]
        topic = " / ".join(str(x) for x in (t.get("service_label"), t.get("city")) if x)
    projection = _read_json_file(Path(paths["out"]) / "projection.json")
    if not (isinstance(projection, dict) and projection.get("attempt_id") == block.get("attempt_id")):
        projection = None
    # V4: a refused run (exit 2: rerun guard or store refusal) writes no attempt, so the
    # block can only say "failed (no attempt written)". Lift the engine's refusal line
    # into the health error so the watchdog FAILED alert carries the reason.
    refusal = _refusal_line(paths["log"]) if child.get("returncode") == 2 else None
    error = None if ok else (
        f"new pipeline refused (exit 2): {refusal}" if refusal else
        f"new pipeline attempt {status}" + (f": {block.get('error')}" if block.get("error") else "")
    )
    # A good attempt whose projection.json is missing (or belongs to another attempt)
    # delivered nothing to weekly_posts: that is a failed Friday, not a warning (R9).
    if ok and not projection:
        ok = False
        error = (f"new pipeline attempt {status} but no projection for attempt "
                 f"{block.get('attempt_id') or '?'} — nothing reached weekly_posts; check the attempt's `project` stage")
    # write_runner_health replaces the whole file, so the attempt block is merged back after it.
    write_runner_health("success" if ok else "failed", topic=topic,
                        returncode=child.get("returncode"), error=error or "")
    _merge_shadow_block(paths, block)
    _write_approval_notify(block, projection)
    if ok:
        approved = projection.get("approved") or {}
        verdict = (f"auto-approved ({approved.get('count')} post(s))" if approved.get("ok")
                   else ("pending approval in MCC" if not projection.get("auto_approve")
                         else f"auto-approve refused ({approved.get('reason') or 'unknown'})"))
        log_line(f"[run-weekly-seo] projected seo_runs {projection.get('runId')}: "
                 f"{projection.get('posts')} post(s), {projection.get('tasks')} task(s), {verdict}")
    log_line(f"[run-weekly-seo] new pipeline: {status}{f' ({error})' if error else ''}")
    return 0 if ok else 1


def run_shadow_pipeline() -> None:
    """Run the rebuilt pipeline (scripts/weekly) after a successful legacy run when
    SEO_PIPELINE is `shadow` (live collectors, real store) or `offline` (the
    isolated rehearsal). Shadow mode writes only to the new tables and to
    outputs/shadow/; it never touches weekly_posts, website_tasks, or the legacy
    outputs, so a failure here is logged and recorded but never changes this
    wrapper's exit code or health status. `new` never reaches here: main()
    routes it to run_new_pipeline() before the crews.
    See docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md."""
    mode = pipeline_mode()
    if mode not in PIPELINE_MODES or mode == "new":
        return
    runner = PROJECT_ROOT / "scripts" / "weekly" / "run.mjs"
    if not runner.exists():
        log_line(f"[run-weekly-seo] SEO_PIPELINE={mode} but {runner} is missing; skipping")
        return
    week_of = None
    try:
        week_of = (_read_json_file(OUTPUTS_DIR / "week_spec.json") or {}).get("week_of")
    except Exception:
        pass  # run.mjs computes the same WeekSpec itself
    run_pipeline(mode, week_of=week_of)


def main() -> None:
    if "--rehearsal" in sys.argv[1:]:
        sys.exit(run_rehearsal())

    # Mark "started" immediately so the monitor can tell a real run from a no-show,
    # even if topic selection or the crew launch fails below.
    write_runner_health("started")
    log_line(f"[run-weekly-seo] Starting — {date.today().isoformat()} (Friday run)")

    # F5: fail closed on an unknown mode. A typo or an unstripped value must not
    # run the legacy crews under a health that reads like a mode problem elsewhere.
    mode = pipeline_mode()
    if mode not in KNOWN_PIPELINE_MODES:
        msg = (f"SEO_PIPELINE={os.environ.get('SEO_PIPELINE')!r} is not one of "
               f"{KNOWN_PIPELINE_MODES}; refusing to run (never falls back to legacy)")
        log_line(f"[run-weekly-seo] REFUSED: {msg}")
        write_runner_health("failed", error=msg)
        sys.exit(2)

    # Phase C cutover: `new` replaces the crew launch entirely (no research /
    # execute / schedule crews, no supabase-sync). `legacy` and `shadow` keep the
    # crew path below byte-for-byte.
    if mode == "new":
        sys.exit(run_new_pipeline())

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
    # package is importable when we fall back to `-m seo_agents.main`. On Windows the
    # child never sees TZ (python_child_env): CPython would read UTC as local time.
    child_env = python_child_env()
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
