from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from coach.graphs.generation.rule_filter import run_rule_filter
from stride_server import weekly_plan_generator as generator


class _Db:
    def list_activities(self, **_kwargs):
        return {"rows": []}

    def close(self):
        pass


class _WeeklyStore:
    def get_current_plan(self, _user_id, _day):
        return None


def _master(low: float, high: float):
    week = SimpleNamespace(
        week_index=11,
        week_start="2026-07-13",
        phase_id="build",
        target_weekly_km_low=low,
        target_weekly_km_high=high,
    )
    phase = SimpleNamespace(id="build", name="专项进展期")
    return SimpleNamespace(weeks=[week], weekly_key_sessions=[], phases=[phase])


def test_generator_uses_active_master_week_target_and_passes_week_rules(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stride_server.master_plan_store.get_master_plan_store",
        lambda: SimpleNamespace(get_active_plan=lambda _uid: _master(68, 74)),
    )
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())

    generated = generator.build_weekly_plan(
        user_id="u1", week_start=date(2026, 7, 13)
    )

    assert generated.total_distance_km == 71.0
    assert sum(
        (session.total_distance_m or 0) for session in generated.plan.sessions
    ) == 71000
    assert "总体计划第 11 周" in (generated.plan.notes_md or "")
    report = run_rule_filter(
        generated.plan.to_dict(), target_weekly_km=71.0
    )
    assert report.ok, report.errors()


def test_explicit_base_distance_overrides_master_week_target(monkeypatch) -> None:
    monkeypatch.setattr(
        generator,
        "_master_week_target",
        lambda *_: (_ for _ in ()).throw(AssertionError("must not read master")),
    )
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())

    generated = generator.build_weekly_plan(
        user_id="u1",
        week_start=date(2026, 7, 13),
        base_distance_km=50,
    )

    assert generated.total_distance_km == 50.0


def test_generator_rejects_rule_invalid_output(monkeypatch) -> None:
    monkeypatch.setattr(generator, "_master_week_target", lambda *_: None)
    monkeypatch.setattr(generator, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(generator, "get_db", lambda _uid: _Db())
    real_generate = generator.generate_week_plan

    def _invalid(**kwargs):
        plan, base = real_generate(**kwargs)
        from dataclasses import replace

        sessions = list(plan.sessions)
        sessions[-1] = replace(sessions[-1], total_distance_m=30000)
        return replace(plan, sessions=tuple(sessions)), base

    monkeypatch.setattr(generator, "generate_week_plan", _invalid)

    import pytest

    with pytest.raises(ValueError, match="failed safety rules"):
        generator.build_weekly_plan(
            user_id="u1",
            week_start=date(2026, 7, 13),
            base_distance_km=40,
        )
