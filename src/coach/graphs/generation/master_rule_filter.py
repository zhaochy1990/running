"""Master plan rule filter — see ``docs/coach-eval_S1.md`` § S1 L1 Rules.

Implements S1 L1 rules. Empty ``MasterPlan.weekly_key_sessions`` makes
all Batch B rules silent no-ops so legacy plans / fixtures don't trip on
the new structure.

* ``strength_durability_track``: plan must program a strength & durability
  track — a strength_test milestone, a strength entry in some phase's
  key_session_types, or a durability line in training_principles (warning).
* ``marathon_pace_specificity``: fm/hm plans must carry goal-pace work
  (a race_pace session or a goal-pace milestone); sub-3:00 fm normally needs
  the longest long_run ≥ 32km (warning), with gated risk-cap exceptions.

Schema-only (no kwargs):

* ``master_schema_validity``: ``MasterPlan.model_validate`` must pass.
* ``phase_count_min``: at least 3 phases (base / build / peak typical).
* ``peak_before_race``: if any RACE milestone exists, the phase ending closest
  before the race must finish within 7-21 days of race_date (1-3 week taper).
* ``phase_duration_balance``: per-phase span 2-16 weeks (warning); race
  phases (1-week wrap-around blocks) are exempt — they're inherently short.

Input-aware (need ``rule_filter_kwargs``):

* ``season_window_fits``: plan.start/end within ``season_window`` and
  ``target_race.race_date`` inside the window (error).
* ``goal_realism``: PB → ``target_race.goal_time_s`` improvement vs
  distance-specific threshold — fm 10%, hm 12%, 5k/10k 15%, ultra 10%
  (warning).
* ``target_distance_long_run``: peak long_run distance_km matches target
  race distance — fm ≥ 28km, hm ≥ 18km, 10k ≥ 10km, 5k ≥ 6km (error),
  with a severe-goal-mismatch low-volume FM exception.
* ``target_distance_volume_ceiling``: 5K / 10K / HM plans must not inherit
  FM-style weekly volume or long-run length (error).
* ``distance_taper_length``: explicit taper phases must stay within the
  distance-specific taper length for 5K / 10K / HM / FM (error).
* ``key_session_density``: ``weekly_run_days_max <= 3`` → ≤2 key sessions
  per week; otherwise ≤3 (error).
* ``three_day_extra_run_text``: ``weekly_run_days_max <= 3`` plans must not
  describe extra short/easy jog days outside the three run days (error).
* ``frequency_volume_ceiling``: ``weekly_run_days_max <= 3`` cannot use
  70-90km weeks to satisfy FM long-run math (error).
* ``injury_return_volume_ceiling``: recent injury return plans with known
  history must not exceed the prior weekly peak by more than a small buffer
  (error).

Weekly-skeleton (no kwargs but require ``weekly_key_sessions`` populated):

* ``weekly_key_sessions_present``: every non-recovery / non-taper week has
  1-3 key sessions (error).
* ``weekly_volume_ramp``: adjacent-week ``target_weekly_km_high`` ratio
  ≤ 1.10 except recovery / taper weeks (error).
* ``taper_volume_drop``: first taper week's ``target_weekly_km_high``
  drops ≥ 25% vs the highest pre-taper load week (error).
* ``hard_session_spacing``: same-week threshold / tempo / interval /
  vo2max / hill / race_pace count ≤ 2 (error).
* ``long_run_distance_share``: non-deload week's longest ``long_run``
  distance_km ≤ 35% of that week's ``target_weekly_km_high`` (warning).
  Frequency-limited / injury-return contexts use a 50% warning threshold so
  they don't inflate weekly volume just to satisfy the default share heuristic.

* ``key_session_distance_within_weekly_volume``: every distance-based key
  session must fit inside that week's ``target_weekly_km_high``; race week
  volume includes the race distance (error).

LLM-free: no langchain / anthropic imports.
"""

from __future__ import annotations

import re
from datetime import date as _date
from datetime import timedelta as _timedelta
from typing import Any

from stride_core.master_plan import MasterPlan, MilestoneType

from .rule_filter import RuleFilterReport, RuleViolation


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def check_master_schema_validity(plan_dict: dict) -> list[RuleViolation]:
    """``MasterPlan.model_validate`` must succeed (pydantic BaseModel)."""
    try:
        MasterPlan.model_validate(plan_dict)
        return []
    except Exception as exc:  # noqa: BLE001 — schema-validation boundary
        return [
            RuleViolation(
                rule="master_schema_validity",
                severity="error",
                message=f"MasterPlan.model_validate failed: {type(exc).__name__}: {exc}",
            )
        ]


def check_phase_count_min(
    plan: MasterPlan, *, min_count: int = 3
) -> list[RuleViolation]:
    """At least ``min_count`` phases — typical periodisation needs base / build / peak.

    Short race windows (< 8 weeks total) relax to ``min_count=2``: a 5-week
    mini-cycle can legitimately be a single build phase plus a 1-2 week taper,
    and the training_goal API accepts those race dates. Forcing 3 phases would
    block prompt-compliant short-cycle plans without protecting anything.
    """
    effective_min = min_count
    try:
        span_days = (
            _date.fromisoformat(plan.end_date)
            - _date.fromisoformat(plan.start_date)
        ).days
        if span_days < 56:  # < 8 weeks → mini-cycle, 2 phases acceptable
            effective_min = min(min_count, 2)
    except (ValueError, TypeError, AttributeError):
        pass

    count = len(plan.phases)
    if count < effective_min:
        return [
            RuleViolation(
                rule="phase_count_min",
                severity="error",
                message=f"only {count} phase(s); need at least {effective_min}",
                details={"count": count, "min_required": effective_min},
            )
        ]
    return []


_NON_PEAK_PHASE_KEYWORDS: tuple[str, ...] = (
    # Race phases — bare `比赛` / `race` are race-week phases per the prompt's
    # recommended order (基础期 → 进展期 → 赛前期 → 比赛 → 恢复期). False-
    # positive risk for prep-style names (`比赛准备期` / `race prep`) is
    # neutralised by the `_PEAK_PHASE_MARKERS` override in
    # :func:`_is_non_peak_phase` — those names match `准备` / `prep` first
    # and return False before the substring scan runs.
    "比赛", "比赛周", "比赛日", "race",
    # Taper / wind-down phases — they end at or near race day by design.
    "减量", "taper", "tapering",
    # Recovery phases (post-race).
    "恢复", "recovery",
)

# Markers that override the non-peak match. If any of these appears in the
# phase name, the phase is treated as peak / prep regardless of any
# race / taper / recovery keyword also being present. Catches:
#   - 比赛准备期 / 比赛专项期       — peak phase, contains "比赛"
#   - pre-race peak / race prep    — peak phase, contains "race"
#   - peak phase                   — peak phase
# Without this override the substring matcher would misclassify them and
# fall back to an earlier build phase, producing false `peak_before_race`
# violations (see codex review round 2, P0 finding).
_PEAK_PHASE_MARKERS: tuple[str, ...] = (
    "峰值", "准备", "专项", "peak", "prep", "preparation", "build",
)


def _is_non_peak_phase(phase_name: str) -> bool:
    """True if the phase name suggests taper / race / recovery, NOT the peak."""
    if not phase_name:
        return False
    low = phase_name.lower()
    # Peak-marker override takes precedence so prep-style names ("比赛准备期",
    # "race prep") are never classified as non-peak.
    if any(marker in low for marker in _PEAK_PHASE_MARKERS):
        return False
    return any(kw in low for kw in _NON_PEAK_PHASE_KEYWORDS)


def _phase_type_value(phase: Any) -> str:
    raw = getattr(phase, "phase_type", "") or ""
    value = getattr(raw, "value", raw)
    return str(value or "").lower()


def _is_explicit_peak_phase(phase: Any) -> bool:
    return _phase_type_value(phase) == "peak"


def _is_explicit_non_peak_phase(phase: Any) -> bool:
    return _phase_type_value(phase) in {"taper", "recovery"}


def _phase_is_non_peak(phase: Any) -> bool:
    """Use structured phase_type first, then legacy name heuristics."""
    if _is_explicit_peak_phase(phase):
        return False
    if _is_explicit_non_peak_phase(phase):
        return True
    return _is_non_peak_phase(str(getattr(phase, "name", "") or ""))


# Distance-specific taper windows — peak phase must end inside this window
# (in days before race day). Source: docs/coach-eval_S1.md anti-patterns +
# the prompt's Distance specificity HARD block.
#   FM: 2-week taper → peak ends 14-21 days before race
#   HM: 1-week taper → peak ends 7-14 days
#   10K: 3-7 day taper → peak ends 3-14 days (some looseness for build phase
#        that doesn't taper sharply)
#   5K: 3-5 day taper → peak ends 3-7 days
# Unknown / missing distance falls back to a permissive 3-21 day window —
# we'd rather not block a marginal plan than reject a 10K plan because we
# don't know its distance.
_PEAK_TAPER_WINDOW: dict[str, tuple[int, int]] = {
    "fm": (14, 21),
    "hm": (7, 14),
    "10k": (3, 14),
    "5k": (3, 7),
    "ultra": (14, 28),  # ultra: longer taper acceptable
}
_PEAK_TAPER_WINDOW_DEFAULT: tuple[int, int] = (3, 21)


def check_peak_before_race(
    plan: MasterPlan, *, target_race: dict | None = None
) -> list[RuleViolation]:
    """RACE milestone must have a peak (non-taper) phase ending inside the
    distance-specific taper window before race day.

    The prompt asks for ``基础期 → 进展期 → 赛前期 → 比赛 →（如有）恢复期`` so
    the LLM may emit explicit `比赛` / `减量` / `taper` / `恢复` phases. Picking
    the *latest* phase before race day is wrong: that's the taper / wind-down,
    which ends 0-3 days before the race by design. We want the *peak* phase's
    end_date — that's the boundary where taper starts.

    Strategy: filter out non-peak phases by name keywords, then the latest
    remaining phase IS the peak. Falls back to "all phases" if every phase
    looks taper-like (defensive — catches a degenerate plan where the keyword
    filter would otherwise leave nothing to check).

    Window: read from :data:`_PEAK_TAPER_WINDOW` based on
    ``target_race.distance``. Unknown / missing → permissive 3-21 days
    (the union of all distance-specific windows, so a missing kwarg never
    fires a false positive).

    Catches:

    * **Peak after race** — no phase ends before race_date.
    * **No taper window** — peak ends too few / too many days before race
      for the race's distance.
    """
    race_milestones = [m for m in plan.milestones if m.type == MilestoneType.RACE]
    if not race_milestones:
        return []

    distance = ""
    if target_race:
        distance = (target_race.get("distance") or "").lower()
    min_days, max_days = _PEAK_TAPER_WINDOW.get(distance, _PEAK_TAPER_WINDOW_DEFAULT)

    violations: list[RuleViolation] = []
    for race in race_milestones:
        try:
            race_date = _date.fromisoformat(race.date)
        except (ValueError, TypeError):
            continue  # malformed milestone date — schema rule should have caught

        peak_candidates: list[tuple[_date, Any]] = []
        all_ends_before: list[tuple[_date, Any]] = []
        for phase in plan.phases:
            try:
                end = _date.fromisoformat(phase.end_date)
            except (ValueError, TypeError):
                continue
            if end < race_date:
                all_ends_before.append((end, phase))
                if not _phase_is_non_peak(phase):
                    peak_candidates.append((end, phase))

        if not all_ends_before:
            violations.append(
                RuleViolation(
                    rule="peak_before_race",
                    severity="error",
                    message=(
                        f"race {race.date} has no preceding phase ending before it "
                        f"(peak phase scheduled after race —灾难)"
                    ),
                    details={"race_date": race.date, "race_milestone_id": race.id},
                )
            )
            continue

        ends_to_use = peak_candidates if peak_candidates else all_ends_before
        latest_end, latest_phase = max(ends_to_use, key=lambda t: t[0])
        days_to_race = (race_date - latest_end).days
        if days_to_race < min_days or days_to_race > max_days:
            violations.append(
                RuleViolation(
                    rule="peak_before_race",
                    severity="error",
                    message=(
                        f"peak phase ({latest_phase.name!r}) ends {days_to_race} day(s) "
                        f"before race {race.date}; expected {min_days}-{max_days} days "
                        f"for {distance or 'unknown'} race taper window"
                    ),
                    details={
                        "race_date": race.date,
                        "race_distance": distance or None,
                        "peak_phase_id": latest_phase.id,
                        "peak_phase_end": latest_phase.end_date,
                        "days_between": days_to_race,
                        "min_days": min_days,
                        "max_days": max_days,
                        "taper_phases_present": [
                            p.name for _, p in all_ends_before if _phase_is_non_peak(p)
                        ],
                    },
                )
            )
    return violations


