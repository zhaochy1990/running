"""Reusable rule-based weekly-plan generation service.

The master plan provides periodisation intent, while recent actual training and
STRIDE load determine the executable weekly target.  This keeps a stale or
conservative master skeleton from abruptly replacing the workload the athlete
has already absorbed.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from datetime import date as date_cls, timedelta
from statistics import median

from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_core.timefmt import shanghai_day_str, today_shanghai

from .deps import get_db
from .week_generator import generate_week_plan
from .weekly_plan_store import get_weekly_plan_store


class WeeklyPlanAlreadyExistsError(ValueError):
    """Raised when generation would replace an existing canonical week."""

    def __init__(self, folder: str) -> None:
        self.folder = folder
        super().__init__(f"weekly plan {folder!r} already exists")


@dataclass(frozen=True)
class GeneratedWeeklyPlan:
    plan: WeeklyPlan
    total_distance_km: float


@dataclass(frozen=True)
class MasterWeekTarget:
    target_km: float
    context: str
    is_recovery_week: bool = False
    is_taper_week: bool = False


@dataclass(frozen=True)
class RecentTrainingContext:
    completed_week_km: tuple[float, ...] = ()
    baseline_km: float | None = None
    load_ratio: float | None = None
    current_week_by_date: dict[str, dict] | None = None


def _master_week_target(user_id: str, week_start: date_cls) -> MasterWeekTarget | None:
    """Return the active master plan's advisory target for this week."""
    from .master_plan_store import get_master_plan_store

    master = get_master_plan_store().get_active_plan(user_id)
    if master is None:
        return None
    weeks = list(master.weeks or master.weekly_key_sessions or [])
    match = next(
        (week for week in weeks if week.week_start == week_start.isoformat()),
        None,
    )
    if match is None:
        return None
    low = float(match.target_weekly_km_low or 0)
    high = float(match.target_weekly_km_high or 0)
    positive = [value for value in (low, high) if value > 0]
    if not positive:
        return None
    target = sum(positive) / len(positive)
    phase = next(
        (phase for phase in master.phases if phase.id == match.phase_id),
        None,
    )
    phase_name = (phase.name if phase is not None else "") or "未命名阶段"
    return MasterWeekTarget(
        target_km=round(target, 1),
        context=(
            f"总体计划第 {match.week_index} 周 · {phase_name} · "
            f"目标范围 {low:.1f}-{high:.1f}km"
        ),
        is_recovery_week=bool(getattr(match, "is_recovery_week", False)),
        is_taper_week=bool(getattr(match, "is_taper_week", False)),
    )


def _recent_training_context(db, week_start: date_cls) -> RecentTrainingContext:
    """Read actual volume, current-week execution, and latest STRIDE load."""
    today = today_shanghai()
    windows: list[tuple[int, str, str]] = []
    for offset in range(1, 5):
        start = week_start - timedelta(days=7 * offset)
        end = start + timedelta(days=6)
        if end >= today:
            # When preparing next week mid-week, the immediately preceding
            # calendar week is still incomplete and must not depress the
            # established-volume baseline.
            continue
        windows.append(
            (offset, start.isoformat(), end.isoformat())
        )
    summaries = (
        db.get_running_week_summaries(windows)
        if hasattr(db, "get_running_week_summaries")
        else {}
    )
    completed = tuple(
        float(summary["actual_distance_km"])
        for offset in range(1, 5)
        if (summary := summaries.get(offset)) is not None
        and float(summary.get("actual_distance_km") or 0) > 0
    )[:2]
    baseline = round(float(median(completed)), 1) if completed else None

    load_ratio = None
    if hasattr(db, "fetch_latest_daily_training_load"):
        load_row = db.fetch_latest_daily_training_load()
        if load_row is not None and load_row["load_ratio"] is not None:
            load_ratio = float(load_row["load_ratio"])

    current_week_by_date = None
    if (
        hasattr(db, "get_running_week_summaries")
        and week_start <= today <= week_start + timedelta(days=6)
    ):
        day_windows = [
            (offset, day.isoformat(), day.isoformat())
            for offset in range(7)
            if (day := week_start + timedelta(days=offset)) <= today
        ]
        daily = db.get_running_week_summaries(day_windows)
        current_week_by_date = {
            (week_start + timedelta(days=offset)).isoformat(): summary
            for offset, summary in daily.items()
        }

    return RecentTrainingContext(
        completed_week_km=completed,
        baseline_km=baseline,
        load_ratio=load_ratio,
        current_week_by_date=current_week_by_date,
    )


