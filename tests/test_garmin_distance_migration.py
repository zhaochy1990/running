"""Regression: legacy Garmin metre distances are repaired to km, once, safely."""
from __future__ import annotations

from garmin_sync.migrations import (
    _DISTANCE_FIX_FLAG,
    migrate_distance_units_m_to_km,
)
from stride_storage.sqlite.database import Database


def _insert(db, label_id, distance_m, synced_at, provider="garmin"):
    db._conn.execute(
        "INSERT INTO activities (label_id, name, sport_type, date, distance_m, "
        "duration_s, provider, synced_at) VALUES (?,?,?,?,?,?,?,?)",
        (label_id, "run", 100, "2026-03-21T08:00:00+00:00", distance_m, 10300.0,
         provider, synced_at),
    )
    db._conn.commit()


def test_migrates_only_prefix_garmin_rows(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert(db, "old_meters", 42609.0, "2026-05-01 00:00:00")   # pre-fix garmin → metres
    _insert(db, "old_small",  244.0,  "2026-05-01 00:00:00")    # pre-fix tiny (the 244->244km bug)
    _insert(db, "new_km",     10.06,  "2026-06-01 00:00:00")    # post-fix garmin → already km
    _insert(db, "coros_row",  42.6,   "2026-05-01 00:00:00", provider="coros")  # not garmin

    n = migrate_distance_units_m_to_km(db)
    assert n == 2  # only the two pre-fix garmin rows

    def dist(lbl):
        return db._conn.execute(
            "SELECT distance_m FROM activities WHERE label_id=?", (lbl,)
        ).fetchone()[0]

    assert dist("old_meters") == 42.609          # 42609 m → 42.609 km
    assert dist("old_small") == 0.244            # 244 m → 0.244 km (no longer 244 km)
    assert dist("new_km") == 10.06               # post-fix row untouched
    assert dist("coros_row") == 42.6             # coros untouched
    assert db.get_meta(_DISTANCE_FIX_FLAG) == "1"


def test_idempotent(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert(db, "old_meters", 42609.0, "2026-05-01 00:00:00")

    assert migrate_distance_units_m_to_km(db) == 1  # first run converts the row
    after_first = db._conn.execute(
        "SELECT distance_m FROM activities WHERE label_id=?", ("old_meters",)
    ).fetchone()[0]
    assert after_first == 42.609

    assert migrate_distance_units_m_to_km(db) == 0  # flag set → no-op
    after_second = db._conn.execute(
        "SELECT distance_m FROM activities WHERE label_id=?", ("old_meters",)
    ).fetchone()[0]
    assert after_second == 42.609  # not divided twice
