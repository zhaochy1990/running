"""Tests for ``derive_phase_weeks`` — deterministic per-phase volume ramp.

Covers the periodization volume-arc logic the Stage-3a per-phase generator
consumes: Shanghai-week alignment, week count, ramp character per
``PhaseType``, the ≤1.10× progression invariant (the key one — the Stage-3a
``run_rule_filter.check_weekly_progression`` cap), 3:1 deload, taper /
recovery step-downs, and cross-phase exit-volume continuity.
"""

from __future__ import annotations

import re

import pytest

from stride_core.master_plan import Phase, PhaseType

from coach.graphs.generation.week_schedule import derive_phase_weeks
from coach.graphs.generation.weekly_prompt import WeekMeta


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _phase(
    *,
    start: str,
    end: str,
    low: float = 50.0,
    high: float = 80.0,
    phase_type: PhaseType | None = PhaseType.BASE,
    name: str = "基础期",
) -> Phase:
    return Phase(
        id="phase-1",
        name=name,
        start_date=start,
        end_date=end,
        focus="有氧基础",
        weekly_distance_km_low=low,
        weekly_distance_km_high=high,
        key_session_types=["长距离", "有氧"],
        milestone_ids=[],
        phase_type=phase_type,
    )


# A 6-week Shanghai-aligned phase: 2026-05-11 (Mon) .. 2026-06-21 (Sun).
_SIX_WEEK_START = "2026-05-11"
_SIX_WEEK_END = "2026-06-21"


# ---------------------------------------------------------------------------
# Week count + alignment
# ---------------------------------------------------------------------------


def test_returns_weekmeta_instances():
    weeks = derive_phase_weeks(_phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END))
    assert weeks
    assert all(isinstance(w, WeekMeta) for w in weeks)


def test_week_count_full_weeks():
    weeks = derive_phase_weeks(_phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END))
    assert len(weeks) == 6


def test_week_count_partial_trailing_week_counts():
    # Mon 2026-05-11 .. Wed 2026-05-20 → week1 (full) + partial week2 = 2 weeks.
    weeks = derive_phase_weeks(_phase(start="2026-05-11", end="2026-05-20"))
    assert len(weeks) == 2


def test_week_count_partial_leading_week():
    # Phase starts mid-week (Wed 2026-05-13) .. Sun 2026-05-24 → 2 weeks.
    weeks = derive_phase_weeks(_phase(start="2026-05-13", end="2026-05-24"))
    assert len(weeks) == 2


# ---------------------------------------------------------------------------
# week_folder / phase_position format
# ---------------------------------------------------------------------------


_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\(W\d+\)$")


def test_week_folder_format():
    weeks = derive_phase_weeks(_phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END))
    for i, w in enumerate(weeks, start=1):
        assert _FOLDER_RE.match(w.week_folder), w.week_folder
        assert w.week_folder.endswith(f"(W{i})")
    # First week: Mon 05-11 .. Sun 05-17.
    assert weeks[0].week_folder == "2026-05-11_05-17(W1)"
    # Second week: Mon 05-18 .. Sun 05-24.
    assert weeks[1].week_folder == "2026-05-18_05-24(W2)"


def test_week_folder_aligns_to_shanghai_monday_when_phase_starts_midweek():
    # Wed 2026-05-13: the containing Shanghai week is Mon 05-11 .. Sun 05-17.
    weeks = derive_phase_weeks(_phase(start="2026-05-13", end="2026-05-24"))
    assert weeks[0].week_folder == "2026-05-11_05-17(W1)"


def test_phase_position_format():
    weeks = derive_phase_weeks(_phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END))
    n = len(weeks)
    for i, w in enumerate(weeks, start=1):
        assert f"{i}/{n}" in w.phase_position


# ---------------------------------------------------------------------------
# Ramp within band (ramp-up phases)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("pt", [PhaseType.BASE, PhaseType.BUILD, PhaseType.SPEED])
def test_ramp_up_within_band(pt):
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80, phase_type=pt)
    )
    kms = [w.target_weekly_km for w in weeks]
    # Never exceed the high band.
    assert all(km <= 80.0 + 1e-6 for km in kms)
    # Stay sane — no negative / absurd values; floor isn't far below low.
    assert all(km > 0 for km in kms)
    assert min(kms) >= 50.0 * 0.65  # deload weeks may dip below low, but not absurdly


@pytest.mark.parametrize("pt", [PhaseType.BASE, PhaseType.BUILD, PhaseType.SPEED])
def test_ramp_up_climbs_overall(pt):
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80, phase_type=pt)
    )
    kms = [w.target_weekly_km for w in weeks]
    # Net upward arc: the peak load week climbs above the first week. (Don't
    # assert on the LAST week — a 3:1 deload can land on it, e.g. week 4 of a
    # 6-week phase, leaving the tail below the pre-deload peak.)
    assert max(kms) > kms[0]