# Phase names that designate the race week itself (`比赛` / `race` / `比赛周`).
# These are inherently short — a single race week or a 1-2 day race wrap-up
# legitimately spans 1-7 days, so phase_duration_balance must NOT fire for
# them. We share the markers with _is_non_peak_phase but exclude `taper` /
# `减量` / `recovery` / `恢复` here — taper / recovery phases SHOULD be ≥ 2
# weeks per the docs, only the race week itself is the exempt edge case.
_RACE_PHASE_MARKERS: tuple[str, ...] = (
    "比赛周", "比赛日", "race week", "race-week",
    # Bare "比赛" / "race" are also valid race-phase names (the LLM may emit
    # the standalone phase `比赛` per the prompt's recommended phase order).
    # _PEAK_PHASE_MARKERS already overrides false matches like `比赛准备期`
    # so we can keep these short tokens here without producing collisions.
    "比赛", "race",
)


def _is_race_phase(phase_name: str) -> bool:
    """True if the phase name designates the race week itself.

    Used to exempt phase_duration_balance — race weeks are inherently
    1-week blocks and shouldn't trip the 2-week minimum. Peak / prep
    phases (e.g. ``比赛准备期`` / ``race prep``) match the peak override
    first via :data:`_PEAK_PHASE_MARKERS`, so this function won't false-
    positive on them.
    """
    if not phase_name:
        return False
    low = phase_name.lower()
    if any(marker in low for marker in _PEAK_PHASE_MARKERS):
        return False  # peak/prep phase, not a race phase
    return any(kw in low for kw in _RACE_PHASE_MARKERS)


def _allows_short_taper_phase(phase: Any, *, target_race: dict | None, days: int) -> bool:
    """True when a short, explicit taper phase is distance-appropriate.

    HM / 10K / 5K plans often use a single race-week taper or sharpening block.
    The generic 2-week minimum is useful for adaptation phases, but it creates
    noise for these race-specific taper phases.
    """
    if not _is_explicit_non_peak_phase(phase):
        return False
    distance = _normalise_distance_key((target_race or {}).get("distance"))
    if distance not in {"hm", "10k", "5k"}:
        return False
    max_taper_days = _DISTANCE_TAPER_MAX_DAYS.get(distance)
    return max_taper_days is not None and 1 <= days <= max_taper_days


def check_phase_duration_balance(
    plan: MasterPlan,
    *,
    min_days: int = 14,
    max_days: int = 112,
    target_race: dict | None = None,
) -> list[RuleViolation]:
    """Per-phase span must be 2-16 weeks (warning).

    Phases shorter than 2 weeks rarely deliver enough physiological
    adaptation to justify a separate periodisation block; phases longer
    than 16 weeks lose specificity because the body plateaus without a
    fresh stimulus. Severity is **warning**: a 1-week intro / deload micro-
    phase can be legitimate, and an 18-week base for an ultramarathon
    isn't catastrophic — the L2 judge owns the final call.

    Race-week phases (``比赛`` / ``race`` / ``比赛周``) are exempt — they
    are inherently 1-week blocks; the 2-week minimum doesn't apply. Explicit
    HM / 10K / 5K taper phases may also be 1 race week, matching the
    distance-specific taper windows.
    """
    violations: list[RuleViolation] = []
    for phase in plan.phases:
        if _is_race_phase(phase.name):
            continue  # race-week phases are inherently short
        try:
            start = _date.fromisoformat(phase.start_date)
            end = _date.fromisoformat(phase.end_date)
        except (ValueError, TypeError):
            continue  # malformed date — schema rule catches the actual error
        # Phase dates are inclusive calendar dates in the athlete-facing plan.
        # 2026-10-05 → 2026-10-18 covers two natural weeks (14 days), even
        # though date subtraction returns 13.
        days = (end - start).days + 1
        if days < min_days and _allows_short_taper_phase(
            phase, target_race=target_race, days=days
        ):
            continue
        if days < min_days or days > max_days:
            violations.append(
                RuleViolation(
                    rule="phase_duration_balance",
                    severity="warning",
                    message=(
                        f"phase {phase.name!r} spans {days} days "
                        f"(expected {min_days}-{max_days} days / 2-16 weeks)"
                    ),
                    details={
                        "phase_id": phase.id,
                        "phase_name": phase.name,
                        "start_date": phase.start_date,
                        "end_date": phase.end_date,
                        "days": days,
                        "min_days": min_days,
                        "max_days": max_days,
                    },
                )
            )
    return violations


def check_season_window_fits(
    plan: MasterPlan,
    *,
    season_window: dict | None,
    target_race: dict | None,
) -> list[RuleViolation]:
    """Plan span must fit inside ``season_window``; race date inside window.

    No-op when ``season_window`` is missing — prod callers that don't
    synthesise an explicit window (e.g. legacy ``goal``-only payload) just
    skip this check. Eval fixtures always carry an explicit window so the
    check fires there.

    Catches:

    * **Plan start before season_window.start** — LLM ignored the window.
    * **Plan end after season_window.end** — overshoot, schedule conflict.
    * **race_date outside [window.start, window.end]** — fixture / goal
      inconsistency the LLM should have refused.
    """
    if not season_window:
        return []
    sw_start_raw = season_window.get("start_date")
    sw_end_raw = season_window.get("end_date")
    try:
        sw_start = _date.fromisoformat(sw_start_raw) if sw_start_raw else None
        sw_end = _date.fromisoformat(sw_end_raw) if sw_end_raw else None
    except (ValueError, TypeError):
        return []  # malformed window — caller bug, not LLM's fault

    try:
        plan_start = _date.fromisoformat(plan.start_date)
        plan_end = _date.fromisoformat(plan.end_date)
    except (ValueError, TypeError):
        return []  # schema rule catches this

    violations: list[RuleViolation] = []
    if sw_start is not None and plan_start < sw_start:
        violations.append(
            RuleViolation(
                rule="season_window_fits",
                severity="error",
                message=(
                    f"plan starts {plan.start_date} but season_window starts "
                    f"{sw_start_raw} ({(sw_start - plan_start).days} days too early)"
                ),
                details={
                    "plan_start": plan.start_date,
                    "season_window_start": sw_start_raw,
                    "overshoot_days": (sw_start - plan_start).days,
                },
            )
        )
    if sw_start is not None:
        # Eval fixtures freeze a season_window; the generated plan must not
        # drift forward with wall-clock time and silently skip early base weeks.
        # Align the fixture start to the next Monday because S1 plans are
        # natural-week based. Starting earlier is covered by the existing
        # too-early check; here we catch only late starts.
        days_until_monday = (7 - sw_start.weekday()) % 7
        aligned_start = sw_start.replace()  # date is immutable; clarity only
        if days_until_monday:
            from datetime import timedelta as _timedelta

            aligned_start = sw_start + _timedelta(days=days_until_monday)
        if plan_start > aligned_start:
            violations.append(
                RuleViolation(
                    rule="season_window_fits",
                    severity="error",
                    message=(
                        f"plan starts {plan.start_date} but aligned season start is "
                        f"{aligned_start.isoformat()} (skips "
                        f"{(plan_start - aligned_start).days} day(s) of frozen fixture window)"
                    ),
                    details={
                        "plan_start": plan.start_date,
                        "season_window_start": sw_start_raw,
                        "aligned_season_start": aligned_start.isoformat(),
                        "skipped_days": (plan_start - aligned_start).days,
                    },
                )
            )
    if sw_end is not None and plan_end > sw_end:
        violations.append(
            RuleViolation(
                rule="season_window_fits",
                severity="error",
                message=(
                    f"plan ends {plan.end_date} but season_window ends "
                    f"{sw_end_raw} ({(plan_end - sw_end).days} days overshoot)"
                ),
                details={
                    "plan_end": plan.end_date,
                    "season_window_end": sw_end_raw,
                    "overshoot_days": (plan_end - sw_end).days,
                },
            )
        )

    # Optional: race date inside window (only check when target_race + window provided).
    if target_race and sw_start is not None and sw_end is not None:
        race_date_raw = target_race.get("race_date")
        try:
            race_date = _date.fromisoformat(race_date_raw) if race_date_raw else None
        except (ValueError, TypeError):
            race_date = None
        if race_date is not None and (race_date < sw_start or race_date > sw_end):
            violations.append(
                RuleViolation(
                    rule="season_window_fits",
                    severity="error",
                    message=(
                        f"target race {race_date_raw} falls outside season_window "
                        f"[{sw_start_raw}, {sw_end_raw}]"
                    ),
                    details={
                        "race_date": race_date_raw,
                        "season_window": {
                            "start_date": sw_start_raw,
                            "end_date": sw_end_raw,
                        },
                    },
                )
            )
    return violations


# Goal-realism thresholds — see docs/coach-eval_S1.md § S1 L1 Rules.
# Distance keys match ``target_race.distance`` enum: 5k / 10k / hm / fm / ultra.
# Threshold = (pr_s - goal_s) / pr_s — improvement fraction (higher = more
# aggressive). Spec gives 10k+: 15%, hm: 12%, fm: 10%. We extend with:
#   - 5k → 15% (similar fast-twitch ceiling as 10k, similar PB elasticity)
#   - ultra → 10% (pacing dominates; large improvement gaps less plausible)
_GOAL_REALISM_THRESHOLDS: dict[str, float] = {
    "5k": 0.15,
    "10k": 0.15,
    "hm": 0.12,
    "fm": 0.10,
    "ultra": 0.10,
}

# Map ``target_race.distance`` → ``user_profile.prs`` key. Stays in sync with
# stride_server.master_plan_generator._PB_KEY_MAP (which goes the other way,
# from prompt-facing keys to internal). Case-insensitive lookups.
_PR_KEY_BY_DISTANCE: dict[str, str] = {
    "5k": "5k_s",
    "10k": "10k_s",
    "hm": "hm_s",
    "fm": "fm_s",
    "ultra": "ultra_s",
}


def check_goal_realism(
    plan: MasterPlan,  # noqa: ARG001 — kept for signature symmetry with other checks
    *,
    target_race: dict | None,
    prs: dict | None,
) -> list[RuleViolation]:
    """Warn when ``goal_time_s`` is too aggressive vs the matching PB.

    Severity is **warning** (not error) because:

    1. Advanced runners with the right training history can hit aggressive
       targets — judging fitness gap is the L2 judge's job.
    2. A well-written plan may explicitly push back in its principles /
       phase notes ("此目标需多周期"), which the warning prompts the
       reviewer to look for.
    3. L1 fast-rejecting on goal_realism would block legitimate experimental
       plans the L2 judge would have rated 3-4.

    No-op when ``target_race`` / ``prs`` / matching PB / ``goal_time_s`` are
    missing — there's nothing to compare against.
    """
    if not target_race or not prs:
        return []
    distance = (target_race.get("distance") or "").lower()
    goal_s_raw = target_race.get("goal_time_s")
    if not distance or goal_s_raw in (None, 0):
        return []

    pr_key = _PR_KEY_BY_DISTANCE.get(distance)
    if pr_key is None:
        return []
    pr_s_raw = prs.get(pr_key)
    if pr_s_raw in (None, 0):
        return []
    try:
        goal_s = float(goal_s_raw)
        pr_s = float(pr_s_raw)
    except (ValueError, TypeError):
        return []
    if goal_s <= 0 or pr_s <= 0:
        return []

    threshold = _GOAL_REALISM_THRESHOLDS.get(distance, 0.10)
    # improvement = how much faster the goal is vs the PR.
    # Negative (goal slower than PR) → never a violation; clamp at 0.
    improvement = (pr_s - goal_s) / pr_s
    if improvement <= threshold:
        return []
    return [
        RuleViolation(
            rule="goal_realism",
            severity="warning",
            message=(
                f"goal time for {distance} is {improvement * 100:.1f}% faster than "
                f"PR (PR {int(pr_s)}s, goal {int(goal_s)}s); threshold for "
                f"{distance} is {threshold * 100:.0f}% — single-cycle realism doubtful"
            ),
            details={
                "distance": distance,
                "pr_s": int(pr_s),
                "goal_time_s": int(goal_s),
                "improvement_pct": round(improvement * 100, 2),
                "threshold_pct": round(threshold * 100, 2),
            },
        )
    ]


