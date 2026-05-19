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
    """At least ``min_count`` phases — typical periodisation needs base / build / peak."""
    count = len(plan.phases)
    if count < min_count:
        return [
            RuleViolation(
                rule="phase_count_min",
                severity="error",
                message=f"only {count} phase(s); need at least {min_count}",
                details={"count": count, "min_required": min_count},
            )
        ]
    return []


def check_peak_before_race(plan: MasterPlan) -> list[RuleViolation]:
    """RACE milestone must have a phase ending 7-21 days before it.

    Catches two failure modes:

    * **Peak after race** — no phase ends before race_date (LLM accidentally
      put peak phase _after_ the race milestone).
    * **No taper window** — the last phase before race ends < 7 days (no time
      to taper) or > 21 days (taper too long, fitness decay) from race day.
    """
    race_milestones = [m for m in plan.milestones if m.type == MilestoneType.RACE]
    if not race_milestones:
        return []  # rule only applies when a race exists

    violations: list[RuleViolation] = []
    for race in race_milestones:
        try:
            race_date = _date.fromisoformat(race.date)
        except (ValueError, TypeError):
            continue  # malformed milestone date — schema rule should have caught

        # Phases that end before race date
        ends_before: list[tuple[_date, Any]] = []
        for phase in plan.phases:
            try:
                end = _date.fromisoformat(phase.end_date)
            except (ValueError, TypeError):
                continue
            if end < race_date:
                ends_before.append((end, phase))

        if not ends_before:
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

        latest_end, latest_phase = max(ends_before, key=lambda t: t[0])
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
