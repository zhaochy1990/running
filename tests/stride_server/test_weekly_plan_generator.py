from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest

from coach.graphs.generation.rule_filter import run_rule_filter
from stride_server import weekly_plan_generator as generator
from tests.stride_server._fake_weekly_plan import (
    fake_week_plan_dict,
    install_fake_weekly_generator,
)


def _install_fake_generator(monkeypatch, *, capture: dict | None = None):
    install_fake_weekly_generator(monkeypatch, capture=capture)


class _Db:
    def list_activities(self, **_kwargs):
        return {"rows": []}

    def close(self):
        pass


class _StateDb(_Db):
    def __init__(
        self,
        *,
        completed_weeks: tuple[float, ...],
        load_ratio: float,
        daily: dict[int, dict] | None = None,
    ) -> None:
        self.completed_weeks = completed_weeks
        self.load_ratio = load_ratio
        self.daily = daily or {}

    def get_running_week_summaries(self, windows):
        if windows and windows[0][1] == windows[0][2]:
            return self.daily
        return {
            window[0]: {"actual_distance_km": km}
            for window, km in zip(windows, self.completed_weeks, strict=False)
        }

    def fetch_latest_daily_training_load(self):
        return {"load_ratio": self.load_ratio}


class _WeeklyStore:
    def get_current_plan(self, _user_id, _day):
        return None


def _patch_master(monkeypatch, plan):
    monkeypatch.setattr(
        "stride_server.master_plan_store.get_master_plan_store",
        lambda: SimpleNamespace(get_active_plan=lambda _uid: plan),
    )


def _master(
    low: float,
    high: float,
    *,
    week_start: str = "2026-07-13",
    is_recovery_week: bool = False,
    is_taper_week: bool = False,
):
    week = SimpleNamespace(
        week_index=11,
        week_start=week_start,
        phase_id="build",
        target_weekly_km_low=low,
        target_weekly_km_high=high,
        is_recovery_week=is_recovery_week,
        is_taper_week=is_taper_week,
    )
    phase = SimpleNamespace(id="build", name="专项进展期")
    return SimpleNamespace(
        weeks=[week], weekly_key_sessions=[], phases=[phase], milestones=[]
    )


# A fixed "today" that is AFTER the test weeks (so prior weeks count as complete
# and the target week is NOT mid-week) — deterministic regardless of wall clock.
_AFTER = date(2026, 7, 27)


def test_generator_uses_active_master_week_target_and_passes_week_rules(
    monkeypatch,
) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    _patch_master(monkeypatch, _master(68, 74))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13)
    )

    assert generated.total_distance_km == 71.0
    assert sum(
        (session.total_distance_m or 0) for session in generated.plan.sessions
    ) == 71000
    assert "总体计划第 11 周" in (generated.plan.notes_md or "")
    report = run_rule_filter(generated.plan.to_dict(), target_weekly_km=71.0)
    assert report.ok, report.errors()


def test_user_request_threads_into_generator(monkeypatch) -> None:
    """An ad-hoc request reaches the LLM generator's user_request arg."""
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    _patch_master(monkeypatch, _master(68, 74))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())
    capture: dict = {}
    _install_fake_generator(monkeypatch, capture=capture)

    generator.build_weekly_plan(
        user_id="u1",
        week_start=date(2026, 7, 13),
        user_request="周三下午加一节 5K 轻松跑（当天两练）",
    )

    assert capture["user_request"] == "周三下午加一节 5K 轻松跑（当天两练）"
    assert capture["meta"].target_weekly_km == 71.0


def test_recent_actual_volume_floors_stale_low_master_target(monkeypatch) -> None:
    """A normal week must not drop from a stable 120km baseline to 71km."""
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    _patch_master(monkeypatch, _master(68, 74, week_start="2026-07-20"))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(completed_weeks=(120.0, 126.0), load_ratio=1.0),
    )
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 20)
    )

    assert generated.total_distance_km == 111.0
    assert "总体计划 71.0km 已校准为 111.0km" in (generated.plan.notes_md or "")


def test_current_stride_model_load_ratio_reduces_overloaded_week(
    monkeypatch,
) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    _patch_master(monkeypatch, _master(98, 102, week_start="2026-07-20"))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(completed_weeks=(100.0, 100.0), load_ratio=1.30),
    )
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 20)
    )

    assert generated.total_distance_km == 90.0
    assert "STRIDE load_ratio=1.30" in (generated.plan.notes_md or "")


def test_recovery_week_allows_controlled_deload_from_actual_baseline(
    monkeypatch,
) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    _patch_master(
        monkeypatch,
        _master(38, 43, week_start="2026-07-20", is_recovery_week=True),
    )
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(completed_weeks=(120.0, 126.0), load_ratio=1.0),
    )
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 20)
    )

    assert generated.total_distance_km == 86.5


def test_midweek_generation_locks_actual_days_and_only_budgets_remainder(
    monkeypatch,
) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: date(2026, 7, 16))
    _patch_master(monkeypatch, _master(98, 102))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(
            completed_weeks=(100.0, 100.0),
            load_ratio=1.0,
            daily={
                0: {"actual_distance_km": 30.0, "total_duration_s": 9000},
                1: {"actual_distance_km": 25.0, "total_duration_s": 7500},
                2: {"actual_distance_km": 20.0, "total_duration_s": 6000},
            },
        ),
    )
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13)
    )

    assert generated.total_distance_km == 100.0
    assert [session.summary for session in generated.plan.sessions[:3]] == [
        "已完成跑步（30.0K）",
        "已完成跑步（25.0K）",
        "已完成跑步（20.0K）",
    ]
    assert sum(
        float(session.total_distance_m or 0)
        for session in generated.plan.sessions
    ) == 100_000
    assert any(
        session.kind.value == "rest" for session in generated.plan.sessions[3:]
    )


