"""US-005 acceptance — all read tool impls must return a ToolResult on both
empty and populated DBs without ever raising."""

from __future__ import annotations

from datetime import date as date_cls
from typing import Any

import pytest
from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION

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
    GetTrainingSummary,
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
        (read_impls.GetTrainingSummaryImpl(uid), GetTrainingSummary),
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
    assert res.data["activities"] == []
    assert res.data["provenance"]["training_load"]["source"] == "stride"


def test_training_summary_defaults_to_previous_shanghai_week(
    patched_db, monkeypatch
) -> None:
    from stride_core import timefmt

    monkeypatch.setattr(timefmt, "today_shanghai", lambda: date_cls(2026, 7, 14))

    res = read_impls.GetTrainingSummaryImpl("uid")()

    assert res.ok
    assert res.data["date_from"] == "2026-07-06"
    assert res.data["date_to"] == "2026-07-12"


def test_training_summary_rejects_one_sided_date_range(patched_db) -> None:
    res = read_impls.GetTrainingSummaryImpl("uid")(date_from="2026-07-06")

    assert not res.ok
    assert res.errors == ["date_from and date_to must be provided together"]


def test_health_snapshot_empty(patched_db) -> None:
    res = read_impls.GetHealthSnapshotImpl("uid")()
    assert res.ok
    assert res.data["stride_training_load"] is None
    assert res.data["raw_measurements"] == {"rhr": None, "hrv": None}
    assert res.data["stride_calibration"] is None
    assert res.data["provenance"]["training_load"]["source"] == "stride"


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
    assert res.data["predictions"] == []
    assert res.data["provenance"]["predictions"]["source"] == "stride"


@pytest.mark.parametrize("score", [0.0, -1.0])
def test_race_predictions_reject_non_positive_stride_vo2max(
    patched_db, score
) -> None:
    patched_db._conn.execute(
        "INSERT INTO ability_snapshot (date, level, dimension, value) VALUES (?, ?, ?, ?)",
        ("2026-07-15", "L3", "vo2max", score),
    )
    patched_db._conn.commit()

    res = read_impls.GetRacePredictionsImpl("uid")()

    assert res.ok
    assert res.data["predictions"] == []
    assert "vo2max" not in res.data
    assert res.data["provenance"]["predictions"]["source"] == "stride"


def test_pbs_empty(patched_db) -> None:
    res = read_impls.GetPbsImpl("uid")()
    assert res.ok
    assert res.data["pbs"] == []
    assert "computed_at" in res.data


def test_get_week_plan_reads_current_canonical_week(monkeypatch) -> None:
    from stride_core import timefmt
    from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
    from stride_server import weekly_plan_store

    folder = "2026-07-13_07-19(P2W4)"
    plan = WeeklyPlan(
        week_folder=folder,
        sessions=(
            PlannedSession(
                date="2026-07-15",
                session_index=0,
                kind=SessionKind.RUN,
                summary="Current Azure run",
            ),
        ),
        notes_md="本周保持提升期负荷。",
    )
    calls: list[tuple[str, str]] = []

    class _Store:
        def get_current_plan(self, user_id, on_date):
            calls.append((user_id, on_date))
            return plan

    monkeypatch.setattr(timefmt, "today_shanghai", lambda: date_cls(2026, 7, 15))
    monkeypatch.setattr(weekly_plan_store, "get_weekly_plan_store", lambda: _Store())

    res = read_impls.GetWeekPlanImpl("uid")()

    assert res.ok
    assert calls == [("uid", "2026-07-15")]
    assert res.data["week_folder"] == folder
    assert res.data["structured_source"] == "weekly_plan_store"
    assert res.data["available"] is True
    assert res.data["missing_reason"] is None
    assert res.data["user_message"] is None
    assert res.data["sessions"][0]["summary"] == "Current Azure run"
    assert res.data["notes_md"] == "本周保持提升期负荷。"


