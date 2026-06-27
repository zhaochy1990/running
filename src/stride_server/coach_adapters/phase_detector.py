"""Current-phase detector (S1 pre-generation) — adapter layer.

Establishes, BEFORE master-plan generation, which phase the athlete is in and
from which phase a new plan should begin, producing an authoritative
:class:`~coach.schemas.CurrentPhaseContext` injected into the planner prompt.

Two-case dispatch (see plan doc 2026-06-16-coach-current-phase-detector):

* **existing STRIDE user** (an active master plan exists) → read the current
  phase + weeks elapsed deterministically from that plan.
* **no prior plan but has history** → infer via the core deterministic
  classifier AND an LLM analysis, cross-validated (deterministic wins on
  disagreement; the divergence is recorded). The LLM half safe-degrades: any
  failure falls back to the deterministic result with confidence capped.

Adapter layer: touches the master-plan store, the SQLite DB, and the LLM —
none of which ``coach.*`` core may import. The pure classification lives in
:mod:`coach.graphs.generation.phase_detection`.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date as date_cls

from coach.graphs.generation.phase_detection import (
    RecentTrainingFeatures,
    classify_current_phase,
)
from coach.runtime.messages import extract_text
from coach.schemas import ContinuitySignals, CurrentPhaseContext
from langchain_core.messages import HumanMessage, SystemMessage
from stride_core.master_plan import MasterPlan, PhaseType
from stride_core.models import RUN_SPORT_SQL_LIST

from .continuity_analyzer import analyze_continuity

logger = logging.getLogger(__name__)

QUALITY_LOOKBACK_DAYS = 28
# Quality (non-aerobic) run kinds; the marathon-specific subset is threshold/tempo.
_QUALITY_KINDS = ("threshold", "interval", "vo2max", "anaerobic", "tempo", "race")
_SPECIFIC_KINDS = ("threshold", "tempo")


# ---------------------------------------------------------------------------
# Existing-plan path (fully deterministic)
# ---------------------------------------------------------------------------


def _get_active_plan(user_id: str) -> MasterPlan | None:
    """Fetch the user's active master plan, or None (new user / no plan)."""
    try:
        from ..master_plan_store import get_master_plan_store

        return get_master_plan_store().get_active_plan(user_id)
    except Exception as exc:  # noqa: BLE001 — store unavailable must not crash gen
        logger.warning("phase_detector: active-plan lookup failed: %s", exc)
        return None