# ---------------------------------------------------------------------------
# Weekly key-session rules (Batch B) — operate on MasterPlan.weekly_key_sessions
# ---------------------------------------------------------------------------


# Sessions with high systemic / mechanical load. Two of these in one week
# is the docs-mandated upper bound (hard_session_spacing); race-pace counts
# because the prompt's HARD rule covers it explicitly. time_trial and
# tune_up_race are race-effort efforts that carry the same recovery cost
# as a hard interval session, so they count too.
_HARD_SESSION_TYPES: frozenset[str] = frozenset({
    "threshold", "tempo", "interval", "vo2max", "hill", "race_pace",
    "time_trial", "tune_up_race",
})

# Cross-week limit — consecutive non-deload weeks each carrying ≥ 2 hard
# sessions add up to chronic overload. The docs phrase: "不得连续多周无
# recovery / deload 调整". We pick 4 weeks because that's the standard 3:1
# periodisation cycle: 3 hard weeks + 1 deload is the safe upper bound;
# 4 hard weeks in a row without a deload signals overtraining risk.
_MAX_CONSECUTIVE_HARD_WEEKS: int = 4

# Long-run distance minimums per target-race distance (peak phase).
# Source: ``docs/coach-eval_S1.md`` § S1 L1 Rules § target_distance_long_run.
# ``ultra`` extrapolation — peak long run for an ultra should at least hit
# a marathon-distance long run; we default to 32km until a fixture motivates
# a stricter rule.
_LONG_RUN_MIN_KM: dict[str, float] = {
    "5k": 6.0,
    "10k": 10.0,
    "hm": 18.0,
    "fm": 28.0,
    "ultra": 32.0,
}

_SEVERE_GOAL_MISMATCH_MARGIN: float = 0.20
_LOW_VOLUME_FM_HISTORY_PEAK_KM: float = 50.0
_LOW_VOLUME_FM_MAX_LONG_RUN_KM: float = 24.0


def _goal_improvement_context(
    *, target_race: dict | None, prs: dict | None, training_history_summary: dict | None
) -> tuple[str, float, float, float, float] | None:
    if not target_race or not prs:
        return None
    distance = _normalise_distance_key(target_race.get("distance"))
    pr_key = _PR_KEY_BY_DISTANCE.get(distance)
    if pr_key is None:
        return None
    try:
        goal_s = float(target_race.get("goal_time_s") or 0)
        pr_s = float(prs.get(pr_key) or 0)
        historical_peak = float(
            (training_history_summary or {}).get("peak_weekly_km_in_window") or 0
        )
    except (TypeError, ValueError):
        return None
    if goal_s <= 0 or pr_s <= 0:
        return None
    improvement = (pr_s - goal_s) / pr_s
    threshold = _GOAL_REALISM_THRESHOLDS.get(distance, 0.10)
    return distance, improvement, threshold, historical_peak, goal_s


def _is_severe_low_volume_fm_mismatch(
    *, target_race: dict | None, prs: dict | None, training_history_summary: dict | None
) -> bool:
    context = _goal_improvement_context(
        target_race=target_race,
        prs=prs,
        training_history_summary=training_history_summary,
    )
    if context is None:
        return False
    distance, improvement, threshold, historical_peak, _goal_s = context
    return (
        distance == "fm"
        and improvement >= max(_SEVERE_GOAL_MISMATCH_MARGIN, threshold * 2)
        and 0 < historical_peak <= _LOW_VOLUME_FM_HISTORY_PEAK_KM
    )


# Distance-specific upper guards. These are not generic training theory caps;
# they catch the S1 failure mode where a short-race plan copies an FM template
# just because the athlete has historical marathon volume.
_TARGET_DISTANCE_VOLUME_LIMITS: dict[str, dict[str, float]] = {
    "5k": {"weekly_km_high": 60.0, "long_run_km": 14.0},
    "10k": {"weekly_km_high": 69.0, "long_run_km": 18.0},
    "hm": {"weekly_km_high": 75.0, "long_run_km": 25.0},
}


_DISTANCE_TAPER_MAX_DAYS: dict[str, int] = {
    # Weekly skeletons are natural-week based. A 5K mini-taper may be expressed
    # as a race-week taper phase (Mon-Sun) whose focus says the actual cut-down
    # is only the final 3-5 days, so L1 allows 7 days while still rejecting a
    # true two-week taper.
    "5k": 7,
    "10k": 7,
    "hm": 10,
    "fm": 21,
    "ultra": 28,
}


def _normalise_distance_key(value: object) -> str:
    token = str(value or "").strip().lower().replace("_", "-")
    lookup = {
        "5-k": "5k",
        "five-k": "5k",
        "five-km": "5k",
        "10-k": "10k",
        "ten-k": "10k",
        "ten-km": "10k",
        "half-marathon": "hm",
        "half marathon": "hm",
        "marathon": "fm",
        "full-marathon": "fm",
        "full marathon": "fm",
        "trail": "ultra",
    }
    return lookup.get(token, token)


def _week_is_deload(week: Any) -> bool:
    """True if the week is a recovery or taper week (rules skip these)."""
    return bool(getattr(week, "is_recovery_week", False) or getattr(week, "is_taper_week", False))


def _active_plan_view(plan: MasterPlan) -> MasterPlan:
    """Weekly-skeleton view that re-bases an already-completed lead-in to week 1.

    Continuity plans (see the season-continuity prompt) carry completed leading
    phases (``Phase.is_completed``) on the timeline with NO weeks, and number the
    emitted weeks continuously from the season start (e.g. base = W1-8 → speed
    starts at W9). The Batch-B weekly rules, however, assume a plan that runs
    from week 1: they assert ``week_index == 1..N`` and derive the expected
    week-count from ``plan.start_date``. Feeding them the raw continuity plan
    mis-fires (sequential-index + coverage failures, plus knock-on taper /
    long-run-share errors).

    This re-bases the weekly skeleton to the first ACTIVE week in two ways, each
    decoupled from how the LLM happened to number the weeks:

    * **week_index** — if the emitted weeks are numbered continuously from the
      season start (base = W1-8 → active starts at W9), subtract the offset so
      they read 1..N. If the LLM already numbered the active weeks from W1
      (offset 0), leave the indices alone.
    * **start_date** — shift to the first active week's start *regardless of the
      index offset*. The completed lead-in still occupies the calendar span
      ``[plan.start_date, first active week)`` even when offset is 0, so without
      this the coverage week-count expectation over-counts by the completed
      weeks and ``weekly_key_sessions_present`` mis-fires. The completed phases
      carry no weeks, so the earliest emitted week IS the first active week.

    Phases are left intact (phase-level rules run on the full plan separately).
    No completed phase, or nothing to re-base → returns the plan unchanged
    (backward compatible).
    """
    if not any(getattr(p, "is_completed", False) for p in plan.phases):
        return plan
    weeks = sorted(plan.weekly_key_sessions, key=lambda w: w.week_index)
    if not weeks:
        return plan
    offset = weeks[0].week_index - 1
    # First active week start: prefer the emitted week's own start, fall back to
    # the earliest non-completed phase start (LLM may omit week_start), then to
    # the plan start. This is the calendar anchor the coverage check should use.
    active_phase_starts = [
        p.start_date for p in plan.phases
        if not getattr(p, "is_completed", False) and p.start_date
    ]
    new_start = (
        weeks[0].week_start
        or (min(active_phase_starts) if active_phase_starts else None)
        or plan.start_date
    )
    if offset <= 0 and new_start == plan.start_date:
        return plan  # already from week 1 with no completed lead-in span
    remapped = (
        [w.model_copy(update={"week_index": w.week_index - offset}) for w in weeks]
        if offset > 0
        else weeks
    )
    return plan.model_copy(update={
        "start_date": new_start,
        "weekly_key_sessions": remapped,
        "weeks": remapped,
        "total_weeks": len(remapped),
    })


def check_completed_phase_has_no_weeks(plan: MasterPlan) -> list[RuleViolation]:
    """Completed carry-over phases must not be re-prescribed weekly.

    Continuity plans keep completed lead-in phases on the timeline for context,
    but weekly skeletons should begin at the current active phase. Re-emitting
    weeks for a completed base block wastes output budget and can make the next
    weekly-plan generator think old work still needs to be performed.
    """
    completed = [p for p in plan.phases if getattr(p, "is_completed", False)]
    if not completed or not plan.weekly_key_sessions:
        return []

    violations: list[RuleViolation] = []
    for phase in completed:
        overlapping = []
        try:
            ph_start = _date.fromisoformat(phase.start_date)
            ph_end = _date.fromisoformat(phase.end_date)
        except (ValueError, TypeError):
            continue
        for week in plan.weekly_key_sessions:
            try:
                week_start = _date.fromisoformat(week.week_start)
            except (ValueError, TypeError):
                continue
            if ph_start <= week_start <= ph_end:
                overlapping.append(week.week_index)
        if overlapping:
            violations.append(
                RuleViolation(
                    rule="completed_phase_has_no_weeks",
                    severity="error",
                    message=(
                        f"completed phase '{phase.name}' has weekly skeleton "
                        f"entries {overlapping}; completed phases must stay "
                        "timeline-only and active weeks must start after them"
                    ),
                    details={
                        "phase_name": phase.name,
                        "phase_start": phase.start_date,
                        "phase_end": phase.end_date,
                        "week_indices": overlapping,
                    },
                )
            )
    return violations


def check_unauthorized_completed_phase_before_plan(
    plan: MasterPlan, *, season_window: dict | None
) -> list[RuleViolation]:
    """Completed lead-in phases require explicit current-phase authorization.

    In eval/prod calls without a rendered current-phase block, previous-plan
    prose is context only. If the LLM inserts a completed phase before the
    requested season window, it shifts ``plan.start_date`` backward and causes
    retry loops. Emit a direct, fixable error instead of only the generic
    season_window_fits violation.
    """
    if not season_window:
        return []
    window_start_raw = season_window.get("start_date")
    if not window_start_raw:
        return []
    try:
        window_start = _date.fromisoformat(str(window_start_raw))
    except (TypeError, ValueError):
        return []

    violations: list[RuleViolation] = []
    for phase in plan.phases:
        if not getattr(phase, "is_completed", False):
            continue
        try:
            phase_start = _date.fromisoformat(phase.start_date)
        except (TypeError, ValueError):
            continue
        if phase_start < window_start:
            violations.append(
                RuleViolation(
                    rule="unauthorized_completed_phase_before_plan",
                    severity="error",
                    message=(
                        f"completed phase '{phase.name}' starts before "
                        f"season_window.start_date {window_start_raw}; without "
                        "an explicit current-phase block, previous-plan history "
                        "must be cited in principles/focus only, not emitted as "
                        "a completed phase"
                    ),
                    details={
                        "phase_name": phase.name,
                        "phase_start": phase.start_date,
                        "season_window_start": str(window_start_raw),
                    },
                )
            )
    return violations