def _resolve_weekly_target(
    master_target: MasterWeekTarget | None,
    context: RecentTrainingContext,
) -> tuple[float | None, str | None]:
    """Blend strategic mileage with recent execution and recovery state.

    Ordinary weeks stay within +/-10% of the recent two-week median. Elevated
    load can lower the ceiling, while explicit recovery/taper weeks retain their
    periodisation semantics.
    """
    baseline = context.baseline_km
    master_km = master_target.target_km if master_target is not None else None
    if baseline is None:
        return master_km, None

    if master_target is not None and master_target.is_taper_week:
        return master_km, None

    if master_target is not None and master_target.is_recovery_week:
        lower, upper = baseline * 0.70, baseline * 0.80
    elif context.load_ratio is not None and context.load_ratio > 1.25:
        lower, upper = baseline * 0.80, baseline * 0.90
    elif context.load_ratio is not None and context.load_ratio > 1.10:
        lower, upper = baseline * 0.90, baseline
    else:
        lower, upper = baseline * 0.90, baseline * 1.10

    desired = baseline * 1.05 if master_km is None else master_km
    lower_half_km = math.ceil(lower * 2.0) / 2.0
    upper_half_km = math.floor(upper * 2.0) / 2.0
    desired_half_km = round(desired * 2.0) / 2.0
    resolved = min(max(desired_half_km, lower_half_km), upper_half_km)
    recent = ", ".join(f"{km:.1f}" for km in context.completed_week_km)
    note = f"近期实际周量基线 {baseline:.1f}km（最近周：{recent}km）"
    if context.load_ratio is not None:
        note += f"，STRIDE load_ratio={context.load_ratio:.2f}"
    if master_km is not None and abs(resolved - master_km) > 0.05:
        note += f"；总体计划 {master_km:.1f}km 已校准为 {resolved:.1f}km"
    return resolved, note


def _current_week_actual_km(context: RecentTrainingContext) -> float:
    return round(
        sum(
            float(summary.get("actual_distance_km") or 0)
            for summary in (context.current_week_by_date or {}).values()
        ),
        1,
    )


def _current_week_immutable_rule_names(
    plan: WeeklyPlan,
    context: RecentTrainingContext,
    *,
    prev_week_km: float | None,
) -> set[str]:
    """Rules violated only by completed work that can no longer be prescribed."""
    actual_by_date = context.current_week_by_date
    if actual_by_date is None:
        return set()
    immutable: set[str] = set()
    actual_km = _current_week_actual_km(context)
    if prev_week_km is not None and actual_km > prev_week_km * 1.10:
        immutable.add("weekly_progression")

    actual_longest = max(
        (
            float(summary.get("actual_distance_km") or 0)
            for summary in actual_by_date.values()
        ),
        default=0.0,
    )
    future_longest = max(
        (
            float(session.total_distance_m or 0) / 1000.0
            for session in plan.sessions
            if session.kind == SessionKind.RUN
            and session.date not in actual_by_date
        ),
        default=0.0,
    )
    if actual_longest > future_longest:
        immutable.add("long_run_share")
    if len(actual_by_date) == 7:
        immutable.add("rest_days")
    return immutable


def _replace_distance_label(summary: str, distance_km: float) -> str:
    km_label = f"{round(distance_km)}K"
    return re.sub(r"（[^，）]+([，）])", rf"（{km_label}\1", summary, count=1)


