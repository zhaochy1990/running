"""Integration regression test: real 2026-05-27 long-run-with-embedded-5K-tempo
activity must yield a 5K PB ≈ 19:30 via the segment scan path. This locks in
the bug-fix that motivated the feature."""
from __future__ import annotations

import json
import pytest
from pathlib import Path

from stride_storage.sqlite.database import Database
from stride_core.ability_hook import run_ability_hook


FIXTURE = (
    Path(__file__).parent / "fixtures" / "segment_pb"
    / "activity_477783793625760045.json"
)


@pytest.fixture
def db_with_fixture(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    data = json.loads(FIXTURE.read_text())
    a = data["activity"]
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, "
        "duration_s, avg_hr, max_hr, train_kind, train_type, pauses, provider) "
        "VALUES (:label_id, :sport_type, :date, :distance_m, :duration_s, "
        ":avg_hr, :max_hr, :train_kind, :train_type, :pauses, :provider)",
        a,
    )
    for point in data["timeseries"]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) "
            "VALUES (?, ?, ?)",
            (a["label_id"], point["timestamp"], point["distance"]),
        )
    db._conn.commit()
    return db


def test_segment_pb_for_2026_05_27_long_run_tempo(db_with_fixture):
    """The 13.36 km activity 477783793625760045 contains a 5km segment in
    ~19:30. After the hook runs, vo2max_pb has a 5K row with that label_id
    and duration ≈ 1170 s."""
    label_id = "477783793625760045"
    run_ability_hook(db_with_fixture, [label_id])

    row = db_with_fixture._conn.execute(
        "SELECT race_type, duration_s, vdot, label_id "
        "FROM vo2max_pb WHERE race_type='5K' AND label_id=?",
        (label_id,),
    ).fetchone()
    assert row is not None
    assert row["duration_s"] == pytest.approx(1170, abs=5)
    assert 49.0 < row["vdot"] < 55.0


def test_segment_pb_beats_prior_5k_pb_in_history(db_with_fixture):
    """Insert the prior 2026-04-24 19:59 PB as 'OLD' and run the hook;
    the 'current best' query should now select the new row, not OLD."""
    label_id = "477783793625760045"
    db_with_fixture._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES ('5K', 5000, 1199.64, 49.8, '2026-04-24', 'OLD', 1, datetime('now'))"
    )
    db_with_fixture._conn.commit()

    run_ability_hook(db_with_fixture, [label_id])

    current = db_with_fixture._conn.execute(
        "SELECT label_id FROM ("
        "  SELECT label_id, ROW_NUMBER() OVER ("
        "    PARTITION BY race_type ORDER BY vdot DESC, pb_date DESC"
        "  ) AS rn FROM vo2max_pb WHERE race_type='5K'"
        ") WHERE rn = 1"
    ).fetchone()
    assert current["label_id"] == label_id