def check_weekly_key_sessions_present(plan: MasterPlan) -> list[RuleViolation]:
    """Every non-recovery / non-taper week must have 1-3 key sessions.

    Also enforces *coverage* — the emitted weeks must span the full plan
    window. A truncated 20-week plan with 8 valid weeks shouldn't pass
    L1 just because every emitted week happens to be valid.

    Coverage checks (all severity ``error``):

    * **Week count** — actual ≥ ``ceil(plan span days / 7) - 1``. The −1
      tolerance allows the LLM to omit a partial last week that's
      sub-7-days (e.g. plan ends mid-week).
    * **Sequential indices** — week_index goes 1, 2, 3, ... without gaps.
    * **Per-week density** — every non-deload week has 1-3 key sessions.

    Recovery weeks (``is_recovery_week=True``) and taper weeks
    (``is_taper_week=True``) are exempt from the density check — a deload
    by definition runs fewer / no quality sessions.
    """
    if not plan.weekly_key_sessions:
        return []  # back-compat: empty skeleton → no-op

    violations: list[RuleViolation] = []
    weeks_sorted = sorted(plan.weekly_key_sessions, key=lambda w: w.week_index)

    # Coverage: expected week count from the plan span.
    try:
        plan_start = _date.fromisoformat(plan.start_date)
        plan_end = _date.fromisoformat(plan.end_date)
        span_days = (plan_end - plan_start).days + 1  # inclusive
        expected_weeks = max(1, (span_days + 6) // 7)  # ceil
        min_acceptable = max(1, expected_weeks - 1)  # 1-week tolerance
        actual = len(weeks_sorted)
        if actual < min_acceptable:
            violations.append(
                RuleViolation(
                    rule="weekly_key_sessions_present",
                    severity="error",
                    message=(
                        f"weekly_key_sessions has {actual} weeks but plan "
                        f"span {plan.start_date} → {plan.end_date} requires "
                        f"≥ {min_acceptable} (expected ~{expected_weeks})"
                    ),
                    details={
                        "actual_weeks": actual,
                        "expected_weeks": expected_weeks,
                        "min_acceptable_weeks": min_acceptable,
                        "plan_start": plan.start_date,
                        "plan_end": plan.end_date,
                    },
                )
            )
    except (ValueError, TypeError):
        pass  # malformed dates — schema rule catches the underlying error

    # Coverage: sequential week_index (1, 2, 3, ...) without gaps.
    for i, week in enumerate(weeks_sorted, start=1):
        if week.week_index != i:
            violations.append(
                RuleViolation(
                    rule="weekly_key_sessions_present",
                    severity="error",
                    message=(
                        f"weekly_key_sessions[{i - 1}].week_index is "
                        f"{week.week_index}; expected {i} (sequential 1..N)"
                    ),
                    details={
                        "position": i - 1,
                        "actual_week_index": week.week_index,
                        "expected_week_index": i,
                    },
                )
            )
            break  # one signal is enough; don't flood

    # Per-week density.
    for week in weeks_sorted:
        if _week_is_deload(week):
            continue
        n = len(week.key_sessions)
        if n < 1 or n > 3:
            violations.append(
                RuleViolation(
                    rule="weekly_key_sessions_present",
                    severity="error",
                    message=(
                        f"week {week.week_index} ({week.week_start}) has "
                        f"{n} key session(s); expected 1-3 for a non-deload week"
                    ),
                    details={
                        "week_index": week.week_index,
                        "week_start": week.week_start,
                        "phase_id": week.phase_id,
                        "key_session_count": n,
                    },
                )
            )
    return violations


def check_weekly_volume_ramp(
    plan: MasterPlan,
    *,
    max_ramp_ratio: float = 1.10,
    integer_rounding_tolerance_km: float = 1.0,
) -> list[RuleViolation]:
    """Adjacent **load-week** ``target_weekly_km_high`` ratio must be ≤ 1.10.

    The comparison walks *past deload weeks* on both sides:

    * If ``curr`` is itself a deload (recovery / taper), it's allowed to
      drop — skip.
    * Otherwise compare ``curr`` to the most recent *non-deload* week
      before it. This is the correct comparison because the prompt asks
      for a recovery week every 4 weeks: a sequence like
      ``60 → 42 (recovery) → 62`` is a normal post-recovery rebound
      (only +3% vs the last load week), NOT a 1.48x ramp violation.

    Also skips when the resolved previous load week's volume is 0
    (degenerate / starting from zero, no ratio defined).
    """
    if not plan.weekly_key_sessions:
        return []
    weeks_sorted = sorted(plan.weekly_key_sessions, key=lambda w: w.week_index)
    violations: list[RuleViolation] = []
    for i, curr in enumerate(weeks_sorted):
        if i == 0:
            continue
        if _week_is_deload(curr):
            continue  # deload is supposed to drop
        # Walk back to find the most recent non-deload load week. If none
        # exists (i.e. all preceding weeks are deload — degenerate plan
        # shape), skip — there's no meaningful baseline to ramp from.
        prev_load = None
        for candidate in reversed(weeks_sorted[:i]):
            if not _week_is_deload(candidate):
                prev_load = candidate
                break
        if prev_load is None or prev_load.target_weekly_km_high <= 0:
            continue
        ratio = curr.target_weekly_km_high / prev_load.target_weekly_km_high
        # Avoid burning a full LLM retry on harmless integer rounding around the
        # 10% cap (e.g. 28km -> 31km is 1.107x but only 0.2km above 30.8km).
        # Large jumps such as 60->72 or 78->92 remain well outside this buffer.
        allowed_high = (
            prev_load.target_weekly_km_high * max_ramp_ratio
            + integer_rounding_tolerance_km
        )
        if ratio > max_ramp_ratio and curr.target_weekly_km_high > allowed_high:
            violations.append(
                RuleViolation(
                    rule="weekly_volume_ramp",
                    severity="error",
                    message=(
                        f"week {curr.week_index} target_weekly_km_high "
                        f"({curr.target_weekly_km_high:.1f}km) jumps "
                        f"{ratio:.2f}x vs last load week {prev_load.week_index} "
                        f"({prev_load.target_weekly_km_high:.1f}km); cap is "
                        f"{max_ramp_ratio:.2f}x"
                    ),
                    details={
                        "prev_load_week_index": prev_load.week_index,
                        "curr_week_index": curr.week_index,
                        "prev_load_km_high": prev_load.target_weekly_km_high,
                        "curr_km_high": curr.target_weekly_km_high,
                        "ratio": round(ratio, 3),
                        "max_ratio": max_ramp_ratio,
                        "allowed_km_high_with_rounding": round(allowed_high, 1),
                    },
                )
            )
    return violations


def check_key_session_distance_within_weekly_volume(
    plan: MasterPlan,
    *,
    tolerance_km: float = 0.05,
) -> list[RuleViolation]:
    """Every distance-based key session must fit inside the week's high volume.

    Race distance counts toward race-week volume. A week with a 42.2km race
    cannot declare ``target_weekly_km_high=28`` and still be internally
    consistent.
    """
    if not plan.weekly_key_sessions:
        return []
    violations: list[RuleViolation] = []
    for week in plan.weekly_key_sessions:
        weekly_high = week.target_weekly_km_high
        if weekly_high is None:
            continue
        for session_index, session in enumerate(week.key_sessions):
            distance_km = session.distance_km
            if distance_km is None:
                continue
            if distance_km <= weekly_high + tolerance_km:
                continue
            violations.append(
                RuleViolation(
                    rule="key_session_distance_within_weekly_volume",
                    severity="error",
                    message=(
                        f"week {week.week_index} {session.type} session is "
                        f"{distance_km:.1f}km but target_weekly_km_high is "
                        f"{weekly_high:.1f}km; weekly volume must include all "
                        "distance-based key sessions, including race distance"
                    ),
                    details={
                        "week_index": week.week_index,
                        "week_start": week.week_start,
                        "session_index": session_index,
                        "session_type": session.type,
                        "session_distance_km": distance_km,
                        "target_weekly_km_high": weekly_high,
                    },
                )
            )
    return violations


def check_taper_volume_drop(
    plan: MasterPlan, *, min_drop_pct: float = 0.25
) -> list[RuleViolation]:
    """First taper week must drop ``target_weekly_km_high`` ≥ 25% vs peak.

    "Peak" here = the highest-volume non-deload week before taper, not the
    immediately preceding load week. S1 often inserts a post-rehearsal deload
    and then a lower sharpener week before taper; comparing taper to that
    sharpener falsely rejects good plans that already dropped from the actual
    peak.
    No-op when there is no taper week at all — the prompt's HARD rule
    requires one, but ``peak_before_race`` already covers that gap and
    we'd be double-counting.
    """
    if not plan.weekly_key_sessions:
        return []
    weeks_sorted = sorted(plan.weekly_key_sessions, key=lambda w: w.week_index)
    first_taper_idx = next(
        (i for i, w in enumerate(weeks_sorted) if w.is_taper_week), -1
    )
    if first_taper_idx <= 0:
        return []  # no taper week, or taper is week 1 (degenerate, peak_before_race catches)
    taper_week = weeks_sorted[first_taper_idx]
    pre_taper_load_weeks = [
        candidate
        for candidate in weeks_sorted[:first_taper_idx]
        if not _week_is_deload(candidate)
    ]
    peak_week = max(
        pre_taper_load_weeks,
        key=lambda w: w.target_weekly_km_high,
        default=None,
    )
    if peak_week is None or peak_week.target_weekly_km_high <= 0:
        return []
    drop_pct = (
        peak_week.target_weekly_km_high - taper_week.target_weekly_km_high
    ) / peak_week.target_weekly_km_high
    if drop_pct < min_drop_pct:
        return [
            RuleViolation(
                rule="taper_volume_drop",
                severity="error",
                message=(
                    f"taper week {taper_week.week_index} only drops "
                    f"{drop_pct * 100:.1f}% from peak week {peak_week.week_index} "
                    f"({peak_week.target_weekly_km_high:.1f}km → "
                    f"{taper_week.target_weekly_km_high:.1f}km); expected "
                    f"≥ {min_drop_pct * 100:.0f}%"
                ),
                details={
                    "peak_week_index": peak_week.week_index,
                    "taper_week_index": taper_week.week_index,
                    "peak_km_high": peak_week.target_weekly_km_high,
                    "taper_km_high": taper_week.target_weekly_km_high,
                    "drop_pct": round(drop_pct * 100, 2),
                    "min_drop_pct": round(min_drop_pct * 100, 2),
                },
            )
        ]
    return []


def _identify_peak_phase(plan: MasterPlan) -> str | None:
    """Return the phase_id of the peak phase, or ``None`` if not identifiable.

    Strategy: the peak phase is the latest non-non-peak phase by end_date.
    Reuses :func:`_is_non_peak_phase` (which already screens out taper /
    race / recovery names and respects the peak-prep override). Falls back
    to ``None`` if there are no phases or none qualify — callers should
    degrade gracefully.
    """
    explicit_candidates: list[tuple[_date, str]] = []
    candidates: list[tuple[_date, str]] = []
    for phase in plan.phases:
        try:
            end = _date.fromisoformat(phase.end_date)
        except (ValueError, TypeError):
            continue
        if _is_explicit_peak_phase(phase):
            explicit_candidates.append((end, phase.id))
            continue
        if _phase_is_non_peak(phase):
            continue
        candidates.append((end, phase.id))
    if explicit_candidates:
        explicit_candidates.sort(key=lambda t: t[0])
        return explicit_candidates[-1][1]
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0])
    return candidates[-1][1]


