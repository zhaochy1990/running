"""Master plan rule filter — see ``docs/coach-eval_S1.md`` § S1 L1 Rules.

Batch A (current) implements 6 rules — 3 schema-based + 3 input-aware:

Schema-only (no kwargs):

* ``master_schema_validity``: ``MasterPlan.model_validate`` must pass.
* ``phase_count_min``: at least 3 phases (base / build / peak typical).
* ``peak_before_race``: if any RACE milestone exists, the phase ending closest
  before the race must finish within 7-21 days of race_date (1-3 week taper).
* ``phase_duration_balance``: per-phase span 2-16 weeks (warning).

Input-aware (need ``rule_filter_kwargs``):

* ``season_window_fits``: plan.start/end within ``season_window`` and
  ``target_race.race_date`` inside the window (error).
* ``goal_realism``: PB → ``target_race.goal_time_s`` improvement vs
  distance-specific threshold — fm 10%, hm 12%, 5k/10k 15%, ultra 10%
  (warning).

Batch B rules (deferred — require ``weekly_key_sessions`` schema extension):
``weekly_key_sessions_present`` / ``weekly_volume_ramp`` / ``taper_volume_drop``
/ ``target_distance_long_run`` / ``key_session_density`` / ``hard_session_spacing``.
See ``docs/coach-eval_S1.md`` § S1 L1 Rules.

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


def check_peak_before_race(plan: MasterPlan) -> list[RuleViolation]:
    """RACE milestone must have a peak (non-taper) phase ending 7-21 days before it.

    The prompt asks for ``基础期 → 进展期 → 赛前期 → 比赛 →（如有）恢复期`` so
    the LLM may emit explicit `比赛` / `减量` / `taper` / `恢复` phases. Picking
    the *latest* phase before race day is wrong: that's the taper / wind-down,
    which ends 0-3 days before the race by design. We want the *peak* phase's
    end_date — that's the boundary where taper starts.

    Strategy: filter out non-peak phases by name keywords, then the latest
    remaining phase IS the peak. Falls back to "all phases" if every phase
    looks taper-like (defensive — catches a degenerate plan where the keyword
    filter would otherwise leave nothing to check).

    Catches:

    * **Peak after race** — no phase ends before race_date.
    * **No taper window** — peak ends < 7 days (no taper) or > 21 days (taper
      too long, fitness decay) before race day.
    """
    race_milestones = [m for m in plan.milestones if m.type == MilestoneType.RACE]
    if not race_milestones:
        return []

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
        if days_to_race < 7 or days_to_race > 21:
            violations.append(
                RuleViolation(
                    rule="peak_before_race",
                    severity="error",
                    message=(
                        f"peak phase ({latest_phase.name!r}) ends {days_to_race} day(s) "
                        f"before race {race.date}; expected 7-21 days (1-3 week taper window)"
                    ),
                    details={
                        "race_date": race.date,
                        "peak_phase_id": latest_phase.id,
                        "peak_phase_end": latest_phase.end_date,
                        "days_between": days_to_race,
                        "taper_phases_present": [
                            p.name for _, p in all_ends_before if _is_non_peak_phase(p.name)
                        ],
                    },
                )
            )
    return violations


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
    """
    violations: list[RuleViolation] = []
    for phase in plan.phases:
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
# Orchestrator
# ---------------------------------------------------------------------------


def run_master_rule_filter(
    plan_dict: dict,
    *,
    target_race: dict | None = None,
    season_window: dict | None = None,
    prs: dict | None = None,
    **_extra: Any,
) -> RuleFilterReport:
    """Run every master-plan rule against ``plan_dict``.

    The schema rule runs first because subsequent checks need a parsed
    ``MasterPlan`` instance. Input-aware rules (``season_window_fits`` /
    ``goal_realism``) accept kwargs from
    :func:`build_generation_graph` → ``rule_filter_kwargs``; missing kwargs
    are silent no-ops so legacy callers don't break.

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
    violations.extend(check_peak_before_race(plan))
    violations.extend(check_phase_duration_balance(plan))
    violations.extend(
        check_season_window_fits(
            plan, season_window=season_window, target_race=target_race
        )
    )
    violations.extend(
        check_goal_realism(plan, target_race=target_race, prs=prs)
    )
    return RuleFilterReport(violations=violations)
