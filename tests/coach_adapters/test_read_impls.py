"""US-005 acceptance — all read tool impls must return a ToolResult on both
empty and populated DBs without ever raising."""

from __future__ import annotations

from datetime import date as date_cls
from typing import Any

import pytest

from coach.runtime.toolkit import Toolkit
from coach.schemas import ToolResult
from coach.tools.protocols import (
    GetAbilitySnapshot,
    GetActivityDetail,
    GetHealthSeries,
    GetHealthSnapshot,
    GetBodyCompositionLatest,
    EstimateMasterPlanLoad,
    GetMasterPlanCurrent,
    GetMasterPlanVersions,
    GetPbs,
    GetPmcSeries,
    GetRacePredictions,
    GetRecentActivities,
    GetWeekPlan,
)
from stride_server.coach_adapters import tool_impls
from stride_server.coach_adapters.tool_impls import read_impls
from stride_server.coach_adapters.toolkit import build_stride_toolkit


# ---------------------------------------------------------------------------
# Fixture: rewire _open_db to a fresh in-memory schema for every test
# ---------------------------------------------------------------------------


@pytest.fixture
def patched_db(tmp_path, monkeypatch):
    """Open a real ``stride_storage.sqlite.database.Database`` against a tmp_path file and
    monkeypatch :func:`read_impls._open_db` to return it. The same DB
    instance is yielded so tests can seed rows."""
    from stride_storage.sqlite.database import Database

    db_path = tmp_path / "coach_test.db"
    db = Database(db_path)
    monkeypatch.setattr(read_impls, "_open_db", lambda _uid: Database(db_path))
    yield db
    db.close()


# ---------------------------------------------------------------------------
# Protocol conformance (every impl satisfies its Protocol class)
# ---------------------------------------------------------------------------


def test_all_impls_satisfy_protocols() -> None:
    """``isinstance(impl, ProtocolClass)`` should pass for every read tool."""
    uid = "test-user"
    pairs: list[tuple[Any, type]] = [
        (read_impls.GetRecentActivitiesImpl(uid), GetRecentActivities),
        (read_impls.GetHealthSnapshotImpl(uid), GetHealthSnapshot),
        (read_impls.GetHealthSeriesImpl(uid), GetHealthSeries),
        (read_impls.GetPmcSeriesImpl(uid), GetPmcSeries),
        (read_impls.GetBodyCompositionLatestImpl(uid), GetBodyCompositionLatest),
        (read_impls.GetAbilitySnapshotImpl(uid), GetAbilitySnapshot),
        (read_impls.GetRacePredictionsImpl(uid), GetRacePredictions),
        (read_impls.GetPbsImpl(uid), GetPbs),
        (read_impls.GetMasterPlanCurrentImpl(uid), GetMasterPlanCurrent),
        (read_impls.GetMasterPlanVersionsImpl(uid), GetMasterPlanVersions),
        (read_impls.GetWeekPlanImpl(uid), GetWeekPlan),
        (read_impls.GetActivityDetailImpl(uid), GetActivityDetail),
        (read_impls.EstimateMasterPlanLoadImpl(uid), EstimateMasterPlanLoad),
    ]
    for impl, proto in pairs:
        assert isinstance(impl, proto), f"{type(impl).__name__} fails {proto.__name__}"


def test_build_stride_toolkit_satisfies_toolkit_protocol() -> None:
    """The factory output must structurally match the full Toolkit Protocol."""
    tk = build_stride_toolkit("uid")
    assert isinstance(tk, Toolkit)


# ---------------------------------------------------------------------------
# Empty DB: every read tool returns a ToolResult, never raises
# ---------------------------------------------------------------------------


def test_recent_activities_empty(patched_db) -> None:
    res = read_impls.GetRecentActivitiesImpl("uid")()
    assert isinstance(res, ToolResult)
    assert res.ok
    assert res.data == {"activities": []}


def test_health_snapshot_empty(patched_db) -> None:
    res = read_impls.GetHealthSnapshotImpl("uid")()
    assert res.ok
    assert res.data == {"latest": None, "dashboard": {}, "calibration": None}