def check_target_distance_long_run(
    plan: MasterPlan,
    *,
    target_race: dict | None,
    prs: dict | None = None,
    training_history_summary: dict | None = None,
) -> list[RuleViolation]:
    """Peak-phase long_run distance_km must match target race distance.

    Thresholds (from docs/coach-eval_S1.md):
    fm ≥ 28km, hm ≥ 18km, 10k ≥ 10km, 5k ≥ 6km, ultra ≥ 32km.

    We take the max ``distance_km`` across long_run sessions in weeks
    belonging to the **peak phase** (identified via
    :func:`_identify_peak_phase`). An early build-phase 28km long run no
    longer satisfies the rule — only the peak-phase max counts.

    Falls back to "max across all non-deload weeks" when the peak phase
    can't be identified (degenerate plans / unusual phase naming),
    preserving the previous lenient behaviour for safety.

    No-op when ``target_race`` lacks ``distance``, the skeleton is empty,
    or no ``long_run`` session was emitted in the peak phase.
    """
    if not plan.weekly_key_sessions:
        return []
    if not target_race:
        return []
    distance = (target_race.get("distance") or "").lower()
    if not distance:
        return []
    threshold = _LONG_RUN_MIN_KM.get(distance)
    if threshold is None:
        return []  # unrecognised race distance — let L2 judge handle

    peak_phase_id = _identify_peak_phase(plan)
    if peak_phase_id is None:
        # No identifiable peak phase — phase_count_min / peak_before_race
        # already flag this shape; don't add a noisy violation here.
        return []

    max_long_run_km = 0.0
    for week in plan.weekly_key_sessions:
        if _week_is_deload(week):
            continue
        if week.phase_id != peak_phase_id:
            continue  # outside peak phase — doesn't count toward "peak long_run"
        for sess in week.key_sessions:
            if sess.type != "long_run":
                continue
            if sess.distance_km is None:
                continue
            if sess.distance_km > max_long_run_km:
                max_long_run_km = sess.distance_km

    if max_long_run_km == 0.0:
        return [
            RuleViolation(
                rule="target_distance_long_run",
                severity="error",
                message=(
                    f"no long_run session with distance_km found in the peak "
                    f"phase ({peak_phase_id or 'unidentified'}); target "
                    f"{distance} requires peak long_run ≥ {threshold:.0f}km"
                ),
                details={
                    "distance": distance,
                    "min_long_run_km": threshold,
                    "max_long_run_km_found": 0.0,
                    "peak_phase_id": peak_phase_id,
                },
            )
        ]
    severe_low_volume_mismatch = _is_severe_low_volume_fm_mismatch(
        target_race=target_race,
        prs=prs,
        training_history_summary=training_history_summary,
    )
    if severe_low_volume_mismatch:
        if max_long_run_km <= _LOW_VOLUME_FM_MAX_LONG_RUN_KM:
            return []
        return [
            RuleViolation(
                rule="target_distance_long_run",
                severity="warning",
                message=(
                    f"severe low-volume fm mismatch: peak long_run "
                    f"{max_long_run_km:.1f}km exceeds the recommended "
                    f"<= {_LOW_VOLUME_FM_MAX_LONG_RUN_KM:.0f}km cap for this "
                    "cycle; downgrade the race target and use a multi-cycle path"
                ),
                details={
                    "distance": distance,
                    "max_long_run_km": max_long_run_km,
                    "max_allowed_long_run_km": _LOW_VOLUME_FM_MAX_LONG_RUN_KM,
                    "peak_phase_id": peak_phase_id,
                    "severe_low_volume_mismatch": True,
                },
            )
        ]

    if max_long_run_km < threshold:
        return [
            RuleViolation(
                rule="target_distance_long_run",
                severity="error",
                message=(
                    f"peak-phase long_run is {max_long_run_km:.1f}km; target "
                    f"{distance} requires ≥ {threshold:.0f}km"
                ),
                details={
                    "distance": distance,
                    "min_long_run_km": threshold,
                    "max_long_run_km": max_long_run_km,
                    "peak_phase_id": peak_phase_id,
                },
            )
        ]
    return []


def check_target_distance_volume_ceiling(
    plan: MasterPlan, *, target_race: dict | None
) -> list[RuleViolation]:
    """Shorter target races must not inherit FM-style volume or long runs.

    This is intentionally limited to 5K / 10K / HM because FM and ultra plans
    need broad individualisation. For the shorter fixtures, the recurring bad
    output is clear: weekly peaks in the 70-80km range and long runs sized for
    HM/FM even when the target is 5K or 10K.
    """
    if not plan.weekly_key_sessions or not target_race:
        return []
    distance = _normalise_distance_key(target_race.get("distance"))
    limits = _TARGET_DISTANCE_VOLUME_LIMITS.get(distance)
    if limits is None:
        return []

    load_weeks = [
        week for week in plan.weekly_key_sessions
        if not _week_is_deload(week) and week.target_weekly_km_high is not None
    ]
    if not load_weeks:
        return []

    violations: list[RuleViolation] = []
    peak_week = max(load_weeks, key=lambda w: w.target_weekly_km_high)
    max_weekly = limits["weekly_km_high"]
    if peak_week.target_weekly_km_high > max_weekly:
        violations.append(
            RuleViolation(
                rule="target_distance_volume_ceiling",
                severity="error",
                message=(
                    f"target {distance} but week {peak_week.week_index} reaches "
                    f"{peak_week.target_weekly_km_high:.0f}km; this looks like "
                    f"an FM/HM volume template. Cap {distance} peak weekly "
                    f"high at <= {max_weekly:.0f}km unless the fixture "
                    "explicitly asks for high-volume specialization"
                ),
                details={
                    "distance": distance,
                    "week_index": peak_week.week_index,
                    "target_weekly_km_high": peak_week.target_weekly_km_high,
                    "max_allowed_km_high": max_weekly,
                },
            )
        )

    max_long_run = 0.0
    max_long_run_week = None
    for week in load_weeks:
        longest = max(
            (
                session.distance_km
                for session in week.key_sessions
                if session.type == "long_run" and session.distance_km is not None
            ),
            default=0.0,
        )
        if longest > max_long_run:
            max_long_run = longest
            max_long_run_week = week
    max_lr = limits["long_run_km"]
    if max_long_run > max_lr and max_long_run_week is not None:
        violations.append(
            RuleViolation(
                rule="target_distance_volume_ceiling",
                severity="error",
                message=(
                    f"target {distance} but week {max_long_run_week.week_index} "
                    f"has {max_long_run:.0f}km long_run; cap long_run at "
                    f"<= {max_lr:.0f}km to preserve target-distance specificity"
                ),
                details={
                    "distance": distance,
                    "week_index": max_long_run_week.week_index,
                    "long_run_km": max_long_run,
                    "max_allowed_long_run_km": max_lr,
                },
            )
        )
    return violations


def check_distance_taper_length(
    plan: MasterPlan, *, target_race: dict | None
) -> list[RuleViolation]:
    """Explicit taper phase must not be longer than the race distance needs."""
    if not target_race:
        return []
    distance = _normalise_distance_key(target_race.get("distance"))
    max_days = _DISTANCE_TAPER_MAX_DAYS.get(distance)
    race_date_raw = target_race.get("race_date")
    if max_days is None or not race_date_raw:
        return []
    try:
        race_date = _date.fromisoformat(str(race_date_raw))
    except (TypeError, ValueError):
        return []

    taper_phases = []
    for phase in plan.phases:
        if "taper" not in str(phase.name).lower() and "减量" not in phase.name:
            continue
        try:
            start = _date.fromisoformat(phase.start_date)
            end = _date.fromisoformat(phase.end_date)
        except (TypeError, ValueError):
            continue
        if start <= race_date and end >= race_date - _timedelta(days=35):
            taper_phases.append((start, end, phase))

    if taper_phases:
        taper_start, taper_end, phase = min(taper_phases, key=lambda item: item[0])
        effective_end = min(taper_end, race_date)
        taper_days = (effective_end - taper_start).days + 1
        if taper_days > max_days:
            return [
                RuleViolation(
                    rule="distance_taper_length",
                    severity="error",
                    message=(
                        f"target {distance} taper phase '{phase.name}' spans "
                        f"{taper_days} days before race; expected <= "
                        f"{max_days} days for this distance"
                    ),
                    details={
                        "distance": distance,
                        "phase_id": phase.id,
                        "phase_name": phase.name,
                        "taper_start": taper_start.isoformat(),
                        "taper_end": effective_end.isoformat(),
                        "taper_days": taper_days,
                        "max_days": max_days,
                    },
                )
            ]
        return []

    if not plan.weekly_key_sessions:
        return []
    taper_weeks = [
        week for week in plan.weekly_key_sessions
        if getattr(week, "is_taper_week", False)
    ]
    if not taper_weeks:
        return []
    starts: list[_date] = []
    for week in taper_weeks:
        try:
            starts.append(_date.fromisoformat(week.week_start))
        except (TypeError, ValueError):
            continue
    if not starts:
        return []
    taper_start = min(starts)
    taper_days = (race_date - taper_start).days + 1
    if taper_days <= max_days:
        return []
    return [
        RuleViolation(
            rule="distance_taper_length",
            severity="error",
            message=(
                f"target {distance} taper weeks start {taper_start.isoformat()}, "
                f"{taper_days} days before race; expected <= {max_days} days"
            ),
            details={
                "distance": distance,
                "taper_start": taper_start.isoformat(),
                "race_date": race_date.isoformat(),
                "taper_days": taper_days,
                "max_days": max_days,
            },
        )
    ]


_LONG_RUN_MAX_WEEK_SHARE: float = 0.35
_VOLUME_CAPPED_FM_HISTORY_PEAK_KM: float = 72.0
_VOLUME_CAPPED_FM_LONG_RUN_SHARE: float = 0.50


def check_long_run_distance_share(
    plan: MasterPlan,
    *,
    max_share: float = _LONG_RUN_MAX_WEEK_SHARE,
    collapse_warnings: bool = False,
) -> list[RuleViolation]:
    """Warn when a non-deload week's longest long_run distance exceeds 35% of
    that week's target_weekly_km_high (the spike anti-pattern by DISTANCE; the
    dose-based rules miss easy long runs). Warning, not error: volume-capped
    runners legitimately exceed it for FM-specific endurance — the plan should
    explain the trade-off in its principles (spec §8 design-consideration #1)."""
    if not plan.weekly_key_sessions:
        return []
    violations: list[RuleViolation] = []
    for week in plan.weekly_key_sessions:
        if _week_is_deload(week):
            continue
        if not week.target_weekly_km_high or week.target_weekly_km_high <= 0:
            continue
        longest = max(
            (s.distance_km for s in week.key_sessions
             if s.type == "long_run" and s.distance_km is not None),
            default=0.0,
        )
        if longest <= 0:
            continue
        share = longest / week.target_weekly_km_high
        if share > max_share:
            violations.append(RuleViolation(
                rule="long_run_distance_share",
                severity="warning",
                message=(
                    f"week {week.week_index} long_run {longest:.0f}km is "
                    f"{share * 100:.0f}% of weekly {week.target_weekly_km_high:.0f}km "
                    f"(> {max_share * 100:.0f}%); for a volume-capped "
                    f"runner this can be acceptable but the plan must justify it"
                ),
                details={
                    "week_index": week.week_index,
                    "long_run_km": longest,
                    "weekly_km_high": week.target_weekly_km_high,
                    "share_pct": round(share * 100, 1),
                    "max_share_pct": round(max_share * 100, 1),
                },
            ))
    if collapse_warnings and len(violations) > 1:
        return [
            max(
                violations,
                key=lambda violation: float(violation.details.get("share_pct") or 0.0),
            )
        ]
    return violations


def _long_run_share_threshold(
    *,
    target_race: dict | None = None,
    weekly_run_days_max: int | None,
    injuries: list[str] | None,
    training_history_summary: dict | None,
) -> float:
    try:
        max_days = int(weekly_run_days_max) if weekly_run_days_max is not None else 99
    except (ValueError, TypeError):
        max_days = 99
    if max_days <= 3:
        return 0.50
    if _has_recent_injury_return_context(
        injuries=injuries, training_history_summary=training_history_summary
    ):
        return 0.45
    distance = _normalise_distance_key((target_race or {}).get("distance"))
    try:
        historical_peak = float(
            (training_history_summary or {}).get("peak_weekly_km_in_window") or 0
        )
    except (TypeError, ValueError):
        historical_peak = 0.0
    if distance == "fm" and 0 < historical_peak <= _VOLUME_CAPPED_FM_HISTORY_PEAK_KM:
        return _VOLUME_CAPPED_FM_LONG_RUN_SHARE
    return _LONG_RUN_MAX_WEEK_SHARE


