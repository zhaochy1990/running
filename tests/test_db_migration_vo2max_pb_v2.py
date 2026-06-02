"""Tests for the vo2max_pb v1→v2 schema migration."""
from __future__ import annotations

import sqlite3
import pytest

from stride_core.db import Database


V1_SCHEMA = """
CREATE TABLE vo2max_pb (
    race_type       TEXT PRIMARY KEY,
    distance_m      REAL NOT NULL,
    duration_s      REAL NOT NULL,
    vdot            REAL NOT NULL,
    pb_date         TEXT NOT NULL,
    label_id        TEXT NOT NULL,
    even_paced      INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)
"""


def _open_with_v1(tmp_path):
    """Create a DB with the v1 schema and return a raw sqlite3 connection."""
    db_path = tmp_path / "coros.db"
    con = sqlite3.connect(db_path)
    con.execute(V1_SCHEMA)
    con.commit()
    return db_path, con


def test_migrate_populated_table_v1_to_v2(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    rows = [
        ("5K", 5000, 1199.64, 49.8, "2026-04-24", "477029282768519567", 1),
        ("10K", 10060, 2453, 51.0, "2026-04-25", "477053397399273475", 1),
    ]
    con.executemany(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
        rows,
    )
    con.commit()
    con.close()

    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()

    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols

    out = list(db._conn.execute(
        "SELECT race_type, label_id, vdot FROM vo2max_pb ORDER BY race_type"
    ))
    assert len(out) == 2
    assert out[0]["race_type"] == "10K"
    assert out[1]["race_type"] == "5K"


def test_migrate_is_idempotent(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    con.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id) VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'X')"
    )
    con.commit()
    con.close()

    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()
    db._migrate_vo2max_pb_to_v2()

    rows = list(db._conn.execute("SELECT race_type, label_id FROM vo2max_pb"))
    assert len(rows) == 1
    assert rows[0]["race_type"] == "5K"


def test_migrate_empty_table_v1_to_v2(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    con.close()

    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()

    rows = list(db._conn.execute("SELECT * FROM vo2max_pb"))
    assert rows == []
    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols


def test_migrate_creates_unique_index_and_constraint(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    con.close()
    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()
    db._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
            "pb_date, label_id, even_paced, updated_at) "
            "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
        )


def test_fresh_database_creates_v2_schema(tmp_path):
    """A brand-new DB (no v1) should already be on v2 — no migration needed."""
    db_path = tmp_path / "fresh_coros.db"
    db = Database(db_path=db_path)
    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols
    db._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
            "pb_date, label_id, even_paced, updated_at) "
            "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
        )


def test_existing_v1_db_auto_migrates_on_open(tmp_path):
    """Opening a v1 DB via Database(...) should auto-migrate to v2."""
    db_path, con = _open_with_v1(tmp_path)
    con.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id) VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A')"
    )
    con.commit()
    con.close()

    db = Database(db_path=db_path)  # _migrate should run _migrate_vo2max_pb_to_v2
    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols
    rows = list(db._conn.execute("SELECT race_type, label_id FROM vo2max_pb"))
    assert len(rows) == 1
