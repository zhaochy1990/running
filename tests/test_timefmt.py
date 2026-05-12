"""Unit tests for the canonical Asia/Shanghai conversion helpers.

The boundary scenarios here intentionally cover the 00:00–07:59 Shanghai
window — that's the slice of the day where a naive UTC comparison
misclassifies activities by one calendar day, and the original bug that
prompted this module.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from stride_core.timefmt import (
    SHANGHAI_DAY_SQL,
    SHANGHAI_TZ,
    shanghai_day_to_utc_range,
    shanghai_week_range,
    today_shanghai,
    utc_iso_to_shanghai_iso,
)


class TestUtcIsoToShanghaiIso:
    def test_cross_day_boundary(self):
        # UTC 16:30 May 8 == Shanghai 00:30 May 9 — the activity belongs to May 9.
        assert (
            utc_iso_to_shanghai_iso("2026-05-08T16:30:00+00:00")
            == "2026-05-09T00:30:00+08:00"
        )

    def test_preserves_microseconds(self):
        assert (
            utc_iso_to_shanghai_iso("2026-05-09T10:46:47.600000+00:00")
            == "2026-05-09T18:46:47.600000+08:00"
        )

    def test_handles_z_suffix(self):
        assert (
            utc_iso_to_shanghai_iso("2026-05-08T16:30:00Z")
            == "2026-05-09T00:30:00+08:00"
        )

    def test_naive_input_assumed_utc(self):
        # Defensive: legacy rows occasionally lack offset; treat as UTC.
        result = utc_iso_to_shanghai_iso("2026-05-08T16:30:00")
        assert result == "2026-05-09T00:30:00+08:00"

    def test_already_shanghai_passes_through(self):
        # Should not double-convert. The instant is the same; we just keep
        # the existing offset notation.
        assert (
            utc_iso_to_shanghai_iso("2026-05-09T00:30:00+08:00")
            == "2026-05-09T00:30:00+08:00"
        )

    def test_none_and_empty(self):
        assert utc_iso_to_shanghai_iso(None) is None
        assert utc_iso_to_shanghai_iso("") == ""

    def test_unparseable_returns_input(self):
        assert utc_iso_to_shanghai_iso("not-a-date") == "not-a-date"

    def test_slice_zero_to_ten_is_shanghai_date(self):
        # The whole point of the API-side conversion: the frontend's existing
        # `activity.date.slice(0, 10)` pattern now yields the Shanghai date.
        out = utc_iso_to_shanghai_iso("2026-05-08T16:30:00+00:00")
        assert out is not None and out[:10] == "2026-05-09"


class TestTodayShanghai:
    def test_returns_date(self):
        d = today_shanghai()
        assert isinstance(d, date)

    def test_matches_shanghai_now(self):
        # Within the same minute of the same call — Shanghai date.
        expected = datetime.now(SHANGHAI_TZ).date()
        assert today_shanghai() == expected


class TestShanghaiDayToUtcRange:
    def test_basic_day(self):
        start, end = shanghai_day_to_utc_range("2026-05-09")
        # Shanghai 2026-05-09 00:00 == UTC 2026-05-08 16:00
        assert start == "2026-05-08T16:00:00+00:00"
        # Shanghai 2026-05-10 00:00 == UTC 2026-05-09 16:00 (exclusive end)
        assert end == "2026-05-09T16:00:00+00:00"

    def test_range_is_24_hours(self):
        start, end = shanghai_day_to_utc_range("2026-05-09")
        ds = datetime.fromisoformat(start)
        de = datetime.fromisoformat(end)
        assert (de - ds).total_seconds() == 24 * 3600


class TestShanghaiWeekRange:
    def test_seven_day_week(self):
        start, end = shanghai_week_range("2026-05-04", "2026-05-10")
        # 7 full days = 168h
        ds = datetime.fromisoformat(start)
        de = datetime.fromisoformat(end)
        assert (de - ds).total_seconds() == 7 * 24 * 3600
        # Anchored to UTC 16:00 the day before Monday
        assert start == "2026-05-03T16:00:00+00:00"


class TestSqlIntegration:
    """Verify the SHANGHAI_DAY_SQL fragment classifies a boundary activity
    correctly when used in a real SQLite query.
    """

    def test_boundary_activity_lands_on_shanghai_day(self, tmp_path):
        import sqlite3

        db_path = tmp_path / "tz.db"
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE activities (id INTEGER PRIMARY KEY, date TEXT)")
        # 2026-05-08T16:30:00 UTC == 2026-05-09T00:30:00 Shanghai
        # Naive `WHERE date >= '2026-05-09'` would EXCLUDE this row;
        # SHANGHAI_DAY_SQL must INCLUDE it.
        conn.execute(
            "INSERT INTO activities (date) VALUES (?)",
            ("2026-05-08T16:30:00+00:00",),
        )
        conn.commit()

        rows = conn.execute(
            f"SELECT id FROM activities WHERE {SHANGHAI_DAY_SQL} = ?",
            ("2026-05-09",),
        ).fetchall()
        assert len(rows) == 1, "boundary activity must classify into Shanghai day"

        # Sanity: naive UTC comparison misses it on May 9, finds it on May 8.
        naive_may9 = conn.execute(
            "SELECT id FROM activities WHERE date(date) = ?", ("2026-05-09",)
        ).fetchall()
        assert len(naive_may9) == 0, "naive UTC compare must NOT find this on May 9"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
