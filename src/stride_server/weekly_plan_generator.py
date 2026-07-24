"""LLM-authored weekly-plan generation service.

The master plan provides periodisation intent (phase + advisory volume), while
recent actual training and STRIDE load resolve an executable weekly km target.
That target, the athlete's real pace table, phase doctrine, continuity signals,
completed-day locks and a body-composition nutrition baseline are handed to the
generator LLM (``generate_week_validated``), which authors the week — running,
strength and nutrition. A deterministic ``run_rule_filter`` safety gate + bounded
regen-with-feedback loop wrap the LLM; a week that cannot be made rule-valid
after retries raises :class:`WeeklyPlanGenerationError` (no rule-based fallback).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import date as date_cls, timedelta
from statistics import median
from typing import Any

from stride_core.master_plan import PhaseType
from stride_core.plan_spec import SessionKind, WeeklyPlan
from stride_core.timefmt import shanghai_day_str, today_shanghai, week_folder

from .content_store import read_json
from .deps import get_db
from .nutrition_rules import (
    NutritionBaseline,
    build_fallback_baseline,
    build_preferences_baseline,
)
from .weekly_plan_store import get_weekly_plan_store

logger = logging.getLogger(__name__)


class WeeklyPlanAlreadyExistsError(ValueError):
    """Raised when generation would replace an existing canonical week."""

    def __init__(self, folder: str) -> None:
        self.folder = folder
        super().__init__(f"weekly plan {folder!r} already exists")


class WeeklyPlanGenerationError(RuntimeError):
    """Raised when the LLM generator cannot produce a rule-valid week.

    Covers every terminal generation failure the caller must surface (retries
    exhausted with rule violations, unparseable/invalid LLM output after the
    generator's own retry, an LLM-infra outage, or a missing precondition such
    as no running-calibration snapshot). Defined here — not in the adapter — so
    routes and the weekly-plan specialist import it cheaply (no langchain), and
    ``week_specialist_adapter`` re-imports it for raising.
    """


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
    phase_type: PhaseType | None = None


@dataclass(frozen=True)
class RecentTrainingContext:
    completed_week_km: tuple[float, ...] = ()
    baseline_km: float | None = None
    load_ratio: float | None = None
    current_week_by_date: dict[str, dict] | None = None


def _read_content_object(relative_path: str) -> dict | None:
    """Best-effort object read for optional plan-generation context."""
    try:
        item = read_json(relative_path)
    except Exception:  # noqa: BLE001 — optional context must not block generation
        return None
    if item is None:
        return None
    data, _source = item
    return data if isinstance(data, dict) else None


def _nutrition_baseline(user_id: str, db) -> NutritionBaseline:
    """Resolve one weekly nutrition baseline from canonical athlete sources."""
    prefs_store = _read_content_object(f"{user_id}/nutrition_prefs.json")
    prefs = prefs_store.get("current") if prefs_store else None
    if isinstance(prefs, dict):
        try:
            return build_preferences_baseline(prefs)
        except ValueError:
            # An incomplete preference record should degrade to an explicitly
            # labelled estimate rather than dropping nutrition from the plan.
            pass

    bmr_kcal: float | None = None
    weight_kg: float | None = None
    if hasattr(db, "latest_body_composition_scan"):
        try:
            row = db.latest_body_composition_scan()
            if row is not None:
                scan = dict(row)
                bmr_kcal = scan.get("bmr_kcal")
                weight_kg = scan.get("weight_kg")
        except Exception:  # noqa: BLE001 — fall through to profile estimate
            pass

    profile = _read_content_object(f"{user_id}/profile.json")
    if weight_kg is None and profile is not None:
        weight_kg = profile.get("weight_kg")
    return build_fallback_baseline(weight_kg=weight_kg, bmr_kcal=bmr_kcal)


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
    phase_type = _coerce_phase_type(getattr(phase, "phase_type", None))
    return MasterWeekTarget(
        target_km=round(target, 1),
        context=(
            f"总体计划第 {match.week_index} 周 · {phase_name} · "
            f"目标范围 {low:.1f}-{high:.1f}km"
        ),
        is_recovery_week=bool(getattr(match, "is_recovery_week", False)),
        is_taper_week=bool(getattr(match, "is_taper_week", False)),
        phase_type=phase_type,
    )


def _coerce_phase_type(value: object) -> PhaseType | None:
    """Best-effort coerce a phase value (PhaseType or its ``.value`` string)."""
    if isinstance(value, PhaseType):
        return value
    if value in (None, ""):
        return None
    try:
        return PhaseType(str(getattr(value, "value", value)))
    except ValueError:
        return None


def _active_master_goal(user_id: str) -> dict:
    """Normalised goal dict from the active master plan's embedded goal snapshot.

    Returns ``{}`` when there is no active plan. The goal feeds ``pace_targets``
    (marathon-pace derivation) and continuity (race_date → macro cycle); both
    degrade gracefully when it is empty, so a missing plan is not fatal.
    """
    from .master_plan_generator import _normalize_for_prompt
    from .master_plan_store import get_master_plan_store

    master = get_master_plan_store().get_active_plan(user_id)
    goal = getattr(master, "goal", None) if master is not None else None
    if goal is None:
        return {}
    raw = {
        "distance": getattr(getattr(goal, "distance", None), "value", None)
        or getattr(goal, "distance", None),
        "race_date": getattr(goal, "race_date", "") or "",
        "target_finish_time": getattr(goal, "target_time", "") or "",
        "race_name": getattr(goal, "race_name", "") or "",
    }
    norm_goal, _profile = _normalize_for_prompt(raw, None)
    return norm_goal


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


def _immutable_rules_from_actuals(
    context: RecentTrainingContext,
    *,
    prev_week_km: float | None,
    target_km: float | None,
) -> set[str]:
    """Rule ids that completed (already-run) work makes unfixable this week.

    A mid-week's finished mileage is echoed verbatim into the generated week, so
    some HARD rules can be violated by history alone — no arrangement of the
    remaining days can repair them. Computed from the completed actuals + the
    prior week + the full weekly target BEFORE generation, so the generator's
    rule gate can exempt exactly them (mirroring the old rule generator's
    immutable-rule exemption):

    * ``weekly_progression`` — completed km already exceeds prev × 1.10; the full
      week's total (>= completed) can only be higher.
    * ``long_run_share`` — a completed run already exceeds 35% of the weekly
      target; its length is fixed and total ~= target, so the share can't drop.
    * ``rest_days`` — the athlete has already run on all 7 days of the week
      (``current_week_by_date`` only carries days with a logged run), so no
      future day remains that could become the required rest day.
    """
    actual_by_date = context.current_week_by_date
    if not actual_by_date:
        return set()
    immutable: set[str] = set()
    actual_km = _current_week_actual_km(context)
    if (
        prev_week_km is not None
        and prev_week_km > 0
        and actual_km > prev_week_km * 1.10
    ):
        immutable.add("weekly_progression")
    actual_longest = max(
        (float(s.get("actual_distance_km") or 0) for s in actual_by_date.values()),
        default=0.0,
    )
    if target_km and target_km > 0 and actual_longest > 0.35 * float(target_km):
        immutable.add("long_run_share")
    if len(actual_by_date) == 7:
        immutable.add("rest_days")
    return immutable


def _render_nutrition_baseline_block(baseline: NutritionBaseline) -> str:
    """Render the athlete's real nutrition baseline for the LLM to author from."""
    return (
        "【营养基线（真实体测数据，据此为每天生成 nutrition）】\n"
        f"- 基线热量（休息日）：约 {baseline.base_kcal:.0f} kcal；训练日在此基础上按当天课型"
        "强度适度增量（易/恢复约 +200 kcal，长距/质量课更高）。\n"
        f"- 宏量占比：蛋白 {baseline.protein_pct:.0f}% / 碳水 {baseline.carb_pct:.0f}% / "
        f"脂肪 {baseline.fat_pct:.0f}%（据此换算每餐克数）。\n"
        f"- 数据来源：{baseline.source_note}。"
    )


