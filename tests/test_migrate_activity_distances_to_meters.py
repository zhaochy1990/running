from stride_storage.sqlite.database import Database
import sqlite3

from scripts.migrate_activity_distances_to_meters import (
    _MIGRATION_FLAG,
    _backup,
    _candidate_counts,
    _migrate,
    _summarize,
)


def test_migrate_activity_and_lap_distances_to_meters(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.executemany(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            ("km-run", "km run", 100, "Run", "2026-05-04T00:00:00+00:00", 12.3, 3600.0, "coros"),
            ("meter-run", "meter run", 100, "Run", "2026-05-05T00:00:00+00:00", 12300.0, 3600.0, "coros"),
            ("zero", "zero", 402, "Strength", "2026-05-06T00:00:00+00:00", 0.0, 1800.0, "coros"),
        ],
    )
    conn.executemany(
        """INSERT INTO laps
           (label_id, lap_index, lap_type, distance_m, duration_s)
           VALUES (?, ?, ?, ?, ?)""",
        [
            ("km-run", 1, "autoKm", 1.0, 300.0),
            ("km-run", 2, "autoKm", 5.0, 1500.0),
            ("meter-run", 1, "autoKm", 1000.0, 300.0),
        ],
    )
    conn.commit()

    assert _candidate_counts(conn) == (1, 2)
    before = _summarize(conn)
    assert before["migration_flag"] is None
    assert before["activity_candidates"] == 1
    assert before["lap_candidates"] == 2

    result = _migrate(conn)
    assert result == {"status": "migrated", "activities_updated": 1, "laps_updated": 2}

    rows = {
        row["label_id"]: row["distance_m"]
        for row in conn.execute("SELECT label_id, distance_m FROM activities ORDER BY label_id")
    }
    assert rows == {"km-run": 12300.0, "meter-run": 12300.0, "zero": 0.0}

    laps = [
        row["distance_m"]
        for row in conn.execute("SELECT distance_m FROM laps ORDER BY label_id, lap_index")
    ]
    assert laps == [1000.0, 5000.0, 1000.0]
    assert db.get_meta(_MIGRATION_FLAG) == "1"

    second = _migrate(conn)
    assert second["status"] == "already_migrated"
    assert second["activities_updated"] == 0
    assert second["laps_updated"] == 0
    assert conn.execute(
        "SELECT distance_m FROM activities WHERE label_id='km-run'"
    ).fetchone()[0] == 12300.0
    db.close()


def test_migration_handles_legacy_schema_without_provider_column(tmp_path):
    conn = sqlite3.connect(tmp_path / "legacy.db")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE activities (
            label_id TEXT PRIMARY KEY,
            date TEXT,
            sport_type INTEGER,
            distance_m REAL,
            duration_s REAL,
            avg_pace_s_km REAL
        );
        CREATE TABLE laps (
            label_id TEXT,
            lap_index INTEGER,
            distance_m REAL,
            duration_s REAL,
            avg_pace REAL
        );
        """
    )
    conn.execute(
        """INSERT INTO activities
           (label_id, date, sport_type, distance_m, duration_s, avg_pace_s_km)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("legacy-km-run", "2026-05-04T00:00:00+00:00", 100, 10.0, 3000.0, 300.0),
    )
    conn.execute(
        """INSERT INTO laps
           (label_id, lap_index, distance_m, duration_s, avg_pace)
           VALUES (?, ?, ?, ?, ?)""",
        ("legacy-km-run", 1, 1.0, 300.0, 300.0),
    )
    conn.commit()

    before = _summarize(conn)
    assert before["activity_candidates"] == 1
    assert before["lap_candidates"] == 1

    result = _migrate(conn)
    assert result == {"status": "migrated", "activities_updated": 1, "laps_updated": 1}
    assert conn.execute("SELECT distance_m FROM activities").fetchone()[0] == 10000.0
    assert conn.execute("SELECT distance_m FROM laps").fetchone()[0] == 1000.0
    assert conn.execute(
        "SELECT value FROM sync_meta WHERE key = ?",
        (_MIGRATION_FLAG,),
    ).fetchone()[0] == "1"
    conn.close()