def test_get_week_plan_reports_no_current_plan(monkeypatch) -> None:
    from stride_core import timefmt
    from stride_server import weekly_plan_store

    class _Store:
        def get_current_plan(self, _user_id, _on_date):
            return None

    monkeypatch.setattr(timefmt, "today_shanghai", lambda: date_cls(2026, 7, 15))
    monkeypatch.setattr(weekly_plan_store, "get_weekly_plan_store", lambda: _Store())

    res = read_impls.GetWeekPlanImpl("uid")()

    assert res.ok
    assert res.data["week_folder"] is None
    assert res.data["on_date"] == "2026-07-15"
    assert res.data["structured_source"] == "weekly_plan_store"
    assert res.data["available"] is False
    assert res.data["missing_reason"] == "no_plan_for_current_shanghai_week"
    assert res.data["user_message"] == "当前周还没有训练计划，你要创建本周的训练计划吗？"
    assert res.data["sessions"] == []


def test_get_week_plan_reads_explicit_target_folder(monkeypatch) -> None:
    from stride_server import weekly_plan_store
    from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan

    folder = "2026-07-20_07-26"
    plan = WeeklyPlan(
        week_folder=folder,
        sessions=(PlannedSession(
            date="2026-07-22", session_index=0, kind=SessionKind.RUN,
            summary="Next-week run",
        ),),
    )
    calls: list[tuple[str, str]] = []

    class _Store:
        def get_plan(self, user_id, target_folder):
            calls.append((user_id, target_folder))
            return plan

    monkeypatch.setattr(weekly_plan_store, "get_weekly_plan_store", lambda: _Store())

    res = read_impls.GetWeekPlanImpl("uid")(folder=folder)

    assert res.ok
    assert calls == [("uid", folder)]
    assert res.data["week_folder"] == folder
    assert res.data["sessions"][0]["summary"] == "Next-week run"


def test_get_week_plan_does_not_fallback_when_canonical_store_fails(
    monkeypatch, tmp_path
) -> None:
    from stride_server import weekly_plan_store

    class _Store:
        def get_current_plan(self, _user_id, _on_date):
            raise RuntimeError("azure unavailable")

    legacy_plan = tmp_path / "uid" / "logs" / "2026-07-13_07-19" / "plan.md"
    legacy_plan.parent.mkdir(parents=True)
    legacy_plan.write_text("# Legacy plan must not be read", encoding="utf-8")
    monkeypatch.setattr(weekly_plan_store, "get_weekly_plan_store", lambda: _Store())

    res = read_impls.GetWeekPlanImpl("uid")()

    assert not res.ok
    assert res.errors == ["RuntimeError: azure unavailable"]


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
    patched_db._conn.execute(
        """INSERT INTO activity_training_load
           (label_id, activity_date, sport, session_class, algorithm_version,
            cardio_tss, external_tss, mechanical_load, training_dose,
            load_confidence, excluded_from_pmc, reasons_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        ("a1", "2026-05-13", "run_outdoor", "easy", TRAINING_LOAD_MODEL_VERSION,
         55.0, 50.0, 10.0, 53.5, "high", 0, '[]'),
    )
    patched_db._conn.commit()
    res = read_impls.GetRecentActivitiesImpl("uid")(limit=5)
    assert res.ok
    assert len(res.data["activities"]) == 1
    a = res.data["activities"][0]
    assert a["label_id"] == "a1"
    assert a["distance_km"] == 10.0
    assert a["pace_fmt"] == "5:00/km"
    assert a["stride_training_load"] == {
        "source": "stride",
        "vendor_derived": False,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "calibration_id": None,
        "session_class": "easy",
        "cardio_load_raw": None,
        "cardio_tss": 55.0,
        "external_tss": 50.0,
        "mechanical_load": 10.0,
        "subjective_internal_load": None,
        "training_dose": 53.5,
        "load_confidence": "high",
        "excluded_from_pmc": False,
        "reasons": [],
        "available": True,
    }


def test_health_snapshot_uses_stride_load_not_vendor(patched_db) -> None:
    # STRIDE self-computed PMC (acute/chronic/form), NOT COROS ati/cti.
    patched_db._conn.execute(
        """INSERT INTO daily_training_load
           (date, algorithm_version, acute_load, chronic_load, form, load_ratio, coverage_status)
           VALUES (?, ?, ?, ?, ?, ?, 'complete')""",
        ("2026-05-13", TRAINING_LOAD_MODEL_VERSION, 50.0, 62.0, 12.0, 0.81),
    )
    patched_db._conn.execute(
        """INSERT INTO daily_health
           (date, rhr, fatigue, ati, cti, training_load_ratio, training_load_state)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        ("20260513", 52, 77.0, 91.0, 63.0, 1.44, "Very High"),
    )
    patched_db._conn.execute(
        "INSERT INTO daily_hrv (date, last_night_avg, status) VALUES (?, ?, ?)",
        ("2026-05-13", 41, "LOW"),
    )
    patched_db._conn.execute(
        """INSERT INTO dashboard
           (id, recovery_pct, running_level, aerobic_score) VALUES (1, 76, 88, 92)"""
    )
    patched_db._conn.commit()
    res = read_impls.GetHealthSnapshotImpl("uid")()
    assert res.ok
    latest = res.data["stride_training_load"]
    assert latest is not None
    assert latest["chronic_load"] == 62.0
    assert latest["acute_load"] == 50.0
    assert latest["form"] == 12.0
    # form/chronic = 12/62 = 0.19 → 比赛就绪 (ratio-based, not fixed TSB threshold)
    assert latest["form_zone"] == "race_ready"
    assert latest["source"] == "stride"
    assert latest["vendor_derived"] is False
    assert res.data["raw_measurements"] == {
        "rhr": {"date": "20260513", "rhr": 52},
        "hrv": {"date": "2026-05-13", "last_night_avg": 41},
    }
    # No vendor-computed load fields leak to the LLM.
    exposed_keys = set(res.data) | set(latest) | set(res.data["raw_measurements"])
    exposed_keys |= set(res.data["raw_measurements"]["rhr"])
    exposed_keys |= set(res.data["raw_measurements"]["hrv"])
    for vendor in (
        "ati", "cti", "tsb", "fatigue", "training_load_state",
        "recovery_pct", "running_level", "aerobic_score",
    ):
        assert vendor not in exposed_keys
    assert "LOW" not in str(res.data)


