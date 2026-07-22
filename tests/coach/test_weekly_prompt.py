"""Tests for the weekly JSON contract + system-prompt composer (Stage-3a Task 2).

Covers:
- the s/km -> m:ss formatting used by the pace/volume renders,
- PaceTargets.render() / VolumeTargets.render() output shape,
- the composer carries the contract sentinel, the phase emphasis, both the
  pace table and the volume budget, the context block, and the week framing,
- all 6 PhaseTypes compose without error and each carries its specialist doctrine,
- pace_targets / volume_targets are required positional/keyword args (TypeError
  if omitted).
"""

from __future__ import annotations

import pytest

from stride_core.master_plan import PhaseType

from coach.graphs.generation.phase_specialists import get_specialist
from coach.graphs.generation.weekly_prompt import (
    WEEKLY_PLAN_JSON_CONTRACT_SENTINEL,
    WeekMeta,
    build_weekly_system_prompt,
)
from coach.schemas import PaceTargets, VolumeTargets
from coach.schemas.specialist_context import fmt_pace_s_km


# ---------------------------------------------------------------------------
# s/km -> m:ss formatting
# ---------------------------------------------------------------------------


def test_fmt_pace_known_value():
    assert fmt_pace_s_km(242) == "4:02"


def test_fmt_pace_pads_seconds():
    assert fmt_pace_s_km(305) == "5:05"
    assert fmt_pace_s_km(300) == "5:00"


def test_fmt_pace_seconds_carry():
    # A fractional value that rounds up to a multiple of 60 must carry into
    # the minutes place (never render "X:60").
    assert fmt_pace_s_km(359.5) == "6:00"
    assert fmt_pace_s_km(119.6) == "2:00"


# ---------------------------------------------------------------------------
# Render methods
# ---------------------------------------------------------------------------


def _pace_targets() -> PaceTargets:
    return PaceTargets(
        easy_pace_low_s_km=325,
        easy_pace_high_s_km=350,
        marathon_pace_s_km=242,
        threshold_pace_s_km=228,
        interval_pace_s_km=212,
        rep_1000m_s_km=210,
        rep_400m_s_km=200,
    )


def _volume_targets() -> VolumeTargets:
    return VolumeTargets(
        weekly_km=100,
        long_run_km=30,
        quality_km_budget=18,
        easy_km=52,
    )


def test_pace_targets_render_carries_tokens():
    line = _pace_targets().render()
    assert "5:25-5:50" in line  # easy/z2 range
    assert "MP 4:02" in line
    assert "3:48" in line  # threshold 228 s/km
    assert "3:32" in line  # interval/VO2max 212 s/km


def test_pace_targets_render_omits_optional_reps_when_none():
    # rep_1000m_s_km / rep_400m_s_km default to None -> their tokens are dropped,
    # while the always-present tokens remain. Exercises the `is not None` branches.
    line = PaceTargets(
        easy_pace_low_s_km=325,
        easy_pace_high_s_km=350,
        marathon_pace_s_km=242,
        threshold_pace_s_km=228,
        interval_pace_s_km=212,
    ).render()
    assert "1km rep" not in line
    assert "400m rep" not in line
    # always-present tokens still there
    assert "z2 5:25-5:50" in line
    assert "MP 4:02" in line
    assert "阈值 3:48" in line
    assert "VO2max(5k) 3:32" in line


def test_volume_targets_render_carries_tokens():
    line = _volume_targets().render()
    assert "周量 100km" in line
    assert "长跑 30km" in line
    assert "质量预算 18km" in line
    assert "easy 52km" in line


# ---------------------------------------------------------------------------
# Composer
# ---------------------------------------------------------------------------


def _week_meta() -> WeekMeta:
    return WeekMeta(
        phase_position="build week 3/7",
        week_folder="2026-06-15_06-21(W3)",
        target_weekly_km=100,
    )


def test_composer_carries_all_required_parts():
    prompt = build_weekly_system_prompt(
        phase=PhaseType.BUILD,
        week_meta=_week_meta(),
        pace_targets=_pace_targets(),
        volume_targets=_volume_targets(),
        context_block="延续性信号：周量趋势 rising；伤病：跟腱（左）。",
    )

    # contract sentinel
    assert WEEKLY_PLAN_JSON_CONTRACT_SENTINEL in prompt
    assert "WEEKLY_PLAN_JSON_CONTRACT/v1" in prompt

    # phase emphasis (the Chinese name)
    assert get_specialist(PhaseType.BUILD).name in prompt  # 专项期

    # pace table render
    assert "MP 4:02" in prompt

    # volume budget render
    assert "周量" in prompt
    assert "长跑" in prompt
    assert "质量预算" in prompt

    # context block
    assert "延续性信号" in prompt
    assert "跟腱" in prompt

    # week framing
    assert "2026-06-15_06-21(W3)" in prompt
    assert "3/7" in prompt


