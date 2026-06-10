"""MasterPlan diff schema and apply logic — domain-semantic diff ops for
long-term training plan adjustments (C module, M3).

Design notes:
- Mirrors ``plan_diff.py`` style: domain ops (ADD_PHASE, RESIZE_PHASE, …)
  rather than JSON Patch RFC 6902 so the frontend can render human-readable
  diff cards without re-parsing arbitrary JSON pointer paths.
- ``accepted`` is tri-state: ``None`` = pending, ``True`` = accepted,
  ``False`` = rejected.  Only accepted ops whose ids appear in
  ``accepted_op_ids`` are applied by ``apply_master_plan_diff``.
- ``store`` is typed via a ``Protocol`` (``MasterPlanStore``) whose full
  implementation lives in T03 (``stride_server/master_plan_store.py``).
  This module only imports the protocol so stride_core stays server-agnostic.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Protocol

from pydantic import BaseModel

from .master_plan import MasterPlan, MasterPlanVersion, Milestone, Phase

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Protocol (T03 provides the concrete implementation)
# ---------------------------------------------------------------------------


class MasterPlanStore(Protocol):
    def get_plan(self, plan_id: str) -> MasterPlan: ...
    def save_plan(self, plan: MasterPlan) -> None: ...
    def add_version(self, version: MasterPlanVersion) -> None: ...


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class MasterPlanDiffOpKind(str, Enum):
    ADD_PHASE               = "add_phase"
    REMOVE_PHASE            = "remove_phase"
    RESIZE_PHASE            = "resize_phase"           # 改阶段起止日期 / 周数
    REPLACE_PHASE_FOCUS     = "replace_phase_focus"    # 改训练重点文字
    REPLACE_WEEKLY_RANGE    = "replace_weekly_range"   # 改周量区间
    ADD_MILESTONE           = "add_milestone"
    REMOVE_MILESTONE        = "remove_milestone"
    REPLACE_MILESTONE_DATE  = "replace_milestone_date"
    REPLACE_MILESTONE_TARGET = "replace_milestone_target"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class MasterPlanDiffOp(BaseModel):
    id: str                       # uuid4，前端用作 React key
    op: MasterPlanDiffOpKind
    phase_id: str | None = None        # 适用于 Phase 类 op
    milestone_id: str | None = None    # 适用于 Milestone 类 op
    old_value: dict | None = None      # 人类可读旧值摘要
    new_value: dict | None = None      # 人类可读新值摘要
    spec_patch: dict | None = None     # 完整更新字段（apply 时用）
    accepted: bool | None = None       # None=pending, True=accepted, False=rejected


class MasterPlanDiff(BaseModel):
    diff_id: str                  # uuid4
    plan_id: str
    ops: list[MasterPlanDiffOp]
    ai_explanation: str
    created_at: str               # ISO datetime UTC


# ---------------------------------------------------------------------------
# apply_master_plan_diff
# ---------------------------------------------------------------------------


def apply_master_plan_diff(
    store: MasterPlanStore,
    plan_id: str,
    diff: MasterPlanDiff,
    accepted_op_ids: list[str],
    change_reason: str,
) -> MasterPlan:
    """Apply accepted ops, bump version, save snapshot, return updated plan.

    Only ops whose ``id`` is in ``accepted_op_ids`` AND whose ``accepted``
    field is ``True`` (or ``None`` — callers may pre-set accepted on the op
    and pass the id, or rely solely on the id list) are applied.

    Snapshot of the *pre-change* plan is written as a ``MasterPlanVersion``
    before any mutation so callers can roll back or display history.

    Returns the updated ``MasterPlan`` (already persisted via store).
    """
    plan = store.get_plan(plan_id)

    # Empty diff → no-op; do NOT bump version.
    if not diff.ops:
        logger.debug("apply_master_plan_diff: empty ops, no-op")
        return plan

    accepted_set = set(accepted_op_ids)
    active_ops = [op for op in diff.ops if op.id in accepted_set and op.accepted is not False]

    if not active_ops:
        logger.debug("apply_master_plan_diff: no ops to apply after filtering")
        return plan

    # Snapshot the current plan BEFORE mutation.
    snapshot = MasterPlanVersion(
        version_id=str(uuid.uuid4()),
        plan_id=plan_id,
        version=plan.version,
        changed_at=datetime.now(timezone.utc).isoformat(),
        change_reason=change_reason,
        change_summary=diff.ai_explanation,
        snapshot_json=plan.model_dump_json(),
    )
    store.add_version(snapshot)

    # Phase-affecting ops invalidate the weekly_key_sessions skeleton —
    # the week_start dates, target_weekly_km_* targets and phase_id back-
    # refs all tie to specific phase shapes. Clear the skeleton if any
    # such op applied, so we don't persist stale references after a
    # version bump. Matches the parallel logic in
    # :func:`stride_core.master_plan._apply_review_diff`.
    PHASE_AFFECTING = {
        MasterPlanDiffOpKind.ADD_PHASE,
        MasterPlanDiffOpKind.REMOVE_PHASE,
        MasterPlanDiffOpKind.RESIZE_PHASE,
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
    }
    phase_affecting_applied = any(op.op in PHASE_AFFECTING for op in active_ops)

    # Work on mutable copies.
    phases: dict[str, Phase] = {p.id: p for p in plan.phases}
    milestones: dict[str, Milestone] = {m.id: m for m in plan.milestones}

    for op in active_ops:
        try:
            _apply_op(op, phases, milestones)
        except Exception:
            logger.exception(
                "apply_master_plan_diff: error applying op %s (%s)", op.id, op.op
            )
            raise

    now_iso = datetime.now(timezone.utc).isoformat()

    update: dict = {
        "phases": list(phases.values()),
        "milestones": list(milestones.values()),
        "version": plan.version + 1,
        "updated_at": now_iso,
    }
    if phase_affecting_applied:
        update["weeks"] = []
        update["weekly_key_sessions"] = []
    updated_plan = plan.model_copy(update=update)
    store.save_plan(updated_plan)
    return updated_plan


# ---------------------------------------------------------------------------
# Per-op apply helpers
# ---------------------------------------------------------------------------


def _apply_op(
    op: MasterPlanDiffOp,
    phases: dict[str, Phase],
    milestones: dict[str, Milestone],
) -> None:
    patch: dict[str, Any] = op.spec_patch or {}

    if op.op == MasterPlanDiffOpKind.ADD_PHASE:
        _require_patch(op, patch)
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
        logger.info("apply_master_plan_diff: ADD_PHASE id=%s", new_phase.id)

    elif op.op == MasterPlanDiffOpKind.REMOVE_PHASE:
        phase_id = _require_phase_id(op)
        phase = phases.pop(phase_id, None)
        if phase is None:
            logger.warning("apply_master_plan_diff REMOVE_PHASE: phase_id=%s not found", phase_id)
            return
        # Remove milestones that belonged to this phase.
        for mid in list(phase.milestone_ids):
            removed = milestones.pop(mid, None)
            if removed is not None:
                logger.info(
                    "apply_master_plan_diff REMOVE_PHASE: cascaded remove milestone %s", mid
                )
        logger.info("apply_master_plan_diff: REMOVE_PHASE id=%s", phase_id)

    elif op.op == MasterPlanDiffOpKind.RESIZE_PHASE:
        phase_id = _require_phase_id(op)
        _require_patch(op, patch)
        phase = _get_phase(phases, phase_id, op.op)
        updates: dict[str, Any] = {}
        if "start_date" in patch:
            updates["start_date"] = patch["start_date"]
        if "end_date" in patch:
            updates["end_date"] = patch["end_date"]
        phases[phase_id] = phase.model_copy(update=updates)
        logger.info("apply_master_plan_diff: RESIZE_PHASE id=%s updates=%s", phase_id, updates)

    elif op.op == MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS:
        phase_id = _require_phase_id(op)
        _require_patch(op, patch)
        phase = _get_phase(phases, phase_id, op.op)
        phases[phase_id] = phase.model_copy(update={"focus": patch["focus"]})
        logger.info("apply_master_plan_diff: REPLACE_PHASE_FOCUS id=%s", phase_id)

    elif op.op == MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE:
        phase_id = _require_phase_id(op)
        _require_patch(op, patch)
        phase = _get_phase(phases, phase_id, op.op)
        updates = {}
        if "weekly_distance_km_low" in patch:
            updates["weekly_distance_km_low"] = float(patch["weekly_distance_km_low"])
        if "weekly_distance_km_high" in patch:
            updates["weekly_distance_km_high"] = float(patch["weekly_distance_km_high"])
        phases[phase_id] = phase.model_copy(update=updates)
        logger.info("apply_master_plan_diff: REPLACE_WEEKLY_RANGE id=%s", phase_id)

    elif op.op == MasterPlanDiffOpKind.ADD_MILESTONE:
        _require_patch(op, patch)
        from .master_plan import MilestoneType
        new_ms = Milestone(
            id=patch["id"],
            type=MilestoneType(patch["type"]),
            date=patch["date"],
            phase_id=patch["phase_id"],
            target=patch.get("target", ""),
            completed_actual=patch.get("completed_actual"),
        )
        milestones[new_ms.id] = new_ms
        # Add to the owning phase's milestone_ids if the phase exists.
        if new_ms.phase_id in phases:
            phase = phases[new_ms.phase_id]
            if new_ms.id not in phase.milestone_ids:
                phases[new_ms.phase_id] = phase.model_copy(
                    update={"milestone_ids": phase.milestone_ids + [new_ms.id]}
                )
        logger.info("apply_master_plan_diff: ADD_MILESTONE id=%s", new_ms.id)

    elif op.op == MasterPlanDiffOpKind.REMOVE_MILESTONE:
        ms_id = _require_milestone_id(op)
        ms = milestones.pop(ms_id, None)
        if ms is None:
            logger.warning(
                "apply_master_plan_diff REMOVE_MILESTONE: milestone_id=%s not found", ms_id
            )
            return
        # Remove from the owning phase's milestone_ids.
        if ms.phase_id in phases:
            phase = phases[ms.phase_id]
            new_ids = [mid for mid in phase.milestone_ids if mid != ms_id]
            phases[ms.phase_id] = phase.model_copy(update={"milestone_ids": new_ids})
        logger.info("apply_master_plan_diff: REMOVE_MILESTONE id=%s", ms_id)

    elif op.op == MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE:
        ms_id = _require_milestone_id(op)
        _require_patch(op, patch)
        ms = _get_milestone(milestones, ms_id, op.op)
        milestones[ms_id] = ms.model_copy(update={"date": patch["date"]})
        logger.info("apply_master_plan_diff: REPLACE_MILESTONE_DATE id=%s", ms_id)

    elif op.op == MasterPlanDiffOpKind.REPLACE_MILESTONE_TARGET:
        ms_id = _require_milestone_id(op)
        _require_patch(op, patch)
        ms = _get_milestone(milestones, ms_id, op.op)
        milestones[ms_id] = ms.model_copy(update={"target": patch["target"]})
        logger.info("apply_master_plan_diff: REPLACE_MILESTONE_TARGET id=%s", ms_id)

    else:
        logger.warning("apply_master_plan_diff: unknown op kind %s, skipping", op.op)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _require_patch(op: MasterPlanDiffOp, patch: dict[str, Any]) -> None:
    if not patch:
        raise ValueError(f"op {op.id} ({op.op.value}) requires spec_patch, got None/empty")


def _require_phase_id(op: MasterPlanDiffOp) -> str:
    if not op.phase_id:
        raise ValueError(f"op {op.id} ({op.op.value}) requires phase_id")
    return op.phase_id


def _require_milestone_id(op: MasterPlanDiffOp) -> str:
    if not op.milestone_id:
        raise ValueError(f"op {op.id} ({op.op.value}) requires milestone_id")
    return op.milestone_id


def _get_phase(phases: dict[str, Phase], phase_id: str, op_kind: MasterPlanDiffOpKind) -> Phase:
    phase = phases.get(phase_id)
    if phase is None:
        raise KeyError(f"{op_kind.value}: phase_id={phase_id} not found in plan")
    return phase


def _get_milestone(
    milestones: dict[str, Milestone],
    ms_id: str,
    op_kind: MasterPlanDiffOpKind,
) -> Milestone:
    ms = milestones.get(ms_id)
    if ms is None:
        raise KeyError(f"{op_kind.value}: milestone_id={ms_id} not found in plan")
    return ms