def test_coach_load_readers_keep_partial_and_skip_unknown_current_state(patched_db, monkeypatch) -> None:
    patched_db._conn.executemany(
        """INSERT INTO daily_training_load
           (date, algorithm_version, training_dose, acute_load, chronic_load, form,
            load_ratio, coverage_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            ("2026-05-13", TRAINING_LOAD_MODEL_VERSION, 70.0, 50.0, 62.0,
             12.0, 0.81, "partial"),
            ("2026-05-14", TRAINING_LOAD_MODEL_VERSION, 0.0, 50.0, 62.0,
             12.0, 0.81, "unknown"),
        ],
    )
    patched_db._conn.commit()
    from stride_storage.sqlite.database import Database

    calls = []
    original = Database.fetch_latest_daily_training_load

    def traced_fetch_latest(self, *, algorithm_version, as_of=None):
        calls.append((algorithm_version, as_of))
        return original(self, algorithm_version=algorithm_version, as_of=as_of)

    monkeypatch.setattr(Database, "fetch_latest_daily_training_load", traced_fetch_latest)

    snapshot = read_impls.GetHealthSnapshotImpl("uid")()
    health_series = read_impls.GetHealthSeriesImpl("uid")(
        days=14, metrics=["training_dose", "form"]
    )
    pmc_series = read_impls.GetPmcSeriesImpl("uid")(days=14)

    assert calls == [(TRAINING_LOAD_MODEL_VERSION, None)]
    assert snapshot.ok and snapshot.data["stride_training_load"]["date"] == "2026-05-13"
    assert snapshot.data["stride_training_load"]["coverage_status"] == "partial"
    assert health_series.ok and health_series.data["series"] == [
        {
            "date": "2026-05-13",
            "coverage_status": "partial",
            "training_dose": 70.0,
            "form": 12.0,
        }
    ]
    assert pmc_series.ok and len(pmc_series.data["series"]) == 1
    assert pmc_series.data["series"][0]["coverage_status"] == "partial"


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
    cal = res.data["stride_calibration"]
    assert cal is not None
    assert cal["threshold_hr"] == 169.0
    assert cal["threshold_pace_s_km"] == 250  # 1000 / 4.0 m/s
    assert "dashboard" not in res.data


def test_health_series_uses_raw_measurements_and_stride_load_only(patched_db) -> None:
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
            ("20260701", 42, "BALANCED", 35, 55, "coros"),
            ("2026-07-03", 38, "LOW", 35, 55, "coros"),
        ],
    )
    conn.executemany(
        """INSERT INTO daily_training_load
           (date, algorithm_version, training_dose, acute_load, chronic_load, form, load_ratio,
            readiness_gate, readiness_reasons_json, coverage_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')""",
        [
            ("2026-07-01", TRAINING_LOAD_MODEL_VERSION, 60.0, 50.0, 55.0, 5.0, 0.91, "green", '["ok"]'),
            ("2026-07-03", TRAINING_LOAD_MODEL_VERSION, 80.0, 58.0, 56.0, -2.0, 1.04, "yellow", '["low_hrv"]'),
        ],
    )
    conn.commit()

    res = read_impls.GetHealthSeriesImpl("uid")(
        days=7,
        metrics=["rhr", "hrv_last_night_avg", "form", "load_ratio"],
    )
    assert res.ok
    assert res.data["metrics"] == [
        "rhr",
        "hrv_last_night_avg",
        "form",
        "load_ratio",
    ]
    assert res.data["coverage"]["rhr"] == 3
    assert res.data["coverage"]["hrv_last_night_avg"] == 2
    assert res.data["coverage"]["form"] == 2
    assert res.data["series"] == [
        {
            "date": "2026-07-01",
            "rhr": 49,
            "hrv_last_night_avg": 42,
            "form": 5.0,
            "load_ratio": 0.91,
        },
        {"date": "2026-07-02", "rhr": 50},
        {
            "date": "2026-07-03",
            "rhr": 51,
            "hrv_last_night_avg": 38,
            "form": -2.0,
            "load_ratio": 1.04,
        },
    ]
    payload = str(res.data)
    assert "fatigue" not in payload
    assert "BALANCED" not in payload
    assert "LOW" not in payload
    assert "readiness" not in payload


def test_health_series_prefers_one_raw_hrv_measurement_when_dual_provider(patched_db) -> None:
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
        metrics=["rhr", "hrv_last_night_avg"],
    )
    assert res.ok
    assert res.data["series"] == [
        {
            "date": "2026-07-04",
            "rhr": 48,
            "hrv_last_night_avg": 44,
        }
    ]