def test_migrate_activity_distance_when_laps_are_already_meters(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("mixed", "mixed", 100, "Run", "2026-05-04T00:00:00+00:00", 30.19, 11757.97, "coros"),
    )
    conn.executemany(
        """INSERT INTO laps
           (label_id, lap_index, lap_type, distance_m, duration_s)
           VALUES (?, ?, ?, ?, ?)""",
        [
            ("mixed", 1, "type2", 20000.0, 6315.57),
            ("mixed", 2, "type2", 10000.0, 3413.91),
            ("mixed", 3, "type2", 190.0, 60.0),
        ],
    )
    conn.commit()

    assert _candidate_counts(conn)[0] == 1
    result = _migrate(conn)
    assert result["activities_updated"] == 1
    assert conn.execute(
        "SELECT distance_m FROM activities WHERE label_id='mixed'"
    ).fetchone()[0] == 30190.0
    db.close()


def test_migrate_repairs_remaining_candidates_even_when_flag_exists(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("flagged", "flagged", 100, "Run", "2026-05-04T00:00:00+00:00", 30.19, 11757.97, "coros"),
    )
    conn.execute(
        "INSERT INTO timeseries (label_id, timestamp, distance) VALUES ('flagged', 100, 30190.0)"
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, '1')",
        (_MIGRATION_FLAG,),
    )
    conn.commit()

    result = _migrate(conn)
    assert result["status"] == "migrated_remaining"
    assert result["activities_updated"] == 1
    assert conn.execute(
        "SELECT distance_m FROM activities WHERE label_id='flagged'"
    ).fetchone()[0] == 30190.0
    db.close()


def test_migrate_is_idempotent_for_short_paused_activity_after_timeseries_migration(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
            avg_pace_s_km, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "paused-400m",
            "paused 400m",
            100,
            "Run",
            "2022-01-14T07:48:04+00:00",
            400.0,
            59012.0,
            148.18,
            "coros",
        ),
    )
    conn.execute(
        """INSERT INTO laps
           (label_id, lap_index, lap_type, distance_m, duration_s, avg_pace)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("paused-400m", 1, "type2", 400.0, 60.0, 148.18),
    )
    conn.execute(
        "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
        ("paused-400m", 100, 404.9),
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, '1')",
        (_MIGRATION_FLAG,),
    )
    conn.commit()

    assert _candidate_counts(conn)[0] == 0
    result = _migrate(conn)
    assert result["status"] == "already_migrated"
    assert result["activities_updated"] == 0
    assert conn.execute(
        "SELECT distance_m FROM activities WHERE label_id='paused-400m'"
    ).fetchone()[0] == 400.0
    db.close()


def test_migrate_short_activity_and_lap_using_timeseries_distance_evidence(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    conn = db._conn
    conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
            avg_pace_s_km, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "short-legacy",
            "short legacy",
            100,
            "Run",
            "2022-08-08T11:36:30+00:00",
            0.01,
            40.0,
            2074.7,
            "coros",
        ),
    )
    conn.execute(
        """INSERT INTO laps
           (label_id, lap_index, lap_type, distance_m, duration_s, avg_pace)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("short-legacy", 1, "type2", 0.01, 30.0, 2074.7),
    )
    conn.execute(
        "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
        ("short-legacy", 100, 14.46),
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, '1')",
        (_MIGRATION_FLAG,),
    )
    conn.commit()

    assert _candidate_counts(conn) == (1, 1)
    result = _migrate(conn)
    assert result["status"] == "migrated_remaining"
    assert result["activities_updated"] == 1
    assert result["laps_updated"] == 1
    assert conn.execute(
        "SELECT distance_m FROM activities WHERE label_id='short-legacy'"
    ).fetchone()[0] == 10.0
    assert conn.execute(
        "SELECT distance_m FROM laps WHERE label_id='short-legacy'"
    ).fetchone()[0] == 10.0
    assert _candidate_counts(conn) == (0, 0)
    db.close()


def test_backup_uses_sqlite_snapshot_for_wal_databases(tmp_path):
    db_path = tmp_path / "wal.db"
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT)")
    conn.execute("INSERT INTO marker (value) VALUES ('committed-in-wal')")
    conn.commit()
    assert db_path.with_name(db_path.name + "-wal").exists()

    backup_path = _backup(db_path)
    with sqlite3.connect(backup_path) as backup:
        value = backup.execute("SELECT value FROM marker WHERE id = 1").fetchone()[0]

    assert value == "committed-in-wal"
    conn.close()