def test_health_series_empty(patched_db) -> None:
    res = read_impls.GetHealthSeriesImpl("uid")(days=14)
    assert res.ok
    assert res.data["days"] == 14
    assert res.data["series"] == []
    assert res.data["coverage"]["rhr"] == 0
    assert res.data["coverage"]["hrv_last_night_avg"] == 0


def test_pmc_series_empty(patched_db) -> None:
    res = read_impls.GetPmcSeriesImpl("uid")(days=14)
    assert res.ok
    assert res.data["series"] == []
    assert res.data["granularity"] == "daily"
    assert res.data["days"] == 14


def test_pmc_series_invalid_granularity_returns_error(patched_db) -> None:
    res = read_impls.GetPmcSeriesImpl("uid")(granularity="hourly")
    assert not res.ok
    assert any("granularity" in e for e in res.errors)


def test_inbody_empty(patched_db) -> None:
    res = read_impls.GetBodyCompositionLatestImpl("uid")()
    assert res.ok
    assert res.data == {"latest": None, "deltas": None}


def test_ability_empty(patched_db) -> None:
    res = read_impls.GetAbilitySnapshotImpl("uid")()
    assert res.ok
    assert res.data["latest_date"] is None
    assert res.data["latest"] == []
    assert res.data["history"] == []


def test_race_predictions_empty(patched_db) -> None:
    res = read_impls.GetRacePredictionsImpl("uid")()
    assert res.ok
    assert res.data == {"predictions": []}


def test_pbs_empty(patched_db) -> None:
    res = read_impls.GetPbsImpl("uid")()
    assert res.ok
    assert res.data["pbs"] == []
    assert "computed_at" in res.data


def test_get_week_plan_invalid_folder(patched_db) -> None:
    res = read_impls.GetWeekPlanImpl("uid")(folder="not-a-week-folder")
    assert not res.ok
    assert any("invalid week folder" in e for e in res.errors)


def test_activity_detail_missing(patched_db) -> None:
    res = read_impls.GetActivityDetailImpl("uid")(label_id="nope")
    assert not res.ok
    assert any("not found" in e for e in res.errors)


def test_estimate_master_plan_load_empty_no_plan(patched_db) -> None:
    res = read_impls.EstimateMasterPlanLoadImpl("uid")()
    assert res.ok
    assert res.data["plan_estimate"] is None
    assert res.data["history_anchor"]["history_active_weeks"] == 0


def test_estimate_master_plan_load_with_plan_and_history(patched_db, monkeypatch) -> None:
    from stride_server import master_plan_generator as mpg

    seen: dict[str, Any] = {}
    kms = [120.0, 130.0, 125.0, 135.0, 128.0, 132.0, 126.0, 129.0]

    def _history(_uid, *, as_of=None):
        seen["as_of"] = as_of
        return {
            "max_weekly_km": max(kms),
            "weekly_profile": [
                {
                    "week_start": f"2026-01-{idx:02d}",
                    "distance_km": km,
                    "hours": km * 300 / 3600,
                    "dose": km * 0.8,
                    "n_runs": 6,
                }
                for idx, km in enumerate(kms, start=1)
            ],
        }

    monkeypatch.setattr(mpg, "_query_history", _history)
    plan = {
        "goal": {"distance": "HM"},
        "weeks": [
            {
                "week_index": 1,
                "week_start": "2026-07-06",
                "target_weekly_km_high": 60,
                "key_sessions": [{"type": "long_run", "distance_km": 18}],
            },
            {
                "week_index": 2,
                "week_start": "2026-07-13",
                "target_weekly_km_high": 65,
                "key_sessions": [{"type": "threshold", "duration_min": 35}],
            },
            {
                "week_index": 3,
                "week_start": "2026-07-20",
                "target_weekly_km_high": 70,
                "key_sessions": [{"type": "long_run", "distance_km": 20}],
            },
            {
                "week_index": 4,
                "week_start": "2026-07-27",
                "target_weekly_km_high": 44,
                "is_recovery_week": True,
                "key_sessions": [],
            },
        ],
    }
    res = read_impls.EstimateMasterPlanLoadImpl("uid")(
        plan=plan,
        target_race={"distance": "hm"},
        weekly_run_days_max=6,
        as_of_date="2026-05-19",
    )
    assert res.ok, res.errors
    assert seen["as_of"] == date_cls(2026, 5, 19)
    estimate = res.data["plan_estimate"]
    assert estimate["history_anchor"]["advanced_history"] is True
    assert estimate["plan_summary"]["peak_weekly_km"] == 70.0
    assert estimate["alignment"]["status"] == "underload"


