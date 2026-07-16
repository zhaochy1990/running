"""Master-plan training-load estimation for S1 generation and Coach tools.

This module is adapter-layer by design: it consumes DB-derived history payloads
and ``MasterPlan``-shaped drafts, then projects the S1 weekly skeleton onto the
same TSS-like planned-load scale used by ``stride_core.training_load``. The core
``coach.*`` package stays DB-free; callers pass the resulting dict into prompts,
tools, or rule-filter feedback.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from statistics import mean, median
from typing import Any

from stride_core.master_plan import MasterPlan, TrainingLoadProjection
from stride_core.running_calibration.zones import PACE_ZONE_SPEED_RATIOS
from stride_core.training_load import estimate_planned_run_load_details
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
        "threshold_speed_mps": _round(_float(history.get("threshold_speed_mps")), 4),
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


def _parse_time_seconds(value: Any) -> float | None:
    if isinstance(value, (int, float)) and float(value) > 0:
        return float(value)
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    try:
        nums = [float(part) for part in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        return nums[0] * 3600.0 + nums[1] * 60.0 + nums[2]
    if len(nums) == 2:
        return nums[0] * 60.0 + nums[1]
    return None


_RACE_DISTANCE_M = {
    "5k": 5_000.0,
    "10k": 10_000.0,
    "hm": 21_097.5,
    "fm": 42_195.0,
}


def _goal_race_if(
    plan: Any,
    target_race: Mapping[str, Any] | None,
    threshold_speed_mps: float | None,
) -> float | None:
    if not threshold_speed_mps or threshold_speed_mps <= 0:
        return None
    goal = _get(plan, "goal") or {}
    distance = _extract_goal_distance(plan, target_race)
    distance_m = _RACE_DISTANCE_M.get(distance)
    source = target_race or {}
    seconds = next((
        parsed
        for value in (
            source.get("goal_time_s"),
            source.get("target_time"),
            source.get("target_finish_time"),
            _get(goal, "goal_time_s"),
            _get(goal, "target_time"),
            _get(goal, "target_finish_time"),
        )
        if (parsed := _parse_time_seconds(value)) is not None
    ), None)
    if not distance_m or not seconds:
        return None
    return max(0.0, min(2.0, (distance_m / seconds) / threshold_speed_mps))


def _zone_range(name: str) -> tuple[float, float]:
    low, high = PACE_ZONE_SPEED_RATIOS[name]
    return float(low or 0.50), float(high or 1.20)


def _has_race_pace_marker(text: str) -> bool:
    if any(phrase in text for phrase in (
        "race pace", "marathon pace", "half marathon pace",
        "比赛配速", "马拉松配速", "半马配速",
    )):
        return True
    # Match the common ASCII abbreviations as standalone markers. Using plain
    # substring checks makes words such as "improve" look like MP sessions.
    # ASCII-only boundaries also preserve compact forms such as "MP配速".
    return re.search(r"(?<![a-z])(?:hmp|mp|rp)(?![a-z])", text, re.IGNORECASE) is not None


def _distance_only_tune_up_if_range(distance_km: float) -> tuple[float, float, str]:
    """Return a conservative race-intensity range when no finish time exists.

    The range stays personalized because every value is relative to the
    athlete's threshold speed. It is deliberately wider than an estimate based
    on an explicit finish time.
    """
    if distance_km <= 7.5:
        low, high = _zone_range("interval")
        return low, high, "tune_up_distance_only_short_race_interval_range"
    if distance_km <= 15.0:
        low, high = _zone_range("threshold")
        return low, high, "tune_up_distance_only_10k_threshold_range"
    if distance_km <= 30.0:
        marathon_low, _ = _zone_range("marathon")
        _, threshold_high = _zone_range("threshold")
        return marathon_low, threshold_high, "tune_up_distance_only_hm_marathon_to_threshold_range"
    low, high = _zone_range("marathon")
    return low, high, "tune_up_distance_only_long_race_marathon_range"


def _distance_only_race_if_range(distance_km: float) -> tuple[float, float, str]:
    low, high, assumption = _distance_only_tune_up_if_range(distance_km)
    return low, high, assumption.replace("tune_up_", "goal_race_", 1)


def _session_if_range(
    session: Any,
    *,
    goal_race_if: float | None,
    goal_race_distance_km: float | None = None,
) -> tuple[float, float, list[str]] | None:
    stype = _session_type(session)
    text = " ".join(
        str(_get(session, key, "") or "")
        for key in ("intensity", "purpose", "note")
    ).lower()
    if stype in {"strength_key", "strength"}:
        return None
    for token, zone in (("z1", "recovery"), ("z2", "easy"), ("z3", "marathon"), ("z4", "threshold"), ("z5", "interval")):
        if token in text:
            low, high = _zone_range(zone)
            return low, high, [f"{token}_pace_zone_range"]
    if stype == "threshold":
        low, high = _zone_range("threshold")
        return low, high, ["threshold_zone_range"]
    if stype in {"interval", "vo2max", "time_trial"}:
        low, high = _zone_range("interval")
        return low, high, [f"{stype}_zone_range"]
    if stype == "tempo":
        low, high = _zone_range("marathon")
        return low, high, ["tempo_marathon_to_threshold_range"]
    if stype == "hill":
        low, high = _zone_range("threshold")
        return low, high, ["hill_effort_flat_equivalent_range"]
    if stype in {"race", "race_pace"}:
        if goal_race_if is not None:
            return goal_race_if, goal_race_if, ["goal_time_race_pace"]
        distance = goal_race_distance_km or _session_distance_km(session)
        if distance:
            low, high, assumption = _distance_only_race_if_range(distance)
            return low, high, [assumption]
        return None
    if stype == "tune_up_race":
        duration = _session_duration_min(session)
        distance = _session_distance_km(session)
        if not distance:
            return None
        if duration:
            # The caller converts this session-specific speed to IF after
            # receiving the sentinel; never borrow the A-race IF.
            return 0.0, 0.0, ["tune_up_uses_own_distance_and_duration"]
        low, high, assumption = _distance_only_tune_up_if_range(distance)
        return low, high, [assumption]
    if stype == "long_run":
        if _has_race_pace_marker(text):
            easy_low, _easy_high = _zone_range("easy")
            if goal_race_if is None:
                return None
            return min(easy_low, goal_race_if), max(easy_low, goal_race_if), [
                "mp_fraction_unspecified_range_easy_to_goal_pace"
            ]
        low, high = _zone_range("easy")
        return low, high, ["long_run_easy_zone_range"]
    return None


def _is_embedded_session(session: Any) -> bool:
    text = " ".join(
        str(_get(session, key, "") or "")
        for key in ("intensity", "purpose", "note")
    ).lower()
    return any(token in text for token in (
        "embedded", "within long", "inside long", "part of long",
        "其中", "内含", "长跑内",
    ))


def _estimate_session(
    *,
    km: float | None,
    duration_min: float | None,
    low_if: float,
    high_if: float,
    threshold_speed_mps: float,
):
    expected_if = (low_if + high_if) / 2.0
    if low_if == high_if == 0.0 and km and duration_min:
        expected_if = (km * 1000.0 / (duration_min * 60.0)) / threshold_speed_mps
        low_if = high_if = expected_if
    pace_low = 1000.0 / max(threshold_speed_mps * low_if, 0.01)
    pace_high = 1000.0 / max(threshold_speed_mps * high_if, 0.01)
    step = WorkoutStep(
        step_kind=StepKind.WORK,
        duration=(Duration.of_time_min(duration_min) if duration_min is not None else Duration.of_distance_km(km or 0.0)),
        target=Target.pace_range_s_km(pace_low, pace_high),
    )
    workout = NormalizedRunWorkout(
        name="master-plan-load-estimate",
        date="2026-01-01",
        blocks=(WorkoutBlock(steps=(step,)),),
    )
    return estimate_planned_run_load_details(workout, threshold_speed_mps=threshold_speed_mps)


def estimate_master_plan_training_load(
    plan: Any,
    *,
    history_anchor: Mapping[str, Any] | None = None,
    target_race: Mapping[str, Any] | None = None,
    weekly_run_days_max: int | None = None,
    injuries: list[str] | None = None,
    threshold_speed_mps: float | None = None,
) -> dict[str, Any]:
    """Estimate planned weekly km and STRIDE dose from an S1 skeleton."""
    anchor = dict(history_anchor or {})
    if threshold_speed_mps is None:
        threshold_speed_mps = _float(anchor.get("threshold_speed_mps"))
    baseline_km = _float(anchor.get("distance_anchor_km"))
    baseline_dose = _float(anchor.get("dose_anchor"))
    goal_race_if = _goal_race_if(plan, target_race, threshold_speed_mps)
    goal_distance_key = _extract_goal_distance(plan, target_race)
    goal_race_distance_km = (
        _RACE_DISTANCE_M.get(goal_distance_key, 0.0) / 1000.0 or None
    )
    weeks_out: list[dict[str, Any]] = []
    for week in _extract_weeks(plan):
        low = _float(_get(week, "target_weekly_km_low")) or 0.0
        high = _float(_get(week, "target_weekly_km_high")) or 0.0
        is_recovery = bool(_get(week, "is_recovery_week", False))
        is_taper = bool(_get(week, "is_taper_week", False))
        sessions = _get(week, "key_sessions", []) or []
        key_km = 0.0
        key_dose = 0.0
        key_dose_low = 0.0
        key_dose_high = 0.0
        week_assumptions: list[str] = []
        load_computable = bool(threshold_speed_mps and threshold_speed_mps > 0)
        long_run_km = 0.0
        long_run_dose = 0.0
        embedded_intensity_ranges: list[tuple[float, float]] = []
        for session in sessions:
            stype = _session_type(session)
            if stype in {"strength_key", "strength"}:
                continue
            if stype in {"race_pace", "threshold", "tempo"} and _is_embedded_session(session):
                embedded_intensity = _session_if_range(
                session, goal_race_if=goal_race_if,
                goal_race_distance_km=goal_race_distance_km,
                )
                if embedded_intensity is not None:
                    embedded_intensity_ranges.append(embedded_intensity[:2])
                week_assumptions.append(f"{stype}_embedded_in_parent_not_double_counted")
                continue
            km = _session_distance_km(session)
            duration = _session_duration_min(session)
            intensity = _session_if_range(
                session, goal_race_if=goal_race_if,
                goal_race_distance_km=goal_race_distance_km,
            )
            estimate = None
            if load_computable and intensity is not None and (km or duration):
                low_if, high_if, assumptions = intensity
                estimate = _estimate_session(
                    km=km, duration_min=duration, low_if=low_if, high_if=high_if,
                    threshold_speed_mps=float(threshold_speed_mps),
                )
                week_assumptions.extend(assumptions)
                if estimate.expected_dose is not None:
                    key_dose += estimate.expected_dose
                    key_dose_low += estimate.low_dose or estimate.expected_dose
                    key_dose_high += estimate.high_dose or estimate.expected_dose
                else:
                    load_computable = False
            elif stype not in {"strength_key", "strength"}:
                load_computable = False
            estimated_km = estimate.estimated_distance_km if estimate is not None else None
            if km is not None:
                key_km += max(0.0, km)
            elif estimated_km is not None:
                key_km += max(0.0, estimated_km)
            if stype == "long_run":
                long_run_km = max(long_run_km, max(0.0, km or 0.0))
                long_run_dose = max(long_run_dose, estimate.expected_dose or 0.0) if estimate else 0.0
        if embedded_intensity_ranges and load_computable:
            long_sessions = [s for s in sessions if _session_type(s) == "long_run"]
            for parent in long_sessions:
                parent_km = _session_distance_km(parent)
                parent_duration = _session_duration_min(parent)
                if not (parent_km or parent_duration):
                    continue
                parent_intensity = _session_if_range(
                    parent, goal_race_if=goal_race_if,
                    goal_race_distance_km=goal_race_distance_km,
                )
                if parent_intensity is None:
                    continue
                low_if = min(parent_intensity[0], *(r[0] for r in embedded_intensity_ranges))
                high_if = max(parent_intensity[1], *(r[1] for r in embedded_intensity_ranges))
                ranged_parent = _estimate_session(
                    km=parent_km, duration_min=parent_duration,
                    low_if=low_if, high_if=high_if,
                    threshold_speed_mps=float(threshold_speed_mps),
                )
                original_parent = _estimate_session(
                    km=parent_km, duration_min=parent_duration,
                    low_if=parent_intensity[0], high_if=parent_intensity[1],
                    threshold_speed_mps=float(threshold_speed_mps),
                )
                if ranged_parent.expected_dose is not None and original_parent.expected_dose is not None:
                    # The embedded segment's exact fraction is unknown. Keep
                    # the parent's expected dose conservative, but lift it
                    # halfway toward the easy-to-quality range midpoint so it
                    # is not priced identically to an all-easy long run.
                    delta = max(
                        0.0,
                        (ranged_parent.high_dose or ranged_parent.expected_dose)
                        - original_parent.expected_dose,
                    ) / 2.0
                    key_dose += delta
                    key_dose_low += (ranged_parent.low_dose or 0.0) - (original_parent.low_dose or 0.0)
                    key_dose_high += (ranged_parent.high_dose or 0.0) - (original_parent.high_dose or 0.0)
                    long_run_dose = max(
                        long_run_dose, original_parent.expected_dose + delta
                    )
                break
        low_remaining_easy_km = max(0.0, low - key_km)
        remaining_easy_km = max(0.0, high - key_km)
        low_easy_dose = 0.0
        low_easy_dose_lower = 0.0
        easy_dose = easy_low = easy_high = 0.0
        if load_computable and (low_remaining_easy_km > 0 or remaining_easy_km > 0):
            low_if, high_if = _zone_range("easy")
            if low_remaining_easy_km > 0:
                low_easy_estimate = _estimate_session(
                    km=low_remaining_easy_km, duration_min=None, low_if=low_if, high_if=high_if,
                    threshold_speed_mps=float(threshold_speed_mps),
                )
                low_easy_dose = low_easy_estimate.expected_dose or 0.0
                low_easy_dose_lower = low_easy_estimate.low_dose or low_easy_dose
            if remaining_easy_km > 0:
                easy_estimate = _estimate_session(
                    km=remaining_easy_km, duration_min=None, low_if=low_if, high_if=high_if,
                    threshold_speed_mps=float(threshold_speed_mps),
                )
                easy_dose = easy_estimate.expected_dose or 0.0
                easy_low = easy_estimate.low_dose or easy_dose
                easy_high = easy_estimate.high_dose or easy_dose
            week_assumptions.append("remaining_weekly_distance_in_easy_zone")
        low_raw_total_dose = key_dose + low_easy_dose if load_computable else None
        raw_total_dose = key_dose + easy_dose if load_computable else None
        total_dose_low = key_dose_low + low_easy_dose_lower if load_computable else None
        total_dose_high = key_dose_high + easy_high if load_computable else None
        total_dose = raw_total_dose
        weeks_out.append({
            "week_index": _get(week, "week_index"),
            "week_start": _get(week, "week_start"),
            "target_weekly_km_low": _round(low),
            "target_weekly_km_high": _round(high),
            "target_training_dose_low": _round(total_dose_low),
            "target_training_dose_high": _round(total_dose_high),
            "estimated_dose": _round(total_dose),
            "estimated_dose_low": _round(total_dose_low),
            "estimated_dose_high": _round(total_dose_high),
            "estimated_raw_tss": _round(raw_total_dose),
            "estimated_raw_tss_low": _round(low_raw_total_dose),
            "load_computable": load_computable,
            "load_assumptions": list(dict.fromkeys(week_assumptions)),
            "key_session_km": _round(key_km),
            "remaining_easy_km_low": _round(low_remaining_easy_km),
            "remaining_easy_km": _round(remaining_easy_km),
            "long_run_km": _round(long_run_km),
            "long_run_dose": _round(long_run_dose) if load_computable else None,
            "key_session_km_ratio": _round(key_km / high if high > 0 else None, 2),
            "long_run_km_ratio": _round(long_run_km / high if high > 0 else None, 2),
            "long_run_dose_ratio": _round(long_run_dose / total_dose if total_dose and total_dose > 0 else None, 2),
            "is_recovery_week": is_recovery,
            "is_taper_week": is_taper,
        })

    load_weeks = [w for w in weeks_out if not _is_deload_week(w) and (w["target_weekly_km_high"] or 0) > 0]
    first4 = load_weeks[:4]
    km_values = [float(w["target_weekly_km_high"] or 0.0) for w in load_weeks]
    dose_values = [float(w["estimated_dose"]) for w in load_weeks if w["estimated_dose"] is not None]
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
        "first4_load_avg_dose": _round(mean([float(w["estimated_dose"]) for w in first4 if w["estimated_dose"] is not None]) if any(w["estimated_dose"] is not None for w in first4) else None),
        "avg_load_week_dose": _round(mean(dose_values) if dose_values else None),
        "peak_weekly_dose": _round(max(dose_values) if dose_values else None),
    }
    summary["load_computable"] = bool(dose_values) and all(w["load_computable"] for w in weeks_out)
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
        "unavailable_reason": (
            "personal_threshold_unavailable"
            if not threshold_speed_mps or threshold_speed_mps <= 0
            else None
        ),
    }


def apply_master_plan_training_load_projection(
    plan: MasterPlan,
    estimate: Mapping[str, Any] | None,
    *,
    calculated_at: str | None = None,
    allow_unavailable_without_weeks: bool = True,
) -> MasterPlan:
    """Persist a deterministic load estimate onto a typed MasterPlan.

    Legacy plans without a weekly skeleton receive an explicit unavailable
    marker. A plan with skeletons must have one valid estimate for every week;
    partial projections are rejected instead of being persisted.
    """
    timestamp = calculated_at or datetime.now(timezone.utc).isoformat()
    if not plan.weeks:
        if not allow_unavailable_without_weeks:
            raise ValueError("weekly skeleton unavailable")
        projection = TrainingLoadProjection(
            status="unavailable",
            unavailable_reason="weekly_skeleton_unavailable",
            calculated_at=timestamp,
        )
        return plan.model_copy(update={
            "weeks": [],
            "weekly_key_sessions": [],
            "training_load_projection": projection,
        })

    estimated_weeks = list((estimate or {}).get("weeks") or [])
    by_index: dict[int, Mapping[str, Any]] = {}
    for row in estimated_weeks:
        if not isinstance(row, Mapping):
            continue
        try:
            index = int(row.get("week_index"))
        except (TypeError, ValueError):
            continue
        if index in by_index:
            raise ValueError(f"duplicate load estimate for week {index}")
        by_index[index] = row

    expected_indexes = {week.week_index for week in plan.weeks}
    if set(by_index) != expected_indexes:
        raise ValueError("load estimate week set does not match master plan")

    if (estimate or {}).get("unavailable_reason") == "personal_threshold_unavailable":
        if any(
            _float(row.get("target_training_dose_low")) is not None
            or _float(row.get("target_training_dose_high")) is not None
            for row in by_index.values()
        ):
            raise ValueError(
                "personal-threshold-unavailable estimate unexpectedly contains weekly dose"
            )
        unprojected = [
            week.model_copy(update={
                "target_training_dose_low": None,
                "target_training_dose_high": None,
            })
            for week in plan.weeks
        ]
        projection = TrainingLoadProjection(
            status="unavailable",
            unavailable_reason="personal_threshold_unavailable",
            calculated_at=timestamp,
        )
        return MasterPlan.model_validate(plan.model_copy(update={
            "weeks": unprojected,
            "weekly_key_sessions": list(unprojected),
            "training_load_projection": projection,
        }).model_dump(mode="json"))

    projected = []
    for week in plan.weeks:
        row = by_index.get(week.week_index)
        if row is None:
            raise ValueError(f"missing load estimate for week {week.week_index}")
        low = _float(row.get("target_training_dose_low"))
        high = _float(row.get("target_training_dose_high"))
        if low is None or high is None:
            raise ValueError(f"incomplete load estimate for week {week.week_index}")
        projected.append(week.model_copy(update={
            "target_training_dose_low": low,
            "target_training_dose_high": high,
        }))

    projection = TrainingLoadProjection(
        status="available",
        unavailable_reason=None,
        calculated_at=timestamp,
    )
    return MasterPlan.model_validate(plan.model_copy(update={
        "weeks": projected,
        "weekly_key_sessions": list(projected),
        "training_load_projection": projection,
    }).model_dump(mode="json"))


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
