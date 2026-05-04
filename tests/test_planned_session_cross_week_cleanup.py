"""Tests for cross-week orphan cleanup in upsert_planned_sessions /
upsert_planned_nutrition.

Bug context: prior reparse runs that used a different week_folder spelling
(e.g. ``2026-05-04_05-10`` vs ``2026-05-04_05-10(P1W2)``) leave orphan rows
behind. The ``DELETE FROM ... WHERE week_folder = ?`` cleanup only removes
rows for the literal current spelling, so the prod calendar ends up with
duplicate sessions: the orphans (pushable=False) plus the freshly authored
ones.

Fix: delete by date range parsed from the week_folder pattern
``YYYY-MM-DD_MM-DD(...)``, regardless of any phase tag in parentheses.
Falls back to literal week_folder match when the folder name doesn't parse.
"""

from __future__ import annotations

from pathlib import Path

from stride_core.db import Database, _parse_week_folder_dates
from stride_core.plan_spec import PlannedNutrition, PlannedSession, SessionKind


def _seed_session_row(
    db: Database,
    *,
    week_folder: str,
    date: str,
    session_index: int = 0,
    kind: str = "run",
    summary: str = "Orphan",
) -> int:
    """Insert a raw planned_session row directly (bypassing upsert)."""
    cur = db._conn.execute(
        """INSERT INTO planned_session
        (week_folder, date, session_index, kind, summary)
        VALUES (?, ?, ?, ?, ?)""",
        (week_folder, date, session_index, kind, summary),
    )
    db._conn.commit()
    return cur.lastrowid


def _seed_nutrition_row(
    db: Database,
    *,
    week_folder: str,
    date: str,
    kcal_target: float = 2200.0,
) -> None:
    """Insert a raw planned_nutrition row directly (bypassing upsert)."""
    db._conn.execute(
        """INSERT INTO planned_nutrition
        (week_folder, date, kcal_target)
        VALUES (?, ?, ?)""",
        (week_folder, date, kcal_target),
    )
    db._conn.commit()


# ─────────────────────────────────────────────────────────────────────────
# _parse_week_folder_dates helper
# ─────────────────────────────────────────────────────────────────────────


class TestParseWeekFolderDates:
    def test_plain_date_range(self):
        assert _parse_week_folder_dates("2026-05-04_05-10") == (
            "2026-05-04", "2026-05-10",
        )

    def test_with_phase_tag(self):
        assert _parse_week_folder_dates("2026-05-04_05-10(P1W2)") == (
            "2026-05-04", "2026-05-10",
        )

    def test_with_chinese_phase_tag(self):
        assert _parse_week_folder_dates("2026-04-13_04-19(赛后恢复)") == (
            "2026-04-13", "2026-04-19",
        )

    def test_year_wrap_week_folder(self):
        # End month < start month → end year rolls forward.
        assert _parse_week_folder_dates("2026-12-29_01-04(NewYear)") == (
            "2026-12-29", "2027-01-04",
        )

    def test_unparseable_returns_none(self):
        assert _parse_week_folder_dates("unusual-folder-name") is None

    def test_partial_match_returns_none(self):
        assert _parse_week_folder_dates("2026-05-04") is None


# ─────────────────────────────────────────────────────────────────────────
# upsert_planned_sessions cross-week cleanup
# ─────────────────────────────────────────────────────────────────────────


class TestUpsertPlannedSessionsCrossWeekCleanup:
    def test_upsert_clears_orphan_rows_in_date_range(self, tmp_path: Path):
        """Orphan rows from a different week_folder spelling but same
        calendar week must be wiped during upsert."""
        db = Database(db_path=tmp_path / "orphans.db")
        try:
            # Two orphan rows from earlier reparse runs that used different
            # week_folder spellings.
            _seed_session_row(
                db,
                week_folder="2026-05-04_05-10",
                date="2026-05-05",
                summary="Orphan A (old spelling)",
            )
            _seed_session_row(
                db,
                week_folder="2026-05-04_05-10(OLD)",
                date="2026-05-06",
                summary="Orphan B (different tag)",
            )

            # Upsert with the canonical current week_folder.
            new_sessions = [
                PlannedSession(
                    date="2026-05-07",
                    session_index=0,
                    kind=SessionKind.RUN,
                    summary="Fresh run",
                ),
                PlannedSession(
                    date="2026-05-09",
                    session_index=0,
                    kind=SessionKind.REST,
                    summary="Fresh rest",
                ),
            ]
            db.upsert_planned_sessions(
                "2026-05-04_05-10(P1W2)", new_sessions,
            )

            rows = db._conn.execute(
                "SELECT week_folder, date, summary "
                "FROM planned_session ORDER BY date"
            ).fetchall()
            # Both orphans gone; only the two new rows remain.
            assert len(rows) == 2
            summaries = [r[2] for r in rows]
            assert "Orphan A (old spelling)" not in summaries
            assert "Orphan B (different tag)" not in summaries
            assert summaries == ["Fresh run", "Fresh rest"]
            # All survivors carry the new canonical week_folder.
            assert all(r[0] == "2026-05-04_05-10(P1W2)" for r in rows)
        finally:
            db.close()

    def test_upsert_preserves_rows_outside_date_range(self, tmp_path: Path):
        """Rows whose date sits outside the current week's [start, end]
        range must be preserved — only same-week orphans get swept."""
        db = Database(db_path=tmp_path / "outside.db")
        try:
            # Earlier-week row.
            _seed_session_row(
                db,
                week_folder="2026-04-27_05-03(W1)",
                date="2026-04-30",
                summary="Earlier week",
            )
            # Later-week row.
            _seed_session_row(
                db,
                week_folder="2026-05-11_05-17(W3)",
                date="2026-05-12",
                summary="Later week",
            )

            db.upsert_planned_sessions(
                "2026-05-04_05-10(P1W2)",
                [
                    PlannedSession(
                        date="2026-05-05",
                        session_index=0,
                        kind=SessionKind.RUN,
                        summary="P1W2 run",
                    ),
                ],
            )

            rows = db._conn.execute(
                "SELECT date, summary FROM planned_session ORDER BY date"
            ).fetchall()
            assert len(rows) == 3
            summaries = [r[1] for r in rows]
            assert "Earlier week" in summaries
            assert "Later week" in summaries
            assert "P1W2 run" in summaries
        finally:
            db.close()

    def test_upsert_falls_back_to_week_folder_when_folder_unparseable(
        self, tmp_path: Path,
    ):
        """When the week_folder doesn't match the date-range regex, fall
        back to the legacy ``WHERE week_folder = ?`` cleanup so non-canonical
        folder names still work."""
        db = Database(db_path=tmp_path / "unparseable.db")
        try:
            # Pre-existing row under the same unparseable folder name —
            # should be wiped by the fallback path.
            _seed_session_row(
                db,
                week_folder="unusual-folder-name",
                date="2026-05-05",
                summary="Old legacy",
            )
            # Pre-existing row under a DIFFERENT folder name — must survive
            # because fallback uses week_folder=? equality, not date range.
            _seed_session_row(
                db,
                week_folder="another-folder",
                date="2026-05-06",
                summary="Different folder, must survive",
            )

            db.upsert_planned_sessions(
                "unusual-folder-name",
                [
                    PlannedSession(
                        date="2026-05-07",
                        session_index=0,
                        kind=SessionKind.RUN,
                        summary="New under unusual folder",
                    ),
                ],
            )

            rows = db._conn.execute(
                "SELECT week_folder, summary FROM planned_session ORDER BY summary"
            ).fetchall()
            summaries = [r[1] for r in rows]
            assert "Old legacy" not in summaries
            assert "Different folder, must survive" in summaries
            assert "New under unusual folder" in summaries
        finally:
            db.close()