def test_midweek_generation_does_not_reject_immutable_over_cap_actuals(
    monkeypatch,
) -> None:
    """Progression gates apply to prescriptions, not completed historical work."""
    monkeypatch.setattr(generator, "today_shanghai", lambda: date(2026, 7, 16))
    _patch_master(monkeypatch, _master(68, 74))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(
            completed_weeks=(40.0, 42.0),
            load_ratio=1.0,
            daily={
                0: {"actual_distance_km": 18.0, "total_duration_s": 5400},
                1: {"actual_distance_km": 16.0, "total_duration_s": 4800},
                2: {"actual_distance_km": 15.0, "total_duration_s": 4500},
            },
        ),
    )
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13)
    )

    # 49km actual is already above the normal 45.1km progression ceiling.
    # The generator must preserve it and avoid prescribing additional mileage.
    assert generated.total_distance_km == 49.0
    assert sum(
        float(session.total_distance_m or 0)
        for session in generated.plan.sessions
    ) == 49_000
    assert all(
        session.kind.value != "run" for session in generated.plan.sessions[3:]
    )


def test_end_of_week_generation_preserves_completed_seven_day_streak(
    monkeypatch,
) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: date(2026, 7, 19))
    _patch_master(monkeypatch, _master(68, 74))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(
            completed_weeks=(70.0, 72.0),
            load_ratio=1.0,
            daily={
                offset: {
                    "actual_distance_km": 10.0,
                    "total_duration_s": 3300,
                }
                for offset in range(7)
            },
        ),
    )
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13)
    )

    assert generated.total_distance_km == 70.0
    assert sum(
        float(session.total_distance_m or 0)
        for session in generated.plan.sessions
    ) == 70_000
    assert all(
        session.summary == "已完成跑步（10.0K）"
        for session in generated.plan.sessions
    )


def test_midweek_same_day_double_does_not_double_count_actuals(monkeypatch) -> None:
    """A synced day's actual km aggregates the whole day, so a same-day double
    (session_index 0/1) must credit it to ONE session — never both."""
    monkeypatch.setattr(generator, "today_shanghai", lambda: date(2026, 7, 15))
    _patch_master(monkeypatch, _master(98, 102))
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        generator,
        "get_db",
        lambda _uid: _StateDb(
            completed_weeks=(100.0, 100.0),
            load_ratio=1.0,
            daily={
                0: {"actual_distance_km": 30.0, "total_duration_s": 9000},
                1: {"actual_distance_km": 30.0, "total_duration_s": 9000},
                2: {"actual_distance_km": 30.0, "total_duration_s": 9000},
            },
        ),
    )

    def _double_fake(phase, week_metas, context, injuries=None, **kwargs):
        meta = week_metas[0]
        week_start = date.fromisoformat(meta.week_folder[:10])
        plan = fake_week_plan_dict(
            meta.week_folder, week_start, float(meta.target_weekly_km)
        )
        plan["sessions"].append(
            {
                "schema": "plan-session/v1",
                "date": "2026-07-15",
                "session_index": 1,
                "kind": "run",
                "summary": "午后恢复跑（6K）",
                "spec": None,
                "notes_md": "极轻松",
                "total_distance_m": 6000,
                "total_duration_s": 2000,
                "scheduled_workout_id": None,
            }
        )
        return [plan]

    monkeypatch.setattr(
        "stride_server.coach_adapters.phase_specialist_adapter."
        "generate_phase_validated",
        _double_fake,
    )

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13)
    )

    wed = [s for s in generated.plan.sessions if s.date == "2026-07-15"]
    assert len(wed) == 2
    completed_wed = [s for s in wed if s.summary.startswith("已完成跑步")]
    assert len(completed_wed) == 1
    completed_km_total = sum(
        float(s.total_distance_m or 0)
        for s in generated.plan.sessions
        if s.summary.startswith("已完成跑步")
    )
    # 3 locked days × 30K credited ONCE each. The double-count bug would credit
    # Wed twice → 120K.
    assert completed_km_total == 90_000


def test_explicit_base_distance_overrides_master_week_target(monkeypatch) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    monkeypatch.setattr(
        generator,
        "_master_week_target",
        lambda *_: (_ for _ in ()).throw(AssertionError("must not read master")),
    )
    _patch_master(monkeypatch, None)
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())
    _install_fake_generator(monkeypatch)

    generated = generator.build_weekly_plan(
        user_id="u1",
        week_start=date(2026, 7, 13),
        base_distance_km=50,
    )

    assert generated.total_distance_km == 50.0


def test_generator_rejects_rule_invalid_output(monkeypatch) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: _AFTER)
    monkeypatch.setattr(generator, "_master_week_target", lambda *_: None)
    _patch_master(monkeypatch, None)
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())

    def _invalid(phase, week_metas, context, injuries=None, **kwargs):
        # A single 30km run out of a 40km week → long_run_share 75% > 35%.
        meta = week_metas[0]
        week_start = date.fromisoformat(meta.week_folder[:10])
        plan = fake_week_plan_dict(meta.week_folder, week_start, 40.0)
        plan["sessions"][-1]["total_distance_m"] = 30000
        return [plan]

    monkeypatch.setattr(
        "stride_server.coach_adapters.phase_specialist_adapter."
        "generate_phase_validated",
        _invalid,
    )

    with pytest.raises(generator.WeeklyPlanGenerationError, match="failed safety rules"):
        generator.build_weekly_plan(
            user_id="u1",
            week_start=date(2026, 7, 13),
            base_distance_km=40,
        )