def test_composer_carries_json_contract_field_instructions():
    prompt = build_weekly_system_prompt(
        phase=PhaseType.BASE,
        week_meta=_week_meta(),
        pace_targets=_pace_targets(),
        volume_targets=_volume_targets(),
        context_block="",
    )
    # exact WeeklyPlan field names the LLM must emit
    for token in (
        "week_folder",
        "sessions",
        "nutrition",
        "session_index",
        "total_distance_m",
        "total_duration_s",
        "notes_md",
        "summary",
    ):
        assert token in prompt
    # aspirational: spec must be null
    assert "spec" in prompt
    assert "null" in prompt


def test_composer_states_default_one_session_per_day():
    """The contract must default to one session/day and only allow a second
    same-day session when the injected user request asks for it."""
    prompt = build_weekly_system_prompt(
        phase=PhaseType.BASE,
        week_meta=_week_meta(),
        pace_targets=_pace_targets(),
        volume_targets=_volume_targets(),
        context_block="",
    )
    assert "每天默认 1 节" in prompt
    # the second same-day session is conditional on an explicit user request
    assert "双练" in prompt
    assert "session_index=1" in prompt


@pytest.mark.parametrize("phase", list(PhaseType))
def test_composer_all_phases_carry_specialist_doctrine(phase: PhaseType):
    spec = get_specialist(phase)
    prompt = build_weekly_system_prompt(
        phase=phase,
        week_meta=_week_meta(),
        pace_targets=_pace_targets(),
        volume_targets=_volume_targets(),
        context_block="ctx",
    )
    assert spec.name in prompt
    # the full guidance doctrine is included verbatim
    assert spec.guidance in prompt


def test_pace_and_volume_are_required():
    with pytest.raises(TypeError):
        build_weekly_system_prompt(  # type: ignore[call-arg]
            phase=PhaseType.BUILD,
            week_meta=_week_meta(),
            context_block="ctx",
        )


# ---------------------------------------------------------------------------
# Contract drift-guard
# ---------------------------------------------------------------------------


def test_contract_example_parses_under_plan_spec():
    """The exact dict shape the contract prose tells the LLM to emit must
    round-trip through ``WeeklyPlan.from_dict`` without error.

    Importing ``stride_core.plan_spec`` here is fine — tests are exempt from
    the coach-core import boundary (lint-imports governs only ``src/``). This
    turns the "keep contract field names in sync with plan_spec" comment in
    ``weekly_prompt.py`` into an enforced invariant: a future plan_spec
    rename that breaks the contract surfaces here.
    """
    from stride_core.plan_spec import WeeklyPlan

    example = {
        "schema": "weekly-plan/v1",
        "week_folder": "2026-06-15_06-21(W3)",
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": "2026-06-15",
                "session_index": 0,
                "kind": "run",
                "summary": "专项长跑 32km（后 16km @ MP）",
                "spec": None,  # aspirational
                "notes_md": "z2 5:25-5:50 起步，后半 MP 4:02",
                "total_distance_m": 32000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            }
        ],
        "nutrition": [
            {
                "schema": "plan-nutrition/v1",
                "date": "2026-06-15",
                "kcal_target": 2600,
                "carbs_g": 360,
                "protein_g": 130,
                "fat_g": 70,
                "water_ml": 2500,
                "meals": [
                    {
                        "name": "早餐",
                        "time_hint": "7:30",
                        "kcal": 600,
                        "carbs_g": 90,
                        "protein_g": 25,
                        "fat_g": 12,
                        "items_md": "燕麦 80g + 鸡蛋 2 个 + 香蕉 1 根",
                    }
                ],
                "notes_md": "长跑日补碳",
            }
        ],
        "notes_md": "W3 build 周说明",
    }

    plan = WeeklyPlan.from_dict(example)

    # the aspirational session parsed and is correctly non-pushable
    assert len(plan.sessions) == 1
    assert plan.sessions[0].spec is None
    assert plan.sessions[0].pushable is False
    # nutrition + meal parsed
    assert len(plan.nutrition) == 1
    assert len(plan.nutrition[0].meals) == 1
    assert plan.nutrition[0].meals[0].name == "早餐"
