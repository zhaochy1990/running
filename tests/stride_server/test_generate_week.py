"""Tests for the single-week LLM generator (week_specialist_adapter).

``generate_specialist_week`` — compose → tool-loop → parse(one retry) → validate,
with an injected fake generator LLM.
``generate_week_validated`` — the rule_filter safety gate + bounded
regen-with-feedback + RAISE-on-exhaust, with the inner generator + pace context
stubbed so the loop logic is exercised deterministically.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest
from langchain_core.messages import AIMessage

from coach.schemas import PaceTargets, VolumeTargets
from stride_core.master_plan import PhaseType
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_server import coach_runtime
from stride_server.coach_adapters import week_specialist_adapter as wsa
from stride_server.coach_adapters.week_specialist_adapter import (
    generate_specialist_week,
    generate_week_validated,
)
from stride_server.coach_adapters.week_specialist_adapter import WeekMeta
from stride_server.llm_client import LLMUnavailable
from stride_server.weekly_plan_generator import WeeklyPlanGenerationError

WEEK_FOLDER = "2026-07-13_07-19"
WEEK_START = date(2026, 7, 13)


def _pace() -> PaceTargets:
    return PaceTargets(
        easy_pace_low_s_km=300.0,
        easy_pace_high_s_km=360.0,
        marathon_pace_s_km=270.0,
        threshold_pace_s_km=255.0,
        interval_pace_s_km=235.0,
        rep_1000m_s_km=230.0,
        rep_400m_s_km=215.0,
    )


def _volume(target_km: float) -> VolumeTargets:
    return VolumeTargets(
        weekly_km=target_km,
        long_run_km=round(target_km * 0.3, 1),
        quality_km_budget=round(target_km * 0.15, 1),
        easy_km=round(target_km * 0.55, 1),
    )


def _week_dict(
    *, target_km: float, rest: bool = True, folder: str = WEEK_FOLDER
) -> dict:
    """A schema-valid WeeklyPlan dict whose runs sum to ~target_km.

    ``rest=True`` leaves Monday as a rest day (rule-clean); ``rest=False`` fills
    all 7 days with runs (violates the rest_days rule).
    """
    longest = round(target_km * 0.33, 1)
    run_days = list(range(0, 7)) if not rest else list(range(1, 7))
    others = round((target_km - longest) / (len(run_days) - 1), 3)
    sessions = []
    for offset in range(7):
        day = (WEEK_START + timedelta(days=offset)).isoformat()
        if offset not in run_days:
            sessions.append(
                PlannedSession(
                    date=day, session_index=0, kind=SessionKind.REST, summary="休息"
                )
            )
            continue
        km = longest if offset == run_days[-1] else others
        sessions.append(
            PlannedSession(
                date=day,
                session_index=0,
                kind=SessionKind.RUN,
                summary="E 跑",
                total_distance_m=round(km * 1000),
            )
        )
    return WeeklyPlan(
        week_folder=folder,
        sessions=tuple(sessions),
        nutrition=(),
        notes_md="notes",
    ).to_dict()


class _FakeLLM:
    """Minimal langchain-shaped chat model returning canned content per invoke."""

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls = 0

    def bind_tools(self, _tools):
        return self

    def invoke(self, _messages):
        content = self._responses[min(self.calls, len(self._responses) - 1)]
        self.calls += 1
        return AIMessage(content=content)


@pytest.fixture(autouse=True)
def _reset_generator_llm():
    yield
    coach_runtime.reset_for_tests()


# ── generate_specialist_week ──────────────────────────────────────────────────


def _gen_one(**overrides):
    kwargs = dict(
        phase_type=PhaseType.TAPER,  # taper has no pull-tools → no DB needed
        week_meta=WeekMeta(
            phase_position="taper", week_folder=WEEK_FOLDER, target_weekly_km=40.0
        ),
        user_id="u1",
        pace_targets=_pace(),
        volume_targets=_volume(40.0),
        context_block="",
        injuries=[],
    )
    kwargs.update(overrides)
    return generate_specialist_week(**kwargs)


def test_generates_valid_week():
    coach_runtime.set_generator_llm_for_tests(
        _FakeLLM([json.dumps(_week_dict(target_km=40.0), ensure_ascii=False)])
    )
    out = _gen_one()
    assert out["week_folder"] == WEEK_FOLDER
    assert any(s["kind"] == "run" for s in out["sessions"])


def test_parse_retry_recovers():
    llm = _FakeLLM(
        [
            "not json at all — the model rambled",
            json.dumps(_week_dict(target_km=40.0), ensure_ascii=False),
        ]
    )
    coach_runtime.set_generator_llm_for_tests(llm)
    out = _gen_one()
    assert out["week_folder"] == WEEK_FOLDER
    assert llm.calls == 2  # first pass failed to parse, retried once


def test_unparseable_twice_raises_value_error():
    coach_runtime.set_generator_llm_for_tests(_FakeLLM(["garbage", "still garbage"]))
    with pytest.raises(ValueError, match="parse_failed"):
        _gen_one()


def test_nutrition_block_injected_into_prompt():
    captured = {}

    class _CaptureLLM(_FakeLLM):
        def invoke(self, messages):
            captured["system"] = messages[0].content
            return super().invoke(messages)

    coach_runtime.set_generator_llm_for_tests(
        _CaptureLLM([json.dumps(_week_dict(target_km=40.0), ensure_ascii=False)])
    )
    _gen_one(nutrition_baseline_block="【营养基线】测试基线")
    assert "营养生成要求" in captured["system"]
    assert "测试基线" in captured["system"]


# ── generate_week_validated ───────────────────────────────────────────────────


class _FakeDB:
    def close(self):
        pass


@pytest.fixture
def _stub_context(monkeypatch):
    """Stub the DB + pace/volume context so the validate loop is deterministic."""
    monkeypatch.setattr(wsa, "Database", lambda user: _FakeDB())
    monkeypatch.setattr(
        wsa,
        "build_specialist_context",
        lambda db, **kw: (_pace(), _volume(kw["week_meta"].target_weekly_km)),
    )


def _validated(**overrides):
    kwargs = dict(
        phase_type=PhaseType.BUILD,
        week_meta=WeekMeta(
            phase_position="build", week_folder=WEEK_FOLDER, target_weekly_km=50.0
        ),
        context={"user_id": "u1", "goal": {}, "level": 60.0},
        injuries=[],
        prev_week_km=None,
        max_attempts=3,
    )
    kwargs.update(overrides)
    return generate_week_validated(**kwargs)


def test_returns_rule_clean_week(monkeypatch, _stub_context):
    monkeypatch.setattr(
        wsa, "generate_specialist_week", lambda **_: _week_dict(target_km=50.0)
    )
    out = _validated()
    assert out["week_folder"] == WEEK_FOLDER


def test_regenerates_with_feedback_then_succeeds(monkeypatch, _stub_context):
    calls = {"n": 0, "context_blocks": []}

    def _fake(**kwargs):
        calls["n"] += 1
        calls["context_blocks"].append(kwargs["context_block"])
        # First attempt violates rest_days (no rest day); second is clean.
        return _week_dict(target_km=50.0, rest=calls["n"] >= 2)

    monkeypatch.setattr(wsa, "generate_specialist_week", _fake)
    out = _validated()
    assert out["week_folder"] == WEEK_FOLDER
    assert calls["n"] == 2
    # The 2nd attempt carried the rule-violation feedback.
    assert "违反" in calls["context_blocks"][1]


def test_raises_after_attempts_exhausted(monkeypatch, _stub_context):
    # Always violates rest_days → never rule-clean.
    monkeypatch.setattr(
        wsa,
        "generate_specialist_week",
        lambda **_: _week_dict(target_km=50.0, rest=False),
    )
    with pytest.raises(WeeklyPlanGenerationError, match="rest_days"):
        _validated(max_attempts=2)


def test_immutable_rule_is_exempted(monkeypatch, _stub_context):
    # The only violation (rest_days) is declared immutable → returned as-is.
    monkeypatch.setattr(
        wsa,
        "generate_specialist_week",
        lambda **_: _week_dict(target_km=50.0, rest=False),
    )
    out = _validated(immutable_rules={"rest_days"})
    assert out["week_folder"] == WEEK_FOLDER


def test_llm_unavailable_raises_generation_error(monkeypatch, _stub_context):
    def _boom(**_):
        raise LLMUnavailable("no endpoint")

    monkeypatch.setattr(wsa, "generate_specialist_week", _boom)
    with pytest.raises(WeeklyPlanGenerationError, match="unavailable"):
        _validated()


def test_missing_calibration_raises_generation_error(monkeypatch):
    monkeypatch.setattr(wsa, "Database", lambda user: _FakeDB())

    def _no_calibration(db, **kw):
        raise ValueError("pace_targets: no running calibration snapshot available")

    monkeypatch.setattr(wsa, "build_specialist_context", _no_calibration)
    with pytest.raises(WeeklyPlanGenerationError, match="cannot build weekly plan"):
        _validated()