def _from_existing_plan(plan: MasterPlan, as_of: date_cls) -> CurrentPhaseContext:
    """Read current phase + weeks elapsed from the athlete's active plan.

    Already-completed leading phases (``is_completed`` — a continuity plan's
    carried-over base) are NOT "current" even when today still falls inside
    their date range (e.g. the last day of a finished base block): the athlete
    has moved past them. They are skipped when locating the current phase and
    instead summed into ``completed_aerobic_weeks`` — the carried-over base the
    regenerated plan must preserve up front. ``recommended_entry_phase`` then
    points at the first *active* phase (the entry the new plan continues from),
    not the completed lead-in. Mirrors
    ``routes.master_plan._build_current_response`` so the pre-generation
    detector and the read-time current-phase resolution agree.

    Without this, regenerating a continuity plan whose completed base ends on
    (or just after) ``as_of`` mis-detects: the loop matches the completed base,
    yields ``entry=base`` + ``completed_aerobic_weeks=0``, and the planner then
    emits a degenerate 2-week base instead of preserving the real ~8-week one.
    """
    # Carried-over completed base weeks → lets the planner place the
    # is_completed lead-in (start ≈ plan_start − N weeks).
    completed_aerobic_weeks = 0
    for ph in plan.phases:
        if not getattr(ph, "is_completed", False):
            continue
        if ph.phase_type != PhaseType.BASE:
            continue
        try:
            s = date_cls.fromisoformat(ph.start_date)
            e = date_cls.fromisoformat(ph.end_date)
        except (ValueError, TypeError):
            continue
        completed_aerobic_weeks += max(1, (e - s).days // 7 + 1)

    # Current phase = first ACTIVE (not-completed) phase containing today; if
    # today sits in a completed phase's tail or before the first active phase
    # begins, fall back to the first active phase (the entry phase).
    active_phases = [p for p in plan.phases if not getattr(p, "is_completed", False)]
    current = None
    for ph in active_phases:
        try:
            start = date_cls.fromisoformat(ph.start_date)
            end = date_cls.fromisoformat(ph.end_date)
        except (ValueError, TypeError):
            continue
        if start <= as_of <= end:
            current = ph
            break
    if current is None and active_phases:
        current = active_phases[0]

    if current is None:
        # No active phase at all (every phase completed, or none parseable).
        return CurrentPhaseContext(
            source="existing_plan",
            current_phase_type=None,
            recommended_entry_phase=None,
            completed_aerobic_weeks=completed_aerobic_weeks,
            confidence="low",
            rationale="存在历史计划，但今日不在任何未完成阶段窗口内（计划已结束或尚未开始）",
        )

    try:
        weeks_in = max(0, (as_of - date_cls.fromisoformat(current.start_date)).days // 7)
    except (ValueError, TypeError):
        weeks_in = 0
    rationale = (
        f"读历史计划：新计划从「{current.name}」"
        f"（{current.phase_type.value if current.phase_type else '?'}）续接"
    )
    if completed_aerobic_weeks:
        rationale += f"；已完成 {completed_aerobic_weeks} 周有氧基础（保留为已完成前置阶段）"
    if weeks_in:
        rationale += f"；当前阶段已进行 {weeks_in} 周"
    return CurrentPhaseContext(
        source="existing_plan",
        current_phase_type=current.phase_type,
        recommended_entry_phase=current.phase_type,  # continue in-place
        weeks_in_phase=weeks_in,
        completed_aerobic_weeks=completed_aerobic_weeks,
        confidence="high",
        rationale=rationale,
    )


# ---------------------------------------------------------------------------
# Inferred path — feature extraction + deterministic classifier + LLM cross-val
# ---------------------------------------------------------------------------


def _quality_features(conn, as_of: date_cls) -> tuple[int, bool]:
    """(recent_quality_count, recent_threshold_or_mp) over the lookback window."""
    placeholders = ",".join("?" for _ in _QUALITY_KINDS)
    rows = conn.execute(
        "SELECT train_kind, COUNT(*) FROM activities "
        "WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ") "
        f"AND date >= date(?, '-{QUALITY_LOOKBACK_DAYS} days') "
        f"AND train_kind IN ({placeholders}) "
        "GROUP BY train_kind",
        (as_of.isoformat(), *_QUALITY_KINDS),
    ).fetchall()
    total = sum(int(r[1] or 0) for r in rows)
    has_specific = any((r[0] in _SPECIFIC_KINDS) and (r[1] or 0) > 0 for r in rows)
    return total, has_specific


def _weeks_to_race(goal: dict, as_of: date_cls) -> int | None:
    race_date = (goal or {}).get("race_date")
    if not race_date:
        return None
    try:
        return max(0, (date_cls.fromisoformat(race_date) - as_of).days // 7)
    except (ValueError, TypeError):
        return None


def _build_features(
    db, continuity: ContinuitySignals, goal: dict, as_of: date_cls
) -> RecentTrainingFeatures:
    quality_count, has_specific = _quality_features(db._conn, as_of)
    return RecentTrainingFeatures(
        aerobic_weeks=continuity.recent_aerobic_weeks,
        longest_run_km=continuity.recent_longest_run_km,
        return_from_layoff=continuity.return_from_layoff,
        macro_cycle=continuity.macro_cycle,
        recent_quality_count=quality_count,
        recent_threshold_or_mp=has_specific,
        weeks_to_race=_weeks_to_race(goal, as_of),
        race_distance=(goal or {}).get("race_distance"),
    )


_PHASE_DEFS = (
    "周期化阶段定义：base=有氧基础；speed=独立速度周期(VO2max/短间歇)；"
    "build=马拉松专项进展(阈值耐力+MP长距离)；peak=赛前专项峰值；taper=减量。"
)


def _llm_classify(features: RecentTrainingFeatures, continuity: ContinuitySignals) -> dict | None:
    """Ask the reviewer-role LLM to classify the current phase from recent
    training. Returns ``{"phase": str, "weeks_in_phase": int|None}`` or None on
    any failure (safe-degrade — the caller keeps the deterministic result)."""
    summary = (
        f"近期有氧周数(≥30km/周): {features.aerobic_weeks}；"
        f"周量趋势: {continuity.recent_volume_trend}；最近最长跑: {features.longest_run_km}km；"
        f"近 {QUALITY_LOOKBACK_DAYS} 天质量课次数: {features.recent_quality_count}"
        f"（含阈值/MP: {'是' if features.recent_threshold_or_mp else '否'}）；"
        f"当前 form: {continuity.current_form_zone}；CTL: {continuity.current_chronic_load}；"
        f"断训回归: {features.return_from_layoff}；macro: {features.macro_cycle}；"
        f"距赛: {features.weeks_to_race} 周；目标距离: {features.race_distance}"
    )
    system = (
        "你是马拉松训练周期化专家。根据运动员近期训练数据，判断其**当前所处的训练阶段**"
        f"以及已在该阶段训练的周数。{_PHASE_DEFS} "
        '仅输出 JSON：{"phase":"base|speed|build|peak|taper","weeks_in_phase":<int 或 null>}，无其他文字。'
    )
    try:
        from ..coach_runtime import get_reviewer_llm

        resp = get_reviewer_llm().invoke(
            [SystemMessage(content=system), HumanMessage(content=summary)]
        )
        raw = extract_text(getattr(resp, "content", resp)).strip()
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return None
        data = json.loads(m.group(0))
        phase = str(data.get("phase", "")).strip().lower()
        if phase not in {p.value for p in PhaseType}:
            return None
        wip = data.get("weeks_in_phase")
        return {"phase": phase, "weeks_in_phase": int(wip) if isinstance(wip, (int, float)) else None}
    except Exception as exc:  # noqa: BLE001 — LLM cross-val must not crash detection
        logger.warning("phase_detector: LLM cross-validation failed: %s", exc)
        return None


def _reconcile(
    det, llm: dict | None, continuity: ContinuitySignals
) -> CurrentPhaseContext:
    """Combine the deterministic classification with the LLM cross-check.

    Deterministic always wins the verdict; the LLM only adjusts confidence and
    annotates agreement/divergence."""
    base = CurrentPhaseContext(
        source="inferred",
        current_phase_type=det.current_phase_type,
        recommended_entry_phase=det.recommended_entry_phase,
        weeks_in_phase=det.weeks_in_phase,
        completed_aerobic_weeks=continuity.recent_aerobic_weeks,
        confidence=det.confidence,
        rationale=f"[确定性] {det.rationale}",
    )
    if llm is None:
        base.method_agreement = None
        base.confidence = "medium" if det.confidence == "high" else det.confidence
        base.rationale += "；[LLM] 不可用，降级（置信度封顶 medium）"
        return base

    agree = llm["phase"] == det.current_phase_type.value
    base.method_agreement = agree
    if agree:
        base.rationale += f"；[LLM] 一致（{llm['phase']}）"
        # both methods agree → keep deterministic confidence (already high/medium)
    else:
        base.rationale += (
            f"；[LLM] 分歧：LLM 判为 {llm['phase']}"
            f"（已以确定性 {det.current_phase_type.value} 为准）"
        )
        base.confidence = "low"
    return base


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def detect_current_phase(
    db,
    *,
    user_id: str,
    goal: dict,
    profile: dict | None,
    as_of: date_cls,
    continuity: ContinuitySignals | None = None,
    cross_validate_with_llm: bool = True,
) -> CurrentPhaseContext:
    """Determine the athlete's current phase + recommended entry phase.

    Args:
        db: per-user ``Database`` handle (SQLite).
        user_id: athlete UUID (for the active-plan lookup).
        goal / profile: generation inputs (race_date / race_distance / injuries).
        as_of: Shanghai-local "today".
        continuity: optional pre-computed signals (reused when the caller already
            ran ``analyze_continuity`` — avoids a second DB pass).
        cross_validate_with_llm: when ``True`` (default) the deterministic
            classification is cross-checked against a reviewer-LLM call (which
            only adjusts the confidence label — the deterministic verdict always
            wins). That LLM round-trip dominates latency (a gpt-5.5 reasoning
            call for a trivial classification), so latency-sensitive callers
            (e.g. the master-plan generation path) pass ``False`` to take the
            instant, fully-deterministic result with confidence capped at
            ``medium``. Has no effect on the existing-plan path (always
            deterministic).

    Returns:
        A :class:`CurrentPhaseContext`. Never raises — store/DB/LLM failures
        degrade to a lower-confidence or ``unknown`` result so generation
        proceeds.
    """
    # 1) Existing STRIDE user → read from their active plan (deterministic).
    plan = _get_active_plan(user_id)
    if plan is not None:
        result = _from_existing_plan(plan, as_of)
        _log_result(result)
        return result

    # 2) No prior plan → infer from recent activities.
    try:
        if continuity is None:
            continuity = analyze_continuity(db, goal=goal, profile=profile, as_of=as_of)
        features = _build_features(db, continuity, goal, as_of)
        det = classify_current_phase(features)
        logger.info(
            "phase_detector: deterministic → current=%s entry=%s conf=%s "
            "(aerobic_weeks=%d quality_28d=%d threshold/mp=%s weeks_to_race=%s)",
            det.current_phase_type.value,
            det.recommended_entry_phase.value,
            det.confidence,
            features.aerobic_weeks,
            features.recent_quality_count,
            features.recent_threshold_or_mp,
            features.weeks_to_race,
        )
        llm = _llm_classify(features, continuity) if cross_validate_with_llm else None
        result = _reconcile(det, llm, continuity)
        _log_result(result)
        return result
    except Exception as exc:  # noqa: BLE001 — detection must never crash generation
        logger.warning("phase_detector: inference failed, degrading to unknown: %s", exc)
        return CurrentPhaseContext(
            source="unknown",
            confidence="low",
            rationale=f"阶段判定失败，降级（planner 自行判断）：{exc}",
        )


def _log_result(ctx: CurrentPhaseContext) -> None:
    logger.info(
        "phase_detector: RESULT source=%s current=%s entry=%s weeks_in=%s conf=%s "
        "llm_agreement=%s | %s",
        ctx.source,
        ctx.current_phase_type.value if ctx.current_phase_type else None,
        ctx.recommended_entry_phase.value if ctx.recommended_entry_phase else None,
        ctx.weeks_in_phase,
        ctx.confidence,
        ctx.method_agreement,
        ctx.rationale,
    )
