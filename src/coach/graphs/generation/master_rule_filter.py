"""Master plan rule filter — see ``docs/coach-eval_S1.md`` § S1 L1 Rules.

Implements 12 S1 L1 rules. Empty ``MasterPlan.weekly_key_sessions`` makes
all Batch B rules silent no-ops so legacy plans / fixtures don't trip on
the new structure.

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
  race distance — fm ≥ 28km, hm ≥ 18km, 10k ≥ 10km, 5k ≥ 6km (error).
* ``key_session_density``: ``weekly_run_days_max <= 3`` → ≤2 key sessions
  per week; otherwise ≤3 (error).

Weekly-skeleton (no kwargs but require ``weekly_key_sessions`` populated):

* ``weekly_key_sessions_present``: every non-recovery / non-taper week has
  1-3 key sessions (error).
* ``weekly_volume_ramp``: adjacent-week ``target_weekly_km_high`` ratio
  ≤ 1.10 except recovery / taper weeks (error).
* ``taper_volume_drop``: first taper week's ``target_weekly_km_high``
  drops ≥ 25% vs the immediately preceding peak week (error).
* ``hard_session_spacing``: same-week threshold / tempo / interval /
  vo2max / hill / race_pace count ≤ 2 (error).

LLM-free: no langchain / anthropic imports.
"""

from __future__ import annotations

from datetime import date as _date
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
    # Race phases — keep these specific (`比赛周` / `比赛日`) rather than bare
    # `比赛`, because `比赛准备期` / `比赛专项期` are valid peak phase names
    # that ALSO contain `比赛` as a substring.
    "比赛周", "比赛日", "race",
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
    "准备", "专项", "peak", "prep", "preparation", "build",
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
                if not _is_non_peak_phase(phase.name):
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
                            p.name for _, p in all_ends_before if _is_non_peak_phase(p.name)
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


def check_phase_duration_balance(
    plan: MasterPlan, *, min_days: int = 14, max_days: int = 112
) -> list[RuleViolation]:
    """Per-phase span must be 2-16 weeks (warning).

    Phases shorter than 2 weeks rarely deliver enough physiological
    adaptation to justify a separate periodisation block; phases longer
    than 16 weeks lose specificity because the body plateaus without a
    fresh stimulus. Severity is **warning**: a 1-week intro / deload micro-
    phase can be legitimate, and an 18-week base for an ultramarathon
    isn't catastrophic — the L2 judge owns the final call.

    Race-week phases (``比赛`` / ``race`` / ``比赛周``) are exempt — they
    are inherently 1-week blocks; the 2-week minimum doesn't apply.
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
        days = (end - start).days
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


def _week_is_deload(week: Any) -> bool:
    """True if the week is a recovery or taper week (rules skip these)."""
    return bool(getattr(week, "is_recovery_week", False) or getattr(week, "is_taper_week", False))


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
    plan: MasterPlan, *, max_ramp_ratio: float = 1.10
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
        if ratio > max_ramp_ratio:
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
                    },
                )
            )
    return violations


def check_taper_volume_drop(
    plan: MasterPlan, *, min_drop_pct: float = 0.25
) -> list[RuleViolation]:
    """First taper week must drop ``target_weekly_km_high`` ≥ 25% vs peak.

    "Peak" here = the week immediately preceding the first taper week
    (well-defined because the prompt asks for ordered weekly_key_sessions).
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
    # Peak = previous non-deload week. Walking backwards lets us skip a
    # spurious recovery deload-week that the LLM might have placed right
    # before taper (which would otherwise make taper "drop" look invalid).
    peak_week = None
    for candidate in reversed(weeks_sorted[:first_taper_idx]):
        if not _week_is_deload(candidate):
            peak_week = candidate
            break
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
    candidates: list[tuple[_date, str]] = []
    for phase in plan.phases:
        if _is_non_peak_phase(phase.name):
            continue
        try:
            end = _date.fromisoformat(phase.end_date)
        except (ValueError, TypeError):
            continue
        candidates.append((end, phase.id))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0])
    return candidates[-1][1]


def check_target_distance_long_run(
    plan: MasterPlan, *, target_race: dict | None
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
        # Race-week exempt: ONLY when the week consists solely of `race`
        # session(s). A week like [race, threshold, tempo, interval] is
        # NOT a legitimate race week — race day + extra hard work the
        # week of the race is a load-management catastrophe.
        if types and set(types) == {"race"}:
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

    ``**_extra`` swallows any future kwargs (e.g. ``injuries``, ``hr_zones``)
    that haven't been wired into a rule yet.
    """
    violations: list[RuleViolation] = []
    violations.extend(check_master_schema_validity(plan_dict))
    if violations:
        # Schema failure — downstream checks need a parsed MasterPlan; bail.
        return RuleFilterReport(violations=violations)
    plan = MasterPlan.model_validate(plan_dict)
    violations.extend(check_phase_count_min(plan))
    violations.extend(check_peak_before_race(plan, target_race=target_race))
    violations.extend(check_phase_duration_balance(plan))
    violations.extend(
        check_season_window_fits(
            plan, season_window=season_window, target_race=target_race
        )
    )
    violations.extend(
        check_goal_realism(plan, target_race=target_race, prs=prs)
    )
    # Batch B — weekly-skeleton rules
    violations.extend(check_weekly_key_sessions_present(plan))
    violations.extend(check_weekly_volume_ramp(plan))
    violations.extend(check_taper_volume_drop(plan))
    violations.extend(
        check_target_distance_long_run(plan, target_race=target_race)
    )
    violations.extend(
        check_key_session_density(
            plan, weekly_run_days_max=weekly_run_days_max
        )
    )
    violations.extend(check_hard_session_spacing(plan))
    return RuleFilterReport(violations=violations)
