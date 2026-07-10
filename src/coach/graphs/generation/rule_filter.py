"""Pure-Python rule pre-filter — see plan §7.3.

Runs 7 deterministic safety checks against a freshly generated weekly plan
(``WeeklyPlan`` dict from ``stride_core.plan_spec``) before handing off to
the (expensive) Claude reviewer. Any HARD-rule violation routes back to
the generator without burning a reviewer round trip.

This module is intentionally LLM-free: no imports of langchain / anthropic.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date as _date
from typing import Any

from stride_core.plan_spec import WeeklyPlan

#: Canonical week-over-week UP-step cap. The per-week ``check_weekly_progression``
#: gate is the authority every other module must satisfy, so this constant is
#: single-sourced HERE and imported by ``week_schedule`` (the derive ramp that
#: must emit ≤-cap descriptors) and ``season_rule_filter`` (the cross-phase
#: aggregate that re-checks the same boundary) — see M1 in the Stage-3b I1 fix.
#: They cannot drift from the gate they exist to satisfy.
MAX_WEEKLY_RAMP_RATIO = 1.10

# Canonical injury → contraindicated-exercise keyword map. Single-source for any
# code that needs to filter strength moves against logged injuries (e.g. the
# adapter ``specialist_tools.strength_library`` pull tool). Keys are lowercase
# injury flags; values are substrings matched (case-insensitive) against an
# exercise's display name. Do NOT duplicate this map elsewhere — import it.
INJURY_CONTRAINDICATION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "knee": ("squat", "深蹲", "lunge", "弓步"),
    "back": ("deadlift", "硬拉"),
    "ankle": ("plyo", "跳跃"),
}


@dataclass(frozen=True)
class RuleViolation:
    """One rule failure with enough context to feed back to the generator."""

    rule: str
    severity: str  # 'error' (HARD) | 'warning' (soft hint)
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RuleFilterReport:
    violations: list[RuleViolation]

    @property
    def ok(self) -> bool:
        return not any(v.severity == "error" for v in self.violations)

    def errors(self) -> list[RuleViolation]:
        return [v for v in self.violations if v.severity == "error"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run_sessions(plan: WeeklyPlan) -> list:
    return [s for s in plan.sessions if s.kind == "run"]


def _total_run_distance_m(plan: WeeklyPlan) -> float:
    return float(sum((s.total_distance_m or 0) for s in _run_sessions(plan)))


# Legacy pace boundary (≈ 4:30/km) used when no athlete threshold is supplied.
_DEFAULT_Z45_PACE_THRESHOLD_S_KM = 270.0


def _intensity_seconds_in_zones_4_5(
    plan: WeeklyPlan, *, z45_pace_threshold_s_km: float | None = None
) -> float:
    """Sum work-step seconds whose target HR or pace lands in Z4-Z5.

    Heuristic: a work step counts as Z4-Z5 when its target HR ≥ 165, or when
    its pace is at or faster than the Z4-Z5 pace boundary. That boundary is
    the athlete's threshold pace (``z45_pace_threshold_s_km``, in s/km) when
    supplied, so MP/tempo work (slower than threshold = Z3) isn't miscounted
    as high-intensity for a fast runner. When no threshold is given it falls
    back to the legacy 270 s/km (≈ 4:30/km) constant.
    """
    pace_threshold = (
        float(z45_pace_threshold_s_km)
        if z45_pace_threshold_s_km is not None
        else _DEFAULT_Z45_PACE_THRESHOLD_S_KM
    )
    total = 0.0
    for sess in _run_sessions(plan):
        spec = sess.spec
        if spec is None or not getattr(spec, "blocks", None):
            continue
        for block in spec.blocks:
            reps = max(1, getattr(block, "repeat", 1) or 1)
            for step in getattr(block, "steps", []) or []:
                if getattr(step, "step_kind", None) != "work":
                    continue
                tgt = getattr(step, "target", None)
                tgt_kind = getattr(tgt, "kind", None) if tgt else None
                hr_high = getattr(tgt, "high", None) if tgt else None
                pace_low = getattr(tgt, "low", None) if tgt else None
                hot = False
                if tgt_kind == "hr_bpm" and hr_high and hr_high >= 165:
                    hot = True
                elif tgt_kind == "pace_s_km" and pace_low and pace_low <= pace_threshold:
                    hot = True
                if not hot:
                    continue
                dur = getattr(step, "duration", None)
                if dur is None:
                    continue
                if dur.kind == "time_s":
                    total += float(dur.value or 0) * reps
                elif dur.kind == "distance_m" and pace_low:
                    total += float(dur.value or 0) / 1000.0 * float(pace_low) * reps
    return total


def _total_planned_seconds(plan: WeeklyPlan) -> float:
    total = 0.0
    for s in plan.sessions:
        if s.total_duration_s:
            total += float(s.total_duration_s)
    return total


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def check_weekly_progression(
    plan: WeeklyPlan, *, prev_week_km: float | None
) -> list[RuleViolation]:
    """Weekly mileage must be ≤ prev × 1.10 (or 0.6–0.8 for recovery weeks)."""
    if prev_week_km is None or prev_week_km <= 0:
        return []
    cur_km = _total_run_distance_m(plan) / 1000.0
    ratio = cur_km / prev_week_km
    if ratio > MAX_WEEKLY_RAMP_RATIO:
        return [
            RuleViolation(
                rule="weekly_progression",
                severity="error",
                message=(
                    f"weekly mileage jumped {ratio:.2f}x (current {cur_km:.1f}km, "
                    f"previous {prev_week_km:.1f}km); cap is "
                    f"{MAX_WEEKLY_RAMP_RATIO:.2f}x"
                ),
                details={"current_km": cur_km, "previous_km": prev_week_km, "ratio": ratio},
            )
        ]
    return []


def check_weekly_target_volume(
    plan: WeeklyPlan,
    *,
    target_weekly_km: float | None,
    tolerance_km: float = 1.0,
) -> list[RuleViolation]:
    """Weekly running distance must match the injected master-plan target.

    S2 receives a deterministic per-week target from ``master_plan.weeks``. A
    generated week that drifts beyond a small rounding tolerance is no longer
    executing the master skeleton, even if the usual progression and long-run
    share checks still pass.
    """
    if target_weekly_km is None or target_weekly_km <= 0:
        return []
    cur_km = _total_run_distance_m(plan) / 1000.0
    diff = cur_km - float(target_weekly_km)
    if abs(diff) <= tolerance_km:
        return []
    return [
        RuleViolation(
            rule="weekly_target_volume",
            severity="error",
            message=(
                f"weekly mileage {cur_km:.1f}km differs from target "
                f"{float(target_weekly_km):.1f}km by {diff:+.1f}km; "
                f"tolerance is ±{tolerance_km:.1f}km"
            ),
            details={
                "current_km": cur_km,
                "target_km": float(target_weekly_km),
                "diff_km": diff,
                "tolerance_km": tolerance_km,
            },
        )
    ]


def check_long_run_share(plan: WeeklyPlan) -> list[RuleViolation]:
    """Longest run ≤ 35% of weekly mileage.

    Only enforced when there are at least 2 runs in the week — a single-run
    week trivially has share=100% and is a valid taper / off-day pattern,
    not a 80/20 violation.
    """
    runs = [s for s in _run_sessions(plan) if (s.total_distance_m or 0) > 0]
    if len(runs) < 2:
        return []
    total_m = _total_run_distance_m(plan)
    if total_m <= 0:
        return []
    longest = max((s.total_distance_m or 0) for s in runs)
    share = longest / total_m
    if share > 0.35:
        return [
            RuleViolation(
                rule="long_run_share",
                severity="error",
                message=(
                    f"longest run is {share*100:.0f}% of weekly volume (limit 35%)"
                ),
                details={"longest_m": longest, "total_m": total_m, "share": share},
            )
        ]
    return []


def check_intensity_distribution(
    plan: WeeklyPlan, *, z45_pace_threshold_s_km: float | None = None
) -> list[RuleViolation]:
    """Z4-Z5 time ≤ 20% of weekly running time (80/20 polarization rule).

    ``z45_pace_threshold_s_km`` sets the athlete-relative pace boundary
    between Z3 and Z4-Z5 (see :func:`_intensity_seconds_in_zones_4_5`);
    falls back to the legacy 270 s/km constant when omitted.
    """
    total_s = _total_planned_seconds(plan)
    if total_s <= 0:
        return []
    hot_s = _intensity_seconds_in_zones_4_5(
        plan, z45_pace_threshold_s_km=z45_pace_threshold_s_km
    )
    share = hot_s / total_s
    if share > 0.20:
        return [
            RuleViolation(
                rule="intensity_distribution",
                severity="error",
                message=(
                    f"high-intensity (Z4-Z5) time is {share*100:.0f}% of weekly "
                    "duration (limit 20%; 80/20 rule)"
                ),
                details={"hot_seconds": hot_s, "total_seconds": total_s, "share": share},
            )
        ]
    return []


def check_rest_days(plan: WeeklyPlan) -> list[RuleViolation]:
    """At least one full rest day per week."""
    dates_with_work = {
        s.date for s in plan.sessions if s.kind in ("run", "strength", "cross")
    }
    if not dates_with_work:
        return []
    # Walk the 7-day window starting from the min date
    try:
        start = min(_date.fromisoformat(s.date) for s in plan.sessions)
    except (ValueError, TypeError):
        return []
    week_dates = {(start.fromordinal(start.toordinal() + i)).isoformat() for i in range(7)}
    rest_dates = week_dates - dates_with_work
    if not rest_dates:
        return [
            RuleViolation(
                rule="rest_days",
                severity="error",
                message="no full rest day scheduled this week",
            )
        ]
    return []


def check_schema(plan_dict: dict) -> list[RuleViolation]:
    """``WeeklyPlan.from_dict`` must succeed (schema validity)."""
    try:
        WeeklyPlan.from_dict(plan_dict)
        return []
    except Exception as exc:  # noqa: BLE001 — schema-validation boundary
        return [
            RuleViolation(
                rule="schema_validity",
                severity="error",
                message=f"WeeklyPlan.from_dict failed: {type(exc).__name__}: {exc}",
            )
        ]


def check_injury_conflict(
    plan: WeeklyPlan, *, injuries: Iterable[str] | None
) -> list[RuleViolation]:
    """If the profile carries injury flags, refuse to schedule conflicting moves.

    For now we use a small keyword map; future iterations can pull from a
    structured contraindication catalog.
    """
    if not injuries:
        return []
    inj_lower = {i.lower() for i in injuries}
    rules = INJURY_CONTRAINDICATION_KEYWORDS
    violations: list[RuleViolation] = []
    for sess in plan.sessions:
        if sess.kind != "strength" or sess.spec is None:
            continue
        for ex in getattr(sess.spec, "exercises", []) or []:
            name = (ex.display_name or "").lower()
            for inj in inj_lower:
                for token in rules.get(inj, ()):
                    if token in name:
                        violations.append(
                            RuleViolation(
                                rule="injury_conflict",
                                severity="error",
                                message=(
                                    f"strength exercise {ex.display_name!r} "
                                    f"conflicts with logged injury {inj!r}"
                                ),
                                details={
                                    "injury": inj,
                                    "exercise": ex.display_name,
                                    "matched_token": token,
                                    "date": sess.date,
                                },
                            )
                        )
    return violations


def check_ctl_ramp(
    plan: WeeklyPlan, *, prev_ctl: float | None, ramp_cap_tss: float = 6.0
) -> list[RuleViolation]:
    """Estimated CTL increase ≤ 6 TSS/week.

    Rough TSS proxy: weekly running seconds × 100/3600 (i.e. 100 TSS per hour
    of running). Real TSS requires NP/IF; this proxy is good enough to catch
    egregious volume jumps.
    """
    if prev_ctl is None:
        return []
    total_s = _total_planned_seconds(plan)
    tss_proxy = total_s * 100.0 / 3600.0
    # CTL is a 42-day EWMA; one new week shifts CTL by ≈ tss / 42
    new_ctl_delta = tss_proxy / 42.0
    if new_ctl_delta > ramp_cap_tss:
        return [
            RuleViolation(
                rule="ctl_ramp",
                severity="error",
                message=(
                    f"estimated CTL increase {new_ctl_delta:.1f} TSS exceeds "
                    f"cap {ramp_cap_tss:.1f}"
                ),
                details={"estimated_tss": tss_proxy, "ctl_delta": new_ctl_delta},
            )
        ]
    return []


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_rule_filter(
    plan_dict: dict,
    *,
    prev_week_km: float | None = None,
    target_weekly_km: float | None = None,
    prev_ctl: float | None = None,
    injuries: Iterable[str] | None = None,
    ramp_cap_tss: float = 6.0,
    z45_pace_threshold_s_km: float | None = None,
    **_extra: Any,
) -> RuleFilterReport:
    """Run every rule against ``plan_dict``; the schema rule runs first because
    later checks need a parsed ``WeeklyPlan``.

    ``z45_pace_threshold_s_km`` (athlete threshold pace, s/km) is threaded
    into the intensity-distribution check so MP/tempo work isn't miscounted
    as Z4-Z5 for fast runners. Callers pass it via ``rule_filter_kwargs``;
    when omitted the check uses the legacy 270 s/km constant.
    """
    violations: list[RuleViolation] = []
    violations.extend(check_schema(plan_dict))
    if violations:
        return RuleFilterReport(violations=violations)
    plan = WeeklyPlan.from_dict(plan_dict)
    violations.extend(check_weekly_progression(plan, prev_week_km=prev_week_km))
    violations.extend(
        check_weekly_target_volume(plan, target_weekly_km=target_weekly_km)
    )
    violations.extend(check_long_run_share(plan))
    violations.extend(
        check_intensity_distribution(
            plan, z45_pace_threshold_s_km=z45_pace_threshold_s_km
        )
    )
    violations.extend(check_rest_days(plan))
    violations.extend(check_injury_conflict(plan, injuries=injuries))
    violations.extend(check_ctl_ramp(plan, prev_ctl=prev_ctl, ramp_cap_tss=ramp_cap_tss))
    return RuleFilterReport(violations=violations)