def _merge_current_week_actuals(
    plan: WeeklyPlan,
    *,
    target_km: float,
    context: RecentTrainingContext,
) -> WeeklyPlan:
    """Lock elapsed days and distribute only the uncompleted mileage budget."""
    actual_by_date = context.current_week_by_date
    if actual_by_date is None:
        return plan
    today = today_shanghai().isoformat()
    sessions: list[PlannedSession] = []
    future_run_indexes: list[int] = []
    future_weights: list[float] = []
    actual_m = 0.0

    for session in plan.sessions:
        actual = actual_by_date.get(session.date)
        locked = session.date < today or actual is not None
        if locked:
            distance_km = float((actual or {}).get("actual_distance_km") or 0)
            if distance_km > 0:
                actual_m += distance_km * 1000.0
                sessions.append(
                    replace(
                        session,
                        kind=SessionKind.RUN,
                        summary=f"已完成跑步（{distance_km:.1f}K）",
                        notes_md="根据已同步训练记录锁定；无需重复执行。",
                        total_distance_m=round(distance_km * 1000.0),
                        total_duration_s=(
                            float((actual or {}).get("total_duration_s") or 0) or None
                        ),
                    )
                )
            else:
                sessions.append(
                    replace(
                        session,
                        kind=SessionKind.REST,
                        summary="已过日期（无跑步记录）",
                        notes_md=None,
                        total_distance_m=None,
                        total_duration_s=None,
                    )
                )
            continue
        sessions.append(session)
        if session.kind == SessionKind.RUN:
            future_run_indexes.append(len(sessions) - 1)
            future_weights.append(float(session.total_distance_m or 0))

    remaining_m = max(target_km * 1000.0 - actual_m, 0.0)
    if future_run_indexes:
        weight_total = sum(future_weights) or float(len(future_run_indexes))
        allocated = 0.0
        for pos, (index, weight) in enumerate(
            zip(future_run_indexes, future_weights, strict=True)
        ):
            distance_m = (
                remaining_m - allocated
                if pos == len(future_run_indexes) - 1
                else round(remaining_m * (weight or 1.0) / weight_total)
            )
            allocated += distance_m
            session = sessions[index]
            if distance_m <= 0:
                sessions[index] = replace(
                    session,
                    kind=SessionKind.REST,
                    summary="恢复休息（本周实际跑量已达目标）",
                    notes_md=None,
                    total_distance_m=None,
                    total_duration_s=None,
                )
                continue
            old_distance = float(session.total_distance_m or 0)
            duration_s = (
                float(session.total_duration_s or 0) * distance_m / old_distance
                if old_distance > 0
                else None
            )
            sessions[index] = replace(
                session,
                summary=_replace_distance_label(session.summary, distance_m / 1000.0),
                total_distance_m=distance_m,
                total_duration_s=round(duration_s) if duration_s else None,
            )

    work_dates = {
        session.date
        for session in sessions
        if session.kind in {SessionKind.RUN, SessionKind.STRENGTH, SessionKind.CROSS}
    }
    if len(work_dates) == 7:
        for index, session in enumerate(sessions):
            if session.date >= today and session.kind == SessionKind.STRENGTH:
                sessions[index] = replace(
                    session,
                    kind=SessionKind.REST,
                    summary="完整休息日",
                    notes_md="本周已完成训练较多，保留至少一个完整休息日。",
                )
                break

    return replace(plan, sessions=tuple(sessions))


