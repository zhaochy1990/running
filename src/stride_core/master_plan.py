"""MasterPlan Pydantic models — long-term training plan (C module, M3).

A MasterPlan spans weeks-to-months and is the backbone for single-week plan
generation. It is composed of Phases (periodisation blocks) and Milestones
(key target events), authored by the LLM and confirmed by the user via a chat
review flow (C5).

Design notes:
- Pydantic v2 BaseModel (same dependency already used by plan_diff.py).
- All date fields are ISO YYYY-MM-DD strings — no datetime objects to keep
  serialisation trivial and match the rest of stride_core conventions.
- ``version`` starts at 1 and is bumped on every adjust operation; a full
  snapshot is stored as ``MasterPlanVersion.snapshot_json`` so the history
  tab (C8) can render diff comparisons without re-running the diff algorithm.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class MasterPlanStatus(str, Enum):
    DRAFT    = "draft"     # 生成中 / review 中，未确认
    ACTIVE   = "active"    # 用户已确认，作为单周生成基础
    ARCHIVED = "archived"  # 被新版本替代


class MilestoneType(str, Enum):
    RACE             = "race"
    TEST_RUN         = "test_run"
    LONG_RUN         = "long_run"
    STRENGTH_TEST    = "strength_test"
    # Body-composition phase exit-target (additive — diff/legacy snapshots
    # treat it as an opaque value). e.g. metric="body_fat_pct",
    # target_value=12.0, comparator="<=" → "基础期末体脂 ≤ 12%".
    BODY_COMPOSITION = "body_composition"


class PhaseType(str, Enum):
    """Closed set of phase types = the Stage-2 specialist registry keys.
    Stage-1 may only emit these; each maps to one specialist (see spec §6)."""
    BASE     = "base"
    BUILD    = "build"
    SPEED    = "speed"
    PEAK     = "peak"
    TAPER    = "taper"
    RECOVERY = "recovery"


# ---------------------------------------------------------------------------
# Component models
# ---------------------------------------------------------------------------


class Milestone(BaseModel):
    id: str                        # uuid4
    type: MilestoneType
    date: str                      # ISO YYYY-MM-DD
    phase_id: str
    target: str                    # 自然语言目标描述，如 "30K 节奏跑 4'45/km"
    completed_actual: str | None = None  # 实际完成情况，如 "4'52/km 完成"
    # Quantifiable phase exit-target (optional; additive so the diff machinery
    # and legacy snapshots keep working). e.g. metric="race_time_s_5k",
    # target_value=1140, comparator="<=" → "5k sub-19:00 by end of phase".
    metric: str | None = None
    target_value: float | None = None
    comparator: Literal["<=", ">=", "=="] | None = None


class Phase(BaseModel):
    id: str                        # uuid4
    name: str                      # 如 "基础期"
    start_date: str                # ISO YYYY-MM-DD
    end_date: str                  # ISO YYYY-MM-DD
    focus: str                     # 训练重点描述
    weekly_distance_km_low: float
    weekly_distance_km_high: float
    key_session_types: list[str]   # 如 ["长距离","有氧","力量"]
    milestone_ids: list[str]
    phase_type: PhaseType | None = None  # Stage-1↔Stage-2 routing key; optional for backcompat


# ---------------------------------------------------------------------------
# Weekly key-session skeleton (S1 strategic — see docs/coach-eval_S1.md)
# ---------------------------------------------------------------------------


class KeySession(BaseModel):
    """One key training session inside a weekly skeleton.

    A *key* session drives physiological adaptation or carries injury /
    race risk — long runs, threshold / tempo / interval / VO2max / hill,
    race pace, time trials, tune-up races, the goal race, and key strength.
    Ordinary easy / aerobic / recovery / commute runs are NOT key sessions
    and do not appear here (they live in S2 weekly plans).

    ``type`` enumeration (str so we can extend without schema churn):
    ``long_run`` / ``threshold`` / ``tempo`` / ``interval`` / ``vo2max`` /
    ``hill`` / ``race_pace`` / ``time_trial`` / ``tune_up_race`` /
    ``race`` / ``strength_key``.

    One of ``distance_km`` / ``duration_min`` is typically populated:
    distance-anchored sessions (long_run / race_pace / tune_up_race / race)
    set ``distance_km``; time-anchored sessions (threshold / interval) set
    ``duration_min``. Both can be set when the prompt produces both.
    """

    type: str                       # see docstring enumeration
    distance_km: float | None = None
    duration_min: float | None = None
    intensity: str | None = None    # "z2" / "z4" / "race_pace" / "mp" / etc.
    purpose: str | None = None      # 1-line rationale, e.g. "建立 FM 专项耐力"


class WeeklyKeySessions(BaseModel):
    """One week of the weekly_key_sessions skeleton.

    Per ``docs/coach-eval_S1.md`` § "S1 Output Requirement: Weekly
    Key-Session Skeleton" — S1 doesn't expand full daily sessions; it only
    lists the key stimuli per week so the eval framework can check
    progression, taper, target-distance specificity, and density.

    ``is_recovery_week`` / ``is_taper_week`` flag deload / wind-down weeks
    so L1 rules can skip the volume-ramp cap and the
    weekly_key_sessions_present requirement for these weeks (a recovery
    week with 0-1 key sessions is correct; a build week with 0 is not).
    """

    week_index: int                # 1-based, sequential across the whole plan
    week_start: str                # ISO YYYY-MM-DD, the Monday of the week
    phase_id: str                  # owning phase (uuid4 from Phase.id)
    target_weekly_km_low: float
    target_weekly_km_high: float
    key_sessions: list[KeySession]
    is_recovery_week: bool = False
    is_taper_week: bool = False


# ---------------------------------------------------------------------------
# Top-level plan models
# ---------------------------------------------------------------------------


class MasterPlan(BaseModel):
    plan_id: str                   # uuid4
    user_id: str                   # JWT sub UUID
    status: MasterPlanStatus
    goal_id: str                   # 关联的 training-goal id
    start_date: str                # 总纲开始日期 ISO YYYY-MM-DD
    end_date: str                  # 总纲结束日期 ISO YYYY-MM-DD
    phases: list[Phase]
    milestones: list[Milestone]
    # Weekly key-session skeleton — list ordered by week_index. Default empty
    # so plans authored before Batch B (existing fixtures, test stubs, legacy
    # MasterPlanVersion snapshots) still validate. New plans MUST populate it
    # for the Batch B L1 rules (weekly_key_sessions_present /
    # weekly_volume_ramp / taper_volume_drop / target_distance_long_run /
    # key_session_density / hard_session_spacing) to do anything; empty list
    # → those rules silently no-op for backwards compatibility.
    weekly_key_sessions: list[WeeklyKeySessions] = Field(default_factory=list)
    training_principles: list[str]  # 训练原则，3-5 条
    generated_by: str              # "gpt-4.1" 等
    version: int                   # 从 1 开始，每次 adjust 递增
    created_at: str                # ISO UTC datetime string
    updated_at: str                # ISO UTC datetime string


class MasterPlanVersion(BaseModel):
    """历史版本快照（存完整 plan JSON 供版本对比）。"""

    version_id: str                # uuid4
    plan_id: str
    version: int
    changed_at: str                # ISO UTC datetime string
    change_reason: str             # 用户输入的调整描述（来自最后一条 user 消息）
    change_summary: str            # AI 生成的一句话摘要
    snapshot_json: str             # 完整 MasterPlan JSON 序列化（用于版本对比）


# ---------------------------------------------------------------------------
# Review-diff apply helper (draft-phase only, no version bump)
# ---------------------------------------------------------------------------


def _apply_review_diff(
    plan: "MasterPlan",
    diff: object,  # MasterPlanDiff — avoid circular import; duck-typed
    accepted_op_ids: list[str],
) -> "MasterPlan":
    """Apply accepted diff ops to a DRAFT plan WITHOUT bumping version.

    Used by the review-chat /apply endpoint (T21) where the plan is still
    being shaped; we don't want history entries or a version increment until
    the user calls /confirm (T22).

    Args:
        plan: The current MasterPlan in DRAFT status.
        diff: A MasterPlanDiff whose ops should be applied selectively.
        accepted_op_ids: The subset of op ids the user accepted.

    Returns:
        A new MasterPlan instance (immutable model_copy) with the accepted
        ops applied; ``version`` and ``status`` are unchanged.
    """
    from datetime import datetime, timezone

    from stride_core.master_plan_diff import MasterPlanDiffOpKind as _K

    accepted_set = set(accepted_op_ids)
    active_ops = [op for op in diff.ops if op.id in accepted_set and op.accepted is not False]

    if not active_ops:
        return plan

    # Phase-affecting ops invalidate the weekly_key_sessions skeleton — its
    # week_start dates, target_weekly_km_* targets and phase_id back-refs all
    # tie to specific phase shapes. Rather than partially patch the skeleton
    # (which would need a diff op of its own to be safe), clear it so the
    # next generation pass / explicit edit can rebuild it consistently.
    PHASE_AFFECTING = {
        _K.ADD_PHASE,
        _K.REMOVE_PHASE,
        _K.RESIZE_PHASE,
        _K.REPLACE_WEEKLY_RANGE,
    }
    phase_affecting_applied = any(op.op in PHASE_AFFECTING for op in active_ops)

    phases: dict[str, Phase] = {p.id: p for p in plan.phases}
    milestones: dict[str, Milestone] = {m.id: m for m in plan.milestones}

    for op in active_ops:
        patch = op.spec_patch or {}
        op_kind = op.op  # MasterPlanDiffOpKind value

        if op_kind == _K.ADD_PHASE:
            new_phase = Phase(
                id=patch["id"],
                name=patch["name"],
                start_date=patch["start_date"],
                end_date=patch["end_date"],
                focus=patch.get("focus", ""),
                weekly_distance_km_low=float(patch.get("weekly_distance_km_low", 0)),
                weekly_distance_km_high=float(patch.get("weekly_distance_km_high", 0)),
                key_session_types=list(patch.get("key_session_types", [])),
                milestone_ids=list(patch.get("milestone_ids", [])),
            )
            phases[new_phase.id] = new_phase

        elif op_kind == _K.REMOVE_PHASE:
            if op.phase_id:
                phase = phases.pop(op.phase_id, None)
                if phase:
                    for mid in list(phase.milestone_ids):
                        milestones.pop(mid, None)

        elif op_kind == _K.RESIZE_PHASE:
            if op.phase_id and op.phase_id in phases:
                updates = {}
                if "start_date" in patch:
                    updates["start_date"] = patch["start_date"]
                if "end_date" in patch:
                    updates["end_date"] = patch["end_date"]
                phases[op.phase_id] = phases[op.phase_id].model_copy(update=updates)

        elif op_kind == _K.REPLACE_PHASE_FOCUS:
            if op.phase_id and op.phase_id in phases and "focus" in patch:
                phases[op.phase_id] = phases[op.phase_id].model_copy(
                    update={"focus": patch["focus"]}
                )

        elif op_kind == _K.REPLACE_WEEKLY_RANGE:
            if op.phase_id and op.phase_id in phases:
                updates = {}
                if "weekly_distance_km_low" in patch:
                    updates["weekly_distance_km_low"] = float(patch["weekly_distance_km_low"])
                if "weekly_distance_km_high" in patch:
                    updates["weekly_distance_km_high"] = float(patch["weekly_distance_km_high"])
                phases[op.phase_id] = phases[op.phase_id].model_copy(update=updates)

        elif op_kind == _K.ADD_MILESTONE:
            new_ms = Milestone(
                id=patch["id"],
                type=MilestoneType(patch["type"]),
                date=patch["date"],
                phase_id=patch["phase_id"],
                target=patch.get("target", ""),
                completed_actual=patch.get("completed_actual"),
            )
            milestones[new_ms.id] = new_ms
            if new_ms.phase_id in phases:
                p = phases[new_ms.phase_id]
                if new_ms.id not in p.milestone_ids:
                    phases[new_ms.phase_id] = p.model_copy(
                        update={"milestone_ids": p.milestone_ids + [new_ms.id]}
                    )

        elif op_kind == _K.REMOVE_MILESTONE:
            if op.milestone_id:
                ms = milestones.pop(op.milestone_id, None)
                if ms and ms.phase_id in phases:
                    p = phases[ms.phase_id]
                    new_ids = [mid for mid in p.milestone_ids if mid != op.milestone_id]
                    phases[ms.phase_id] = p.model_copy(update={"milestone_ids": new_ids})

        elif op_kind == _K.REPLACE_MILESTONE_DATE:
            if op.milestone_id and op.milestone_id in milestones and "date" in patch:
                milestones[op.milestone_id] = milestones[op.milestone_id].model_copy(
                    update={"date": patch["date"]}
                )

        elif op_kind == _K.REPLACE_MILESTONE_TARGET:
            if op.milestone_id and op.milestone_id in milestones and "target" in patch:
                milestones[op.milestone_id] = milestones[op.milestone_id].model_copy(
                    update={"target": patch["target"]}
                )

    now_iso = datetime.now(timezone.utc).isoformat()
    update: dict = {
        "phases": list(phases.values()),
        "milestones": list(milestones.values()),
        "updated_at": now_iso,
        # version and status intentionally unchanged
    }
    if phase_affecting_applied:
        # See "Phase-affecting ops invalidate..." comment above. Caller (the
        # review-chat /apply route) is responsible for triggering a fresh
        # skeleton generation before the plan is /confirmed.
        update["weekly_key_sessions"] = []
    return plan.model_copy(update=update)
