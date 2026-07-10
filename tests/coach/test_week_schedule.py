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

from stride_core.master_plan import Milestone, MilestoneType, Phase, PhaseType

from coach.graphs.generation.week_schedule import (
    derive_phase_weeks,
    _is_rampup_deload_index,
    representative_working_km,
)
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
    if pt in (PhaseType.BASE, PhaseType.BUILD, PhaseType.SPEED, None):
        last_load = kms[0]
        for i, cur in enumerate(kms[1:], start=1):
            if _is_rampup_deload_index(i):
                continue
            assert cur <= last_load * 1.10 + 1e-6, (pt, last_load, cur, kms)
            last_load = cur
    else:
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


@pytest.mark.parametrize("pt", list(PhaseType) + [None])
def test_first_week_cap_holds_when_prev_below_band_floor(pt):
    # CRITICAL invariant: when the prior phase exit volume sits BELOW (or near)
    # this phase's band floor, the HARD ≤1.10× continuity cap must still win —
    # the band floor / peak floor / recovery floor must NOT lift the first week
    # above prev*1.10. Previously PEAK and RECOVERY applied no continuity cap at
    # all, and a big detraining gap let the ramp-up band floor override the cap.
    prev_end = 20.0  # well below the band floor of 50
    weeks = derive_phase_weeks(
        _phase(start=_SIX_WEEK_START, end=_SIX_WEEK_END, low=50, high=80, phase_type=pt),
        prev_phase_end_km=prev_end,
    )
    kms = [w.target_weekly_km for w in weeks]
    # First week honors the HARD ≤1.10× rule even though it opens BELOW the band
    # floor (band floor is a soft target; ≤1.10× is HARD and wins).
    assert kms[0] <= prev_end * 1.10 + 1e-6, (pt, kms)
    # Subsequent weeks ramp from the (sub-floor) first week WITHOUT themselves
    # violating the relevant ≤1.10× baseline — ramp-up phases compare load
    # weeks across deloads, other phases compare adjacent weeks.
    if pt in (PhaseType.BASE, PhaseType.BUILD, PhaseType.SPEED, None):
        last_load = kms[0]
        for i, cur in enumerate(kms[1:], start=1):
            if _is_rampup_deload_index(i):
                continue
            assert cur <= last_load * 1.10 + 1e-6, (pt, last_load, cur, kms)
            last_load = cur
    else:
        for prev, cur in zip(kms, kms[1:]):
            assert cur <= prev * 1.10 + 1e-6, (pt, prev, cur, kms)


def test_first_week_cap_specific_violation_cases():
    # The exact cases from the spec review that previously violated ≤1.10×.
    # PEAK, prev=45, band [50,70]: floor lifted week 1 to 50 > 45*1.10=49.5.
    peak = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end=_SIX_WEEK_END,
            low=50,
            high=70,
            phase_type=PhaseType.PEAK,
        ),
        prev_phase_end_km=45.0,
    )
    assert peak[0].target_weekly_km <= 45.0 * 1.10 + 1e-6, peak[0]

    # RECOVERY, prev=45, band [50,70]: 0.80*45=36 floored to low 50 > 49.5.
    recovery = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end=_SIX_WEEK_END,
            low=50,
            high=70,
            phase_type=PhaseType.RECOVERY,
        ),
        prev_phase_end_km=45.0,
    )
    assert recovery[0].target_weekly_km <= 45.0 * 1.10 + 1e-6, recovery[0]

    # BASE, prev=20, band [50,80]: band-floor clamp overrode the continuity cap.
    base = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end=_SIX_WEEK_END,
            low=50,
            high=80,
            phase_type=PhaseType.BASE,
        ),
        prev_phase_end_km=20.0,
    )
    base_kms = [w.target_weekly_km for w in base]
    assert base_kms[0] <= 20.0 * 1.10 + 1e-6, base_kms
    last_load = base_kms[0]
    for i, cur in enumerate(base_kms[1:], start=1):
        if _is_rampup_deload_index(i):
            continue
        assert cur <= last_load * 1.10 + 1e-6, (last_load, cur, base_kms)
        last_load = cur


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


