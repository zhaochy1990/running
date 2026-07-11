from __future__ import annotations

from stride_storage.sqlite.database import Database

from scripts.migrate_distance_aux_tables import (
    _TIMESERIES_FLAG,
    _VO2MAX_PB_FLAG,
    _migrate,
    _summarize,
)


def test_migrate_timeseries_cm_to_meters_and_keeps_garmin_meters(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.executemany(
        """INSERT INTO activities
           (label_id, sport_type, date, distance_m, duration_s, provider)
           VALUES (?, ?, ?, ?, ?, ?)""",
        [
            ("coros-cm", 100, "2026-05-01T00:00:00+00:00", 5000.0, 1200.0, "coros"),
            ("garmin-m", 8001, "2026-05-01T00:00:00+00:00", 5000.0, 1200.0, "garmin"),
            ("coros-m", 100, "2026-05-02T00:00:00+00:00", 5000.0, 1200.0, "coros"),
        ],
    )
    conn.executemany(
        "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
        [
            ("coros-cm", 0, 0.0),
            ("coros-cm", 100, 500000.0),
            ("garmin-m", 0, 0.0),
            ("garmin-m", 100, 5000.0),
            ("coros-m", 0, 0.0),
            ("coros-m", 100, 5000.0),
        ],
    )
    conn.commit()

    before = _summarize(conn)
    assert before["timeseries_legacy_label_count"] == 1

    result = _migrate(conn)
    assert result["timeseries_labels_updated"] == 1

    rows = {
        row["label_id"]: row["max_distance"]
        for row in conn.execute(
            """SELECT label_id, MAX(distance) AS max_distance
               FROM timeseries GROUP BY label_id"""
        )
    }
    assert rows == {"coros-cm": 5000.0, "garmin-m": 5000.0, "coros-m": 5000.0}
    assert db.get_meta(_TIMESERIES_FLAG) == "1"

    second = _migrate(conn)
    assert second["timeseries_labels_updated"] == 0
    db.close()


def test_migrate_timeseries_does_not_double_divide_when_activity_still_km_like(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.execute(
        """INSERT INTO activities
           (label_id, sport_type, date, distance_m, duration_s, provider)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("activity-km-ts-m", 100, "2026-05-01T00:00:00+00:00", 30.19, 11757.97, "coros"),
    )
    conn.executemany(
        "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
        [
            ("activity-km-ts-m", 0, 0.0),
            ("activity-km-ts-m", 100, 30190.0),
        ],
    )
    conn.commit()

    before = _summarize(conn)
    assert before["timeseries_legacy_label_count"] == 0

    result = _migrate(conn)
    assert result["timeseries_labels_updated"] == 0
    assert conn.execute(
        "SELECT MAX(distance) FROM timeseries WHERE label_id='activity-km-ts-m'"
    ).fetchone()[0] == 30190.0
    db.close()


def test_migrate_vo2max_pb_km_rows_to_canonical_meters(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.executemany(
        """INSERT INTO vo2max_pb
           (race_type, distance_m, duration_s, vdot, pb_date, label_id)
           VALUES (?, ?, ?, ?, ?, ?)""",
        [
            ("5K", 5.0, 1200.0, 50.0, "2026-05-01", "a"),
            ("10K", 10.08, 2450.0, 51.0, "2026-05-02", "b"),
            ("half", 21.3, 5200.0, 52.0, "2026-05-03", "c"),
            ("full", 42.45, 10800.0, 53.0, "2026-05-04", "d"),
            ("5K", 5000.0, 1210.0, 49.0, "2026-05-05", "e"),
        ],
    )
    conn.commit()

    before = _summarize(conn)
    assert before["vo2max_pb_legacy_rows"] == 4

    result = _migrate(conn)
    assert result["vo2max_pb_rows_updated"] == 4

    rows = {
        row["label_id"]: row["distance_m"]
        for row in conn.execute("SELECT label_id, distance_m FROM vo2max_pb")
    }
    assert rows == {
        "a": 5000.0,
        "b": 10000.0,
        "c": 21097.5,
        "d": 42195.0,
        "e": 5000.0,
    }
    assert db.get_meta(_VO2MAX_PB_FLAG) == "1"

    second = _migrate(conn)
    assert second["vo2max_pb_rows_updated"] == 0
    db.close()
