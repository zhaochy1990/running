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
    parse_local_day,
    parse_week_folder_dates,
    shanghai_day_to_utc_range,
    shanghai_week_range,
    sqlite_mixed_date_expr,
    today_shanghai,
    utc_iso_to_shanghai_iso,
)


class TestParseWeekFolderDates:
    def test_plain_folder(self):
        assert parse_week_folder_dates("2026-05-04_05-10") == ("2026-05-04", "2026-05-10")

    def test_with_chinese_tag(self):
        assert parse_week_folder_dates("2026-04-13_04-19(赛后恢复)") == (
            "2026-04-13",
            "2026-04-19",
        )

    def test_cross_year_rollover(self):
        assert parse_week_folder_dates("2026-12-29_01-04(NewYear)") == (
            "2026-12-29",
            "2027-01-04",
        )

    def test_path_traversal_rejected(self):
        assert parse_week_folder_dates("2026-05-04_05-10/../../etc/passwd") is None
        assert parse_week_folder_dates("2026-05-04_05-10(../x)") is None

    def test_garbage_returns_none(self):
        assert parse_week_folder_dates("not-a-folder") is None
        assert parse_week_folder_dates("") is None


class TestParseLocalDay:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("20260501", date(2026, 5, 1)),
            ("2026-05-01", date(2026, 5, 1)),
            (date(2026, 5, 1), date(2026, 5, 1)),
        ],
    )
    def test_parses_supported_formats(self, raw, expected):
        assert parse_local_day(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "20260230", "2026-02-30", "bad"])
    def test_invalid_values_return_none(self, raw):
        assert parse_local_day(raw) is None


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


class TestSqliteMixedDateExpr:
    def test_matches_compact_and_iso_dates_with_iso_bounds(self, tmp_path):
        import sqlite3

        db_path = tmp_path / "mixed.db"
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE daily_health (date TEXT PRIMARY KEY, rhr INTEGER)")
        conn.executemany(
            "INSERT INTO daily_health (date, rhr) VALUES (?, ?)",
            [("20260501", 50), ("2026-05-02", 52), ("20260503", 53)],
        )
        conn.commit()

        day_sql = sqlite_mixed_date_expr("date")
        rows = conn.execute(
            f"SELECT {day_sql} AS day, rhr FROM daily_health "
            f"WHERE {day_sql} BETWEEN ? AND ? ORDER BY day",
            ("2026-05-01", "2026-05-02"),
        ).fetchall()

        assert rows == [("2026-05-01", 50), ("2026-05-02", 52)]

    def test_rejects_non_identifier_column(self):
        with pytest.raises(ValueError):
            sqlite_mixed_date_expr("date); DROP TABLE daily_health; --")


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