def get_last_week_summary(
    user_id: str,
    db,
    week_start: date_cls,
    *,
    plan_store=None,
) -> dict | None:
    """Compatibility summary with actual volume and plan-date adherence."""
    prev_start = week_start - timedelta(days=7)
    prev_end = week_start - timedelta(days=1)
    store = plan_store or get_weekly_plan_store()
    previous = store.get_current_plan(user_id, prev_start.isoformat())
    planned_rows = list(previous.sessions) if previous else []
    page = db.list_activities(
        offset=0,
        limit=1000,
        date_from=prev_start.isoformat(),
        date_to=prev_end.isoformat(),
    )
    activity_rows = page.get("rows", [])
    if not planned_rows and not activity_rows:
        return None
    planned_run_dates = {
        row.date for row in planned_rows if row.kind == SessionKind.RUN
    }
    completed = 0
    for activity in activity_rows:
        raw = str(activity["date"])
        activity_day = (
            f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
            if len(raw) == 8 and raw.isdigit()
            else shanghai_day_str(raw)
        )
        if activity_day in planned_run_dates:
            completed += 1
    actual = db.get_running_week_summaries(
        [(0, prev_start.isoformat(), prev_end.isoformat())]
    ).get(0, {})
    return {
        "completed_sessions": completed,
        "total_sessions": len(planned_rows),
        "total_distance_km": float(actual.get("actual_distance_km") or 0),
        "avg_rpe": None,
    }


def build_weekly_plan(
    *,
    user_id: str,
    week_start: date_cls,
    base_distance_km: float | None = None,
    allow_existing: bool = False,
) -> GeneratedWeeklyPlan:
    """Generate one Monday-based week without persisting it."""
    if week_start.weekday() != 0:
        raise ValueError("week_start must be a Monday")

    existing = get_weekly_plan_store().get_current_plan(
        user_id, week_start.isoformat()
    )
    if existing is not None and not allow_existing:
        raise WeeklyPlanAlreadyExistsError(existing.week_folder)

    master_target = (
        _master_week_target(user_id, week_start)
        if base_distance_km is None
        else None
    )

    db = get_db(user_id)
    try:
        training_context = _recent_training_context(db, week_start)
        resolved_base_km, calibration_note = (
            (base_distance_km, None)
            if base_distance_km is not None
            else _resolve_weekly_target(master_target, training_context)
        )
        actual_km = _current_week_actual_km(training_context)
        completed_run_days = len(training_context.current_week_by_date or {})
        if completed_run_days == 7:
            resolved_base_km = math.ceil(actual_km * 2.0) / 2.0
            actual_note = f"本周已全部完成，最终实际跑量 {actual_km:.1f}km"
        elif actual_km > 0 and (
            resolved_base_km is None or actual_km > resolved_base_km
        ):
            resolved_base_km = math.ceil(actual_km * 2.0) / 2.0
            actual_note = (
                f"本周已完成 {actual_km:.1f}km，目标下限抬升为 "
                f"{resolved_base_km:.1f}km"
            )
        else:
            actual_note = None
        plan, total_distance_km = generate_week_plan(
            user_id=user_id,
            week_start=week_start,
            base_distance_km=resolved_base_km,
            last_week_summary=None,
        )
        plan = _merge_current_week_actuals(
            plan,
            target_km=total_distance_km,
            context=training_context,
        )
    finally:
        db.close()

    notes = [
        master_target.context if master_target is not None else None,
        calibration_note,
        actual_note,
        plan.notes_md,
    ]
    plan = replace(
        plan,
        notes_md="。".join(note.strip("。 \t\n") for note in notes if note),
    )

    from coach.graphs.generation.rule_filter import run_rule_filter

    prev_week_km = (
        training_context.completed_week_km[0]
        if training_context.completed_week_km
        else None
    )
    report = run_rule_filter(
        plan.to_dict(),
        prev_week_km=prev_week_km,
        target_weekly_km=resolved_base_km,
    )
    immutable_rules = _current_week_immutable_rule_names(
        plan,
        training_context,
        prev_week_km=prev_week_km,
    )
    actionable_errors = [
        violation
        for violation in report.errors()
        if violation.rule not in immutable_rules
    ]
    if actionable_errors:
        messages = "; ".join(
            f"{violation.rule}: {violation.message}"
            for violation in actionable_errors
        )
        raise ValueError(f"generated weekly plan failed safety rules: {messages}")

    return GeneratedWeeklyPlan(
        plan=plan,
        total_distance_km=round(total_distance_km, 1),
    )
