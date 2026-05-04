"""Pace-fallback tests for COROS run translation.

When ``step.target`` carries an HR (or open / power) target — common in
Phase 1 plans where we cue heart rate but still write a pace reference in
the step note — the translator should regex-extract pace from
``step.note`` so the pushed COROS workout still shows a pace target on
the watch.
"""

from __future__ import annotations

from coros_sync.translate import (
    _extract_pace_from_note,
    _pace_bounds,
    normalized_to_coros_run,
)
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
    parse_pace_s_km,
)


def _step(target: Target, note: str | None = None) -> WorkoutStep:
    """Tiny WORK step builder — duration is irrelevant for pace tests."""
    return WorkoutStep(
        StepKind.WORK,
        Duration.of_distance_km(8),
        target,
        note=note,
    )


# ─────────────────────────────────────────────────────────────────────────────
# _pace_bounds: target vs note routing
# ─────────────────────────────────────────────────────────────────────────────


def test_pace_target_used_directly():
    """When target.kind == PACE_S_KM, target wins; note is ignored."""
    step = _step(
        Target.pace_range_s_km(parse_pace_s_km("5:40"), parse_pace_s_km("5:20")),
        note="配速参考 6:00-6:30/km",  # would extract differently if used
    )
    assert _pace_bounds(step) == ("5:40", "5:20")


def test_hr_target_with_note_pace_range():
    """HR target + note carrying a pace range → range extracted from note."""
    step = _step(
        Target.hr_range_bpm(130, 148),
        note="配速参考 6:00-6:30/km；HR>148 立即降速",
    )
    assert _pace_bounds(step) == ("6:30", "6:00")


def test_hr_target_with_note_ceiling():
    """HR target + ``≤4:30/km`` note → ±10s window above the ceiling."""
    step = _step(
        Target.hr_range_bpm(160, 175),
        note="阈值段：HR 160-175，≤4:30/km",
    )
    # ceiling 4:30 (270s) → slow 4:40 (280s), fast 4:30
    assert _pace_bounds(step) == ("4:40", "4:30")


def test_hr_target_with_note_at_pace():
    """HR target + ``@5:13/km`` note → ±5s window around target."""
    step = _step(
        Target.hr_range_bpm(150, 165),
        note="马配 @5:13/km",
    )
    # 5:13 = 313s → slow 5:18 (318s), fast 5:08 (308s)
    assert _pace_bounds(step) == ("5:18", "5:08")


def test_hr_target_no_pace_in_note():
    """HR target with no pace anywhere in the note → no pace bounds."""
    step = _step(
        Target.hr_range_bpm(130, 148),
        note="HR<148，按感觉跑；不冲刺",
    )
    assert _pace_bounds(step) == (None, None)


def test_hr_target_no_note():
    """HR target with note=None → no pace bounds."""
    step = _step(Target.hr_range_bpm(130, 148))
    assert _pace_bounds(step) == (None, None)


def test_open_target_with_note_range():
    """Open target with pace in note → still extracts."""
    step = _step(Target.open(), note="放松跑 5:30-6:00/km")
    assert _pace_bounds(step) == ("6:00", "5:30")


# ─────────────────────────────────────────────────────────────────────────────
# _extract_pace_from_note: edge cases on the regex itself
# ─────────────────────────────────────────────────────────────────────────────


def test_pace_range_handles_full_width_dash():
    """CJK / full-width range separators should still match."""
    # full-width tilde "～"
    assert _extract_pace_from_note("配速 5:00～5:30/km") == ("5:30", "5:00")
    # em-dash "—"
    assert _extract_pace_from_note("E 区 6:00—6:30/km") == ("6:30", "6:00")
    # full-width hyphen "－"
    assert _extract_pace_from_note("放松 5:00－5:30/km") == ("5:30", "5:00")
    # tilde "~"
    assert _extract_pace_from_note("热身 6:30~7:00/km") == ("7:00", "6:30")


def test_pace_extraction_with_chinese_text():
    """Pace embedded in mixed Chinese / punctuation context."""
    note = "HR<148，配速 6:00-6:30/km；末段不冲"
    assert _extract_pace_from_note(note) == ("6:30", "6:00")


def test_pace_range_inside_parentheses():
    """Common plan.md form: ``（5:00-5:20/km）`` with full-width parens."""
    assert _extract_pace_from_note("M配段（5:00-5:20/km）") == ("5:20", "5:00")


def test_pace_range_normalized_when_fast_first():
    """If the note writes fast-then-slow (rare), still normalize to slow/fast."""
    # 4:00-5:00 — 4:00 is faster, 5:00 is slower. Output: (slow, fast).
    assert _extract_pace_from_note("配速 4:00-5:00/km") == ("5:00", "4:00")


def test_pace_ceiling_lt_form():
    """``<4:30/km`` (ASCII less-than) treated like ``≤``."""
    # 4:30 = 270s → (4:40, 4:30)
    assert _extract_pace_from_note("阈值 <4:30/km") == ("4:40", "4:30")


def test_no_pace_in_note_returns_none():
    assert _extract_pace_from_note("按感觉跑") is None
    assert _extract_pace_from_note("") is None
    assert _extract_pace_from_note(None) is None


# ─────────────────────────────────────────────────────────────────────────────
# Integration: full normalized_to_coros_run() round-trip with HR + note
# ─────────────────────────────────────────────────────────────────────────────


def test_full_run_hr_target_with_pace_note_roundtrips_to_coros_segment():
    """End-to-end: HR-target step with pace note pushes a paced segment."""
    workout = NormalizedRunWorkout(
        name="Phase1 Easy 12K",
        date="2026-05-04",
        blocks=(
            WorkoutBlock(steps=(
                WorkoutStep(
                    StepKind.WORK,
                    Duration.of_distance_km(12),
                    Target.hr_range_bpm(130, 148),
                    note="HR 130-148；配速参考 6:00-6:30/km",
                ),
            )),
        ),
    )
    coros = normalized_to_coros_run(workout)
    assert len(coros.segments) == 1
    seg = coros.segments[0]
    assert seg.segment_type == "training"
    assert seg.distance_km == 12.0
    # Pace from note was extracted into the segment.
    assert seg.pace_low == "6:30"
    assert seg.pace_high == "6:00"
