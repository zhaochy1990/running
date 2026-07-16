"""Reusable rule-based weekly-plan generation service.

The HTTP route and Coach orchestrator both use this module so last-week
adaptation, canonical conflict detection, and SQLite lifecycle stay identical.
Generation itself is side-effect free: callers decide whether to save the
returned plan immediately or surface it as a confirmation proposal.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import replace
from datetime import date as date_cls, timedelta

from stride_core.plan_spec import SessionKind, WeeklyPlan
from stride_core.timefmt import shanghai_day_str

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


def _master_week_target(user_id: str, week_start: date_cls) -> tuple[float, str] | None:
    """Return the active master plan's midpoint target for this week."""
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
    context = (
        f"总体计划第 {match.week_index} 周 · {phase_name} · "
        f"目标范围 {low:.1f}-{high:.1f}km"
    )
    return round(target, 1), context


def get_last_week_summary(
    user_id: str, db, week_start: date_cls, *, plan_store=None
) -> dict | None:
    """Return previous-week completion signals for the rule generator."""
    prev_start = week_start - timedelta(days=7)
    prev_end = prev_start + timedelta(days=6)
    store = plan_store or get_weekly_plan_store()
    previous = store.get_current_plan(
        user_id, prev_start.isoformat()
    )
    planned_rows = list(previous.sessions) if previous else []
    if not planned_rows:
        return None

    date_from = prev_start.isoformat()
    date_to = prev_end.isoformat()
    page = db.list_activities(
        offset=0,
        limit=1000,
        date_from=date_from,
        date_to=date_to,
    )
    activity_rows = page.get("rows", [])

    planned_runs = [row for row in planned_rows if row.kind == SessionKind.RUN]
    run_distances = [
        float(getattr(row, "total_distance_m", 0) or 0)
        for row in planned_runs
    ]
    planned_run_dates = {
        row.date for row in planned_rows if row.kind == SessionKind.RUN
    }
    completed = 0
    for activity in activity_rows:
        raw = str(activity["date"])
        if len(raw) == 8 and raw.isdigit():
            activity_day = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
        else:
            activity_day = shanghai_day_str(raw)
        if activity_day in planned_run_dates:
            completed += 1

    return {
        "completed_sessions": completed,
        "total_sessions": len(planned_rows),
        # Use the planned base. Reducing from under-completed actual mileage
        # would punish a missed week twice.
        "total_distance_km": sum(run_distances) / 1000.0,
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
    resolved_base_km = master_target[0] if master_target else base_distance_km

    db = get_db(user_id)
    try:
        last_week_summary = get_last_week_summary(user_id, db, week_start)
        plan, total_distance_km = generate_week_plan(
            user_id=user_id,
            week_start=week_start,
            base_distance_km=resolved_base_km,
            last_week_summary=last_week_summary,
        )
    finally:
        db.close()

    if master_target is not None:
        plan = replace(
            plan,
            notes_md=f"{master_target[1]}。{plan.notes_md or ''}".strip(),
        )

    from coach.graphs.generation.rule_filter import run_rule_filter

    report = run_rule_filter(
        plan.to_dict(),
        target_weekly_km=resolved_base_km,
    )
    if not report.ok:
        messages = "; ".join(
            f"{violation.rule}: {violation.message}"
            for violation in report.errors()
        )
        raise ValueError(f"generated weekly plan failed safety rules: {messages}")

    return GeneratedWeeklyPlan(
        plan=plan, total_distance_km=round(total_distance_km, 1)
    )
