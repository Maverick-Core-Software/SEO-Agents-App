"""Frozen posting-week identity for the Friday SEO run.

GBP used to take date.today() as Day 1. A Saturday re-run therefore shifted
every GBP DATE by one day (2026-08-29 incident). Facebook already snaps to
Monday-on-or-after in fb_week_dates; this module is the single calendar both
crews and supabase-sync must use.

Rule (America/Chicago):
  run_friday = most recent Friday (Friday stays Friday; Sat/Sun rewind)
  week_of    = Monday on or after run_friday
  gbp_start  = run_friday  (keeps the live Fri–Thu GBP cadence)
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo("America/Chicago")
WEEK_SPEC_NAME = "week_spec.json"


@dataclass(frozen=True)
class WeekSpec:
    run_friday: str  # YYYY-MM-DD
    week_of: str  # YYYY-MM-DD Monday; seo_runs unique key
    gbp_start: str  # YYYY-MM-DD; GBP Day 1
    computed_at: str  # UTC instant

    def gbp_dates(self, days: int = 7) -> dict[int, date]:
        start = date.fromisoformat(self.gbp_start)
        return {d: start + timedelta(days=d - 1) for d in range(1, days + 1)}

    def to_dict(self) -> dict:
        return asdict(self)


def chicago_today(now: datetime | None = None) -> date:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(CHICAGO).date()


def most_recent_friday(anchor: date) -> date:
    """Friday on or before ``anchor``. Monday→previous Friday, not next."""
    return anchor - timedelta(days=(anchor.weekday() - 4) % 7)


def monday_on_or_after(anchor: date) -> date:
    """Same rule as crew.fb_week_dates: a Monday anchor stays that Monday."""
    return anchor + timedelta(days=(7 - anchor.weekday()) % 7)


def compute_week_spec(anchor: date | None = None, now: datetime | None = None) -> WeekSpec:
    if anchor is None:
        anchor = chicago_today(now)
    run_friday = most_recent_friday(anchor)
    week_of = monday_on_or_after(run_friday)
    computed = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    return WeekSpec(
        run_friday=run_friday.isoformat(),
        week_of=week_of.isoformat(),
        gbp_start=run_friday.isoformat(),
        computed_at=computed.isoformat().replace("+00:00", "Z"),
    )


def load_week_spec(output_dir: Path) -> WeekSpec | None:
    path = output_dir / WEEK_SPEC_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return WeekSpec(
            run_friday=data["run_friday"],
            week_of=data["week_of"],
            gbp_start=data.get("gbp_start") or data["run_friday"],
            computed_at=data.get("computed_at") or "",
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError, ValueError):
        return None


def save_week_spec(output_dir: Path, spec: WeekSpec) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / WEEK_SPEC_NAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(spec.to_dict(), indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def load_or_create_week_spec(output_dir: Path, now: datetime | None = None) -> WeekSpec:
    """Reuse a same-Friday spec so a Saturday execute cannot shift dates.

    If the file is from a different Friday, recompute.
    """
    wanted = compute_week_spec(chicago_today(now), now)
    existing = load_week_spec(output_dir)
    if existing and existing.run_friday == wanted.run_friday:
        return existing
    save_week_spec(output_dir, wanted)
    return wanted