# ---------------------------------------------------------------------------
# Populated DB: smoke-test that real rows flow through
# ---------------------------------------------------------------------------


def test_recent_activities_populated(patched_db) -> None:
    patched_db._conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s, avg_pace_s_km)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("a1", "Morning run", 100, "Run", "2026-05-13T08:00:00+00:00", 10000, 3000, 300),
    )
    patched_db._conn.commit()
    res = read_impls.GetRecentActivitiesImpl("uid")(limit=5)
    assert res.ok
    assert len(res.data["activities"]) == 1
    a = res.data["activities"][0]
    assert a["label_id"] == "a1"
    assert a["distance_km"] == 10.0
    assert a["pace_fmt"] == "5:00/km"


def test_health_snapshot_uses_stride_load_not_vendor(patched_db) -> None:
    # STRIDE self-computed PMC (acute/chronic/form), NOT COROS ati/cti.
    patched_db._conn.execute(
        """INSERT INTO daily_training_load
           (date, algorithm_version, acute_load, chronic_load, form, load_ratio)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("2026-05-13", 1, 50.0, 62.0, 12.0, 0.81),
    )
    patched_db._conn.execute(
        "INSERT INTO daily_health (date, rhr) VALUES (?, ?)", ("20260513", 52)
    )
    patched_db._conn.commit()
    res = read_impls.GetHealthSnapshotImpl("uid")()
    assert res.ok
    latest = res.data["latest"]
    assert latest is not None
    assert latest["chronic_load"] == 62.0
    assert latest["acute_load"] == 50.0
    assert latest["form"] == 12.0
    # form/chronic = 12/62 = 0.19 → 比赛就绪 (ratio-based, not fixed TSB threshold)
    assert latest["form_zone"] == "race_ready"
    assert latest["rhr"] == 52  # raw signal still surfaced
    # No vendor-computed load fields leak to the LLM.
    for vendor in ("ati", "cti", "tsb", "fatigue", "training_load_state"):
        assert vendor not in latest


def test_health_snapshot_threshold_from_stride_calibration(patched_db) -> None:
    from datetime import date

    from stride_storage.sqlite.calibration_connector import (
        SQLiteRunningCalibrationRepository,
    )
    from stride_core.running_calibration.types import RunningCalibrationSnapshot

    SQLiteRunningCalibrationRepository(patched_db).save_snapshot(
        RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 13), threshold_hr=169.0, threshold_speed_mps=4.0
        )
    )
    res = read_impls.GetHealthSnapshotImpl("uid")()
    assert res.ok
    cal = res.data["calibration"]
    assert cal is not None
    assert cal["threshold_hr"] == 169.0
    assert cal["threshold_pace_s_km"] == 250  # 1000 / 4.0 m/s
    # The COROS dashboard threshold must NOT be surfaced.
    assert "threshold_hr" not in res.data["dashboard"]
    assert "threshold_pace_s_km" not in res.data["dashboard"]


def test_health_series_merges_requested_metrics_by_date(patched_db) -> None:
    conn = patched_db._conn
    conn.executemany(
        "INSERT INTO daily_health (date, rhr, fatigue) VALUES (?, ?, ?)",
        [
            ("20260701", 49, 42.0),
            ("20260702", 50, 45.0),
            ("2026-07-03", 51, 50.0),
        ],
    )
    conn.executemany(
        """INSERT INTO daily_hrv
           (date, last_night_avg, status, baseline_balanced_low, baseline_balanced_upper, provider)
           VALUES (?, ?, ?, ?, ?, ?)""",
        [
            ("2026-07-01", 42, "BALANCED", 35, 55, "coros"),
            ("2026-07-03", 38, "LOW", 35, 55, "coros"),
        ],
    )
    conn.executemany(
        """INSERT INTO daily_training_load
           (date, algorithm_version, training_dose, acute_load, chronic_load, form, load_ratio,
            readiness_gate, readiness_reasons_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            ("2026-07-01", 1, 60.0, 50.0, 55.0, 5.0, 0.91, "green", '["ok"]'),
            ("2026-07-03", 1, 80.0, 58.0, 56.0, -2.0, 1.04, "yellow", '["low_hrv"]'),
        ],
    )
    conn.commit()

    res = read_impls.GetHealthSeriesImpl("uid")(
        days=7,
        metrics=["rhr", "hrv_last_night_avg", "hrv_status", "fatigue", "form", "readiness_reasons"],
    )
    assert res.ok
    assert res.data["metrics"] == [
        "rhr",
        "hrv_last_night_avg",
        "hrv_status",
        "fatigue",
        "form",
        "readiness_reasons",
    ]
    assert res.data["coverage"]["rhr"] == 3
    assert res.data["coverage"]["hrv_last_night_avg"] == 2
    assert res.data["coverage"]["form"] == 2
    assert res.data["series"] == [
        {
            "date": "2026-07-01",
            "rhr": 49,
            "hrv_last_night_avg": 42,
            "hrv_status": "BALANCED",
            "fatigue": 42.0,
            "form": 5.0,
            "readiness_reasons": ["ok"],
        },
        {"date": "2026-07-02", "rhr": 50, "fatigue": 45.0},
        {
            "date": "2026-07-03",
            "rhr": 51,
            "hrv_last_night_avg": 38,
            "hrv_status": "LOW",
            "fatigue": 50.0,
            "form": -2.0,
            "readiness_reasons": ["low_hrv"],
        },
    ]