def check_key_session_density(
    plan: MasterPlan, *, weekly_run_days_max: int | None
) -> list[RuleViolation]:
    """Per-week key session count must respect the frequency cap.

    ``weekly_run_days_max <= 3`` → max 2 key sessions/week.
    ``weekly_run_days_max >= 4`` (or missing) → max 3 key sessions/week.

    Race weeks (any week containing a ``race`` session) are exempt — a
    race week's single ``race`` session is the whole week's training, not
    a density violation.
    """
    if not plan.weekly_key_sessions:
        return []
    try:
        max_days = int(weekly_run_days_max) if weekly_run_days_max is not None else 99
    except (ValueError, TypeError):
        max_days = 99
    limit = 2 if max_days <= 3 else 3

    violations: list[RuleViolation] = []
    for week in plan.weekly_key_sessions:
        types = [ks.type for ks in week.key_sessions]
        # Race-week handling: when ``race`` is one of the session types,
        # the only legitimate week shape is exactly {race} — race day plus
        # anything else (even a single extra session under the density
        # limit) is a load-management catastrophe. Flag explicitly rather
        # than letting the under-limit count pass.
        if "race" in types:
            if set(types) == {"race"}:
                continue  # only race in the week — fine
            violations.append(
                RuleViolation(
                    rule="key_session_density",
                    severity="error",
                    message=(
                        f"week {week.week_index} has a race session plus "
                        f"{len(types) - 1} extra key session(s) "
                        f"({', '.join(t for t in types if t != 'race')}); "
                        f"race weeks must contain only the race"
                    ),
                    details={
                        "week_index": week.week_index,
                        "key_session_types": types,
                        "race_week_only_race_allowed": True,
                    },
                )
            )
            continue
        if len(types) > limit:
            violations.append(
                RuleViolation(
                    rule="key_session_density",
                    severity="error",
                    message=(
                        f"week {week.week_index} has {len(types)} key sessions; "
                        f"limit is {limit} (weekly_run_days_max="
                        f"{weekly_run_days_max if weekly_run_days_max is not None else 'unset'})"
                    ),
                    details={
                        "week_index": week.week_index,
                        "key_session_types": types,
                        "limit": limit,
                        "weekly_run_days_max": weekly_run_days_max,
                    },
                )
            )
    return violations


_EXTRA_RUN_DAY_MARKERS: tuple[str, ...] = (
    "外加", "额外", "另加", "加上", "plus", "extra", "in addition",
)
_SHORT_RUN_DAY_MARKERS: tuple[str, ...] = (
    "短慢跑", "慢跑", "轻松跑", "easy run", "short jog", "jog",
)
_EXTRA_RUN_NEGATION_MARKERS: tuple[str, ...] = (
    "不", "无", "禁止", "不得", "不要", "避免", "no ", "not ", "without",
)


def _negates_extra_short_run(text: str) -> bool:
    """True when a phrase says extra jogs are forbidden, not prescribed."""
    low = text.lower()
    for extra in _EXTRA_RUN_DAY_MARKERS:
        extra_at = low.find(extra)
        if extra_at == -1:
            continue
        for short_run in _SHORT_RUN_DAY_MARKERS:
            run_at = low.find(short_run, extra_at)
            if run_at == -1:
                continue
            window = low[max(0, extra_at - 8): run_at]
            if any(marker in window for marker in _EXTRA_RUN_NEGATION_MARKERS):
                return True
    return False


def _iter_plan_frequency_text(plan: MasterPlan) -> list[tuple[str, str]]:
    fields: list[tuple[str, str]] = []
    for idx, text in enumerate(getattr(plan, "training_principles", None) or []):
        fields.append((f"training_principles[{idx}]", str(text)))
    for idx, phase in enumerate(plan.phases):
        for name in ("focus", "rhythm", "key_workouts", "coach_note"):
            text = getattr(phase, name, "")
            if text:
                fields.append((f"phases[{idx}].{name}", str(text)))
        for j, text in enumerate(getattr(phase, "monitoring_triggers", None) or []):
            fields.append((f"phases[{idx}].monitoring_triggers[{j}]", str(text)))
    return fields


def check_three_day_extra_run_text(
    plan: MasterPlan, *, weekly_run_days_max: int | None
) -> list[RuleViolation]:
    """Three-run caps forbid extra short/easy jog days outside the cap."""
    try:
        max_days = int(weekly_run_days_max) if weekly_run_days_max is not None else 99
    except (ValueError, TypeError):
        max_days = 99
    if max_days > 3:
        return []

    violations: list[RuleViolation] = []
    for field_path, text in _iter_plan_frequency_text(plan):
        low = text.lower()
        if not any(marker in low for marker in _EXTRA_RUN_DAY_MARKERS):
            continue
        if not any(marker in low for marker in _SHORT_RUN_DAY_MARKERS):
            continue
        if _negates_extra_short_run(text):
            continue
        violations.append(
            RuleViolation(
                rule="three_day_extra_run_text",
                severity="error",
                message=(
                    f"weekly_run_days_max={weekly_run_days_max} but {field_path} "
                    "describes extra short/easy jog days outside the three run days; "
                    "keep non-run days to strength, mobility, or rest only"
                ),
                details={
                    "field_path": field_path,
                    "text": text,
                    "weekly_run_days_max": weekly_run_days_max,
                },
            )
        )
    return violations


def check_three_day_quality_stacking(
    plan: MasterPlan, *, weekly_run_days_max: int | None
) -> list[RuleViolation]:
    """Three-run weeks cannot stack MP long runs plus another hard workout."""
    if not plan.weekly_key_sessions:
        return []
    try:
        max_days = int(weekly_run_days_max) if weekly_run_days_max is not None else 99
    except (ValueError, TypeError):
        max_days = 99
    if max_days > 3:
        return []

    violations: list[RuleViolation] = []
    extra_hard_types = {"threshold", "tempo", "interval", "vo2max", "hill", "tune_up_race", "time_trial"}
    for week in plan.weekly_key_sessions:
        if _week_is_deload(week):
            continue
        long_runs = [s for s in week.key_sessions if s.type == "long_run"]
        if not long_runs:
            continue
        has_mp_long_run = any(
            (s.distance_km or 0) >= 24
            or any(marker in str(s.purpose or "").lower() for marker in ("mp", "马配", "目标配速"))
            for s in long_runs
        )
        if not has_mp_long_run:
            continue
        stacked = [s.type for s in week.key_sessions if s.type in extra_hard_types]
        if stacked:
            violations.append(
                RuleViolation(
                    rule="three_day_quality_stacking",
                    severity="error",
                    message=(
                        f"weekly_run_days_max={weekly_run_days_max} and week "
                        f"{week.week_index} has an MP/long-run key session plus "
                        f"{', '.join(stacked)}; 3-run plans need 1 long run + "
                        "1 quality + 1 medium aerobic, so do not stack a second "
                        "hard workout in MP long-run weeks"
                    ),
                    details={
                        "week_index": week.week_index,
                        "weekly_run_days_max": weekly_run_days_max,
                        "stacked_hard_types": stacked,
                    },
                )
            )
    return violations


def check_hard_session_spacing(plan: MasterPlan) -> list[RuleViolation]:
    """Per-week + cross-week hard-session limits.

    Same-week: at most 2 hard sessions (threshold / tempo / interval /
    vo2max / hill / race_pace / time_trial / tune_up_race). Three+ in
    one week is the canonical overtraining trap.

    Cross-week: no more than ``_MAX_CONSECUTIVE_HARD_WEEKS`` (4)
    consecutive non-deload weeks each carrying ≥ 2 hard sessions. The
    docs' "不得连续多周无 recovery / deload 调整" rule — 3:1 periodisation
    means 3 hard weeks + 1 deload is the upper bound; 4 hard weeks in a
    row without a deload signals chronic overload.
    """
    if not plan.weekly_key_sessions:
        return []
    weeks_sorted = sorted(plan.weekly_key_sessions, key=lambda w: w.week_index)
    violations: list[RuleViolation] = []

    # Per-week limit.
    week_hard_counts: list[tuple[int, int]] = []  # (week_index, hard_count)
    for week in weeks_sorted:
        hard = [ks.type for ks in week.key_sessions if ks.type in _HARD_SESSION_TYPES]
        week_hard_counts.append((week.week_index, len(hard)))
        if len(hard) > 2:
            violations.append(
                RuleViolation(
                    rule="hard_session_spacing",
                    severity="error",
                    message=(
                        f"week {week.week_index} has {len(hard)} hard sessions "
                        f"({', '.join(hard)}); limit is 2 per week"
                    ),
                    details={
                        "week_index": week.week_index,
                        "hard_session_types": hard,
                        "limit": 2,
                    },
                )
            )

    # Cross-week streak: identify consecutive non-deload weeks each with
    # ≥ 2 hard sessions, no deload break, longer than the max allowed.
    streak: list[int] = []
    for week in weeks_sorted:
        hard_count = sum(
            1 for ks in week.key_sessions if ks.type in _HARD_SESSION_TYPES
        )
        if _week_is_deload(week):
            streak = []
            continue
        if hard_count >= 2:
            streak.append(week.week_index)
        else:
            streak = []
        if len(streak) > _MAX_CONSECUTIVE_HARD_WEEKS:
            violations.append(
                RuleViolation(
                    rule="hard_session_spacing",
                    severity="error",
                    message=(
                        f"{len(streak)} consecutive non-deload weeks each "
                        f"carry ≥ 2 hard sessions (weeks "
                        f"{streak[0]}-{streak[-1]}); limit is "
                        f"{_MAX_CONSECUTIVE_HARD_WEEKS} (insert a recovery week)"
                    ),
                    details={
                        "streak_start": streak[0],
                        "streak_end": streak[-1],
                        "streak_length": len(streak),
                        "max_allowed": _MAX_CONSECUTIVE_HARD_WEEKS,
                    },
                )
            )
            streak = []  # reset to avoid flooding per-extra-week violations
    return violations


def check_strength_durability_track(plan: MasterPlan) -> list[RuleViolation]:
    """A plan must program a strength & durability track — never run-only.

    Severity ``warning`` (advisory, non-blocking): the project rule is that
    every plan covers Strength & Conditioning, and for endurance athletes the
    late-race fade is often a structural (posterior-chain / hip / ankle /
    tendon) failure rather than an aerobic one, so a run-only plan both
    under-addresses the goal-limiting weakness and raises injury/dropout risk.
    The durability track is tracked at the phase / principles / milestone level
    (it is non-running, exempt from the weekly key-session caps), so this rule
    accepts ANY of those signals as evidence the track exists:

    * a ``strength_test`` milestone, or
    * a phase whose ``key_session_types`` names a strength/durability entry, or
    * a ``training_principles`` entry mentioning strength / durability.

    Kept as a warning (not error) so it surfaces the gap for review without
    blocking generation or hard-failing legacy fixtures that predate the
    strength-track doctrine.
    """
    has_milestone = any(
        m.type == MilestoneType.STRENGTH_TEST for m in plan.milestones
    )
    has_phase_type = any(
        any("strength" in str(t).lower() or "durab" in str(t).lower()
            for t in (ph.key_session_types or []))
        for ph in plan.phases
    )
    _KW = ("strength", "durab", "力量", "耐久", "稳定", "跟腱", "偏心")
    principles = getattr(plan, "training_principles", None) or []
    has_principle = any(
        any(kw in str(p).lower() if kw.isascii() else kw in str(p) for kw in _KW)
        for p in principles
    )
    if has_milestone or has_phase_type or has_principle:
        return []
    return [
        RuleViolation(
            rule="strength_durability_track",
            severity="warning",
            message=(
                "plan is run-only — no strength & durability track found "
                "(no strength_test milestone, no strength entry in any phase's "
                "key_session_types, no durability line in training_principles). "
                "Every plan should program S&C; for injury-prone / late-fade "
                "athletes durability is a goal prerequisite."
            ),
            details={},
        )
    ]


# Goal-pace volume inside long runs is what builds race-specific endurance for
# the longer goals; a sub-3:00 marathon needs the longest specific run to clear
# the 30km fade point. ``_SUB3_FM_S`` is the 3:00:00 cutoff in seconds.
_SUB3_FM_S: int = 3 * 3600
_MP_KEYWORDS: tuple[str, ...] = (
    "配速", "marathon pace", "race pace", "race-pace", "goal pace", "目标配速",
    "mp", "马配",
)


def _text_mentions_goal_pace(text: object) -> bool:
    lowered = str(text or "").lower()
    return any(
        kw in lowered if kw.isascii() else kw in str(text or "")
        for kw in _MP_KEYWORDS
    )


_STRICT_SUB3_GATE_KEYWORDS: tuple[str, ...] = (
    "a=", "a goal", "a通道", "开a", "开放a", "才开a", "才保留a",
    "才保a", "保a", "a2:", "a<", "hm", "半马", "30km", "专项",
    "hr/rpe", "跟腱", "achilles",
)