def _render_completed_days_block(
    context: RecentTrainingContext,
    *,
    target_km: float,
) -> str:
    """Render already-completed current-week days as locked context.

    Non-empty only mid-week. Instructs the LLM to echo each completed day
    verbatim as a done session and to plan ONLY the remaining dates, so the full
    week's running mileage still hits ``target_km`` (rule_filter validates the
    whole stitched week).
    """
    actual_by_date = context.current_week_by_date
    if not actual_by_date:
        return ""
    completed_km = _current_week_actual_km(context)
    lines = [
        "【本周已完成（锁定，勿改）——只为剩余日期排课，全周跑量仍须命中目标周量】",
    ]
    for day in sorted(actual_by_date):
        summary = actual_by_date[day] or {}
        km = float(summary.get("actual_distance_km") or 0)
        if km > 0:
            lines.append(
                f"- {day}：已完成跑步 {km:.1f}km —— 原样回显为一条已完成 session"
                f"（kind=run，summary 写“已完成跑步（{km:.1f}K）”，"
                f"total_distance_m={round(km * 1000)}，spec=null），不要改动或重复安排。"
            )
        else:
            lines.append(f"- {day}：已过日期、无跑步记录 —— 回显为一条 rest。")
    remaining = max(round(float(target_km) - completed_km, 1), 0.0)
    lines.append(
        f"- 已完成合计 {completed_km:.1f}km；剩余目标 ≈ 目标 {float(target_km):.1f}km − "
        f"已完成 {completed_km:.1f}km ≈ {remaining:.1f}km，分配到剩余日期；"
        "已完成日期不要重复排课。"
    )
    return "\n".join(lines)