@pytest.mark.parametrize(
    "metric",
    [
        "fatigue", "ati", "cti", "training_load_ratio",
        "training_load_state", "hrv_status", "hrv_provider",
        "readiness_gate", "readiness_reasons",
    ],
)
def test_health_series_rejects_vendor_derived_metrics(patched_db, metric) -> None:
    res = read_impls.GetHealthSeriesImpl("uid")(metrics=[metric])
    assert not res.ok
    assert any("unsupported metrics" in error for error in res.errors)


def test_health_series_rejects_unknown_metrics(patched_db) -> None:
    res = read_impls.GetHealthSeriesImpl("uid")(metrics=["rhr", "vo2max"])
    assert not res.ok
    assert any("unsupported metrics" in e and "vo2max" in e for e in res.errors)


def test_pmc_series_uses_stride_load(patched_db) -> None:
    patched_db._conn.execute(
        """INSERT INTO daily_training_load
           (date, algorithm_version, acute_load, chronic_load, form, load_ratio, coverage_status)
           VALUES (?, ?, ?, ?, ?, ?, 'complete')""",
        ("2026-05-13", TRAINING_LOAD_MODEL_VERSION, 50.0, 62.0, 12.0, 0.81),
    )
    patched_db._conn.commit()
    res = read_impls.GetPmcSeriesImpl("uid")(days=14)
    assert res.ok
    series = res.data["series"]
    assert len(series) == 1
    assert series[0]["chronic_load"] == 62.0
    assert series[0]["form"] == 12.0
    assert series[0]["source"] == "stride"
    assert series[0]["vendor_derived"] is False
    assert res.data["provenance"]["training_load"]["source"] == "stride"
    assert "ati" not in series[0] and "cti" not in series[0]