def _has_strict_sub3_fm_gate(plan: MasterPlan) -> bool:
    """A-gated sub-3 FM plans may cap peak long run for risk control."""
    texts = [str(item or "") for item in getattr(plan, "training_principles", None) or []]
    texts.extend(str(m.target or "") for m in plan.milestones)
    joined = "\n".join(texts).lower()
    has_a_gate = any(token in joined for token in ("a=", "a goal", "a通道", "开a", "开放a", "才开a", "才保留a", "才保a", "保a", "a2:", "a<"))
    has_performance_gate = any(token in joined for token in ("hm", "半马", "30km", "专项"))
    has_risk_gate = any(token in joined for token in ("hr/rpe", "跟腱", "achilles"))
    return has_a_gate and has_performance_gate and has_risk_gate


def _has_explicit_sub3_risk_cap(plan: MasterPlan) -> bool:
    texts = [str(item or "") for item in getattr(plan, "training_principles", None) or []]
    texts.extend(str(m.target or "") for m in plan.milestones)
    joined = "\n".join(texts).lower()
    return any(
        token in joined
        for token in (
            "风险上限", "显式风险", "risk cap", "ramp cap", "history/ramp",
            "爬坡上限", "峰值控", "控在",
        )
    )


def check_marathon_pace_specificity(
    plan: MasterPlan,
    *,
    target_race: dict | None = None,
    prs: dict | None = None,
    training_history_summary: dict | None = None,
) -> list[RuleViolation]:
    """fm/hm plans must carry goal-pace-specific work; sub-3 fm normally needs
    a ≥32km long run (both ``warning`` — advisory, non-blocking).

    Two advisory checks, only for fm/hm goals (no-op otherwise, and no-op when
    ``target_race`` / ``weekly_key_sessions`` are absent so legacy callers and
    early-pipeline plans don't trip):

    1. **Goal-pace specificity** — an all-easy plan does not build race-specific
       endurance. Accept EITHER a ``race_pace`` key session OR a milestone whose
       target text references goal/marathon pace (the low-day representation
       embeds the goal-pace block inside the long_run and names it in the
       milestone instead of a separate race_pace session). Warn if neither.
    2. **sub-3:00 fm long-run depth** — when the fm goal is sub-3:00, the longest
       ``long_run`` should reach ≥ 32km to rehearse goal pace past the 30km fade,
       unless a strict A gate plus risk cap deliberately limits it to 30-31km.
    """
    if not target_race or not plan.weekly_key_sessions:
        return []
    distance = str(target_race.get("distance") or "").lower()
    if distance not in ("fm", "hm"):
        return []

    violations: list[RuleViolation] = []

    has_race_pace = any(
        ks.type == "race_pace"
        for w in plan.weekly_key_sessions
        for ks in (w.key_sessions or [])
    )
    has_embedded_goal_pace_long_run = any(
        ks.type == "long_run" and _text_mentions_goal_pace(ks.purpose)
        for w in plan.weekly_key_sessions
        for ks in (w.key_sessions or [])
    )
    has_mp_milestone = any(
        _text_mentions_goal_pace(m.target)
        for m in plan.milestones
    )
    if not has_race_pace and not has_embedded_goal_pace_long_run and not has_mp_milestone:
        violations.append(
            RuleViolation(
                rule="marathon_pace_specificity",
                severity="warning",
                message=(
                    f"{distance} plan has no goal-pace-specific work — no "
                    "race_pace key session and no goal-pace milestone. Easy "
                    "long runs alone don't build race-specific endurance; embed "
                    "a progressive goal-pace block in the long runs."
                ),
                details={"distance": distance},
            )
        )

    goal_time_s = target_race.get("goal_time_s")
    if (
        distance == "fm"
        and isinstance(goal_time_s, (int, float))
        and goal_time_s < _SUB3_FM_S
        and not _is_severe_low_volume_fm_mismatch(
            target_race=target_race,
            prs=prs,
            training_history_summary=training_history_summary,
        )
    ):
        long_runs = [
            ks.distance_km
            for w in plan.weekly_key_sessions
            for ks in (w.key_sessions or [])
            if ks.type == "long_run" and ks.distance_km
        ]
        peak_lr = max(long_runs) if long_runs else 0.0
        if peak_lr >= 31.0 and _has_strict_sub3_fm_gate(plan):
            return violations
        if (
            peak_lr >= 30.0
            and _has_strict_sub3_fm_gate(plan)
            and _has_explicit_sub3_risk_cap(plan)
        ):
            return violations
        if peak_lr < 32.0:
            violations.append(
                RuleViolation(
                    rule="marathon_pace_specificity",
                    severity="warning",
                    message=(
                        f"sub-3:00 fm goal but longest long_run is {peak_lr:.0f}km "
                        "(< 32km) — push the peak long run to ≥32km to rehearse "
                        "goal pace past the 30km fade point."
                    ),
                    details={"peak_long_run_km": peak_lr, "goal_time_s": goal_time_s},
                )
            )
    return violations


def check_frequency_volume_ceiling(
    plan: MasterPlan,
    *,
    weekly_run_days_max: int | None,
    max_three_day_km_high: float = 60.0,
) -> list[RuleViolation]:
    """Three-run plans must not inflate weekly volume to full-volume templates.

    A 30km FM rehearsal can make the 35% long-run-share rule imply 86km, but
    that is not executable on three run days. For <=3 days/week users, prefer a
    shorter rehearsal and an explicit trade-off over impossible weekly volume.
    """
    if not plan.weekly_key_sessions:
        return []
    try:
        max_days = int(weekly_run_days_max) if weekly_run_days_max is not None else 99
    except (ValueError, TypeError):
        max_days = 99
    if max_days > 3:
        return []

    load_weeks = [
        week for week in plan.weekly_key_sessions
        if not _week_is_deload(week) and week.target_weekly_km_high is not None
    ]
    if not load_weeks:
        return []
    peak_week = max(load_weeks, key=lambda w: w.target_weekly_km_high)
    if peak_week.target_weekly_km_high <= max_three_day_km_high:
        return []
    return [
        RuleViolation(
            rule="frequency_volume_ceiling",
            severity="error",
            message=(
                f"weekly_run_days_max={weekly_run_days_max} but week "
                f"{peak_week.week_index} reaches "
                f"{peak_week.target_weekly_km_high:.0f}km; 3-run plans must "
                f"stay <= {max_three_day_km_high:.0f}km and trade long-run "
                "share explicitly instead of inflating volume"
            ),
            details={
                "week_index": peak_week.week_index,
                "weekly_run_days_max": weekly_run_days_max,
                "target_weekly_km_high": peak_week.target_weekly_km_high,
                "max_allowed_km_high": max_three_day_km_high,
            },
        )
    ]


def check_aggressive_goal_volume_ceiling(
    plan: MasterPlan,
    *,
    target_race: dict | None,
    prs: dict | None,
    training_history_summary: dict | None,
    max_peak_ratio: float = 1.10,
    rounding_buffer_km: float = 2.0,
    max_absolute_increase_km: float = 7.0,
    integer_rounding_tolerance_km: float = 0.5,
) -> list[RuleViolation]:
    """Aggressive goals should not also chase an unproven volume record.

    When the goal already exceeds the PB-improvement threshold, the safer S1
    shape is to gate the A goal and train by the B goal. Adding a 20%+ peak
    volume jump on top of that is the exact anti-pattern seen in the boundary
    fixture.
    """
    if not plan.weekly_key_sessions or not target_race or not prs:
        return []
    distance = _normalise_distance_key(target_race.get("distance"))
    pr_key = _PR_KEY_BY_DISTANCE.get(distance)
    if pr_key is None:
        return []
    try:
        goal_s = float(target_race.get("goal_time_s") or 0)
        pr_s = float(prs.get(pr_key) or 0)
        historical_peak = float(
            (training_history_summary or {}).get("peak_weekly_km_in_window") or 0
        )
    except (TypeError, ValueError):
        return []
    if goal_s <= 0 or pr_s <= 0 or historical_peak <= 0:
        return []

    threshold = _GOAL_REALISM_THRESHOLDS.get(distance, 0.10)
    improvement = (pr_s - goal_s) / pr_s
    if improvement <= threshold:
        return []

    load_weeks = [
        week for week in plan.weekly_key_sessions
        if not _week_is_deload(week) and week.target_weekly_km_high is not None
    ]
    if not load_weeks:
        return []
    peak_week = max(load_weeks, key=lambda w: w.target_weekly_km_high)
    ratio_allowed = historical_peak * max_peak_ratio + rounding_buffer_km
    absolute_allowed = historical_peak + max_absolute_increase_km
    max_allowed = min(ratio_allowed, absolute_allowed)
    if peak_week.target_weekly_km_high <= max_allowed + integer_rounding_tolerance_km:
        return []
    return [
        RuleViolation(
            rule="aggressive_goal_volume_ceiling",
            severity="error",
            message=(
                f"{distance} goal is {improvement * 100:.1f}% faster than PB "
                f"(>{threshold * 100:.0f}% realism threshold) and week "
                f"{peak_week.week_index} reaches "
                f"{peak_week.target_weekly_km_high:.0f}km vs historical peak "
                f"{historical_peak:.0f}km; keep peak <= about "
                f"{max_allowed:.0f}km and gate the A goal instead of stacking "
                "pace risk with a new volume record. If this cap prevents a "
                "30-32km sub-3 rehearsal, choose a 28-29km max rehearsal "
                "inside the cap rather than emitting 32/92."
            ),
            details={
                "distance": distance,
                "week_index": peak_week.week_index,
                "improvement_pct": round(improvement * 100, 2),
                "threshold_pct": round(threshold * 100, 2),
                "historical_peak_weekly_km": historical_peak,
                "target_weekly_km_high": peak_week.target_weekly_km_high,
                "max_allowed_km_high": round(max_allowed, 1),
                "ratio_allowed_km_high": round(ratio_allowed, 1),
                "absolute_allowed_km_high": round(absolute_allowed, 1),
            },
        )
    ]


_INJURY_TERMS: tuple[str, ...] = (
    "injury", "injured", "pain", "tendinitis", "tendinopathy",
    "patellar", "knee", "achilles", "伤", "膝", "髌", "腱", "痛",
)

_INJURY_RETURN_CONTEXT_MARKERS: tuple[str, ...] = (
    "rehab", "pt", "return", "returning", "rebuild", "post-injury",
    "伤后", "停训", "复跑", "康复", "恢复跑", "恢复训练", "重建", "理疗",
)


def _has_recent_injury_return_context(
    *, injuries: list[str] | None,
    training_history_summary: dict | None,
) -> bool:
    def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
        low = text.lower()
        return any(marker.lower() in low for marker in markers)

    # A training gap is stronger evidence than a generic injury note: if the
    # gap reason names an injury/pain/tendon issue, this is a return-to-training
    # context even if the reason does not spell out "rehab".
    for gap in (training_history_summary or {}).get("training_gaps") or []:
        if isinstance(gap, dict):
            reason = str(gap.get("reason") or "")
            if _contains_any(reason, _INJURY_TERMS):
                return True

    # Injury list alone can describe either a recent return ("PT rehab",
    # "8 weeks post injury") or a stable chronic risk ("慢性，可控，无痛").
    # Only the former should trigger the hard volume ceiling; chronic controlled
    # issues are handled by durability monitoring and ordinary peak-volume caps.
    for item in injuries or []:
        text = str(item)
        if _contains_any(text, _INJURY_TERMS) and _contains_any(
            text, _INJURY_RETURN_CONTEXT_MARKERS
        ):
            return True
    return False


