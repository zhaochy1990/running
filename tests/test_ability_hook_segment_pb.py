"""Tests for run_ability_hook segment PB scan path.

Uses an in-memory-ish on-disk SQLite DB seeded with one activity + a
synthetic timeseries; calls run_ability_hook and asserts on vo2max_pb.
"""
from __future__ import annotations

import pytest

from stride_storage.sqlite.database import Database
from stride_core.ability_hook import run_ability_hook
from stride_core.models import RUN_SPORT_IDS


RUN_SPORT_ID = next(iter(RUN_SPORT_IDS))


def _seed_activity_with_timeseries(
    db, label_id, *, total_dist_km, total_dur_s,
    sport_type=RUN_SPORT_ID,
    pauses_json=None,
):
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, "
        "duration_s, avg_hr, max_hr, provider, pauses) "
        "VALUES (?, ?, '2026-05-27T10:00:00+00:00', ?, ?, 150, 175, 'coros', ?)",
        (label_id, sport_type, total_dist_km, total_dur_s, pauses_json),
    )
    total_dist_cm = int(total_dist_km * 1000 * 100)
    n = int(total_dur_s) + 1
    for i in range(n):
        t_tick = 100_000_000 + i * 100
        dist_cm = int(total_dist_cm * (i / max(1, n - 1)))
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) "
            "VALUES (?, ?, ?)",
            (label_id, t_tick, dist_cm),
        )
    db._conn.commit()


def test_hook_writes_5k_segment_pb_from_5km_activity(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "A", total_dist_km=5.0, total_dur_s=1170)
    run_ability_hook(db, ["A"])
    rows = list(db._conn.execute(
        "SELECT race_type, label_id, duration_s FROM vo2max_pb"
    ))
    pbs = {r["race_type"]: r for r in rows}
    assert "5K" in pbs
    assert pbs["5K"]["label_id"] == "A"
    assert pbs["5K"]["duration_s"] == pytest.approx(1170, abs=2)


def test_hook_writes_5k_and_10k_from_long_run(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "B", total_dist_km=13.0, total_dur_s=4000)
    run_ability_hook(db, ["B"])
    race_types = {r["race_type"] for r in db._conn.execute(
        "SELECT race_type FROM vo2max_pb WHERE label_id='B'"
    )}
    assert race_types == {"5K", "10K"}


def test_hook_idempotent_on_resync(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "A", total_dist_km=5.0, total_dur_s=1170)
    run_ability_hook(db, ["A"])
    run_ability_hook(db, ["A"])
    rows = list(db._conn.execute(
        "SELECT COUNT(*) AS n FROM vo2max_pb WHERE label_id='A'"
    ))
    assert rows[0]["n"] == 1


def test_hook_skips_non_running_sport(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "S", total_dist_km=0.0,
                                    total_dur_s=2700, sport_type=200)
    run_ability_hook(db, ["S"])
    rows = list(db._conn.execute("SELECT * FROM vo2max_pb"))
    assert rows == []


def test_hook_skips_activity_without_timeseries(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, "
        "duration_s, provider) "
        "VALUES ('NOTS', ?, '2026-05-27T10:00:00+00:00', 5.0, 1200, 'coros')",
        (RUN_SPORT_ID,),
    )
    db._conn.commit()
    run_ability_hook(db, ["NOTS"])
    rows = list(db._conn.execute("SELECT * FROM vo2max_pb"))
    assert rows == []


def test_hook_skips_segment_overlapping_pause(tmp_path):
    """5km activity with a pause from t=300s to t=400s (absolute ticks
    100030000..100040000). No 5K segment can avoid the pause → no PB."""
    db = Database(db_path=tmp_path / "coros.db")
    pauses_json = '[{"start_ts": 100030000, "end_ts": 100040000, "type": 0}]'
    _seed_activity_with_timeseries(
        db, "P", total_dist_km=5.0, total_dur_s=1170,
        pauses_json=pauses_json,
    )
    run_ability_hook(db, ["P"])
    rows = list(db._conn.execute(
        "SELECT * FROM vo2max_pb WHERE race_type='5K'"
    ))
    assert rows == []
