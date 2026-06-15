"""Tests for the phase-level (phase-at-once) system-prompt composer (PA-T2).

The phase composer asks the LLM to emit ALL weeks of a phase in a single batch
(``{"schema":"phase-weeks/v1","weeks":[<WeeklyPlan>, …]}``) with exactly N
weeks, each an aspirational ``spec=null`` WeeklyPlan.

Covers:
- the composed prompt carries the phase sentinel, the specialist name/guidance
  (doctrine), the pace table (``MP 4:02``), a per-week line for EACH of the N
  weeks (week_folder + target km appear), the deload markers, and the
  ``{"weeks":[...]}`` batch instruction with "exactly N",
- with ``feedback=...`` the prompt carries the feedback block + a "fix these"
  instruction; without it, no feedback section (and no dangling label),
- all 6 PhaseTypes compose without error and each carries its specialist
  doctrine,
- a drift-guard: the WeeklyPlan field names in the phase contract round-trip
  through ``WeeklyPlan.from_dict`` (importing plan_spec in the test is fine).
"""

from __future__ import annotations

import pytest

from stride_core.master_plan import PhaseType

from coach.graphs.generation.phase_prompt import (
    PHASE_WEEKS_JSON_CONTRACT_SENTINEL,
    PhaseWeekSpec,
    build_phase_system_prompt,
)
from coach.graphs.generation.phase_specialists import get_specialist
from coach.schemas import PaceTargets, VolumeTargets


# ---------------------------------------------------------------------------
# Fixtures
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


def _week_specs() -> list[PhaseWeekSpec]:
    """A 4-week build phase: 3 ramp weeks + 1 deload."""
    vt = [
        VolumeTargets(weekly_km=90, long_run_km=28, quality_km_budget=16, easy_km=46),
        VolumeTargets(weekly_km=96, long_run_km=30, quality_km_budget=18, easy_km=48),
        VolumeTargets(weekly_km=102, long_run_km=32, quality_km_budget=20, easy_km=50),
        VolumeTargets(weekly_km=72, long_run_km=22, quality_km_budget=8, easy_km=42),
    ]
    folders = [
        "2026-06-15_06-21(W1)",
        "2026-06-22_06-28(W2)",
        "2026-06-29_07-05(W3)",
        "2026-07-06_07-12(W4-deload)",
    ]
    target_km = [90, 96, 102, 72]
    deload = [False, False, False, True]
    specs: list[PhaseWeekSpec] = []
    for i in range(4):
        specs.append(
            PhaseWeekSpec(
                week_index=i + 1,
                n_weeks=4,
                week_folder=folders[i],
                target_weekly_km=target_km[i],
                volume=vt[i],
                is_deload=deload[i],
            )
        )
    return specs


# ---------------------------------------------------------------------------
# Composer — core content
# ---------------------------------------------------------------------------


def test_phase_prompt_carries_sentinel_and_doctrine():
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="延续性信号：周量趋势 rising；伤病：跟腱（左）。",
    )

    # phase sentinel (distinct from the per-week one)
    assert PHASE_WEEKS_JSON_CONTRACT_SENTINEL in prompt
    assert "PHASE_WEEKS_JSON_CONTRACT/v1" in prompt

    # specialist name + full guidance doctrine verbatim
    spec = get_specialist(PhaseType.BUILD)
    assert spec.name in prompt          # 专项期
    assert spec.guidance in prompt

    # pace table render (shared across all weeks, rendered once)
    assert "MP 4:02" in prompt

    # context block passed through
    assert "延续性信号" in prompt
    assert "跟腱" in prompt


def test_phase_prompt_carries_per_week_table():
    specs = _week_specs()
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=specs,
        pace_targets=_pace_targets(),
        context_block="",
    )

    # every week: folder + target km appears
    for s in specs:
        assert s.week_folder in prompt
        # target km rendered as an integer token
        assert str(int(s.target_weekly_km)) in prompt
        # per-week "i/N" framing
        assert f"{s.week_index}/{s.n_weeks}" in prompt


def test_phase_prompt_marks_deload_weeks():
    specs = _week_specs()
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=specs,
        pace_targets=_pace_targets(),
        context_block="",
    )
    # the deload week's folder line must carry a deload marker
    assert "deload" in prompt.lower()
    # the batch instruction names the exact count + the weeks envelope
    assert "exactly 4" in prompt or "恰好 4" in prompt
    assert '"weeks"' in prompt


def test_phase_prompt_exactly_n_scales_with_specs():
    # A 6-week phase -> the "exactly N" instruction reflects 6.
    specs = []
    for i in range(6):
        specs.append(
            PhaseWeekSpec(
                week_index=i + 1,
                n_weeks=6,
                week_folder=f"wk{i + 1}",
                target_weekly_km=80 + i,
                volume=VolumeTargets(
                    weekly_km=80 + i, long_run_km=24, quality_km_budget=12, easy_km=40
                ),
                is_deload=(i == 5),
            )
        )
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BASE,
        week_specs=specs,
        pace_targets=_pace_targets(),
        context_block="",
    )
    assert "exactly 6" in prompt or "恰好 6" in prompt
    for s in specs:
        assert s.week_folder in prompt