def check_injury_return_volume_ceiling(
    plan: MasterPlan,
    *,
    injuries: list[str] | None,
    training_history_summary: dict | None,
    max_peak_ratio: float = 1.10,
    rounding_buffer_km: float = 2.0,
) -> list[RuleViolation]:
    """Recent injury-return plans must respect the pre-injury volume ceiling."""
    if not plan.weekly_key_sessions:
        return []
    if not _has_recent_injury_return_context(
        injuries=injuries, training_history_summary=training_history_summary
    ):
        return []
    try:
        historical_peak = float(
            (training_history_summary or {}).get("peak_weekly_km_in_window") or 0
        )
    except (TypeError, ValueError):
        historical_peak = 0.0
    if historical_peak <= 0:
        return []

    load_weeks = [
        week for week in plan.weekly_key_sessions
        if not _week_is_deload(week) and week.target_weekly_km_high is not None
    ]
    if not load_weeks:
        return []
    peak_week = max(load_weeks, key=lambda w: w.target_weekly_km_high)
    max_allowed = historical_peak * max_peak_ratio + rounding_buffer_km
    if peak_week.target_weekly_km_high <= max_allowed:
        return []
    return [
        RuleViolation(
            rule="injury_return_volume_ceiling",
            severity="error",
            message=(
                f"recent injury-return context with historical peak "
                f"{historical_peak:.0f}km, but week {peak_week.week_index} "
                f"reaches {peak_week.target_weekly_km_high:.0f}km; cap is "
                f"about {max_allowed:.0f}km (prior peak + ~10%)"
            ),
            details={
                "week_index": peak_week.week_index,
                "historical_peak_weekly_km": historical_peak,
                "target_weekly_km_high": peak_week.target_weekly_km_high,
                "max_allowed_km_high": round(max_allowed, 1),
                "max_peak_ratio": max_peak_ratio,
            },
        )
    ]


def check_injury_return_peak_exception_count(
    plan: MasterPlan,
    *,
    injuries: list[str] | None,
    training_history_summary: dict | None,
    exception_threshold_km: float = 64.0,
    max_exception_weeks: int = 1,
) -> list[RuleViolation]:
    """Warn when an injury-return plan repeats protected high-peak stress.

    Some FM return fixtures allow one monitored 28km rehearsal in a 64-65km
    week. A prior 64km adaptation week can be acceptable when the unique 28km
    rehearsal is the final high week and recovery/taper follows; repeated 28km
    rehearsals or high weeks after that rehearsal are quality warnings.
    """
    if not plan.weekly_key_sessions:
        return []
    if not _has_recent_injury_return_context(
        injuries=injuries, training_history_summary=training_history_summary
    ):
        return []
    try:
        historical_peak = float(
            (training_history_summary or {}).get("peak_weekly_km_in_window") or 0
        )
    except (TypeError, ValueError):
        historical_peak = 0.0
    if historical_peak <= 0 or historical_peak > 60:
        return []

    high_weeks = [
        week
        for week in plan.weekly_key_sessions
        if not _week_is_deload(week)
        and week.target_weekly_km_high is not None
        and week.target_weekly_km_high >= exception_threshold_km
    ]
    if len(high_weeks) <= max_exception_weeks:
        return []
    rehearsal_weeks = [
        week
        for week in high_weeks
        if max(
            (
                session.distance_km or 0.0
                for session in week.key_sessions
                if session.type == "long_run"
            ),
            default=0.0,
        ) >= 28.0
    ]
    if len(rehearsal_weeks) == 1 and rehearsal_weeks[0] is high_weeks[-1]:
        return []
    return [
        RuleViolation(
            rule="injury_return_peak_exception_count",
            severity="warning",
            message=(
                f"recent injury-return context allows at most "
                f"{max_exception_weeks} protected high week(s) near "
                f"{exception_threshold_km:.0f}-65km, but found "
                f"{len(high_weeks)}; keep 64-65km as a single monitored FM "
                "rehearsal exception and use lower surrounding load weeks"
            ),
            details={
                "historical_peak_weekly_km": historical_peak,
                "exception_threshold_km": exception_threshold_km,
                "max_exception_weeks": max_exception_weeks,
                "week_indices": [week.week_index for week in high_weeks],
                "week_highs": [week.target_weekly_km_high for week in high_weeks],
            },
        )
    ]


_KM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:km|公里|K)", re.IGNORECASE)
_WEEKLY_VOLUME_KM_CONTEXT_RE = re.compile(
    r"周量|周跑量|周里程|周训练量|weekly\s+(?:volume|mileage)|weekly\s+km|volume|mileage",
    re.IGNORECASE,
)


def _float_or_none(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _is_weekly_volume_km_mention(text: str, match: re.Match[str]) -> bool:
    context_start = max(0, match.start() - 14)
    context_end = min(len(text), match.end() + 14)
    return bool(_WEEKLY_VOLUME_KM_CONTEXT_RE.search(text[context_start:context_end]))


def _milestone_target_km(milestone: object) -> float | None:
    """Best-effort long-run distance mentioned in milestone target text.

    Prefer structured ``target_value`` when the milestone declares a long-run
    distance metric. Text fallback ignores weekly-volume mentions such as
    ``13km long run, weekly volume 38km``.

    Prefer plausible run distances (<=45km) so shorthand like ``32km/92km``
    (long run / weekly high) does not treat 92km as the milestone long run.
    """
    metric = str(getattr(milestone, "metric", "") or "").lower()
    target_value = _float_or_none(getattr(milestone, "target_value", None))
    if target_value is not None and (
        metric == "long_run_distance_km" or metric.startswith("long_run")
    ):
        return target_value

    target = getattr(milestone, "target", milestone)
    text = str(target or "")
    matches = [
        float(m.group(1))
        for m in _KM_RE.finditer(text)
        if not _is_weekly_volume_km_mention(text, m)
    ]
    if not matches:
        return None
    plausible_run_distances = [km for km in matches if 5.0 <= km <= 45.0]
    return max(plausible_run_distances or matches)


def check_milestone_week_consistency(plan: MasterPlan) -> list[RuleViolation]:
    """Long-run milestone distance should match that calendar week's skeleton.

    The milestone layer is athlete-facing; if it promises a 30-32km checkpoint
    while the same week's ``weeks`` entry is recovery or only 18km, the judge
    reads the plan as inconsistent even when L1 weekly rules pass. Warning only:
    this is a coherence problem, not an unsafe training prescription by itself.
    """
    if not plan.milestones or not plan.weekly_key_sessions:
        return []
    weeks: list[tuple[Any, _date, _date]] = []
    for week in plan.weekly_key_sessions:
        try:
            start = _date.fromisoformat(week.week_start)
        except (TypeError, ValueError):
            continue
        weeks.append((week, start, start + _timedelta(days=6)))

    violations: list[RuleViolation] = []
    for milestone in plan.milestones:
        if milestone.type != MilestoneType.LONG_RUN:
            continue
        target_km = _milestone_target_km(milestone)
        if target_km is None:
            continue
        try:
            milestone_date = _date.fromisoformat(milestone.date)
        except (TypeError, ValueError):
            continue
        matching_week = next(
            (week for week, start, end in weeks if start <= milestone_date <= end),
            None,
        )
        if matching_week is None:
            continue
        week_lr = max(
            (
                session.distance_km
                for session in matching_week.key_sessions
                if session.type == "long_run" and session.distance_km is not None
            ),
            default=0.0,
        )
        if week_lr + 0.5 < target_km:
            violations.append(
                RuleViolation(
                    rule="milestone_week_consistency",
                    severity="warning",
                    message=(
                        f"long_run milestone on {milestone.date} targets "
                        f"{target_km:.0f}km but week {matching_week.week_index} "
                        f"has longest long_run {week_lr:.0f}km; align milestone "
                        "date/target with the weekly skeleton"
                    ),
                    details={
                        "milestone_date": milestone.date,
                        "milestone_target_km": target_km,
                        "week_index": matching_week.week_index,
                        "week_start": matching_week.week_start,
                        "week_long_run_km": week_lr,
                    },
                )
            )
    return violations


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_master_rule_filter(
    plan_dict: dict,
    *,
    target_race: dict | None = None,
    season_window: dict | None = None,
    prs: dict | None = None,
    weekly_run_days_max: int | None = None,
    injuries: list[str] | None = None,
    training_history_summary: dict | None = None,
    **_extra: Any,
) -> RuleFilterReport:
    """Run every master-plan rule against ``plan_dict``.

    The schema rule runs first because subsequent checks need a parsed
    ``MasterPlan`` instance. Input-aware rules (``season_window_fits`` /
    ``goal_realism`` / ``target_distance_long_run`` /
    ``key_session_density``) accept kwargs from
    :func:`build_generation_graph` → ``rule_filter_kwargs``; missing kwargs
    are silent no-ops so legacy callers don't break.

    Batch B rules (``weekly_key_sessions_present`` / ``weekly_volume_ramp``
    / ``taper_volume_drop`` / ``hard_session_spacing``) no-op when
    ``MasterPlan.weekly_key_sessions`` is empty — same back-compat shape.

    ``**_extra`` swallows any future kwargs (e.g. ``hr_zones``) that haven't
    been wired into a rule yet.
    """
    violations: list[RuleViolation] = []
    violations.extend(check_master_schema_validity(plan_dict))
    if violations:
        # Schema failure — downstream checks need a parsed MasterPlan; bail.
        return RuleFilterReport(violations=violations)
    plan = MasterPlan.model_validate(plan_dict)
    # Weekly-skeleton (Batch B) rules run on the active view, re-based to week 1,
    # so a continuity plan's already-completed lead-in (is_completed phases with
    # no weeks, weeks numbered from W9 etc.) doesn't trip the index / coverage
    # checks. Phase-level rules keep using the full plan (they need the complete
    # phase sequence, including the completed phases). No completed phase →
    # _active_plan_view returns plan unchanged, so existing plans are unaffected.
    active = _active_plan_view(plan)
    violations.extend(check_phase_count_min(plan))
    violations.extend(check_peak_before_race(plan, target_race=target_race))
    violations.extend(check_phase_duration_balance(plan, target_race=target_race))
    violations.extend(check_completed_phase_has_no_weeks(plan))
    violations.extend(
        check_unauthorized_completed_phase_before_plan(
            plan, season_window=season_window
        )
    )
    violations.extend(
        check_season_window_fits(
            plan, season_window=season_window, target_race=target_race
        )
    )
    violations.extend(
        check_goal_realism(plan, target_race=target_race, prs=prs)
    )
    # Batch B — weekly-skeleton rules (active view)
    violations.extend(check_weekly_key_sessions_present(active))
    violations.extend(check_weekly_volume_ramp(active))
    violations.extend(check_key_session_distance_within_weekly_volume(active))
    violations.extend(check_taper_volume_drop(active))
    violations.extend(
        check_distance_taper_length(plan, target_race=target_race)
    )
    violations.extend(
        check_target_distance_long_run(
            active,
            target_race=target_race,
            prs=prs,
            training_history_summary=training_history_summary,
        )
    )
    violations.extend(
        check_target_distance_volume_ceiling(active, target_race=target_race)
    )
    violations.extend(
        check_key_session_density(
            active, weekly_run_days_max=weekly_run_days_max
        )
    )
    violations.extend(
        check_three_day_extra_run_text(
            active, weekly_run_days_max=weekly_run_days_max
        )
    )
    violations.extend(
        check_three_day_quality_stacking(
            active, weekly_run_days_max=weekly_run_days_max
        )
    )
    violations.extend(
        check_frequency_volume_ceiling(
            active, weekly_run_days_max=weekly_run_days_max
        )
    )
    violations.extend(
        check_aggressive_goal_volume_ceiling(
            active,
            target_race=target_race,
            prs=prs,
            training_history_summary=training_history_summary,
        )
    )
    violations.extend(
        check_injury_return_volume_ceiling(
            active,
            injuries=injuries,
            training_history_summary=training_history_summary,
        )
    )
    violations.extend(
        check_injury_return_peak_exception_count(
            active,
            injuries=injuries,
            training_history_summary=training_history_summary,
        )
    )
    violations.extend(check_hard_session_spacing(active))
    long_run_share_threshold = _long_run_share_threshold(
        target_race=target_race,
        weekly_run_days_max=weekly_run_days_max,
        injuries=injuries,
        training_history_summary=training_history_summary,
    )
    violations.extend(
        check_long_run_distance_share(
            active,
            max_share=long_run_share_threshold,
            collapse_warnings=long_run_share_threshold > _LONG_RUN_MAX_WEEK_SHARE,
        )
    )
    violations.extend(check_strength_durability_track(active))
    violations.extend(
        check_marathon_pace_specificity(
            active,
            target_race=target_race,
            prs=prs,
            training_history_summary=training_history_summary,
        )
    )
    violations.extend(check_milestone_week_consistency(active))
    return RuleFilterReport(violations=violations)