def _continuity_to_dict(signals: Any) -> dict | None:
    """Project ContinuitySignals into the small dict ``_render_context_block`` reads."""
    if signals is None:
        return None
    out = {
        "macro_cycle": getattr(signals, "macro_cycle", None),
        "current_chronic_load": getattr(signals, "current_chronic_load", None),
        "post_race_recovery_status": getattr(signals, "post_race_recovery_status", None),
    }
    trimmed = {k: v for k, v in out.items() if v is not None}
    return trimmed or None


def _safe_continuity(db, *, goal: dict, profile: dict | None, as_of: date_cls):
    """Best-effort continuity signals; ``None`` when unavailable (never raises)."""
    try:
        from .coach_adapters.continuity_analyzer import analyze_continuity

        return analyze_continuity(db, goal=goal, profile=profile, as_of=as_of)
    except Exception:  # noqa: BLE001 — continuity is optional context
        logger.warning(
            "weekly_plan: continuity analysis failed; continuing without it",
            exc_info=True,
        )
        return None


def _injuries_from(signals: Any, profile: dict | None) -> list[str]:
    inj = getattr(signals, "injuries", None) if signals is not None else None
    if not inj and profile:
        inj = profile.get("injuries")
    return [str(i) for i in (inj or []) if i and str(i).lower() != "none"]


def _athlete_level(db) -> float:
    """Athlete-level signal (CTL) for the volume budget; fall back to 60."""
    if not hasattr(db, "fetch_latest_daily_training_load"):
        return 60.0
    try:
        row = db.fetch_latest_daily_training_load()
    except Exception:  # noqa: BLE001 — level is a soft signal
        return 60.0
    if row is None:
        return 60.0
    try:
        chronic = row["chronic_load"]
    except (KeyError, IndexError, TypeError):
        chronic = None
    if isinstance(chronic, (int, float)) and chronic > 0:
        return float(chronic)
    return 60.0


