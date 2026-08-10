from datetime import date

import pytest

from stride_storage.interfaces.season_plan import CanonicalSeasonPlanDataUnavailable
from stride_storage.mysql.season_plan_reader import (
    CANONICAL_MYSQL_PROBE_SQL,
    MySQLSeasonPlanReader,
    probe_canonical_mysql,
)


class _Result:
    def __init__(self, rows): self._rows = rows
    def mappings(self): return self
    def all(self): return self._rows


class _Conn:
    def __init__(self, responses): self._responses = responses
    def __enter__(self): return self
    def __exit__(self, *_args): pass
    def execute(self, *_args, **_kwargs): return _Result(self._responses.pop(0))


class _Engine:
    def __init__(self, responses): self._responses = list(responses)
    def connect(self): return _Conn(self._responses)


def _responses():
    return [
        [{"goal_id": "go-goal", "race_date": "2026-11-01", "race_distance": "FM", "target_finish_time": "3:30:00", "weekly_training_days": 5}],
        [{"height_cm": 180, "weight_kg": 70}],
        [{"date": "2026-08-01T16:30:00+00:00", "distance_m": 10000, "duration_s": 3000, "avg_hr": 150, "train_kind": "base"}],
        [{"date": "20260801", "rhr": 50}],
        [{"date": "2026-08-01", "last_night_avg": 55}],
        [{"date": "2026-08-01", "training_dose": 80, "acute_load": 70, "chronic_load": 60, "form": -10, "load_ratio": 1.17, "coverage_status": "complete"}],
        [{"id": 1, "as_of_date": "2026-07-31", "threshold_speed_mps": 4.0, "rhr_baseline": 50}],
        [{"distance": "FM", "pb_time_sec": 13000}],
    ]


def test_go_goal_and_context_are_resolved_from_one_mysql_reader():
    result = MySQLSeasonPlanReader(_Engine(_responses())).read("user", goal_id="go-goal", as_of=date(2026, 8, 2))
    assert result["contract_version"] == "mysql-season-plan-context-v1"
    assert result["goal"]["goal_id"] == "go-goal"
    assert result["goal"]["goal_time_s"] == 12600
    assert result["history"]["total_activities"] == 1
    assert result["pb_seconds"] == {"fm": 13000.0}


def test_missing_goal_is_a_hard_generation_input_failure():
    responses = [[]] + _responses()[1:]
    with pytest.raises(CanonicalSeasonPlanDataUnavailable, match="race goal"):
        MySQLSeasonPlanReader(_Engine(responses)).read("user", goal_id="missing", as_of=date(2026, 8, 2))


def test_connection_failure_is_not_a_sqlite_fallback():
    class Broken:
        def connect(self): raise OSError("offline")
    with pytest.raises(CanonicalSeasonPlanDataUnavailable, match="canonical MySQL"):
        MySQLSeasonPlanReader(Broken()).read_goal("user")


def test_canonical_probe_is_a_single_read_only_statement():
    engine = _Engine([[]])

    probe_canonical_mysql(engine)

    assert engine._responses == []


def test_canonical_probe_normalizes_connection_errors():
    class Broken:
        def connect(self): raise OSError("offline")

    with pytest.raises(CanonicalSeasonPlanDataUnavailable, match="canonical MySQL"):
        probe_canonical_mysql(Broken())