def test_health_series_prefers_garmin_when_dual_provider_hrv(patched_db) -> None:
    conn = patched_db._conn
    conn.execute("INSERT INTO daily_health (date, rhr) VALUES ('20260704', 48)")
    conn.executemany(
        "INSERT INTO daily_hrv (date, last_night_avg, provider) VALUES (?, ?, ?)",
        [
            ("2026-07-04", 20, "coros"),
            ("2026-07-04", 44, "garmin"),
        ],
    )
    conn.commit()

    res = read_impls.GetHealthSeriesImpl("uid")(
        days=7,
        metrics=["rhr", "hrv_last_night_avg", "hrv_provider"],
    )
    assert res.ok
    assert res.data["series"] == [
        {
            "date": "2026-07-04",
            "rhr": 48,
            "hrv_last_night_avg": 44,
            "hrv_provider": "garmin",
        }
    ]


def test_health_series_rejects_unknown_metrics(patched_db) -> None:
    res = read_impls.GetHealthSeriesImpl("uid")(metrics=["rhr", "vo2max"])
    assert not res.ok
    assert any("unsupported metrics" in e and "vo2max" in e for e in res.errors)


def test_pmc_series_uses_stride_load(patched_db) -> None:
    patched_db._conn.execute(
        """INSERT INTO daily_training_load
           (date, algorithm_version, acute_load, chronic_load, form, load_ratio)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("2026-05-13", 1, 50.0, 62.0, 12.0, 0.81),
    )
    patched_db._conn.commit()
    res = read_impls.GetPmcSeriesImpl("uid")(days=14)
    assert res.ok
    series = res.data["series"]
    assert len(series) == 1
    assert series[0]["chronic_load"] == 62.0
    assert series[0]["form"] == 12.0
    assert "ati" not in series[0] and "cti" not in series[0]


def test_recent_activities_drops_vendor_training_load(patched_db) -> None:
    patched_db._conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s, training_load)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("a1", "run", 100, "Run", "2026-05-13T08:00:00+00:00", 10000, 3000, 400),
    )
    patched_db._conn.commit()
    res = read_impls.GetRecentActivitiesImpl("uid")(limit=5)
    assert res.ok
    # The vendor per-activity load must not reach the coach context.
    assert "training_load" not in res.data["activities"][0]


def test_training_environment_detects_altitude(patched_db, monkeypatch) -> None:
    from datetime import date

    import stride_core.timefmt as timefmt
    from stride_storage.sqlite.calibration_connector import (
        SQLiteRunningCalibrationRepository,
    )
    from stride_core.running_calibration.types import RunningCalibrationSnapshot

    monkeypatch.setattr(timefmt, "today_shanghai", lambda: date(2026, 6, 27))
    conn = patched_db._conn
    conn.executemany(
        "INSERT INTO activities (label_id, name, sport_type, sport_name, date) VALUES (?,?,?,?,?)",
        [
            ("s1", "run", 100, "Run", "2026-06-24T02:00:00+00:00"),  # Shanghai
            ("k1", "run", 100, "Run", "2026-06-27T02:00:00+00:00"),  # Kunming
        ],
    )
    conn.executemany(
        "INSERT INTO timeseries (label_id, timestamp, altitude) VALUES (?,?,?)",
        [("s1", 1, 2.0), ("s1", 2, 3.0), ("k1", 1, 1930.0), ("k1", 2, 1932.0)],
    )
    conn.execute("INSERT INTO daily_health (date, rhr) VALUES ('20260627', 55)")
    conn.execute("INSERT INTO daily_hrv (date, last_night_avg) VALUES ('2026-06-27', 27)")
    conn.commit()
    SQLiteRunningCalibrationRepository(patched_db).save_snapshot(
        RunningCalibrationSnapshot(as_of_date=date(2026, 6, 1), rhr_baseline=48.0)
    )

    res = read_impls.GetTrainingEnvironmentImpl("uid")()
    assert res.ok, res.errors
    env = res.data["environment"]
    assert env is not None
    assert env["at_altitude"] is True
    assert env["altitude_band"] == "moderate"
    assert 1900 <= env["current_altitude_m"] <= 1935
    acc = env["acclimatization"]
    assert acc is not None
    assert acc["from_altitude_m"] < 100 and acc["to_altitude_m"] > 1900
    assert acc["status"] == "disturbed"  # RHR 55 vs baseline 48 → +7 bpm
    assert env["weather"] is None


def test_training_environment_dedups_dual_provider_hrv(patched_db, monkeypatch) -> None:
    """A dual-watch user (garmin + coros same night) must not double-count HRV.

    Regression: the env HRV query read ``daily_hrv`` directly, so a user with two
    providers got two rows per date and the median skewed — flipping the
    acclimatization status. Reading through ``HRV_PREFERRED_PER_DATE_SQL`` picks
    one provider (garmin) per night.
    """
    from datetime import date

    import stride_core.timefmt as timefmt
    from stride_storage.sqlite.calibration_connector import (
        SQLiteRunningCalibrationRepository,
    )
    from stride_core.running_calibration.types import RunningCalibrationSnapshot

    monkeypatch.setattr(timefmt, "today_shanghai", lambda: date(2026, 6, 27))
    conn = patched_db._conn
    conn.executemany(
        "INSERT INTO activities (label_id, name, sport_type, sport_name, date) VALUES (?,?,?,?,?)",
        [
            ("s1", "run", 100, "Run", "2026-06-24T02:00:00+00:00"),  # Shanghai
            ("k1", "run", 100, "Run", "2026-06-27T02:00:00+00:00"),  # Kunming
        ],
    )
    conn.executemany(
        "INSERT INTO timeseries (label_id, timestamp, altitude) VALUES (?,?,?)",
        [("s1", 1, 2.0), ("k1", 1, 1931.0)],
    )
    conn.execute("INSERT INTO daily_health (date, rhr) VALUES ('20260627', 49)")
    # HRV baseline (pre-change-point) = 40, garmin only.
    conn.executemany(
        "INSERT INTO daily_hrv (date, last_night_avg, provider) VALUES (?,?,?)",
        [
            ("2026-06-10", 40, "garmin"),
            ("2026-06-15", 40, "garmin"),
            # Recent night: garmin (preferred) = 40, coros = 10. Counting both
            # → median 25 → −37.5% → 'disturbed'. Deduped → 40 → ~0% → not.
            ("2026-06-27", 40, "garmin"),
            ("2026-06-27", 10, "coros"),
        ],
    )
    conn.commit()
    SQLiteRunningCalibrationRepository(patched_db).save_snapshot(
        RunningCalibrationSnapshot(as_of_date=date(2026, 6, 1), rhr_baseline=48.0)
    )

    acc = read_impls.GetTrainingEnvironmentImpl("uid")().data["environment"]["acclimatization"]
    assert acc["hrv_current"] == 40.0  # garmin, not median(40, 10)=25
    assert acc["status"] != "disturbed"


def test_pbs_detects_10k_pb(patched_db) -> None:
    # Seed two 10k runs; the faster one should win.
    patched_db._conn.executemany(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            ("a1", "10k run", 100, "Run", "2026-05-01T08:00:00+00:00", 10000, 3000),
            ("a2", "10k fast", 100, "Run", "2026-05-13T08:00:00+00:00", 10000, 2400),
        ],
    )
    patched_db._conn.commit()
    res = read_impls.GetPbsImpl("uid")()
    assert res.ok
    pbs = res.data["pbs"]
    assert len(pbs) == 1
    assert pbs[0]["distance"] == "10K"
    assert pbs[0]["pb_time_sec"] == 2400
    assert pbs[0]["label_id"] == "a2"


# ---------------------------------------------------------------------------
# Tool safety: any uncaught exception → ok=False, no raise
# ---------------------------------------------------------------------------


def test_tool_safe_wraps_exceptions(monkeypatch) -> None:
    """Force ``_open_db`` to raise; the impl must catch and return ok=False."""
    def boom(_uid: str) -> Any:
        raise RuntimeError("db on fire")

    monkeypatch.setattr(read_impls, "_open_db", boom)
    res = read_impls.GetRecentActivitiesImpl("uid")()
    assert isinstance(res, ToolResult)
    assert not res.ok
    assert any("RuntimeError" in e and "db on fire" in e for e in res.errors)


# ---------------------------------------------------------------------------
# Placeholder draft tools still return ToolResult (US-005 boundary)
# ---------------------------------------------------------------------------


def test_master_draft_tools_reject_unknown_plan(patched_db) -> None:
    """Master-scope draft tools (US-009) emit MasterPlanDiff for real plans
    and ok=False for missing plans. Week-scope tools tested in
    test_draft_impls.py; master-scope tools tested in test_master_draft_impls.py."""
    tk = build_stride_toolkit("uid")
    # All master tools need at least plan_id; supply a bogus one and verify
    # graceful failure instead of crashes.
    test_args = {
        "extend_phase": {"plan_id": "nope", "phase_id": "phid", "weeks": 1},
        "compress_phase": {"plan_id": "nope", "phase_id": "phid", "weeks": 1},
        "shift_milestone": {"plan_id": "nope", "milestone_id": "mid", "new_date": "2026-08-01"},
        "change_target": {"plan_id": "nope", "milestone_id": "mid", "new_target_time": "5K 20:00"},
        "propose_alternatives": {"plan_id": "nope", "intent": "x"},
        "regenerate_master": {"plan_id": "nope", "reason": "x"},
    }
    for tool_name, kwargs in test_args.items():
        tool = getattr(tk, tool_name)
        res = tool(**kwargs)
        assert isinstance(res, ToolResult)
        assert not res.ok


def test_tool_impls_package_imports() -> None:
    """Smoke import for the tool_impls package itself."""
    assert tool_impls is not None