def test_recovery_clamps_to_high_when_prev_above_band():
    # prev exit 90 sits ABOVE this recovery phase's high band (55). The early
    # recovery weeks must NOT come out above the band ceiling — a "recovery"
    # phase running above its own high is semantically wrong.
    high = 55.0
    weeks = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end=_SIX_WEEK_END,  # 6 weeks
            low=30,
            high=high,
            phase_type=PhaseType.RECOVERY,
            name="恢复周",
        ),
        prev_phase_end_km=90.0,
    )
    kms = [w.target_weekly_km for w in weeks]
    # Clamped to the band high.
    assert all(km <= high + 1e-6 for km in kms), kms
    # Still trends down.
    assert all(kms[i] <= kms[i - 1] for i in range(1, len(kms))), kms
    # HARD ≤1.10× continuity cap on week 1 (clamping down can't break it).
    assert kms[0] <= 90.0 * 1.10 + 1e-6, kms
    for prev, cur in zip(kms, kms[1:]):
        assert cur <= prev * 1.10 + 1e-6, (prev, cur, kms)


def test_taper_clamps_to_high_when_prev_above_band():
    # prev exit 90 sits ABOVE this taper phase's high band (55). The early
    # taper weeks must NOT come out above the band ceiling.
    high = 55.0
    weeks = derive_phase_weeks(
        _phase(
            start=_SIX_WEEK_START,
            end=_SIX_WEEK_END,  # 6 weeks
            low=30,
            high=high,
            phase_type=PhaseType.TAPER,
            name="减量周",
        ),
        prev_phase_end_km=90.0,
    )
    kms = [w.target_weekly_km for w in weeks]
    # Clamped to the band high.
    assert all(km <= high + 1e-6 for km in kms), kms
    # Still trends down (monotone non-increasing).
    assert all(kms[i] <= kms[i - 1] for i in range(1, len(kms))), kms
    # HARD ≤1.10× continuity cap on week 1 (clamping down can't break it).
    assert kms[0] <= 90.0 * 1.10 + 1e-6, kms
    for prev, cur in zip(kms, kms[1:]):
        assert cur <= prev * 1.10 + 1e-6, (prev, cur, kms)


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
    last_load = kms[0]
    for i, cur in enumerate(kms[1:], start=1):
        if _is_rampup_deload_index(i):
            continue
        assert cur <= last_load * 1.10 + 1e-6
        last_load = cur


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


# ---------------------------------------------------------------------------
# representative_working_km (Stage-3b I1) — the max per-week run km of a phase
# ---------------------------------------------------------------------------


def _week_dict(folder: str, total_km: float) -> dict:
    """A minimal one-run-session WeeklyPlan dict whose run km == ``total_km``."""
    start = folder[:10]
    return {
        "schema": "weekly-plan/v1",
        "week_folder": folder,
        "sessions": [
            {
                "date": start,
                "session_index": 0,
                "kind": "run",
                "summary": "easy run",
                "spec": None,
                "notes_md": None,
                "total_distance_m": total_km * 1000.0,
                "total_duration_s": 2700,
            }
        ],
        "nutrition": [],
    }


def test_representative_working_km_is_the_max_not_the_last_week():
    # A phase that climbs then deloads on its last week: working volume is the
    # pre-deload peak (62.0), NOT the deload-trough last week (47.0).
    weeks = [
        _week_dict("2026-05-04_05-10(W1)", 55.0),
        _week_dict("2026-05-11_05-17(W2)", 58.0),
        _week_dict("2026-05-18_05-24(W3)", 62.0),
        _week_dict("2026-05-25_05-31(W4)", 47.0),  # deload trough (last week)
    ]
    assert representative_working_km(weeks) == pytest.approx(62.0)


def test_representative_working_km_none_for_empty():
    assert representative_working_km([]) is None


def test_representative_working_km_skips_unparseable_weeks():
    broken = {"schema": "weekly-plan/v1", "week_folder": "wbad", "sessions": "nope"}
    weeks = [_week_dict("2026-05-04_05-10(W1)", 50.0), broken]
    # The broken week is ignored; the one parseable week is the working volume.
    assert representative_working_km(weeks) == pytest.approx(50.0)


def test_representative_working_km_none_when_all_unparseable():
    broken = {"schema": "weekly-plan/v1", "week_folder": "wbad", "sessions": "nope"}
    assert representative_working_km([broken]) is None


