"""WeekSpec: Saturday re-run must not shift GBP dates (2026-08-29 incident)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

from seo_agents.week_spec import (
    compute_week_spec,
    load_or_create_week_spec,
    load_week_spec,
    most_recent_friday,
    monday_on_or_after,
)

ROOT = Path(__file__).resolve().parents[1]

# (anchor, run_friday, week_of, gbp_start)
WEEK_CASES = [
    (date(2026, 8, 28), "2026-08-28", "2026-08-31", "2026-08-28"),  # Fri
    (date(2026, 8, 29), "2026-08-28", "2026-08-31", "2026-08-28"),  # Sat — last week's shift
    (date(2026, 8, 30), "2026-08-28", "2026-08-31", "2026-08-28"),  # Sun
    (date(2026, 8, 31), "2026-08-28", "2026-08-31", "2026-08-28"),  # Mon
    (date(2026, 9, 3), "2026-08-28", "2026-08-31", "2026-08-28"),  # Thu
    (date(2026, 9, 4), "2026-09-04", "2026-09-07", "2026-09-04"),  # next Fri
]


def test_compute_week_spec_table():
    for anchor, run_friday, week_of, gbp_start in WEEK_CASES:
        spec = compute_week_spec(anchor)
        assert spec.run_friday == run_friday, anchor
        assert spec.week_of == week_of, anchor
        assert spec.gbp_start == gbp_start, anchor


def test_most_recent_friday_does_not_fast_forward():
    assert most_recent_friday(date(2026, 8, 31)).isoformat() == "2026-08-28"
    assert monday_on_or_after(date(2026, 8, 28)).isoformat() == "2026-08-31"
    assert monday_on_or_after(date(2026, 8, 31)).isoformat() == "2026-08-31"


def test_gbp_dates_stay_fri_through_thu():
    spec = compute_week_spec(date(2026, 8, 28))
    days = spec.gbp_dates()
    assert days[1].isoformat() == "2026-08-28"
    assert days[7].isoformat() == "2026-09-03"


def test_saturday_reuses_friday_file(tmp_path):
    friday = datetime(2026, 8, 28, 13, 30, tzinfo=timezone.utc)
    spec1 = load_or_create_week_spec(tmp_path, now=friday)
    saturday = datetime(2026, 8, 29, 15, 0, tzinfo=timezone.utc)
    spec2 = load_or_create_week_spec(tmp_path, now=saturday)
    assert spec2 == spec1
    assert spec2.gbp_start == "2026-08-28"
    assert spec2.week_of == "2026-08-31"
    on_disk = load_week_spec(tmp_path)
    assert on_disk == spec1


def test_next_friday_replaces_file(tmp_path):
    first = load_or_create_week_spec(
        tmp_path, now=datetime(2026, 8, 28, 13, 30, tzinfo=timezone.utc)
    )
    nxt = load_or_create_week_spec(
        tmp_path, now=datetime(2026, 9, 4, 13, 30, tzinfo=timezone.utc)
    )
    assert first.run_friday == "2026-08-28"
    assert nxt.run_friday == "2026-09-04"
    assert nxt.week_of == "2026-09-07"


def test_live_research_does_not_compact_baselines():
    source = (ROOT / "src" / "seo_agents" / "main.py").read_text(encoding="utf-8")
    live = source.split("# Live mode")[1].split("elif command ==")[0]
    assert "compact_baselines()" not in live
    execute = source.split("def _run_execute_pipeline")[1].split("def main")[0]
    assert "_run_supabase_sync(week_of=week.week_of)" in execute
    assert "start_date = date.today()" not in execute
    assert "sys.exit(1)" in execute


def test_gbp_prompt_copies_dates_without_unix_strftime():
    source = (ROOT / "src" / "seo_agents" / "crew.py").read_text(encoding="utf-8")
    assert "%-d" not in source
    assert "EXACT POSTING DATES" in source
    assert "copy these verbatim" in source
