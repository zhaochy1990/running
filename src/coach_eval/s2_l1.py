"""S2 weekly-plan deterministic eval rules.

This wraps the production weekly ``run_rule_filter`` with fixture-specific
offline-eval checks. The extra checks are deliberately dev-only: they validate
that a generated week honored the frozen fixture envelope (target dates,
target week folder, nutrition coverage, and expected safety constraints)
without changing production generation behavior while S2 eval is still being
calibrated.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta
from typing import Any

from coach.graphs.generation.rule_filter import RuleFilterReport, RuleViolation, run_rule_filter
from stride_core.plan_spec import WeeklyPlan


def run_s2_l1_filter(plan_dict: dict, *, fixture: dict) -> RuleFilterReport:
    """Run production weekly rules plus S2 fixture-specific hard constraints."""
    input_data = fixture.get("input") or {}
    profile = input_data.get("user_profile") or {}
    signals = input_data.get("recent_signals") or {}
    expected = fixture.get("expected") or {}
    hard = expected.get("hard_constraints") or {}

    prev_week_km = _first_number(
        hard.get("prev_week_km"),
        signals.get("prev_week_km"),
        _last_prev_week_km(input_data.get("prev_plans_md") or []),
    )
    prev_ctl = _first_number(hard.get("prev_ctl"), signals.get("ctl"))
    z45 = _first_number(
        hard.get("z45_pace_threshold_s_km"),
        profile.get("threshold_pace_s_km"),
        (input_data.get("pace_targets") or {}).get("threshold_pace_s_km"),
    )
    injuries = profile.get("injuries") or []
    ramp_cap_tss = _first_number(hard.get("ramp_cap_tss"), 6.0) or 6.0

    base_report = run_rule_filter(
        plan_dict,
        prev_week_km=prev_week_km,
        prev_ctl=prev_ctl,
        injuries=injuries,
        ramp_cap_tss=ramp_cap_tss,
        z45_pace_threshold_s_km=z45,
    )
    violations = list(base_report.violations)
    if not base_report.ok:
        return RuleFilterReport(violations=violations)

    plan = WeeklyPlan.from_dict(plan_dict)
    violations.extend(_check_target_week(plan, input_data, hard))
    violations.extend(_check_target_volume(plan, input_data, hard))
    violations.extend(_check_nutrition_coverage(plan, input_data, hard))
    violations.extend(_check_run_frequency(plan, hard))
    violations.extend(_check_hard_session_count(plan, input_data, hard, z45))
    violations.extend(_check_bad_signal_response(plan, input_data, hard, z45))
    violations.extend(_check_required_note_tokens(plan, hard))
    return RuleFilterReport(violations=violations)


def s2_rule_filter_kwargs(fixture: dict) -> dict[str, Any]:
    """Return kwargs suitable for ``build_generation_graph(rule_filter=run_s2_l1_filter)``."""
    return {"fixture": fixture}


def _first_number(*values: Any) -> float | None:
    for value in values:
        if value is None or isinstance(value, bool):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _last_prev_week_km(prev_plans_md: list[Any]) -> float | None:
    """Best-effort extraction from hand-written fixture notes.

    Fixtures should prefer ``recent_signals.prev_week_km`` or
    ``expected.hard_constraints.prev_week_km``. This fallback accepts simple
    text snippets such as ``prev_week_km: 56`` for draft fixtures.
    """
    import re

    for text in reversed(prev_plans_md):
        if not isinstance(text, str):
            continue
        match = re.search(r"prev_week_km\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)", text)
        if match:
            return float(match.group(1))
    return None


def _week_dates(start_iso: str | None) -> set[str]:
    if not start_iso:
        return set()
    try:
        start = date.fromisoformat(str(start_iso))
    except ValueError:
        return set()
    return {(start + timedelta(days=i)).isoformat() for i in range(7)}


def _total_run_km(plan: WeeklyPlan) -> float:
    return sum(
        float(session.total_distance_m or 0.0) / 1000.0
        for session in plan.sessions
        if session.kind == "run"
    )


def _run_sessions(plan: WeeklyPlan) -> list[Any]:
    return [session for session in plan.sessions if session.kind == "run"]


def _session_text(session: Any) -> str:
    return " ".join(
        str(part or "") for part in (session.summary, getattr(session, "notes_md", None))
    ).lower()


def _hard_session_count(plan: WeeklyPlan, z45_pace_threshold_s_km: float | None) -> int:
    count = 0
    hot_tokens = (
        "threshold", "阈值", "tempo", "节奏", "vo2", "interval", "间歇",
        "hmp", "5k pace", "10k pace", "race pace", "比赛配速",
    )
    threshold = float(z45_pace_threshold_s_km or 270.0)
    for session in _run_sessions(plan):
        text = _session_text(session)
        if any(token in text for token in hot_tokens):
            count += 1
            continue
        spec = session.spec
        if spec is None or not getattr(spec, "blocks", None):
            continue
        found = False
        for block in spec.blocks:
            for step in getattr(block, "steps", []) or []:
                if getattr(step, "step_kind", None) != "work":
                    continue
                target = getattr(step, "target", None)
                if target is None:
                    continue
                if target.kind == "hr_bpm" and target.high and target.high >= 165:
                    found = True
                if target.kind == "pace_s_km" and target.low and target.low <= threshold:
                    found = True
        if found:
            count += 1
    return count


def _check_target_week(
    plan: WeeklyPlan, input_data: dict, hard: dict
) -> list[RuleViolation]:
    violations: list[RuleViolation] = []
    expected_folder = hard.get("week_folder") or input_data.get("week_folder")
    if expected_folder and plan.week_folder != expected_folder:
        violations.append(RuleViolation(
            rule="week_folder_match",
            severity="error",
            message=(
                f"plan.week_folder {plan.week_folder!r} does not match fixture "
                f"week_folder {expected_folder!r}"
            ),
            details={"expected": expected_folder, "actual": plan.week_folder},
        ))

    allowed_dates = _week_dates(
        hard.get("target_week_start") or input_data.get("target_week_start")
    )
    if not allowed_dates:
        return violations
    bad_session_dates = sorted({s.date for s in plan.sessions if s.date not in allowed_dates})
    bad_nutrition_dates = sorted({n.date for n in plan.nutrition if n.date not in allowed_dates})
    if bad_session_dates or bad_nutrition_dates:
        violations.append(RuleViolation(
            rule="dates_within_target_week",
            severity="error",
            message="sessions/nutrition must all fall within target week",
            details={
                "allowed_dates": sorted(allowed_dates),
                "bad_session_dates": bad_session_dates,
                "bad_nutrition_dates": bad_nutrition_dates,
            },
        ))
    return violations


def _check_target_volume(
    plan: WeeklyPlan, input_data: dict, hard: dict
) -> list[RuleViolation]:
    target = _first_number(
        hard.get("target_weekly_km"),
        input_data.get("target_weekly_km"),
        (input_data.get("week_meta") or {}).get("target_weekly_km"),
    )
    if target is None or target <= 0:
        return []
    tolerance = _first_number(hard.get("weekly_km_tolerance_pct"), 0.08) or 0.08
    current = _total_run_km(plan)
    lower = target * (1.0 - tolerance)
    upper = target * (1.0 + tolerance)
    if current < lower or current > upper:
        return [RuleViolation(
            rule="target_weekly_volume",
            severity="error",
            message=(
                f"weekly run volume {current:.1f}km is outside target "
                f"{target:.1f}km ± {tolerance * 100:.0f}%"
            ),
            details={"current_km": current, "target_km": target, "tolerance_pct": tolerance},
        )]
    return []


def _check_nutrition_coverage(
    plan: WeeklyPlan, input_data: dict, hard: dict
) -> list[RuleViolation]:
    required = hard.get("nutrition_daily")
    if required is None:
        required = True
    if required is False:
        return []
    allowed_dates = _week_dates(
        hard.get("target_week_start") or input_data.get("target_week_start")
    )
    if not allowed_dates:
        return []
    nutrition_dates = {item.date for item in plan.nutrition}
    missing = sorted(allowed_dates - nutrition_dates)
    if missing:
        return [RuleViolation(
            rule="nutrition_daily_coverage",
            severity="error",
            message="nutrition list must include one entry for every day of the target week",
            details={"missing_dates": missing},
        )]
    return []


def _check_run_frequency(plan: WeeklyPlan, hard: dict) -> list[RuleViolation]:
    min_runs = hard.get("min_run_days")
    max_runs = hard.get("max_run_days")
    run_days = {session.date for session in _run_sessions(plan)}
    violations: list[RuleViolation] = []
    if isinstance(min_runs, int) and len(run_days) < min_runs:
        violations.append(RuleViolation(
            rule="min_run_days",
            severity="error",
            message=f"scheduled {len(run_days)} run day(s), below minimum {min_runs}",
            details={"run_days": sorted(run_days), "min_run_days": min_runs},
        ))
    if isinstance(max_runs, int) and len(run_days) > max_runs:
        violations.append(RuleViolation(
            rule="max_run_days",
            severity="error",
            message=f"scheduled {len(run_days)} run day(s), above maximum {max_runs}",
            details={"run_days": sorted(run_days), "max_run_days": max_runs},
        ))
    return violations


def _check_hard_session_count(
    plan: WeeklyPlan,
    input_data: dict,
    hard: dict,
    z45_pace_threshold_s_km: float | None,
) -> list[RuleViolation]:
    max_hard = hard.get("max_hard_sessions")
    if not isinstance(max_hard, int):
        return []
    count = _hard_session_count(plan, z45_pace_threshold_s_km)
    if count > max_hard:
        return [RuleViolation(
            rule="hard_session_count",
            severity="error",
            message=f"scheduled {count} hard run session(s), cap is {max_hard}",
            details={"hard_sessions": count, "max_hard_sessions": max_hard},
        )]
    return []


def _check_bad_signal_response(
    plan: WeeklyPlan,
    input_data: dict,
    hard: dict,
    z45_pace_threshold_s_km: float | None,
) -> list[RuleViolation]:
    if not _fixture_has_bad_recovery_signal(input_data, hard):
        return []
    max_hard = hard.get("max_hard_sessions_when_bad_signals")
    if not isinstance(max_hard, int):
        max_hard = 1
    count = _hard_session_count(plan, z45_pace_threshold_s_km)
    if count > max_hard:
        return [RuleViolation(
            rule="signal_response_hard_sessions",
            severity="error",
            message=(
                f"bad recovery signals permit at most {max_hard} hard run "
                f"session(s), got {count}"
            ),
            details={"hard_sessions": count, "max_hard_sessions_when_bad_signals": max_hard},
        )]
    return []


def _fixture_has_bad_recovery_signal(input_data: dict, hard: dict) -> bool:
    if hard.get("bad_recovery_signal") is True:
        return True
    signals = input_data.get("recent_signals") or {}
    hrv = _numeric_series(signals.get("hrv_7d"))
    rhr = _numeric_series(signals.get("rhr_7d"))
    sleep = _numeric_series(signals.get("sleep_score_7d"))
    if len(hrv) >= 5 and hrv[-1] <= hrv[0] * 0.92:
        return True
    if len(rhr) >= 5 and rhr[-1] >= rhr[0] + 5:
        return True
    if len(sleep) >= 5 and sleep[-1] <= 65 and sleep[-1] <= sleep[0] - 10:
        return True
    atl = _first_number(signals.get("atl"))
    ctl = _first_number(signals.get("ctl"))
    if atl is not None and ctl is not None and ctl > 0 and atl / ctl > 1.25:
        return True
    return False


def _numeric_series(value: Any) -> list[float]:
    if not isinstance(value, list):
        return []
    out: list[float] = []
    for item in value:
        number = _first_number(item)
        if number is not None:
            out.append(number)
    return out


def _check_required_note_tokens(plan: WeeklyPlan, hard: dict) -> list[RuleViolation]:
    tokens = hard.get("required_note_tokens")
    if not isinstance(tokens, list) or not tokens:
        return []
    haystack = "\n".join(
        [str(plan.notes_md or "")]
        + [str(s.summary or "") + "\n" + str(s.notes_md or "") for s in plan.sessions]
        + [str(n.notes_md or "") for n in plan.nutrition]
    ).lower()
    missing = [str(token) for token in tokens if str(token).lower() not in haystack]
    if missing:
        return [RuleViolation(
            rule="required_note_tokens",
            severity="error",
            message="generated plan is missing required explanatory token(s)",
            details={"missing_tokens": missing},
        )]
    return []
