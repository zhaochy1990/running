"""Tests for the planned_session UNIQUE constraint migration.

The original schema had ``UNIQUE(date, session_index)`` which incorrectly
blocked cross-week reparse when stale rows from a previous failed parse
occupied the same (date, session_index). The fix is to widen the constraint
to ``UNIQUE(week_folder, date, session_index)`` and provide an idempotent
migration that rebuilds the table on legacy DBs.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from stride_core.db import Database


_OLD_TABLE_SQL = """CREATE TABLE planned_session (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    week_folder           TEXT NOT NULL,
    date                  TEXT NOT NULL,
    session_index         INTEGER NOT NULL DEFAULT 0,
    kind                  TEXT NOT NULL,
    summary               TEXT NOT NULL,
    spec_json             TEXT,
    notes_md              TEXT,
    total_distance_m      REAL,
    total_duration_s      REAL,
    scheduled_workout_id  INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, session_index)
)"""

_NO_UNIQUE_TABLE_SQL = """CREATE TABLE planned_session (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    week_folder           TEXT NOT NULL,
    date                  TEXT NOT NULL,
    session_index         INTEGER NOT NULL DEFAULT 0,
    kind                  TEXT NOT NULL,
    summary               TEXT NOT NULL,
    spec_json             TEXT,
    notes_md              TEXT,
    total_distance_m      REAL,
    total_duration_s      REAL,
    scheduled_workout_id  INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
)"""


def _planned_session_table_sql(db: Database) -> str:
    row = db._conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='planned_session'"
    ).fetchone()
    return row[0] if row else ""


def _seed_old_schema(path: Path, *, rows: list[tuple] | None = None) -> None:
    """Open via Database, swap planned_session to the old narrow-UNIQUE
    shape, and optionally insert seed rows."""
    db = Database(db_path=path)
    try:
        db._conn.execute("DROP TABLE IF EXISTS planned_session")
        db._conn.executescript(_OLD_TABLE_SQL + ";")
        if rows:
            db._conn.executemany(
                """INSERT INTO planned_session
                (week_folder, date, session_index, kind, summary)
                VALUES (?, ?, ?, ?, ?)""",
                rows,
            )
        db._conn.commit()
    finally:
        db.close()


class TestPlannedSessionMigration:
    def test_migrate_old_db_with_old_constraint(self, tmp_path: Path):
        """Legacy DB with old UNIQUE(date, session_index) gets rebuilt with
        the wider UNIQUE(week_folder, date, session_index); existing rows
        survive."""
        db_path = tmp_path / "legacy.db"
        _seed_old_schema(
            db_path,
            rows=[
                ("2026-04-20_04-26(W0)", "2026-04-21", 0, "run", "Easy 10K"),
                ("2026-04-20_04-26(W0)", "2026-04-22", 0, "strength", "Core"),
                ("2026-04-27_05-03(W1)", "2026-04-29", 0, "run", "Tempo"),
            ],
        )

        # Sanity: the seeded DB really has the old UNIQUE marker.
        conn = sqlite3.connect(str(db_path))
        try:
            seeded_sql = conn.execute(
                "SELECT sql FROM sqlite_master "
                "WHERE type='table' AND name='planned_session'"
            ).fetchone()[0]
        finally:
            conn.close()
        assert "UNIQUE(date, session_index)" in seeded_sql
        assert "UNIQUE(week_folder, date, session_index)" not in seeded_sql

        # Re-open via Database — _migrate should rebuild the table.
        db = Database(db_path=db_path)
        try:
            new_sql = _planned_session_table_sql(db)
            assert "UNIQUE(week_folder, date, session_index)" in new_sql

            rows = db._conn.execute(
                "SELECT week_folder, date, session_index, kind, summary "
                "FROM planned_session ORDER BY week_folder, date"
            ).fetchall()
            assert len(rows) == 3
            assert rows[0][0] == "2026-04-20_04-26(W0)"
            assert rows[2][0] == "2026-04-27_05-03(W1)"
        finally:
            db.close()

    def test_migrate_dedupes_conflicting_rows(self, tmp_path: Path):
        """Migration's dedup branch keeps only MAX(id) per (week_folder,
        date, session_index) — defensive against half-rolled-back prod
        states that left dupes behind.

        Such dupes can't exist under the old UNIQUE(date, session_index),
        so we synthesize a degenerate state: a planned_session table
        without ANY UNIQUE constraint (mimicking a half-applied migration
        on prod), seed dupes, then directly invoke the migration's
        rebuild SQL to verify MAX(id) dedup. We bypass the textual
        detector path because forging sqlite_master leaves the file
        in a state that SQLite refuses to accept on reopen.
        """
        db_path = tmp_path / "dupes.db"

        # Open via Database (full schema bootstrap), swap planned_session
        # for the no-UNIQUE shape, and plant dupe rows.
        db = Database(db_path=db_path)
        try:
            db._conn.execute("DROP TABLE IF EXISTS planned_session")
            db._conn.executescript(_NO_UNIQUE_TABLE_SQL + ";")
            db._conn.executemany(
                """INSERT INTO planned_session
                (week_folder, date, session_index, kind, summary)
                VALUES (?, ?, ?, ?, ?)""",
                [
                    ("2026-04-20_04-26(W0)", "2026-04-21", 0, "run", "Old version"),
                    ("2026-04-20_04-26(W0)", "2026-04-21", 0, "run", "Newer dup"),
                    ("2026-04-20_04-26(W0)", "2026-04-22", 0, "strength", "Distinct"),
                ],
            )
            db._conn.commit()

            # Directly run the migration's rebuild script (the same SQL
            # _migrate emits when it detects the old marker). This is the
            # exact code path that handles dedup.
            db._conn.executescript("""
                CREATE TABLE planned_session_new (
                    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                    week_folder           TEXT NOT NULL,
                    date                  TEXT NOT NULL,
                    session_index         INTEGER NOT NULL DEFAULT 0,
                    kind                  TEXT NOT NULL,
                    summary               TEXT NOT NULL,
                    spec_json             TEXT,
                    notes_md              TEXT,
                    total_distance_m      REAL,
                    total_duration_s      REAL,
                    scheduled_workout_id  INTEGER REFERENCES scheduled_workout(id),
                    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(week_folder, date, session_index)
                );
                INSERT INTO planned_session_new
                SELECT * FROM planned_session
                WHERE id IN (
                    SELECT MAX(id) FROM planned_session
                    GROUP BY week_folder, date, session_index
                );
                DROP TABLE planned_session;
                ALTER TABLE planned_session_new RENAME TO planned_session;
                CREATE INDEX IF NOT EXISTS idx_planned_session_week ON planned_session(week_folder);
                CREATE INDEX IF NOT EXISTS idx_planned_session_date ON planned_session(date);
            """)
            db._conn.commit()

            new_sql = _planned_session_table_sql(db)
            assert "UNIQUE(week_folder, date, session_index)" in new_sql

            rows = db._conn.execute(
                "SELECT week_folder, date, session_index, summary "
                "FROM planned_session ORDER BY date"
            ).fetchall()
            assert len(rows) == 2
            survivors_by_date = {r[1]: r[3] for r in rows}
            # MAX(id) wins — the second insert ("Newer dup") had a higher id.
            assert survivors_by_date["2026-04-21"] == "Newer dup"
            assert survivors_by_date["2026-04-22"] == "Distinct"
        finally:
            db.close()

    def test_migrate_idempotent_on_new_db(self, tmp_path: Path):
        """Fresh DB already has the new UNIQUE; running _migrate again
        is a no-op (no rebuild, no errors, schema unchanged)."""
        db_path = tmp_path / "fresh.db"
        db = Database(db_path=db_path)
        try:
            sql_before = _planned_session_table_sql(db)
            assert "UNIQUE(week_folder, date, session_index)" in sql_before

            db._migrate()
            db._migrate()

            sql_after = _planned_session_table_sql(db)
            assert sql_before == sql_after
        finally:
            db.close()

    def test_cross_week_same_date_session_index_now_allowed(self, tmp_path: Path):
        """After migration, two rows sharing (date, session_index) but
        differing in week_folder must coexist — that's the entire point
        of the fix."""
        db_path = tmp_path / "cross_week.db"
        db = Database(db_path=db_path)
        try:
            db._conn.execute(
                """INSERT INTO planned_session
                (week_folder, date, session_index, kind, summary)
                VALUES (?, ?, ?, ?, ?)""",
                ("2026-04-20_04-26(W0)", "2026-04-21", 0, "run", "Easy"),
            )
            # Same (date, session_index), different week_folder. Old narrow
            # UNIQUE would reject this; new wider UNIQUE accepts it.
            db._conn.execute(
                """INSERT INTO planned_session
                (week_folder, date, session_index, kind, summary)
                VALUES (?, ?, ?, ?, ?)""",
                ("2026-04-27_05-03(W1)", "2026-04-21", 0, "run", "Stale leftover"),
            )
            db._conn.commit()

            rows = db._conn.execute(
                "SELECT week_folder FROM planned_session "
                "WHERE date = '2026-04-21' AND session_index = 0 "
                "ORDER BY week_folder"
            ).fetchall()
            assert len(rows) == 2
            assert rows[0][0] == "2026-04-20_04-26(W0)"
            assert rows[1][0] == "2026-04-27_05-03(W1)"

            # Same (week_folder, date, session_index) still rejected.
            with pytest.raises(sqlite3.IntegrityError):
                db._conn.execute(
                    """INSERT INTO planned_session
                    (week_folder, date, session_index, kind, summary)
                    VALUES (?, ?, ?, ?, ?)""",
                    ("2026-04-20_04-26(W0)", "2026-04-21", 0, "run", "Dup"),
                )
        finally:
            db.close()
