"""Master-plan training-load estimation for S1 generation and Coach tools.

This module is adapter-layer by design: it consumes DB-derived history payloads
and ``MasterPlan``-shaped drafts, then projects the S1 weekly skeleton onto the
same TSS-like planned-load scale used by ``stride_core.training_load``. The core
``coach.*`` package stays DB-free; callers pass the resulting dict into prompts,
tools, or rule-filter feedback.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from statistics import mean, median
from typing import Any

from stride_core.training_load import estimate_planned_run_load
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
)


def _round(value: float | None, ndigits: int = 1) -> float | None:
    if value is None:
        return None
    return round(float(value), ndigits)


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _truthy_week_km(week: Mapping[str, Any]) -> float:
    km = _float(week.get("distance_km"))
    return km if km is not None else 0.0


def _active_history_weeks(history: Mapping[str, Any]) -> list[dict[str, Any]]:
    weeks = history.get("weekly_profile") or []
    active: list[dict[str, Any]] = []
    for raw in weeks:
        if not isinstance(raw, Mapping):
            continue
        km = _truthy_week_km(raw)
        n_runs = int(raw.get("n_runs") or 0)
        if km > 0 or n_runs > 0:
            active.append(dict(raw))
    return active


def build_training_history_load_anchor(history: Mapping[str, Any] | None) -> dict[str, Any]:
    """Derive a robust historical load anchor from ``_query_history`` output.

    Active weeks only are used for averages so zero rows from watch gaps do not
    make an experienced athlete look detrained. The primary km anchor is the
    recent active-week median; it is intentionally robust to one taper or travel
    week while still reflecting the athlete's normal training level.
    """
    history = history or {}
    active = _active_history_weeks(history)
    distances = [_truthy_week_km(w) for w in active if _truthy_week_km(w) > 0]
    doses = [float(w["dose"]) for w in active if _float(w.get("dose")) is not None and float(w["dose"]) > 0]
    recent_last4 = distances[-4:]
    dose_last4 = doses[-4:]

    total_km = sum(distances)
    total_hours = sum(float(w.get("hours") or 0.0) for w in active)
    avg_pace_s_km = (total_hours * 3600.0 / total_km) if total_km > 0 and total_hours > 0 else None
    avg_runs = (
        sum(int(w.get("n_runs") or 0) for w in active) / len(active)
        if active
        else 0.0
    )

    history_peak = max(
        [_float(history.get("max_weekly_km")) or 0.0, *(distances or [0.0])]
    )
    recent_avg = mean(distances) if distances else None
    recent_median = median(distances) if distances else None
    distance_anchor = recent_median if recent_median is not None else recent_avg
    dose_anchor = median(doses) if doses else None

    advanced = bool(
        len(active) >= 8
        and distance_anchor is not None
        and (distance_anchor >= 70.0 or history_peak >= 100.0 or avg_runs >= 5.0)
    )

    return {
        "history_active_weeks": len(active),
        "recent_avg_weekly_km": _round(recent_avg),
        "recent_median_weekly_km": _round(recent_median),
        "recent_last4_avg_weekly_km": _round(mean(recent_last4) if recent_last4 else None),
        "recent_peak_weekly_km": _round(max(distances) if distances else None),
        "history_peak_weekly_km": _round(history_peak),
        "distance_anchor_km": _round(distance_anchor),
        "recent_avg_weekly_dose": _round(mean(doses) if doses else None),
        "recent_median_weekly_dose": _round(dose_anchor),
        "recent_last4_avg_weekly_dose": _round(mean(dose_last4) if dose_last4 else None),
        "recent_peak_weekly_dose": _round(max(doses) if doses else None),
        "dose_anchor": _round(dose_anchor),
        "avg_runs_per_active_week": _round(avg_runs),
        "avg_pace_s_km": _round(avg_pace_s_km, 0),
        "advanced_history": advanced,
    }


def format_training_load_anchor_for_prompt(anchor: Mapping[str, Any] | None) -> str:
    """Compact user-turn text for the generator prompt."""
    if not anchor or not anchor.get("history_active_weeks"):
        return "Training-load estimator tool: insufficient recent active-week history."
    def val(key: str, suffix: str = "") -> str:
        item = anchor.get(key)
        return "n/a" if item is None else f"{item}{suffix}"

    parts = [
        "Training-load estimator tool (use as the volume/load anchor; no fixed race-distance cap):",
        f"active_weeks={anchor.get('history_active_weeks')}",
        f"km_anchor={val('distance_anchor_km', 'km')}",
        f"recent_avg/median={val('recent_avg_weekly_km')}/{val('recent_median_weekly_km')}km",
        f"last4_avg={val('recent_last4_avg_weekly_km', 'km')}",
        f"history_peak={val('history_peak_weekly_km', 'km')}",
        f"dose_anchor={val('dose_anchor')}",
        f"runs_per_active_week={val('avg_runs_per_active_week')}",
    ]
    return "; ".join(parts)


def _normalise_distance(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("_", "")
    aliases = {
        "halfmarathon": "hm",
        "half_marathon": "hm",
        "fullmarathon": "fm",
        "full_marathon": "fm",
        "marathon": "fm",
        "5km": "5k",
        "10km": "10k",
    }
    return aliases.get(raw, raw)


def _extract_weeks(plan: Any) -> list[Any]:
    if plan is None:
        return []
    if isinstance(plan, Mapping) and isinstance(plan.get("plan"), Mapping):
        plan = plan["plan"]
    weeks = _get(plan, "weekly_key_sessions") or _get(plan, "weeks") or []
    return list(weeks) if isinstance(weeks, Iterable) and not isinstance(weeks, (str, bytes, Mapping)) else []


def _extract_goal_distance(plan: Any, target_race: Mapping[str, Any] | None = None) -> str:
    if target_race and target_race.get("distance"):
        return _normalise_distance(target_race.get("distance"))
    goal = _get(plan, "goal") or {}
    if isinstance(goal, Mapping):
        return _normalise_distance(goal.get("distance"))
    return _normalise_distance(_get(goal, "distance"))


def _session_type(session: Any) -> str:
    return str(_get(session, "type", "") or "").lower()


def _session_distance_km(session: Any) -> float | None:
    return _float(_get(session, "distance_km"))


def _session_duration_min(session: Any) -> float | None:
    return _float(_get(session, "duration_min"))


def _is_deload_week(week: Mapping[str, Any]) -> bool:
    return bool(week.get("is_recovery_week") or week.get("is_taper_week"))


def _session_intensity_factor(session: Any, race_distance: str) -> float:
    stype = _session_type(session)
    text = " ".join(
        str(_get(session, key, "") or "")
        for key in ("intensity", "purpose", "note")
    ).lower()
    if stype in {"strength_key", "strength"}:
        return 0.0
    if stype in {"interval", "vo2max", "time_trial", "race"}:
        return 1.05 if stype != "vo2max" else 1.08
    if stype == "threshold":
        return 0.98
    if stype in {"tempo", "hill"}:
        return 0.90 if stype == "tempo" else 0.95
    if stype in {"race_pace", "tune_up_race"}:
        if race_distance in {"5k", "10k"}:
            return 1.02
        if race_distance == "hm":
            return 0.94
        return 0.90
    if stype == "long_run":
        if any(token in text for token in ("mp", "hmp", "rp", "比赛配速", "马拉松配速", "半马配速")):
            return 0.88 if race_distance == "fm" else 0.92
        return 0.78
    return 0.82


def _estimate_step_dose(*, minutes: float, intensity_factor: float) -> float:
    if minutes <= 0 or intensity_factor <= 0:
        return 0.0
    # threshold_speed_mps=1.0 makes target pace encode IF directly:
    # speed/threshold_speed = IF.
    pace_s_km = 1000.0 / max(intensity_factor, 0.01)
    step = WorkoutStep(
        step_kind=StepKind.WORK,
        duration=Duration.of_time_min(minutes),
        target=Target.pace_range_s_km(pace_s_km, pace_s_km),
    )
    workout = NormalizedRunWorkout(
        name="master-plan-load-estimate",
        date="2026-01-01",
        blocks=(WorkoutBlock(steps=(step,)),),
    )
    return float(estimate_planned_run_load(workout, threshold_speed_mps=1.0) or 0.0)


def _estimate_run_dose(*, km: float | None, duration_min: float | None, pace_s_km: float, intensity_factor: float) -> float:
    if duration_min is None:
        if km is None or km <= 0:
            return 0.0
        duration_min = km * pace_s_km / 60.0
    return _estimate_step_dose(minutes=duration_min, intensity_factor=intensity_factor)


def estimate_master_plan_training_load(
    plan: Any,
    *,
    history_anchor: Mapping[str, Any] | None = None,
    target_race: Mapping[str, Any] | None = None,
    weekly_run_days_max: int | None = None,
    injuries: list[str] | None = None,
) -> dict[str, Any]:
    """Estimate planned weekly km and STRIDE dose from an S1 skeleton."""
    anchor = dict(history_anchor or {})
    pace_s_km = float(anchor.get("avg_pace_s_km") or 300.0)
    baseline_km = _float(anchor.get("distance_anchor_km"))
    baseline_dose = _float(anchor.get("dose_anchor"))
    easy_raw_dose_per_km = _estimate_run_dose(
        km=1.0,
        duration_min=None,
        pace_s_km=pace_s_km,
        intensity_factor=0.78,
    )
    dose_scale = 1.0
    if baseline_km and baseline_dose and easy_raw_dose_per_km > 0:
        dose_scale = baseline_dose / (baseline_km * easy_raw_dose_per_km)
    race_distance = _extract_goal_distance(plan, target_race)
    weeks_out: list[dict[str, Any]] = []
    for week in _extract_weeks(plan):
        high = _float(_get(week, "target_weekly_km_high")) or 0.0
        is_recovery = bool(_get(week, "is_recovery_week", False))
        is_taper = bool(_get(week, "is_taper_week", False))
        sessions = _get(week, "key_sessions", []) or []
        key_km = 0.0
        key_dose = 0.0
        long_run_km = 0.0
        long_run_dose = 0.0
        for session in sessions:
            stype = _session_type(session)
            if stype in {"strength_key", "strength"}:
                continue
            km = _session_distance_km(session)
            duration = _session_duration_min(session)
            if km is not None:
                key_km += max(0.0, km)
            intensity = _session_intensity_factor(session, race_distance)
            session_dose = _estimate_run_dose(
                km=km,
                duration_min=duration,
                pace_s_km=pace_s_km,
                intensity_factor=intensity,
            )
            key_dose += session_dose
            if stype == "long_run":
                long_run_km = max(long_run_km, max(0.0, km or 0.0))
                long_run_dose = max(long_run_dose, session_dose)
        remaining_easy_km = max(0.0, high - key_km)
        easy_dose = _estimate_run_dose(
            km=remaining_easy_km,
            duration_min=None,
            pace_s_km=pace_s_km,
            intensity_factor=0.78,
        )
        raw_total_dose = key_dose + easy_dose
        total_dose = raw_total_dose * dose_scale
        weeks_out.append({
            "week_index": _get(week, "week_index"),
            "week_start": _get(week, "week_start"),
            "target_weekly_km_high": _round(high),
            "estimated_dose": _round(total_dose),
            "estimated_raw_tss": _round(raw_total_dose),
            "key_session_km": _round(key_km),
            "remaining_easy_km": _round(remaining_easy_km),
            "long_run_km": _round(long_run_km),
            "long_run_dose": _round(long_run_dose * dose_scale),
            "key_session_km_ratio": _round(key_km / high if high > 0 else None, 2),
            "long_run_km_ratio": _round(long_run_km / high if high > 0 else None, 2),
            "long_run_dose_ratio": _round((long_run_dose * dose_scale) / total_dose if total_dose > 0 else None, 2),
            "is_recovery_week": is_recovery,
            "is_taper_week": is_taper,
        })

    load_weeks = [w for w in weeks_out if not _is_deload_week(w) and (w["target_weekly_km_high"] or 0) > 0]
    first4 = load_weeks[:4]
    km_values = [float(w["target_weekly_km_high"] or 0.0) for w in load_weeks]
    dose_values = [float(w["estimated_dose"] or 0.0) for w in load_weeks]
    summary = {
        "planned_week_count": len(weeks_out),
        "load_week_count": len(load_weeks),
        "first4_load_avg_km": _round(mean([float(w["target_weekly_km_high"] or 0.0) for w in first4]) if first4 else None),
        "avg_load_week_km": _round(mean(km_values) if km_values else None),
        "peak_weekly_km": _round(max(km_values) if km_values else None),
        "peak_long_run_km": _round(max((float(w["long_run_km"] or 0.0) for w in load_weeks), default=0.0) if load_weeks else None),
        "max_long_run_km_ratio": _round(max((float(w["long_run_km_ratio"] or 0.0) for w in load_weeks), default=0.0) if load_weeks else None, 2),
        "max_long_run_dose_ratio": _round(max((float(w["long_run_dose_ratio"] or 0.0) for w in load_weeks), default=0.0) if load_weeks else None, 2),
        "max_key_session_km_ratio": _round(max((float(w["key_session_km_ratio"] or 0.0) for w in load_weeks), default=0.0) if load_weeks else None, 2),
        "first4_load_avg_dose": _round(mean([float(w["estimated_dose"] or 0.0) for w in first4]) if first4 else None),
        "avg_load_week_dose": _round(mean(dose_values) if dose_values else None),
        "peak_weekly_dose": _round(max(dose_values) if dose_values else None),
    }
    summary["dose_scale"] = _round(dose_scale, 3)
    if baseline_km:
        for key in ("first4_load_avg_km", "avg_load_week_km", "peak_weekly_km"):
            summary[f"{key}_ratio_to_anchor"] = _round((_float(summary.get(key)) or 0.0) / baseline_km, 2)
    if baseline_dose:
        for key in ("first4_load_avg_dose", "avg_load_week_dose", "peak_weekly_dose"):
            summary[f"{key}_ratio_to_anchor"] = _round((_float(summary.get(key)) or 0.0) / baseline_dose, 2)

    alignment = evaluate_master_plan_load_alignment(
        plan_summary=summary,
        history_anchor=anchor,
        weeks=weeks_out,
        target_race=target_race,
        weekly_run_days_max=weekly_run_days_max,
        injuries=injuries,
    )
    return {
        "history_anchor": anchor,
        "plan_summary": summary,
        "weeks": weeks_out,
        "alignment": alignment,
    }


def _has_injury_or_gap(injuries: list[str] | None) -> bool:
    text = " ".join(str(i) for i in injuries or []).lower()
    return any(token in text for token in ("injury", "pain", "rehab", "return", "伤", "痛", "康复", "复跑", "停训"))


def evaluate_master_plan_load_alignment(
    *,
    plan_summary: Mapping[str, Any],
    history_anchor: Mapping[str, Any],
    weeks: Iterable[Mapping[str, Any]] | None = None,
    target_race: Mapping[str, Any] | None = None,
    weekly_run_days_max: int | None = None,
    injuries: list[str] | None = None,
) -> dict[str, Any]:
    """Return under/over-load issues for rule-filter feedback."""
    issues: list[dict[str, Any]] = []
    baseline_km = _float(history_anchor.get("distance_anchor_km"))
    history_peak = _float(history_anchor.get("history_peak_weekly_km"))
    baseline_dose = _float(history_anchor.get("dose_anchor"))
    active_weeks = int(history_anchor.get("history_active_weeks") or 0)
    distance = _normalise_distance((target_race or {}).get("distance"))
    high_history = bool(history_anchor.get("advanced_history"))
    run_days_ok = weekly_run_days_max is None or weekly_run_days_max >= 5
    injury_or_gap = _has_injury_or_gap(injuries)
    has_history_anchor = bool(baseline_km and active_weeks >= 4)

    first4 = _float(plan_summary.get("first4_load_avg_km"))
    peak = _float(plan_summary.get("peak_weekly_km"))
    avg = _float(plan_summary.get("avg_load_week_km"))
    first4_dose = _float(plan_summary.get("first4_load_avg_dose"))
    peak_dose = _float(plan_summary.get("peak_weekly_dose"))
    load_weeks = [dict(w) for w in (weeks or []) if not _is_deload_week(w) and (_float(w.get("target_weekly_km_high")) or 0.0) > 0]

    if has_history_anchor and high_history and run_days_ok and distance in {"hm", "fm"} and not injury_or_gap:
        if first4 is not None and first4 < baseline_km * 0.75:
            issues.append({
                "kind": "underload_start",
                "severity": "error",
                "message": (
                    f"first 4 active load weeks average {first4:.0f}km, only "
                    f"{first4 / baseline_km:.0%} of the historical active-week "
                    f"anchor {baseline_km:.0f}km; use the load-estimator tool "
                    "anchor and regenerate near the athlete's actual level unless "
                    "there is an explicit injury/recovery reason"
                ),
                "details": {"first4_load_avg_km": first4, "distance_anchor_km": baseline_km},
            })
        if peak is not None and peak < baseline_km * 0.85:
            issues.append({
                "kind": "underload_peak",
                "severity": "error",
                "message": (
                    f"planned peak {peak:.0f}km is below 85% of historical "
                    f"active-week anchor {baseline_km:.0f}km; this is a major "
                    "downshift for a high-history HM/FM runner"
                ),
                "details": {"peak_weekly_km": peak, "distance_anchor_km": baseline_km},
            })
        if baseline_dose and peak_dose is not None and peak_dose < baseline_dose * 0.75 and (peak or 0) < baseline_km * 0.95:
            issues.append({
                "kind": "underload_dose",
                "severity": "error",
                "message": (
                    f"planned peak dose {peak_dose:.0f} is below 75% of historical "
                    f"dose anchor {baseline_dose:.0f}; planned km is also below "
                    "the history anchor"
                ),
                "details": {"peak_weekly_dose": peak_dose, "dose_anchor": baseline_dose},
            })

    if has_history_anchor and history_peak and peak is not None and peak > history_peak * 1.10 + 5.0:
        issues.append({
            "kind": "overload_peak",
            "severity": "error",
            "message": (
                f"planned peak {peak:.0f}km exceeds historical peak {history_peak:.0f}km "
                "by more than a controlled progression buffer; regenerate with "
                "load growth tied to history rather than an unproven volume record"
            ),
            "details": {"peak_weekly_km": peak, "history_peak_weekly_km": history_peak},
        })
    if has_history_anchor and baseline_km and avg is not None and not injury_or_gap and avg > baseline_km * 1.30:
        issues.append({
            "kind": "overload_average",
            "severity": "error",
            "message": (
                f"average load-week volume {avg:.0f}km is >130% of historical "
                f"anchor {baseline_km:.0f}km; ramp the cycle more gradually"
            ),
            "details": {"avg_load_week_km": avg, "distance_anchor_km": baseline_km},
        })

    long_run_km_limit = 0.60 if weekly_run_days_max is not None and weekly_run_days_max <= 3 else 0.50
    long_run_dose_limit = 0.65 if weekly_run_days_max is not None and weekly_run_days_max <= 3 else 0.55
    if injury_or_gap:
        long_run_km_limit = max(long_run_km_limit, 0.55)
        long_run_dose_limit = max(long_run_dose_limit, 0.60)
    concentrated = [
        w for w in load_weeks
        if (_float(w.get("long_run_km_ratio")) or 0.0) > long_run_km_limit
        or (_float(w.get("long_run_dose_ratio")) or 0.0) > long_run_dose_limit
    ]
    if concentrated:
        worst = max(
            concentrated,
            key=lambda w: max(
                _float(w.get("long_run_km_ratio")) or 0.0,
                _float(w.get("long_run_dose_ratio")) or 0.0,
            ),
        )
        issues.append({
            "kind": "overload_long_run_load",
            "severity": "error",
            "message": (
                f"week {worst.get('week_index')} puts too much estimated load into the long run "
                f"({(_float(worst.get('long_run_km_ratio')) or 0.0):.0%} of weekly km, "
                f"{(_float(worst.get('long_run_dose_ratio')) or 0.0):.0%} of weekly dose); "
                "use the load-estimator tool to spread load across supporting easy/aerobic work "
                "or reduce the long run rather than relying on a fixed distance template"
            ),
            "details": {
                "week_index": worst.get("week_index"),
                "target_weekly_km_high": worst.get("target_weekly_km_high"),
                "long_run_km": worst.get("long_run_km"),
                "long_run_km_ratio": worst.get("long_run_km_ratio"),
                "long_run_dose": worst.get("long_run_dose"),
                "long_run_dose_ratio": worst.get("long_run_dose_ratio"),
                "long_run_km_ratio_limit": long_run_km_limit,
                "long_run_dose_ratio_limit": long_run_dose_limit,
            },
        })

    has_underload_issue = any(i.get("kind", "").startswith("underload") for i in issues)
    has_overload_issue = any(i.get("kind", "").startswith("overload") for i in issues)
    if has_underload_issue and has_overload_issue:
        status = "mixed"
    elif has_underload_issue:
        status = "underload"
    elif has_overload_issue:
        status = "overload"
    else:
        status = "ok" if has_history_anchor else "insufficient_history"
    return {"status": status, "issues": issues}
