"""Tests for Database.fetch_timeseries used by segment PB scan."""
from __future__ import annotations

from stride_storage.sqlite.database import Database


def _insert_activity(db, label_id="X"):
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s, provider) "
        "VALUES (?, 100, '2026-05-27T10:00:00+00:00', 5000.0, 1200, 'coros')",
        (label_id,),
    )


def test_fetch_timeseries_returns_ordered_rows(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_activity(db, "X")
    for ts, dist in [(300, 5000), (100, 1000), (200, 3000), (0, 0)]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
            ("X", ts, dist),
        )
    db._conn.commit()
    rows = db.fetch_timeseries("X")
    assert [r["timestamp"] for r in rows] == [0, 100, 200, 300]
    assert [r["distance"] for r in rows] == [0, 1000, 3000, 5000]


def test_fetch_timeseries_skips_null_distance(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_activity(db, "X")
    for ts, dist in [(0, 0), (100, None), (200, 2000)]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
            ("X", ts, dist),
        )
    db._conn.commit()
    rows = db.fetch_timeseries("X")
    assert len(rows) == 2
    assert all(r["distance"] is not None for r in rows)


def test_fetch_timeseries_returns_empty_for_unknown_label(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    assert db.fetch_timeseries("NOPE") == []
