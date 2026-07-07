"""Tests for the v2 upsert: keyed on (race_type, label_id), vdot-monotonic."""
from __future__ import annotations

import pytest

from stride_storage.sqlite.database import Database


@pytest.fixture
def db(tmp_path):
    return Database(db_path=tmp_path / "coros.db")


def _upsert(db, *, race_type, label_id, vdot, distance_m=5000.0,
            duration_s=1200.0, pb_date="2026-04-24"):
    return db.upsert_vo2max_pb(
        race_type=race_type, distance_m=distance_m, duration_s=duration_s,
        vdot=vdot, pb_date=pb_date, label_id=label_id, even_paced=True,
    )


def test_two_activities_same_race_type_both_persist(db):
    """Two different activities for 5K → two rows (PB history)."""
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0)
    assert _upsert(db, race_type="5K", label_id="B", vdot=50.0)
    rows = list(db._conn.execute(
        "SELECT label_id, vdot FROM vo2max_pb WHERE race_type='5K' "
        "ORDER BY vdot DESC"
    ))
    assert [r["label_id"] for r in rows] == ["B", "A"]


def test_resync_same_activity_idempotent(db):
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0)
    # Re-sync with same vdot → no change (returns False)
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0) is False
    rows = list(db._conn.execute("SELECT label_id, vdot FROM vo2max_pb"))
    assert len(rows) == 1


def test_recompute_higher_vdot_for_same_activity_updates(db):
    """If a recompute on the same activity yields a higher VDOT, the row
    updates (e.g., algorithm improvement)."""
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0)
    assert _upsert(db, race_type="5K", label_id="A", vdot=51.0) is True
    row = db._conn.execute(
        "SELECT vdot FROM vo2max_pb WHERE race_type='5K' AND label_id='A'"
    ).fetchone()
    assert row["vdot"] == pytest.approx(51.0)


def test_recompute_lower_vdot_for_same_activity_keeps_higher(db):
    assert _upsert(db, race_type="5K", label_id="A", vdot=51.0)
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0) is False
    row = db._conn.execute(
        "SELECT vdot FROM vo2max_pb WHERE race_type='5K' AND label_id='A'"
    ).fetchone()
    assert row["vdot"] == pytest.approx(51.0)


def test_different_race_types_same_activity_both_persist(db):
    """13km long run with embedded 5K and 10K segments → 2 rows under same
    label_id but different race_types."""
    assert _upsert(db, race_type="5K", label_id="A", vdot=50.0, distance_m=5000.0)
    assert _upsert(db, race_type="10K", label_id="A", vdot=51.0, distance_m=10000.0)
    rows = list(db._conn.execute("SELECT race_type FROM vo2max_pb WHERE label_id='A'"))
    assert sorted(r["race_type"] for r in rows) == ["10K", "5K"]


def test_v2_upsert_atomic_under_concurrent_connections(tmp_path):
    """Two connections racing on the same (race_type, label_id) — the
    second commit must not demote a higher-vdot first commit."""
    import sqlite3
    db_path = tmp_path / "coros.db"
    db_a = Database(db_path=db_path)
    db_b = Database(db_path=db_path)

    db_a.upsert_vo2max_pb(
        race_type="5K", distance_m=5000, duration_s=1170, vdot=51.0,
        pb_date="2026-05-27", label_id="A", even_paced=True,
    )
    # Attempt to demote
    written = db_b.upsert_vo2max_pb(
        race_type="5K", distance_m=5000, duration_s=1200, vdot=49.0,
        pb_date="2026-05-27", label_id="A", even_paced=True,
    )
    assert written is False
    row = db_a._conn.execute(
        "SELECT vdot FROM vo2max_pb WHERE race_type='5K' AND label_id='A'"
    ).fetchone()
    assert row["vdot"] == pytest.approx(51.0)
