"""build_weekly_plan orchestration tests (LLM path).

The heavy generator LLM call (``generate_week_validated``) is stubbed so these
tests exercise build_weekly_plan's own responsibilities: resolving the
executable weekly km target, threading phase / prev-week / immutable-rule /
nutrition-baseline / completed-day context into the generator, and surfacing
generation failures. The LLM authoring itself is covered by
``test_generate_week.py``.
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from stride_core.master_plan import PhaseType
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_server import weekly_plan_generator as generator
from stride_server.weekly_plan_generator import (
    WeeklyPlanAlreadyExistsError,
    WeeklyPlanGenerationError,
)

_GEN_TARGET = (
    "stride_server.coach_adapters.week_specialist_adapter.generate_week_validated"
)


# ── Test doubles ──────────────────────────────────────────────────────────────


class _Db:
    def list_activities(self, **_kwargs):
        return {"rows": []}

    def close(self):
        pass


class _StateDb(_Db):
    def __init__(
        self,
        *,
        completed_weeks: tuple[float, ...] = (),
        load_ratio: float | None = None,
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
        if self.load_ratio is None:
            return None
        return {"load_ratio": self.load_ratio}


class _WeeklyStore:
    def __init__(self, existing=None) -> None:
        self._existing = existing

    def get_current_plan(self, _user_id, _day):
        return self._existing


def _master(
    low: float,
    high: float,
    *,
    week_start: str = "2026-07-13",
    is_recovery_week: bool = False,
    is_taper_week: bool = False,
    phase_type: PhaseType | None = PhaseType.BUILD,
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
    phase = SimpleNamespace(id="build", name="专项进展期", phase_type=phase_type)
    return SimpleNamespace(
        weeks=[week], weekly_key_sessions=[], phases=[phase], goal=None
    )


def _fake_week_dict(*, week_meta, **_kwargs) -> dict:
    """A schema-valid WeeklyPlan dict — build_weekly_plan reports the resolved
    target regardless of the LLM's mileage, so a minimal plan suffices."""
    start = date.fromisoformat(week_meta.week_folder[:10])
    plan = WeeklyPlan(
        week_folder=week_meta.week_folder,
        sessions=(
            PlannedSession(
                date=start.isoformat(),
                session_index=0,
                kind=SessionKind.REST,
                summary="休息日",
            ),
            PlannedSession(
                date=(start + timedelta(days=1)).isoformat(),
                session_index=0,
                kind=SessionKind.RUN,
                summary="E 轻松跑",
                total_distance_m=round(week_meta.target_weekly_km * 1000),
            ),
        ),
        nutrition=(),
        notes_md="LLM authored notes",
    )
    return plan.to_dict()


def _patch_common(monkeypatch, *, master, db, existing=None):
    monkeypatch.setattr(
        "stride_server.master_plan_store.get_master_plan_store",
        lambda: SimpleNamespace(get_active_plan=lambda _uid: master),
    )
    monkeypatch.setattr(
        generator, "get_weekly_plan_store", lambda: _WeeklyStore(existing)
    )
    monkeypatch.setattr(generator, "get_db", lambda _uid: db)


# ── Target resolution (km) ────────────────────────────────────────────────────


def test_resolves_master_week_target_with_no_recent_volume(monkeypatch) -> None:
    _patch_common(monkeypatch, master=_master(68, 74), db=_Db())
    monkeypatch.setattr(_GEN_TARGET, _fake_week_dict)

    generated = generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 13))

    assert generated.total_distance_km == 71.0


def test_recent_actual_volume_floors_stale_low_master_target(monkeypatch) -> None:
    _patch_common(
        monkeypatch,
        master=_master(68, 74, week_start="2026-07-20"),
        db=_StateDb(completed_weeks=(120.0, 126.0), load_ratio=1.0),
    )
    monkeypatch.setattr(_GEN_TARGET, _fake_week_dict)

    generated = generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 20))

    assert generated.total_distance_km == 111.0


def test_stride_load_ratio_reduces_overloaded_week(monkeypatch) -> None:
    _patch_common(
        monkeypatch,
        master=_master(98, 102, week_start="2026-07-20"),
        db=_StateDb(completed_weeks=(100.0, 100.0), load_ratio=1.30),
    )
    monkeypatch.setattr(_GEN_TARGET, _fake_week_dict)

    generated = generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 20))

    assert generated.total_distance_km == 90.0