def test_ability_snapshot_excludes_legacy_vendor_dependent_dimensions(patched_db) -> None:
    conn = patched_db._conn
    rows = [
        ("2026-07-01", "L2", "total", 88.0),
        ("2026-07-01", "L3", "recovery", 91.0),
        ("2026-07-01", "L3", "endurance", 82.0),
        ("2026-07-01", "L3", "vo2max", 75.0),
        ("2026-07-01", "L4", "composite", 84.0),
    ]
    conn.executemany(
        "INSERT INTO ability_snapshot (date, level, dimension, value) VALUES (?, ?, ?, ?)",
        rows,
    )
    conn.commit()

    res = read_impls.GetAbilitySnapshotImpl("uid")()

    assert res.ok
    visible = {(row["level"], row["dimension"]) for row in res.data["latest"]}
    assert visible == {("L3", "endurance"), ("L3", "vo2max")}


def test_race_predictions_use_stride_ability_not_vendor_table(patched_db) -> None:
    conn = patched_db._conn
    conn.execute(
        "INSERT INTO ability_snapshot (date, level, dimension, value) VALUES (?, ?, ?, ?)",
        ("2026-07-01", "L3", "vo2max", 75.0),
    )
    conn.execute(
        "INSERT INTO race_predictions (race_type, duration_s, avg_pace) VALUES (?, ?, ?)",
        ("Marathon", 9999.0, 237.0),
    )
    conn.commit()

    res = read_impls.GetRacePredictionsImpl("uid")()

    assert res.ok
    assert res.data["provenance"]["predictions"]["source"] == "stride"
    assert res.data["computed_at"] == "2026-07-01"
    assert res.data["predictions"]["FM"]["predicted_time_sec"] != 9999


def test_activity_detail_drops_vendor_scores_zones_and_existing_commentary(patched_db) -> None:
    conn = patched_db._conn
    conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
            training_load, vo2max, performance, train_type, aerobic_effect, anaerobic_effect,
            calories_kcal, adjusted_pace)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        ("a1", "run", 100, "Run", "2026-07-01T00:00:00+00:00", 10000, 3000,
         222, 61, 90, "Aerobic Endurance", 4.0, 2.0, 800, 299),
    )
    conn.execute(
        """INSERT INTO zones
           (label_id, zone_type, zone_index, range_min, range_max, range_unit, duration_s, percent)
           VALUES ('a1', 'heartRate', 1, 100, 120, 'bpm', 500, 10)"""
    )
    conn.execute(
        "INSERT INTO activity_commentary (label_id, commentary) VALUES (?, ?)",
        ("a1", "厂商疲劳值 70"),
    )
    conn.commit()

    res = read_impls.GetActivityDetailImpl("uid")(label_id="a1")

    assert res.ok
    activity = res.data["activity"]
    for field in (
        "training_load", "vo2max", "performance", "train_type",
        "aerobic_effect", "anaerobic_effect", "calories_kcal",
        "adjusted_pace", "commentary",
    ):
        assert field not in activity
    assert "zones" not in res.data
    assert "厂商疲劳值" not in str(res.data)


def test_recent_activities_drops_vendor_training_load(patched_db) -> None:
    patched_db._conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
            training_load, vo2max, train_type, calories_kcal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        ("a1", "run", 100, "Run", "2026-05-13T08:00:00+00:00", 10000, 3000,
         400, 62, "Aerobic Endurance", 700),
    )
    patched_db._conn.commit()
    res = read_impls.GetRecentActivitiesImpl("uid")(limit=5)
    assert res.ok
    # The vendor per-activity load must not reach the coach context.
    assert "training_load" not in res.data["activities"][0]
    assert "vo2max" not in res.data["activities"][0]
    assert "train_type" not in res.data["activities"][0]
    assert "calories_kcal" not in res.data["activities"][0]
    assert res.data["activities"][0]["stride_training_load"] == {
        "source": "stride",
        "vendor_derived": False,
        "algorithm_version": None,
        "calibration_id": None,
        "session_class": None,
        "cardio_load_raw": None,
        "cardio_tss": None,
        "external_tss": None,
        "mechanical_load": None,
        "subjective_internal_load": None,
        "training_dose": None,
        "load_confidence": None,
        "excluded_from_pmc": None,
        "reasons": [],
        "available": False,
        "missing_reason": "stride_load_not_computed",
    }


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