def _resolve_phase_type(
    master_target: MasterWeekTarget | None,
    *,
    user_id: str,
    db,
    goal: dict,
    profile: dict | None,
    as_of: date_cls,
    continuity_signals: Any,
) -> PhaseType:
    """The week's periodisation phase: master phase when known, else detected, else BASE."""
    if master_target is not None and master_target.phase_type is not None:
        return master_target.phase_type
    try:
        from .coach_adapters.phase_detector import detect_current_phase

        ctx = detect_current_phase(
            db,
            user_id=user_id,
            goal=goal,
            profile=profile,
            as_of=as_of,
            continuity=continuity_signals,
            cross_validate_with_llm=False,
        )
        if ctx.current_phase_type is not None:
            return ctx.current_phase_type
    except Exception:  # noqa: BLE001 — phase detection must never block generation
        logger.warning(
            "weekly_plan: phase detection failed; defaulting to BASE", exc_info=True
        )
    return PhaseType.BASE


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
    """Author one Monday-based week via the generator LLM (not persisted).

    Resolves the executable weekly km target (master intent blended with recent
    actual volume + STRIDE load), gathers the athlete's phase / continuity /
    injuries / nutrition baseline + any completed-day locks, then hands them to
    :func:`generate_week_validated`, which authors the running + strength +
    nutrition and enforces the ``run_rule_filter`` safety gate with bounded
    regen-with-feedback.

    Raises:
        WeeklyPlanAlreadyExistsError: the week already exists and
            ``allow_existing`` is false.
        WeeklyPlanGenerationError: no volume target could be resolved, or the LLM
            could not produce a rule-valid week after retries.
    """
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
    goal = _active_master_goal(user_id) if base_distance_km is None else {}

    db = get_db(user_id)
    try:
        training_context = _recent_training_context(db, week_start)
        resolved_base_km, calibration_note = (
            (base_distance_km, None)
            if base_distance_km is not None
            else _resolve_weekly_target(master_target, training_context)
        )
        # Completed current-week work can only raise the executable floor: a week
        # already run beyond target/plan is honoured, not clawed back.
        actual_km = _current_week_actual_km(training_context)
        completed_run_days = len(training_context.current_week_by_date or {})
        if completed_run_days == 7:
            resolved_base_km = math.ceil(actual_km * 2.0) / 2.0
        elif actual_km > 0 and (
            resolved_base_km is None or actual_km > resolved_base_km
        ):
            resolved_base_km = math.ceil(actual_km * 2.0) / 2.0
        if resolved_base_km is None or resolved_base_km <= 0:
            raise WeeklyPlanGenerationError(
                "cannot resolve a weekly volume target for "
                f"{week_start.isoformat()} (no master plan week, recent actual "
                "volume, or explicit base_distance_km)"
            )
        resolved_base_km = round(float(resolved_base_km), 1)

        profile = _read_content_object(f"{user_id}/profile.json")
        continuity_signals = _safe_continuity(
            db, goal=goal, profile=profile, as_of=week_start
        )
        injuries = _injuries_from(continuity_signals, profile)
        phase_type = _resolve_phase_type(
            master_target,
            user_id=user_id,
            db=db,
            goal=goal,
            profile=profile,
            as_of=week_start,
            continuity_signals=continuity_signals,
        )
        level = _athlete_level(db)
        nutrition_block = _render_nutrition_baseline_block(
            _nutrition_baseline(user_id, db)
        )
        completed_block = _render_completed_days_block(
            training_context, target_km=resolved_base_km
        )
        continuity_dict = _continuity_to_dict(continuity_signals)
    finally:
        db.close()

    prev_week_km = (
        training_context.completed_week_km[0]
        if training_context.completed_week_km
        else None
    )
    immutable_rules = _immutable_rules_from_actuals(
        training_context, prev_week_km=prev_week_km, target_km=resolved_base_km
    )

    # Fold the resolution / master / completed-day context into a single extra
    # block so the LLM's authored notes_md reflects them and it plans only the
    # remaining days mid-week.
    extra_parts = [
        part
        for part in (
            master_target.context if master_target is not None else None,
            calibration_note,
            completed_block or None,
        )
        if part
    ]

    from coach.graphs.generation.weekly_prompt import WeekMeta

    from .coach_adapters.week_specialist_adapter import generate_week_validated

    phase_position = (
        master_target.context
        if master_target is not None
        else f"{phase_type.value} phase"
    )
    week_meta = WeekMeta(
        phase_position=phase_position,
        week_folder=week_folder(week_start),
        target_weekly_km=resolved_base_km,
    )
    context = {
        "user_id": user_id,
        "goal": goal,
        "level": level,
        "continuity": continuity_dict,
        "extra_context_block": "\n".join(extra_parts),
    }

    week_dict = generate_week_validated(
        phase_type=phase_type,
        week_meta=week_meta,
        context=context,
        injuries=injuries,
        prev_week_km=prev_week_km,
        immutable_rules=immutable_rules,
        nutrition_baseline_block=nutrition_block,
        as_of=week_start,
    )

    plan = WeeklyPlan.from_dict(week_dict)
    return GeneratedWeeklyPlan(plan=plan, total_distance_km=resolved_base_km)