# ---------------------------------------------------------------------------
# Feedback (regen) block
# ---------------------------------------------------------------------------


def test_phase_prompt_includes_feedback_when_present():
    fb = "第 4 周违反 rest_days：连续两个硬日；长跑未推进到 milestone 21km。"
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="",
        feedback=fb,
    )
    assert fb in prompt
    # an explicit "fix these" style instruction must accompany the feedback
    assert "修复" in prompt or "逐条" in prompt or "fix" in prompt.lower()


def test_phase_prompt_omits_feedback_section_when_absent():
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="",
    )
    # no dangling feedback label / heading when feedback is None
    assert "上一轮问题" not in prompt
    assert "需修复" not in prompt


# ---------------------------------------------------------------------------
# All phases
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("phase", list(PhaseType))
def test_phase_prompt_all_phases_carry_doctrine(phase: PhaseType):
    spec = get_specialist(phase)
    prompt = build_phase_system_prompt(
        phase_type=phase,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="ctx",
    )
    assert spec.name in prompt
    assert spec.guidance in prompt


# ---------------------------------------------------------------------------
# OPT-A: run_rule_filter HARD-rules block injected into the generation prompt
# ---------------------------------------------------------------------------


def test_phase_prompt_carries_weekly_hard_rules_block():
    """The composed phase prompt must state the 5 run_rule_filter HARD rules
    with their exact thresholds, so the generator produces rule-clean output on
    the FIRST try (OPT-A) instead of learning them via feedback regens.
    """
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="",
    )
    # the block's framing header
    assert "rule_filter" in prompt
    # 1. weekly_progression — 1.10x cap
    assert "1.10" in prompt
    # 2. long_run_share — 35%
    assert "35%" in prompt
    # 3. intensity_distribution — 20% (80/20)
    assert "20%" in prompt
    # 4. rest_days — at least one full rest day
    assert "休息日" in prompt
    # 5. injury_conflict — injury-contraindicated strength
    assert "伤病" in prompt


@pytest.mark.parametrize("phase", list(PhaseType))
def test_phase_prompt_hard_rules_block_present_for_all_phases(phase: PhaseType):
    """The HARD-rules block is phase-independent and must appear for every
    PhaseType (it composes without error for all 6)."""
    from coach.graphs.generation.weekly_plan_contract import WEEKLY_HARD_RULES

    prompt = build_phase_system_prompt(
        phase_type=phase,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="",
    )
    assert WEEKLY_HARD_RULES in prompt


def test_phase_prompt_hard_rules_ramp_matches_gate():
    """Drift-guard: the 1.10 ramp threshold stated in the prompt MUST equal the
    actual gate constant ``rule_filter.MAX_WEEKLY_RAMP_RATIO``. If the gate
    changes, this test fails so the prompt can't silently diverge.
    """
    from coach.graphs.generation.rule_filter import MAX_WEEKLY_RAMP_RATIO

    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BUILD,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="",
    )
    # the constant rendered to 2dp must literally appear in the prompt
    assert f"{MAX_WEEKLY_RAMP_RATIO:.2f}" in prompt
    assert MAX_WEEKLY_RAMP_RATIO == 1.10


# ---------------------------------------------------------------------------
# Contract drift-guard
# ---------------------------------------------------------------------------


def test_phase_contract_field_names_present():
    """The phase contract must carry the WeeklyPlan field names the LLM emits."""
    prompt = build_phase_system_prompt(
        phase_type=PhaseType.BASE,
        week_specs=_week_specs(),
        pace_targets=_pace_targets(),
        context_block="",
    )
    for token in (
        "week_folder",
        "sessions",
        "nutrition",
        "session_index",
        "total_distance_m",
        "total_duration_s",
        "notes_md",
        "summary",
        "spec",
        "null",
    ):
        assert token in prompt


def test_phase_contract_example_week_parses_under_plan_spec():
    """One week inside the phase envelope must round-trip through
    ``WeeklyPlan.from_dict`` — the same drift-guard as weekly_prompt, applied to
    the wrapped per-week shape. Importing plan_spec in the TEST is fine.
    """
    from stride_core.plan_spec import WeeklyPlan

    example_week = {
        "schema": "weekly-plan/v1",
        "week_folder": "2026-06-15_06-21(W1)",
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": "2026-06-15",
                "session_index": 0,
                "kind": "run",
                "summary": "专项长跑 28km（后 12km @ MP）",
                "spec": None,
                "notes_md": "z2 起步，后段 MP 4:02",
                "total_distance_m": 28000,
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
                        "items_md": "燕麦 80g + 鸡蛋 2 个",
                    }
                ],
                "notes_md": "长跑日补碳",
            }
        ],
        "notes_md": "W1 build 周说明",
    }

    plan = WeeklyPlan.from_dict(example_week)
    assert len(plan.sessions) == 1
    assert plan.sessions[0].spec is None
    assert plan.sessions[0].pushable is False
    assert len(plan.nutrition) == 1
    assert plan.nutrition[0].meals[0].name == "早餐"