def test_recovery_week_allows_controlled_deload(monkeypatch) -> None:
    _patch_common(
        monkeypatch,
        master=_master(38, 43, week_start="2026-07-20", is_recovery_week=True),
        db=_StateDb(completed_weeks=(120.0, 126.0), load_ratio=1.0),
    )
    monkeypatch.setattr(_GEN_TARGET, _fake_week_dict)

    generated = generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 20))

    assert generated.total_distance_km == 86.5


def test_explicit_base_distance_overrides_master(monkeypatch) -> None:
    monkeypatch.setattr(
        generator,
        "_master_week_target",
        lambda *_: (_ for _ in ()).throw(AssertionError("must not read master")),
    )
    monkeypatch.setattr(
        generator,
        "_active_master_goal",
        lambda *_: (_ for _ in ()).throw(AssertionError("must not read master goal")),
    )
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())
    monkeypatch.setattr(_GEN_TARGET, _fake_week_dict)

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13), base_distance_km=50
    )

    assert generated.total_distance_km == 50.0


# ── Context threaded into the generator ───────────────────────────────────────


def test_threads_phase_target_and_nutrition_to_generator(monkeypatch) -> None:
    _patch_common(
        monkeypatch,
        master=_master(68, 74, phase_type=PhaseType.BUILD),
        db=_StateDb(completed_weeks=(70.0, 68.0), load_ratio=1.0),
    )
    captured: dict = {}

    def _capture(**kwargs):
        captured.update(kwargs)
        return _fake_week_dict(week_meta=kwargs["week_meta"])

    monkeypatch.setattr(_GEN_TARGET, _capture)

    generated = generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 13))

    assert captured["phase_type"] == PhaseType.BUILD
    assert captured["week_meta"].target_weekly_km == generated.total_distance_km
    assert captured["week_meta"].week_folder.startswith("2026-07-13_")
    # prev week actual km drives the progression gate.
    assert captured["prev_week_km"] == 70.0
    # nutrition baseline is injected as real body-composition context.
    assert "营养基线" in captured["nutrition_baseline_block"]
    assert captured["as_of"] == date(2026, 7, 13)


def test_midweek_injects_completed_days_and_immutable_rules(monkeypatch) -> None:
    monkeypatch.setattr(generator, "today_shanghai", lambda: date(2026, 7, 16))
    _patch_common(
        monkeypatch,
        master=_master(68, 74),
        db=_StateDb(
            completed_weeks=(40.0, 42.0),
            load_ratio=1.0,
            daily={
                0: {"actual_distance_km": 18.0, "total_duration_s": 5400},
                1: {"actual_distance_km": 16.0, "total_duration_s": 4800},
                2: {"actual_distance_km": 15.0, "total_duration_s": 4500},
            },
        ),
    )
    captured: dict = {}

    def _capture(**kwargs):
        captured.update(kwargs)
        return _fake_week_dict(week_meta=kwargs["week_meta"])

    monkeypatch.setattr(_GEN_TARGET, _capture)

    generated = generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 13))

    # 49 km already run is above the normal progression ceiling → floor rises.
    assert generated.total_distance_km == 49.0
    # Completed work makes weekly_progression unfixable → exempted from the gate.
    assert "weekly_progression" in captured["immutable_rules"]
    # Completed days are injected as locked context for the LLM to echo/avoid.
    assert "已完成" in captured["context"]["extra_context_block"]
    assert "2026-07-13" in captured["context"]["extra_context_block"]


# ── Failure surfaces ──────────────────────────────────────────────────────────


def test_generation_failure_propagates(monkeypatch) -> None:
    _patch_common(monkeypatch, master=_master(68, 74), db=_Db())

    def _boom(**_kwargs):
        raise WeeklyPlanGenerationError("persistently violates [rest_days]")

    monkeypatch.setattr(_GEN_TARGET, _boom)

    with pytest.raises(WeeklyPlanGenerationError):
        generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 13))


def test_no_resolvable_target_raises(monkeypatch) -> None:
    # No active master plan and no recent volume → nothing to build a week from.
    _patch_common(monkeypatch, master=None, db=_Db())

    def _must_not_call(**_kwargs):
        raise AssertionError("generator must not run without a target")

    monkeypatch.setattr(_GEN_TARGET, _must_not_call)

    with pytest.raises(WeeklyPlanGenerationError):
        generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 13))


def test_existing_week_without_force_raises(monkeypatch) -> None:
    existing = SimpleNamespace(week_folder="2026-07-13_07-19", sessions=())
    _patch_common(monkeypatch, master=_master(68, 74), db=_Db(), existing=existing)

    with pytest.raises(WeeklyPlanAlreadyExistsError):
        generator.build_weekly_plan(user_id="u1", week_start=date(2026, 7, 13))
