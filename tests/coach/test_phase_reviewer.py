"""Tests for coach.graphs.generation.phase_reviewer (Stage-3b T4).

The per-phase doctrine reviewer — the LLM half of the hybrid review. Core
module: prompt strings + XML parsing only, NO LLM call, NO DB.

  * ``build_phase_review_prompt`` carries the phase specialist doctrine
    (name/signature), the master-plan focus, any quantifiable milestone, and a
    compact per-week summary.
  * ``parse_phase_review`` reuses ``parse_reviewer_xml`` then maps the
    ``ReviewReport`` to the slim ``PhaseReview`` (verdict + commentary + issues),
    with ``auto_fix`` softened to ``pass`` and malformed XML softened from the
    parser's hard ``block`` to a non-shipping ``revise``.
"""

from __future__ import annotations

from coach.graphs.generation.phase_reviewer import (
    build_phase_review_prompt,
    parse_phase_review,
)
from coach.schemas import PhaseReview


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def _speed_weeks() -> list[dict]:
    """Two compact WeeklyPlan dicts for a speed phase."""
    return [
        {
            "schema": "weekly-plan/v1",
            "week_folder": "2026-06-15_06-21(W1)",
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-06-16",
                    "session_index": 0,
                    "kind": "run",
                    "summary": "VO2max 1k * 6 @ 3:35/km",
                    "total_distance_m": 12000,
                },
                {
                    "schema": "plan-session/v1",
                    "date": "2026-06-18",
                    "session_index": 0,
                    "kind": "run",
                    "summary": "z2 easy 14km",
                    "total_distance_m": 14000,
                },
            ],
        },
        {
            "schema": "weekly-plan/v1",
            "week_folder": "2026-06-22_06-28(W2)",
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-06-23",
                    "session_index": 0,
                    "kind": "run",
                    "summary": "短间歇 400m * 16 @ 速度配速",
                    "total_distance_m": 11000,
                },
            ],
        },
    ]


# ---------------------------------------------------------------------------
# build_phase_review_prompt
# ---------------------------------------------------------------------------


def test_prompt_carries_doctrine_focus_milestone_and_weeks():
    prompt = build_phase_review_prompt(
        phase_type="speed",
        phase_focus="发展 VO2max 与速度储备",
        milestone_summary="5k sub-19:00（race_time_s_5k <= 1140）",
        weeks=_speed_weeks(),
    )
    # specialist doctrine signature (name + a distinctive doctrine token)
    assert "速度周期" in prompt
    assert "VO2max" in prompt
    # the phase focus string
    assert "发展 VO2max 与速度储备" in prompt
    # the milestone summary
    assert "5k sub-19:00" in prompt
    assert "1140" in prompt
    # per-week summary tokens (folder + a key session summary + km)
    assert "2026-06-15_06-21(W1)" in prompt
    assert "1k * 6" in prompt
    assert "短间歇 400m * 16" in prompt


def test_prompt_emits_review_xml_envelope_contract():
    """The prompt must instruct the LLM to emit the same XML envelope the
    shared ``parse_reviewer_xml`` consumes (verdict/commentary/issues)."""
    prompt = build_phase_review_prompt(
        phase_type="base",
        phase_focus="建立有氧基底",
        milestone_summary=None,
        weeks=_speed_weeks(),
    )
    assert "<review>" in prompt
    assert "<verdict>" in prompt
    assert "<commentary>" in prompt
    assert "<issues>" in prompt
    # the four verdict tokens the parser recognises
    assert "pass" in prompt
    assert "revise" in prompt
    assert "block" in prompt


def test_prompt_handles_missing_milestone():
    """No milestone → prompt still composes (no dangling 'None')."""
    prompt = build_phase_review_prompt(
        phase_type="recovery",
        phase_focus="主动恢复",
        milestone_summary=None,
        weeks=[],
    )
    assert "恢复期" in prompt
    assert "主动恢复" in prompt
    # no stray python None literal leaked into the prose
    assert "None" not in prompt


# ---------------------------------------------------------------------------
# parse_phase_review
# ---------------------------------------------------------------------------


def test_parse_block_preserves_verdict_and_issues():
    raw = """<review>
      <verdict>block</verdict>
      <reviewer_model>claude-opus-4-5</reviewer_model>
      <iteration>0</iteration>
      <commentary>speed 阶段缺真正的 Z5 间歇</commentary>
      <issues>[{"review_class": "phase_fit", "severity": "error", "message": "no real Z5 work"}]</issues>
    </review>"""
    review = parse_phase_review(raw)
    assert isinstance(review, PhaseReview)
    assert review.verdict == "block"
    assert review.commentary_md == "speed 阶段缺真正的 Z5 间歇"
    assert len(review.issues) == 1
    assert review.issues[0].review_class == "phase_fit"
    assert review.issues[0].message == "no real Z5 work"


def test_parse_revise_maps_through():
    raw = """<review>
      <verdict>revise</verdict>
      <commentary>质量密度不足</commentary>
      <issues>[]</issues>
    </review>"""
    review = parse_phase_review(raw)
    assert review.verdict == "revise"
    assert review.commentary_md == "质量密度不足"


def test_parse_pass_maps_through():
    raw = """<review>
      <verdict>pass</verdict>
      <commentary>符合速度周期特征</commentary>
    </review>"""
    review = parse_phase_review(raw)
    assert review.verdict == "pass"


def test_parse_auto_fix_softened_to_pass():
    """At per-phase granularity there is no patch-apply step (PhaseReview drops
    suggested_patches), so an ``auto_fix`` verdict is softened to ``pass`` — keep
    the weeks, surface the minor issues in commentary/issues."""
    raw = """<review>
      <verdict>auto_fix</verdict>
      <commentary>仅小问题</commentary>
      <issues>[{"review_class": "rest_distribution", "severity": "warning", "message": "三个零 dose 天"}]</issues>
    </review>"""
    review = parse_phase_review(raw)
    assert review.verdict == "pass"
    # issues are preserved even though the verdict softened
    assert len(review.issues) == 1
    assert review.issues[0].severity == "warning"


def test_parse_malformed_softens_block_to_revise():
    """``parse_reviewer_xml`` falls back to ``block`` on garbage. For a phase
    review a parse failure means "review unavailable, can't confirm" — we soften
    that to ``revise`` so the orchestrator regenerates/retries rather than hard
    blocking the whole season on an LLM formatting hiccup."""
    review = parse_phase_review("not xml at all")
    assert review.verdict == "revise"
    assert review.issues == []