# ---------------------------------------------------------------------------
# ≤1.10× invariant — the critical one, swept over ALL phase types
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("pt", list(PhaseType) + [None])
def test_no_rampup_week_exceeds_110pct_of_prev(pt):
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80, phase_type=pt)
    )
    kms = [w.target_weekly_km for w in weeks]
    for prev, cur in zip(kms, kms[1:]):
        # Up-weeks must respect the 1.10x cap; down-weeks (deload/taper) are
        # always safe. So the only assertion that matters is the UP bound.
        assert cur <= prev * 1.10 + 1e-6, (pt, prev, cur, kms)


@pytest.mark.parametrize("pt", list(PhaseType) + [None])
def test_first_week_respects_continuity_cap(pt):
    prev_end = 60.0
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80, phase_type=pt),
        prev_phase_end_km=prev_end,
    )
    # No phase-boundary spike: first week ≤ 1.10x the prior phase exit volume.
    assert weeks[0].target_weekly_km <= prev_end * 1.10 + 1e-6, (pt, weeks[0])


# ---------------------------------------------------------------------------
# 3:1 deload (base/build, ≥4 weeks)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("pt", [PhaseType.BASE, PhaseType.BUILD])
def test_three_to_one_deload_present(pt):
    # 8-week phase: 2026-05-11 .. 2026-07-05.
    weeks = derive_phase_weeks(
        _phase(start="2026-05-11", end="2026-07-05", low=50, high=85, phase_type=pt)
    )
    kms = [w.target_weekly_km for w in weeks]
    assert len(kms) == 8
    # There exists at least one week lower than its predecessor (a deload).
    deload_idxs = [i for i in range(1, len(kms)) if kms[i] < kms[i - 1]]
    assert deload_idxs, kms
    # Cadence: a deload around the 4th week (index 3).
    assert 3 in deload_idxs, (kms, deload_idxs)


# ---------------------------------------------------------------------------
# taper steps down
# ---------------------------------------------------------------------------


def test_taper_steps_down():
    weeks = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end="2026-05-31",  # 3 weeks
            low=40,
            high=70,
            phase_type=PhaseType.TAPER,
            name="减量周",
        ),
        prev_phase_end_km=70.0,
    )
    kms = [w.target_weekly_km for w in weeks]
    # Monotone non-increasing.
    assert all(kms[i] <= kms[i - 1] for i in range(1, len(kms))), kms
    # Ends well below the peak-entry volume (~-40%).
    assert kms[-1] <= 70.0 * 0.6, kms


# ---------------------------------------------------------------------------
# recovery deload
# ---------------------------------------------------------------------------


def test_recovery_is_low_and_decreasing():
    weeks = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end="2026-05-24",  # 2 weeks
            low=30,
            high=55,
            phase_type=PhaseType.RECOVERY,
            name="恢复周",
        ),
        prev_phase_end_km=65.0,
    )
    kms = [w.target_weekly_km for w in weeks]
    # Step down from entry — chronic intentionally drops.
    assert kms[0] < 65.0, kms
    assert all(kms[i] <= kms[i - 1] for i in range(1, len(kms))), kms


# ---------------------------------------------------------------------------
# continuity — start from prev_phase_end_km, not the band floor
# ---------------------------------------------------------------------------


def test_continuity_starts_from_prev_exit_volume():
    # prev exit 60 sits inside the band [50, 80]; first ramp-up week should
    # climb from ~60, NOT reset to the floor 50.
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80),
        prev_phase_end_km=60.0,
    )
    first = weeks[0].target_weekly_km
    assert first >= 60.0 - 1e-6, first
    assert first <= 60.0 * 1.10 + 1e-6, first


def test_no_continuity_starts_from_band_low():
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80),
    )
    # Without continuity, first week anchors at the band floor.
    assert weeks[0].target_weekly_km == pytest.approx(50.0, abs=0.5)


# ---------------------------------------------------------------------------
# phase_type=None fallback
# ---------------------------------------------------------------------------


def test_none_phase_type_behaves_base_like():
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80, phase_type=None)
    )
    kms = [w.target_weekly_km for w in weeks]
    # Neutral ramp-up: climbs overall (peak above start), respects the cap.
    assert max(kms) > kms[0]
    for prev, cur in zip(kms, kms[1:]):
        assert cur <= prev * 1.10 + 1e-6


# ---------------------------------------------------------------------------
# short-phase edge cases
# ---------------------------------------------------------------------------


def test_single_week_phase():
    weeks = derive_phase_weeks(
        _phase(start="2026-05-11", end="2026-05-17", low=50, high=80)
    )
    assert len(weeks) == 1
    assert weeks[0].week_folder == "2026-05-11_05-17(W1)"


def test_two_week_phase_no_spike():
    # A 2-week base phase can't ramp AND deload; it just ramps ≤1.10x.
    weeks = derive_phase_weeks(
        _phase(start="2026-05-11", end="2026-05-24", low=50, high=80),
        prev_phase_end_km=55.0,
    )
    kms = [w.target_weekly_km for w in weeks]
    assert len(kms) == 2
    assert kms[1] <= kms[0] * 1.10 + 1e-6
    assert kms[0] <= 55.0 * 1.10 + 1e-6
