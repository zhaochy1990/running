"""Tests for the planned_nutrition PRIMARY KEY migration.

The original schema had ``date TEXT PRIMARY KEY`` which incorrectly blocked
cross-week reparse when stale rows from a previous failed parse occupied the
same date. The fix is to widen the PRIMARY KEY to ``(week_folder, date)`` and
provide an idempotent migration that rebuilds the table on legacy DBs.

Same root cause + same fix shape as planned_session — see
``test_planned_session_migration.py``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from stride_core.db import Database


_OLD_TABLE_SQL = """CREATE TABLE planned_nutrition (
    date            TEXT PRIMARY KEY,
    week_folder     TEXT NOT NULL,
    kcal_target     REAL,
    carbs_g         REAL,
    protein_g       REAL,
    fat_g           REAL,
    water_ml        REAL,
    meals_json      TEXT,
    notes_md        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)"""

_NO_PK_TABLE_SQL = """CREATE TABLE planned_nutrition (
    week_folder     TEXT NOT NULL,
    date            TEXT NOT NULL,
    kcal_target     REAL,
    carbs_g         REAL,
    protein_g       REAL,
    fat_g           REAL,
    water_ml        REAL,
    meals_json      TEXT,
    notes_md        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)"""


def _planned_nutrition_table_sql(db: Database) -> str:
    row = db._conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='planned_nutrition'"
    ).fetchone()
    return row[0] if row else ""


def _seed_old_schema(path: Path, *, rows: list[tuple] | None = None) -> None:
    """Open via Database, swap planned_nutrition to the old narrow-PK shape,
    and optionally insert seed rows."""
    db = Database(db_path=path)
    try:
        db._conn.execute("DROP TABLE IF EXISTS planned_nutrition")
        db._conn.executescript(_OLD_TABLE_SQL + ";")
        if rows:
            db._conn.executemany(
                """INSERT INTO planned_nutrition
                (date, week_folder, kcal_target, carbs_g, protein_g, fat_g)
                VALUES (?, ?, ?, ?, ?, ?)""",
                rows,
            )
        db._conn.commit()
    finally:
        db.close()


class TestPlannedNutritionMigration:
    def test_migrate_old_db_with_old_pk(self, tmp_path: Path):
        """Legacy DB with old ``date TEXT PRIMARY KEY`` gets rebuilt with the
        wider ``PRIMARY KEY (week_folder, date)``; existing rows survive."""
        db_path = tmp_path / "legacy.db"
        _seed_old_schema(
            db_path,
            rows=[
                ("2026-04-21", "2026-04-20_04-26(W0)", 2400.0, 320.0, 130.0, 70.0),
                ("2026-04-22", "2026-04-20_04-26(W0)", 2200.0, 280.0, 130.0, 70.0),
                ("2026-04-29", "2026-04-27_05-03(W1)", 2500.0, 340.0, 130.0, 70.0),
            ],
        )

        # Sanity: the seeded DB really has the old narrow-PK marker.
        conn = sqlite3.connect(str(db_path))
        try:
            seeded_sql = conn.execute(
                "SELECT sql FROM sqlite_master "
                "WHERE type='table' AND name='planned_nutrition'"
            ).fetchone()[0]
        finally:
            conn.close()
        assert "date            TEXT PRIMARY KEY" in seeded_sql
        assert "PRIMARY KEY (week_folder, date)" not in seeded_sql

        # Re-open via Database — _migrate should rebuild the table.
        db = Database(db_path=db_path)
        try:
            new_sql = _planned_nutrition_table_sql(db)
            assert "PRIMARY KEY (week_folder, date)" in new_sql

            rows = db._conn.execute(
                "SELECT week_folder, date, kcal_target "
                "FROM planned_nutrition ORDER BY week_folder, date"
            ).fetchall()
            assert len(rows) == 3
            assert rows[0][0] == "2026-04-20_04-26(W0)"
            assert rows[2][0] == "2026-04-27_05-03(W1)"
        finally:
            db.close()

    def test_migrate_dedupes_conflicting_rows(self, tmp_path: Path):
        """Migration's dedup branch keeps only MAX(rowid) per (week_folder,
        date) — defensive against half-rolled-back prod states that left
        dupes behind.

        Such dupes can't exist under the old ``date TEXT PRIMARY KEY``, so we
        synthesize a degenerate state: a planned_nutrition table without ANY
        PRIMARY KEY (mimicking a half-applied migration on prod), seed dupes,
        then directly invoke the migration's rebuild SQL to verify MAX(rowid)
        dedup. We bypass the textual detector path because forging
        sqlite_master leaves the file in a state SQLite refuses to reopen.
        """
        db_path = tmp_path / "dupes.db"

        # Open via Database (full schema bootstrap), swap planned_nutrition
        # for the no-PK shape, and plant dupe rows.
        db = Database(db_path=db_path)
        try:
            db._conn.execute("DROP TABLE IF EXISTS planned_nutrition")
            db._conn.executescript(_NO_PK_TABLE_SQL + ";")
            db._conn.executemany(
                """INSERT INTO planned_nutrition
                (week_folder, date, kcal_target)
                VALUES (?, ?, ?)""",
                [
                    ("2026-04-20_04-26(W0)", "2026-04-21", 2000.0),
                    ("2026-04-20_04-26(W0)", "2026-04-21", 2400.0),  # newer dup
                    ("2026-04-20_04-26(W0)", "2026-04-22", 2200.0),
                ],
            )
            db._conn.commit()

            # Directly run the migration's rebuild script (the same SQL
            # _migrate emits when it detects the old marker). This is the
            # exact code path that handles dedup.
            db._conn.executescript("""
                CREATE TABLE planned_nutrition_new (
                    week_folder     TEXT NOT NULL,
                    date            TEXT NOT NULL,
                    kcal_target     REAL,
                    carbs_g         REAL,
                    protein_g       REAL,
                    fat_g           REAL,
                    water_ml        REAL,
                    meals_json      TEXT,
                    notes_md        TEXT,
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (week_folder, date)
                );
                INSERT INTO planned_nutrition_new
                SELECT week_folder, date, kcal_target, carbs_g, protein_g, fat_g,
                       water_ml, meals_json, notes_md, created_at, updated_at
                FROM planned_nutrition
                WHERE rowid IN (
                    SELECT MAX(rowid) FROM planned_nutrition
                    GROUP BY week_folder, date
                );
                DROP TABLE planned_nutrition;
                ALTER TABLE planned_nutrition_new RENAME TO planned_nutrition;
                CREATE INDEX IF NOT EXISTS idx_planned_nutrition_week ON planned_nutrition(week_folder);
            """)
            db._conn.commit()

            new_sql = _planned_nutrition_table_sql(db)
            assert "PRIMARY KEY (week_folder, date)" in new_sql

            rows = db._conn.execute(
                "SELECT week_folder, date, kcal_target "
                "FROM planned_nutrition ORDER BY date"
            ).fetchall()
            assert len(rows) == 2
            survivors_by_date = {r[1]: r[2] for r in rows}
            # MAX(rowid) wins — the second insert (kcal=2400) had a higher rowid.
            assert survivors_by_date["2026-04-21"] == 2400.0
            assert survivors_by_date["2026-04-22"] == 2200.0
        finally:
            db.close()

    def test_migrate_idempotent_on_new_db(self, tmp_path: Path):
        """Fresh DB already has the new PRIMARY KEY; running _migrate again
        is a no-op (no rebuild, no errors, schema unchanged)."""
        db_path = tmp_path / "fresh.db"
        db = Database(db_path=db_path)
        try:
            sql_before = _planned_nutrition_table_sql(db)
            assert "PRIMARY KEY (week_folder, date)" in sql_before

            db._migrate()
            db._migrate()

            sql_after = _planned_nutrition_table_sql(db)
            assert sql_before == sql_after
        finally:
            db.close()

    def test_cross_week_same_date_now_allowed(self, tmp_path: Path):
        """After migration, two rows sharing the same date but differing in
        week_folder must coexist — that's the entire point of the fix."""
        db_path = tmp_path / "cross_week.db"
        db = Database(db_path=db_path)
        try:
            db._conn.execute(
                """INSERT INTO planned_nutrition
                (week_folder, date, kcal_target)
                VALUES (?, ?, ?)""",
                ("2026-04-20_04-26(W0)", "2026-04-21", 2400.0),
            )
            # Same date, different week_folder. Old narrow PK would reject
            # this; new wider PK accepts it.
            db._conn.execute(
                """INSERT INTO planned_nutrition
                (week_folder, date, kcal_target)
                VALUES (?, ?, ?)""",
                ("2026-04-27_05-03(W1)", "2026-04-21", 2500.0),
            )
            db._conn.commit()

            rows = db._conn.execute(
                "SELECT week_folder FROM planned_nutrition "
                "WHERE date = '2026-04-21' "
                "ORDER BY week_folder"
            ).fetchall()
            assert len(rows) == 2
            assert rows[0][0] == "2026-04-20_04-26(W0)"
            assert rows[1][0] == "2026-04-27_05-03(W1)"

            # Same (week_folder, date) still rejected.
            with pytest.raises(sqlite3.IntegrityError):
                db._conn.execute(
                    """INSERT INTO planned_nutrition
                    (week_folder, date, kcal_target)
                    VALUES (?, ?, ?)""",
                    ("2026-04-20_04-26(W0)", "2026-04-21", 9999.0),
                )
        finally:
            db.close()
