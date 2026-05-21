"""Behavioral tests for the per-route timezone-conversion logic.

The invariants test (``test_timezone_invariants.py``) catches a few common
regex shapes but cannot reach two of the sites the original tz-fix PR
touched:

- ``stride_server.routes.pbs._normalise_date``: ISO branch normalises a
  UTC ``activities.date`` to a Shanghai calendar day. A
  ``fromisoformat(...).date()`` regression returns the UTC day silently.
- ``stride_server.routes.generate._get_last_week_summary``: matches actual
  activities against the previous week's planned-session dates (which are
  Shanghai-local YYYY-MM-DD). A regression in the per-row date conversion
  would silently undercount completions for Shanghai-morning workouts.

These tests pin the 00:00–07:59 Shanghai boundary behavior so future
refactors of those functions can't drift back to the UTC bucket.
"""

from __future__ import annotations

from datetime import date as date_cls
from typing import Any

import pytest

from stride_core.plan_spec import SessionKind


# ── pbs._normalise_date ──────────────────────────────────────────────────


class TestPbsNormaliseDate:
    @pytest.fixture
    def normalise(self):
        from stride_server.routes.pbs import _normalise_date
        return _normalise_date

    def test_utc_iso_evening_advances_to_next_shanghai_day(self, normalise):
        # 18:00 UTC == 02:00 Shanghai the next day. The PB row was recorded
        # in the early Shanghai morning; the user expects to see that morning's
        # date on their PB card, not the prior UTC day.
        assert normalise("2026-05-08T18:00:00+00:00") == "2026-05-09"

    def test_utc_iso_exact_boundary(self, normalise):
        # 16:00 UTC is exactly 00:00 Shanghai the next day.
        assert normalise("2026-05-08T16:00:00+00:00") == "2026-05-09"

    def test_utc_iso_before_boundary_stays_on_prior_day(self, normalise):
        # 15:59 UTC is still 23:59 Shanghai the same UTC day.
        assert normalise("2026-05-08T15:59:00+00:00") == "2026-05-08"

    def test_utc_iso_with_z_suffix(self, normalise):
        assert normalise("2026-05-08T18:00:00Z") == "2026-05-09"

    def test_compact_yyyymmdd_passthrough(self, normalise):
        assert normalise("20260509") == "2026-05-09"

    def test_already_yyyy_mm_dd_passthrough(self, normalise):
        assert normalise("2026-05-09") == "2026-05-09"

    def test_empty_returns_empty(self, normalise):
        assert normalise("") == ""

    def test_garbage_returns_truncated_fallback(self, normalise):
        # Unparseable: helper returned input unchanged → fall through to the
        # YYYY-MM-DD slice fallback. Documented behavior, not great input but
        # the function shouldn't crash.
        assert normalise("not-a-real-date-string") == "not-a-real"


# ── generate._get_last_week_summary ──────────────────────────────────────


class _StubPlanStore:
    """Minimal plan_store implementing the surface ``_get_last_week_summary``
    actually touches. Real implementations live in stride_core.state_stores."""

    def __init__(self, sessions: list[dict[str, Any]]):
        self._sessions = sessions

    def get_planned_sessions(self, *, week_folder: str | None = None, **_kw):
        # ``_get_last_week_summary`` only calls with ``week_folder=...``;
        # the stub returns the same fixture irrespective of which folder is
        # asked about (the test sets up exactly the prev-week folder).
        return list(self._sessions)


class _StubDb:
    """Wraps an in-memory sqlite3 connection with ``.query()`` matching the
    Database adapter contract."""

    def __init__(self, conn):
        self._conn = conn

    def query(self, sql: str, params: tuple = ()):  # noqa: D401
        return self._conn.execute(sql, params).fetchall()


@pytest.fixture
def last_week_summary():
    from stride_server.routes.generate import _get_last_week_summary
    return _get_last_week_summary


@pytest.fixture
def db_with_one_activity():
    """A coros.db-shaped activities table containing exactly one row at the
    Shanghai-morning boundary (02:00 Shanghai 2026-05-05 == 18:00 UTC
    2026-05-04). Caller supplies the planned-session date as 2026-05-05;
    a regression in the per-row UTC→Shanghai conversion would miss the
    match and report completed=0."""
    import sqlite3

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE activities (date TEXT, distance_m REAL, avg_pace_s_km REAL)"
    )
    # UTC 18:00 May 4 == Shanghai 02:00 May 5.
    conn.execute(
        "INSERT INTO activities VALUES (?, ?, ?)",
        ("2026-05-04T18:00:00+00:00", 10000.0, 300.0),
    )
    conn.commit()
    yield _StubDb(conn)
    conn.close()


class TestGenerateLastWeekSummary:
    def test_shanghai_morning_activity_matches_planned_run(
        self, db_with_one_activity, last_week_summary,
    ):
        # Prev week starts 2026-05-04 (Monday). Planned run is on 2026-05-05
        # (Tuesday) — the Shanghai-morning activity belongs to this day.
        sessions = [
            {
                "kind": SessionKind.RUN.value,
                "total_distance_m": 10000.0,
                "date": "2026-05-05",
            }
        ]
        plan_store = _StubPlanStore(sessions)
        week_start = date_cls(2026, 5, 11)  # current week start

        summary = last_week_summary(db_with_one_activity, plan_store, week_start)

        assert summary is not None
        assert summary["completed_sessions"] == 1, (
            "Activity at 02:00 Shanghai May 5 (18:00 UTC May 4) must match "
            "the May 5 planned run. A naive `raw[:10]` would put it on May 4."
        )

    def test_no_match_when_planned_date_is_prior_utc_day(
        self, db_with_one_activity, last_week_summary,
    ):
        # If `_get_last_week_summary` mistakenly used the UTC day, a planned
        # session on 2026-05-04 (the UTC day of the activity) would
        # incorrectly count as completed. Pin the inverse: with planned on
        # May 4, the May 5 Shanghai activity must NOT match.
        sessions = [
            {
                "kind": SessionKind.RUN.value,
                "total_distance_m": 10000.0,
                "date": "2026-05-04",
            }
        ]
        plan_store = _StubPlanStore(sessions)
        week_start = date_cls(2026, 5, 11)

        summary = last_week_summary(db_with_one_activity, plan_store, week_start)

        assert summary is not None
        assert summary["completed_sessions"] == 0
