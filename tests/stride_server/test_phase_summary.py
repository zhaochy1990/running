"""Tests for aggregate_phase_summary (Q2a completed-phase actual-results rollup).

Seeds a temporary coros.db with activities + zones rows and asserts the
deterministic aggregation: km totals (excluding strength), duration-weighted
pace/HR, HR-zone percentages, empty-window behaviour, and Shanghai-day
windowing (a UTC-boundary run must land on the correct Shanghai day).
"""
from __future__ import annotations

import pytest

from stride_core.master_plan import CompletedPhaseSummary, MasterPlan, Phase
from stride_server.phase_summary import aggregate_phase_summary


def _db(tmp_path):
    from stride_core.db import Database

    return Database(db_path=tmp_path / "coros.db")


def _add_activity(
    db,
    *,
    label_id: str,
    date: str,            # UTC ISO 8601
    distance_m: float,    # NOTE: column stores KILOMETERS
    duration_s: int,
    sport_type: int = 100,
    avg_pace_s_km: float | None = None,
    avg_hr: float | None = None,
):
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s, "
        "avg_pace_s_km, avg_hr) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (label_id, sport_type, date, distance_m, duration_s, avg_pace_s_km, avg_hr),
    )


def _add_zone(db, *, label_id: str, zone_index: int, duration_s: int, zone_type: str = "heartRate"):
    db._conn.execute(
        "INSERT INTO zones (label_id, zone_type, zone_index, duration_s, percent) "
        "VALUES (?, ?, ?, ?, ?)",
        (label_id, zone_type, zone_index, duration_s, 0.0),
    )


# ---------------------------------------------------------------------------
# 1. total km excludes Strength Training (402)
# ---------------------------------------------------------------------------


def test_total_km_excludes_strength(tmp_path):
    db = _db(tmp_path)
    _add_activity(db, label_id="r1", date="2026-05-05T08:00:00+00:00",
                  distance_m=10.0, duration_s=3000, sport_type=100)
    _add_activity(db, label_id="r2", date="2026-05-06T08:00:00+00:00",
                  distance_m=5.0, duration_s=1800, sport_type=101)  # indoor run
    _add_activity(db, label_id="r3", date="2026-05-07T08:00:00+00:00",
                  distance_m=8.0, duration_s=2400, sport_type=103)  # track run
    # Strength training — distance 0, must be excluded from km + count.
    _add_activity(db, label_id="s1", date="2026-05-08T08:00:00+00:00",
                  distance_m=0.0, duration_s=2700, sport_type=402)
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-05-31")
    assert s.total_distance_km == 23.0  # 10 + 5 + 8, strength excluded
    assert s.run_count == 3


# ---------------------------------------------------------------------------
# 2. duration-weighted pace + HR
# ---------------------------------------------------------------------------


def test_duration_weighted_pace_and_hr(tmp_path):
    db = _db(tmp_path)
    # Run A: 3600s @ pace 300, hr 140 ; Run B: 1200s @ pace 360, hr 160.
    # Weighted pace = (300*3600 + 360*1200) / 4800 = (1080000+432000)/4800 = 315
    # Weighted hr   = (140*3600 + 160*1200) / 4800 = (504000+192000)/4800 = 145
    _add_activity(db, label_id="A", date="2026-05-05T08:00:00+00:00",
                  distance_m=12.0, duration_s=3600, avg_pace_s_km=300, avg_hr=140)
    _add_activity(db, label_id="B", date="2026-05-06T08:00:00+00:00",
                  distance_m=4.0, duration_s=1200, avg_pace_s_km=360, avg_hr=160)
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-05-31")
    assert s.avg_pace_s_km == 315
    assert s.avg_pace_fmt == "5:15"
    assert s.avg_hr == 145


def test_pace_and_hr_none_when_absent(tmp_path):
    db = _db(tmp_path)
    # Run with no pace / no hr — weighted means must be None, not 0.
    _add_activity(db, label_id="A", date="2026-05-05T08:00:00+00:00",
                  distance_m=10.0, duration_s=3000, avg_pace_s_km=None, avg_hr=None)
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-05-31")
    assert s.run_count == 1
    assert s.avg_pace_s_km is None
    assert s.avg_pace_fmt == ""
    assert s.avg_hr is None


# ---------------------------------------------------------------------------
# 3. HR zone percentages
# ---------------------------------------------------------------------------


def test_hr_zone_distribution_percent(tmp_path):
    db = _db(tmp_path)
    _add_activity(db, label_id="A", date="2026-05-05T08:00:00+00:00",
                  distance_m=12.0, duration_s=3600, avg_hr=145)
    # Z1=600s, Z2=2400s, Z3=1000s  => total 4000s
    _add_zone(db, label_id="A", zone_index=1, duration_s=600)
    _add_zone(db, label_id="A", zone_index=2, duration_s=2400)
    _add_zone(db, label_id="A", zone_index=3, duration_s=1000)
    # A 'pace' zone row must be ignored entirely.
    _add_zone(db, label_id="A", zone_index=1, duration_s=9999, zone_type="pace")
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-05-31")
    dist = {z.zone_index: z for z in s.hr_zone_distribution}
    assert set(dist) == {1, 2, 3}
    assert dist[1].minutes == 10  # 600/60
    assert dist[2].minutes == 40
    assert dist[1].percent == 15.0   # 600/4000
    assert dist[2].percent == 60.0   # 2400/4000
    assert dist[3].percent == 25.0   # 1000/4000
    assert round(sum(z.percent for z in s.hr_zone_distribution)) == 100


