"""Master plan rule filter — see ``docs/coach-eval_S1.md`` § S1 L1 Rules.

v1 implements 3 critical rules:

* ``master_schema_validity``: ``MasterPlan.model_validate`` must pass.
* ``phase_count_min``: at least 3 phases (base / build / peak typical).
* ``peak_before_race``: if any RACE milestone exists, the phase ending closest
  before the race must finish within 7-21 days of race_date (1-3 week taper).

The remaining 7 rules (``phase_duration_balance`` / ``weekly_volume_ramp`` /
``taper_present`` / ``target_distance_consistency`` / ``frequency_respects_max``
/ ``season_window_fits`` / ``goal_realism``) are deferred to a follow-up PR —
see ``docs/coach-eval_S1.md`` Phase 1 Roadmap.

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


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_master_rule_filter(plan_dict: dict, **_kwargs: Any) -> RuleFilterReport:
    """Run every master-plan rule against ``plan_dict``.

    The schema rule runs first because subsequent checks need a parsed
    ``MasterPlan`` instance. Accepts arbitrary ``**_kwargs`` to match the
    ``RuleFilterFn`` signature in :func:`build_generation_graph` — callers
    may pass ``target_race`` / ``season_window`` for v1.1 rules that aren't
    implemented yet; they're silently ignored.
    """
    violations: list[RuleViolation] = []
    violations.extend(check_master_schema_validity(plan_dict))
    if violations:
        # Schema failure — downstream checks need a parsed MasterPlan; bail.
        return RuleFilterReport(violations=violations)
    plan = MasterPlan.model_validate(plan_dict)
    violations.extend(check_phase_count_min(plan))
    violations.extend(check_peak_before_race(plan))
    return RuleFilterReport(violations=violations)