# ─────────────────────────────────────────────────────────────────────────
# upsert_planned_nutrition cross-week cleanup (mirrors above)
# ─────────────────────────────────────────────────────────────────────────


class TestUpsertPlannedNutritionCrossWeekCleanup:
    def test_upsert_clears_orphan_rows_in_date_range(self, tmp_path: Path):
        """Same orphan-cleanup behavior for planned_nutrition."""
        db = Database(db_path=tmp_path / "nut_orphans.db")
        try:
            _seed_nutrition_row(
                db,
                week_folder="2026-05-04_05-10",
                date="2026-05-05",
                kcal_target=1111.0,
            )
            _seed_nutrition_row(
                db,
                week_folder="2026-05-04_05-10(OLD)",
                date="2026-05-06",
                kcal_target=2222.0,
            )

            db.upsert_planned_nutrition(
                "2026-05-04_05-10(P1W2)",
                [
                    PlannedNutrition(date="2026-05-07", kcal_target=2400.0),
                    PlannedNutrition(date="2026-05-09", kcal_target=2200.0),
                ],
            )

            rows = db._conn.execute(
                "SELECT week_folder, date, kcal_target "
                "FROM planned_nutrition ORDER BY date"
            ).fetchall()
            assert len(rows) == 2
            kcals = [r[2] for r in rows]
            assert 1111.0 not in kcals
            assert 2222.0 not in kcals
            assert kcals == [2400.0, 2200.0]
            assert all(r[0] == "2026-05-04_05-10(P1W2)" for r in rows)
        finally:
            db.close()

    def test_upsert_preserves_rows_outside_date_range(self, tmp_path: Path):
        db = Database(db_path=tmp_path / "nut_outside.db")
        try:
            _seed_nutrition_row(
                db,
                week_folder="2026-04-27_05-03(W1)",
                date="2026-04-30",
                kcal_target=1500.0,
            )
            _seed_nutrition_row(
                db,
                week_folder="2026-05-11_05-17(W3)",
                date="2026-05-12",
                kcal_target=1600.0,
            )

            db.upsert_planned_nutrition(
                "2026-05-04_05-10(P1W2)",
                [
                    PlannedNutrition(date="2026-05-05", kcal_target=2400.0),
                ],
            )

            rows = db._conn.execute(
                "SELECT date, kcal_target "
                "FROM planned_nutrition ORDER BY date"
            ).fetchall()
            assert len(rows) == 3
            dates = [r[0] for r in rows]
            assert "2026-04-30" in dates
            assert "2026-05-05" in dates
            assert "2026-05-12" in dates
        finally:
            db.close()

    def test_upsert_falls_back_to_week_folder_when_folder_unparseable(
        self, tmp_path: Path,
    ):
        db = Database(db_path=tmp_path / "nut_unparseable.db")
        try:
            _seed_nutrition_row(
                db,
                week_folder="unusual-folder-name",
                date="2026-05-05",
                kcal_target=1234.0,
            )
            _seed_nutrition_row(
                db,
                week_folder="another-folder",
                date="2026-05-06",
                kcal_target=5678.0,
            )

            db.upsert_planned_nutrition(
                "unusual-folder-name",
                [
                    PlannedNutrition(date="2026-05-07", kcal_target=2400.0),
                ],
            )

            rows = db._conn.execute(
                "SELECT week_folder, kcal_target "
                "FROM planned_nutrition ORDER BY kcal_target"
            ).fetchall()
            kcals = [r[1] for r in rows]
            assert 1234.0 not in kcals
            assert 5678.0 in kcals
            assert 2400.0 in kcals
        finally:
            db.close()