# ---------------------------------------------------------------------------
# 4. empty window → zeros / None / []
# ---------------------------------------------------------------------------


def test_empty_window(tmp_path):
    db = _db(tmp_path)
    # An activity OUTSIDE the queried window.
    _add_activity(db, label_id="A", date="2026-01-05T08:00:00+00:00",
                  distance_m=10.0, duration_s=3000, avg_hr=145)
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-05-31")
    assert s.total_distance_km == 0.0
    assert s.run_count == 0
    assert s.weekly_avg_km == 0.0
    assert s.avg_pace_s_km is None
    assert s.avg_pace_fmt == ""
    assert s.avg_hr is None
    assert s.hr_zone_distribution == []


# ---------------------------------------------------------------------------
# 5. Shanghai-day windowing — a UTC-boundary run must not leak across days
# ---------------------------------------------------------------------------


def test_shanghai_day_windowing(tmp_path):
    db = _db(tmp_path)
    # 2026-05-03T18:00:00Z == 2026-05-04T02:00 Shanghai → INSIDE a window
    # that starts 2026-05-04. A naive UTC `date >= '2026-05-04'` compare would
    # wrongly exclude it.
    _add_activity(db, label_id="edge_in", date="2026-05-03T18:00:00+00:00",
                  distance_m=7.0, duration_s=2000, avg_hr=140)
    # 2026-05-31T17:00:00Z == 2026-06-01T01:00 Shanghai → OUTSIDE a window
    # that ends 2026-05-31. Naive UTC compare would wrongly include it.
    _add_activity(db, label_id="edge_out", date="2026-05-31T17:00:00+00:00",
                  distance_m=99.0, duration_s=2000, avg_hr=140)
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-05-31")
    assert s.run_count == 1
    assert s.total_distance_km == 7.0  # only the in-window edge run


def test_weekly_avg_uses_phase_weeks(tmp_path):
    db = _db(tmp_path)
    # 56 days = exactly 8 weeks; 400 km / 8 = 50.0
    _add_activity(db, label_id="A", date="2026-05-10T08:00:00+00:00",
                  distance_m=400.0, duration_s=3000, avg_hr=145)
    db._conn.commit()

    s = aggregate_phase_summary(db, "2026-05-04", "2026-06-28")
    assert s.total_distance_km == 400.0
    assert s.weekly_avg_km == 50.0


# ---------------------------------------------------------------------------
# Schema round-trip + backward compat
# ---------------------------------------------------------------------------


def _minimal_plan_dict() -> dict:
    return {
        "plan_id": "p1",
        "user_id": "u1",
        "status": "active",
        "goal_id": "g1",
        "goal": {"goal_id": "g1", "target_time": "", "race_date": "2026-10-18"},
        "start_date": "2026-05-04",
        "end_date": "2026-10-18",
        "total_weeks": 24,
        "phases": [
            {
                "id": "ph1",
                "name": "已完成的有氧基础期",
                "start_date": "2026-05-04",
                "end_date": "2026-06-28",
                "focus": "有氧基础",
                "weekly_distance_km_low": 50.0,
                "weekly_distance_km_high": 60.0,
                "key_session_types": ["长距离"],
                "milestone_ids": [],
                "is_completed": True,
            },
        ],
        "milestones": [],
        "training_principles": ["渐进负荷"],
        "generated_by": "test",
        "version": 1,
        "created_at": "2026-05-01T00:00:00+00:00",
        "updated_at": "2026-05-01T00:00:00+00:00",
    }


def test_schema_round_trip_with_summary():
    summary = CompletedPhaseSummary(
        total_distance_km=476.6,
        run_count=45,
        weekly_avg_km=59.6,
        avg_pace_s_km=315,
        avg_pace_fmt="5:15",
        avg_hr=149,
        hr_zone_distribution=[
            {"zone_index": 1, "minutes": 126.0, "percent": 5.1},
            {"zone_index": 2, "minutes": 1405.0, "percent": 56.7},
        ],
    )
    data = _minimal_plan_dict()
    data["phases"][0]["summary"] = summary.model_dump()

    plan = MasterPlan.model_validate(data)
    assert plan.phases[0].summary is not None
    assert plan.phases[0].summary.total_distance_km == 476.6
    assert plan.phases[0].summary.hr_zone_distribution[1].percent == 56.7

    # Dump → reload must be lossless.
    reloaded = MasterPlan.model_validate(plan.model_dump())
    assert reloaded.phases[0].summary == plan.phases[0].summary


def test_legacy_plan_without_summary_still_validates():
    # No `summary` key on any phase — the old shape must keep working and
    # default to None (backward compatible).
    plan = MasterPlan.model_validate(_minimal_plan_dict())
    assert plan.phases[0].summary is None
    # Active phase model also defaults summary to None.
    assert isinstance(Phase(
        id="x", name="n", start_date="2026-05-04", end_date="2026-05-31",
        focus="", weekly_distance_km_low=0, weekly_distance_km_high=0,
        key_session_types=[], milestone_ids=[],
    ).summary, type(None))