# ---------------------------------------------------------------------------
# Band-reaching under working-volume threading (Stage-3b I1) — the headline.
# ---------------------------------------------------------------------------


def test_peak_reaches_band_when_threaded_with_working_volume_not_deload_trough():
    """A peak phase [70,85] threaded from the prior phase's WORKING volume
    (~62.5) reaches its band (≥70) within the phase — whereas threading the
    prior phase's deload-trough last week (~47) leaves it stranded below.

    This is the I1 fix's core payoff: phases reach their prescribed bands.
    """
    peak = _phase(
        start="2026-09-07",
        end="2026-09-27",  # 3 weeks
        low=70,
        high=85,
        phase_type=PhaseType.PEAK,
        name="赛前巅峰期",
    )
    # Threaded from the WORKING volume (max week of the prior build phase).
    working = derive_phase_weeks(peak, prev_phase_end_km=62.5)
    working_kms = [w.target_weekly_km for w in working]
    assert any(km >= 70.0 - 1e-6 for km in working_kms), working_kms
    # ≤1.10× weekly progression still holds while climbing into the band.
    for prev, cur in zip(working_kms, working_kms[1:]):
        assert cur <= prev * 1.10 + 1e-6, (prev, cur, working_kms)
    # First week respects the boundary continuity cap vs the working volume.
    assert working_kms[0] <= 62.5 * 1.10 + 1e-6, working_kms

    # Contrast: threaded from the deload-trough last week (~47) it never reaches.
    trough = derive_phase_weeks(peak, prev_phase_end_km=47.0)
    trough_kms = [w.target_weekly_km for w in trough]
    assert not any(km >= 70.0 - 1e-6 for km in trough_kms), trough_kms


def test_ramp_up_rebounds_after_deload_from_prior_load_week():
    """After a 3:1 recovery dip, the next load week resumes from the last
    non-deload target, not from the recovery trough.

    User-facing weekly-plan quality depends on this: a 72 -> 79 -> 87 -> 65
    recovery week should be allowed to rebound near the previous load level.
    Climbing from the 65km trough strands the next load week around 69km and
    makes late-phase long-run milestones impossible for the wrong reason.
    """
    phase = _phase(
        start="2026-07-27",
        end="2026-08-30",  # 5 weeks: 3 load + 1 deload + 1 rebound
        low=72,
        high=92,
        phase_type=PhaseType.BUILD,
        name="专项 build",
    )

    weeks = derive_phase_weeks(phase, prev_phase_end_km=69.8)
    kms = [w.target_weekly_km for w in weeks]

    assert len(kms) == 5
    assert kms[3] < kms[2]  # planned recovery dip
    assert kms[4] >= kms[2]
    assert kms[4] <= kms[2] * 1.10 + 1e-6
    assert kms[4] > kms[3] * 1.20  # not a slow climb from the trough


def test_milestone_long_run_target_sets_weekly_volume_floor_when_feasible():
    """A long-run milestone needs enough weekly km for the 35% longest-run
    safety rule. The scheduler should back-propagate a feasible volume floor to
    the milestone week instead of handing the generator a budget that makes the
    milestone structurally impossible.
    """
    phase = _phase(
        start="2026-07-27",
        end="2026-08-30",
        low=72,
        high=92,
        phase_type=PhaseType.BUILD,
        name="专项 build",
    )
    milestone = Milestone(
        id="m-long",
        type=MilestoneType.LONG_RUN,
        date="2026-08-16",  # week 3
        phase_id=phase.id,
        target="完成 31km 长跑，内含 16km MP",
        metric="long_run_km",
        comparator=">=",
        target_value=31.0,
    )

    weeks = derive_phase_weeks(
        phase,
        prev_phase_end_km=69.8,
        milestones=[milestone],
    )
    kms = [w.target_weekly_km for w in weeks]

    required_week_km = 31.0 / 0.35
    assert kms[2] >= required_week_km
    assert all(km <= 92.0 + 1e-6 for km in kms)
    for i, (prev, cur) in enumerate(zip(kms, kms[1:]), start=2):
        if cur >= prev:
            # The post-deload rebound (week 5) is still compared to the most
            # recent load week, so adjacent ratio can legitimately exceed 1.10.
            if i == 5:
                assert cur <= kms[2] * 1.10 + 1e-6
            else:
                assert cur <= prev * 1.10 + 1e-6
