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
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import Any, Protocol

from pydantic import BaseModel

from .master_plan import (
    MasterPlan,
    MasterPlanVersion,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
    compute_total_weeks,
)
from .timefmt import today_shanghai

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
    RESCHEDULE_TARGET_RACE  = "reschedule_target_race"  # 原子同步比赛日与赛季边界
    UPDATE_TARGET_RACE_TIME = "update_target_race_time"  # 原子同步目标比赛成绩


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


_TARGET_TIME_RE = re.compile(
    r"^(?P<hours>\d{1,2}):(?P<minutes>[0-5]\d):(?P<seconds>[0-5]\d)$"
)
_TARGET_DISTANCE_LABELS = {
    "5K": "5K",
    "10K": "10K",
    "HM": "半马",
    "FM": "全马",
    "trail": "越野",
}
_TARGET_TIME_TOKEN_RE = re.compile(r"(?<!\d)(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?!\d)")


def normalise_target_race_time(value: str) -> str:
    """Return canonical H:MM:SS or reject an ambiguous race target."""
    match = _TARGET_TIME_RE.fullmatch(str(value).strip())
    if match is None:
        raise ValueError(
            "new_target_time must use H:MM:SS with valid minutes and seconds"
        )
    hours = int(match.group("hours"))
    minutes = int(match.group("minutes"))
    seconds = int(match.group("seconds"))
    if hours == 0 and minutes == 0 and seconds == 0:
        raise ValueError("new_target_time must be greater than zero")
    return f"{hours}:{minutes:02d}:{seconds:02d}"


def _updated_milestone_target(
    current_target: str, current_time: str, new_time: str, distance: str
) -> str:
    """Preserve milestone coaching context while replacing its goal time."""
    text = str(current_target or "").strip()
    if current_time:
        for match in _TARGET_TIME_TOKEN_RE.finditer(text):
            token = match.group(1)
            candidate = token if token.count(":") == 2 else f"{token}:00"
            try:
                matches_current = normalise_target_race_time(candidate) == current_time
            except ValueError:
                matches_current = False
            if matches_current:
                return text[: match.start(1)] + new_time + text[match.end(1) :]

    label = _TARGET_DISTANCE_LABELS.get(distance, distance)
    if text:
        return f"{text}；目标完赛时间 {new_time}"
    return f"{label} {new_time}"


def build_target_race_time_patch(
    plan: MasterPlan, milestone_id: str, new_target_time: str
) -> dict[str, Any]:
    """Build one coherent patch for the external and embedded race target."""
    target_time = normalise_target_race_time(new_target_time)
    milestone = next((item for item in plan.milestones if item.id == milestone_id), None)
    if milestone is None:
        raise ValueError(f"milestone {milestone_id!r} not in plan")
    if milestone.type != MilestoneType.RACE:
        raise ValueError(f"milestone {milestone_id!r} is not the target race")
    if milestone.date != plan.goal.race_date:
        raise ValueError(
            "target race milestone and embedded goal date are inconsistent"
        )
    phase = next((item for item in plan.phases if item.id == milestone.phase_id), None)
    if phase is None or milestone.id not in phase.milestone_ids:
        raise ValueError("target race milestone is not attached to its owning phase")
    try:
        milestone_day = date.fromisoformat(milestone.date)
        phase_start = date.fromisoformat(phase.start_date)
        phase_end = date.fromisoformat(phase.end_date)
    except (TypeError, ValueError) as exc:
        raise ValueError("target race milestone or phase date is invalid") from exc
    if not phase_start <= milestone_day <= phase_end:
        raise ValueError("target race milestone date is outside its owning phase")

    current_raw = str(plan.goal.target_time or "").strip()
    current_time = normalise_target_race_time(current_raw) if current_raw else ""
    if current_time and target_time == current_time:
        raise ValueError(
            "target race already uses the requested time; no proposal is needed"
        )

    distance = getattr(plan.goal.distance, "value", str(plan.goal.distance))
    return {
        "target_time": target_time,
        "milestone_target": _updated_milestone_target(
            milestone.target, current_time, target_time, str(distance)
        ),
    }


def build_target_race_reschedule_patch(
    plan: MasterPlan,
    milestone_id: str,
    new_date: str,
    *,
    as_of: date | None = None,
) -> dict[str, Any]:
    """Build the only coherent atomic patch for moving the target race.

    The target-race milestone, embedded goal, plan end, final taper and the
    preceding phase boundary are one semantic unit. Returning one op prevents
    clients from accepting only part of the move and persisting a split-brain
    season plan. The taper duration is preserved; the preceding phase absorbs
    the schedule delta.
    """
    try:
        target_day = date.fromisoformat(new_date)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"new_date must be ISO YYYY-MM-DD, got {new_date!r}") from exc

    milestone = next((item for item in plan.milestones if item.id == milestone_id), None)
    if milestone is None:
        raise ValueError(f"milestone {milestone_id!r} not in plan")
    if milestone.type != MilestoneType.RACE:
        raise ValueError(f"milestone {milestone_id!r} is not the target race")
    if not plan.phases:
        raise ValueError("plan has no phases to reschedule")

    taper_index = next(
        (index for index, phase in enumerate(plan.phases) if phase.id == milestone.phase_id),
        None,
    )
    if taper_index is None:
        raise ValueError("target race milestone does not belong to a plan phase")
    taper = plan.phases[taper_index]
    if taper_index != len(plan.phases) - 1 or taper.phase_type != PhaseType.TAPER:
        raise ValueError("target race must belong to the final taper phase")
    if taper_index == 0:
        raise ValueError("target race reschedule requires a phase before taper")

    try:
        old_race_day = date.fromisoformat(milestone.date)
        old_taper_start = date.fromisoformat(taper.start_date)
        old_taper_end = date.fromisoformat(taper.end_date)
        plan_start = date.fromisoformat(plan.start_date)
    except (TypeError, ValueError) as exc:
        raise ValueError("current target race or phase dates are not valid ISO dates") from exc
    if (
        plan.goal.race_date != milestone.date
        or plan.end_date != milestone.date
        or taper.end_date != milestone.date
    ):
        raise ValueError(
            "current goal, plan end, target race milestone and taper end are inconsistent"
        )
    if target_day == old_race_day:
        raise ValueError("target race already uses the requested date; no proposal is needed")
    effective_today = as_of or today_shanghai()
    if target_day <= effective_today:
        raise ValueError("new target race must be a future Shanghai date")
    if target_day <= plan_start:
        raise ValueError("new target race must be after the plan start")

    delta = target_day - old_race_day
    new_taper_start = old_taper_start + delta
    new_taper_end = old_taper_end + delta
    if new_taper_start < effective_today:
        raise ValueError("reschedule cannot move the preserved taper into the past")
    previous = plan.phases[taper_index - 1]
    if previous.is_completed or taper.is_completed:
        raise ValueError("target race reschedule cannot rewrite a completed phase")
    try:
        previous_start = date.fromisoformat(previous.start_date)
        current_previous_end = date.fromisoformat(previous.end_date)
    except (TypeError, ValueError) as exc:
        raise ValueError("phase before taper has an invalid date") from exc
    if current_previous_end != old_taper_start - timedelta(days=1):
        raise ValueError(
            "phase before taper and taper must already have a continuous boundary"
        )
    previous_end = new_taper_start - timedelta(days=1)
    if previous_end <= previous_start:
        raise ValueError("reschedule would collapse the phase before taper")

    return {
        "race_date": target_day.isoformat(),
        "plan_end_date": target_day.isoformat(),
        "milestone_date": target_day.isoformat(),
        "phase_updates": [
            {"phase_id": previous.id, "end_date": previous_end.isoformat()},
            {
                "phase_id": taper.id,
                "start_date": new_taper_start.isoformat(),
                "end_date": new_taper_end.isoformat(),
            },
        ],
    }


def apply_target_race_reschedule_op(
    plan: MasterPlan,
    op: MasterPlanDiffOp,
    phases: dict[str, Phase],
    milestones: dict[str, Milestone],
) -> dict[str, Any]:
    """Apply a validated atomic race-reschedule op to mutable components."""
    milestone_id = _require_milestone_id(op)
    patch = op.spec_patch or {}
    expected = build_target_race_reschedule_patch(
        plan, milestone_id, str(patch.get("race_date") or "")
    )
    if patch != expected:
        raise ValueError("target race reschedule patch is incomplete or inconsistent")

    for item in expected["phase_updates"]:
        phase_id = item["phase_id"]
        phase = _get_phase(phases, phase_id, op.op)
        phases[phase_id] = phase.model_copy(
            update={key: value for key, value in item.items() if key != "phase_id"}
        )
    milestone = _get_milestone(milestones, milestone_id, op.op)
    milestones[milestone_id] = milestone.model_copy(
        update={"date": expected["milestone_date"]}
    )
    return {
        "goal": plan.goal.model_copy(update={"race_date": expected["race_date"]}),
        "end_date": expected["plan_end_date"],
        "total_weeks": compute_total_weeks(plan.start_date, expected["plan_end_date"]),
    }


def apply_target_race_time_op(
    plan: MasterPlan,
    op: MasterPlanDiffOp,
    milestones: dict[str, Milestone],
) -> dict[str, Any]:
    """Apply a validated atomic target-time update."""
    milestone_id = _require_milestone_id(op)
    patch = op.spec_patch or {}
    expected = build_target_race_time_patch(
        plan, milestone_id, str(patch.get("target_time") or "")
    )
    if patch != expected:
        raise ValueError("target race time patch is incomplete or inconsistent")

    milestone = _get_milestone(milestones, milestone_id, op.op)
    milestones[milestone_id] = milestone.model_copy(
        update={"target": expected["milestone_target"]}
    )
    return {
        "goal": plan.goal.model_copy(
            update={"target_time": expected["target_time"]}
        )
    }


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
    atomic_race_ops = [
        op
        for op in active_ops
        if op.op
        in {
            MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME,
        }
    ]
    if atomic_race_ops and len(active_ops) != 1:
        raise ValueError(
            "atomic target race update must be the only accepted operation in its diff"
        )

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
        MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
        MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME,
    }
    phase_affecting_applied = any(op.op in PHASE_AFFECTING for op in active_ops)

    # Work on mutable copies.
    phases: dict[str, Phase] = {p.id: p for p in plan.phases}
    milestones: dict[str, Milestone] = {m.id: m for m in plan.milestones}

    top_level_updates: dict[str, Any] = {}
    for op in active_ops:
        try:
            if op.op == MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE:
                top_level_updates.update(
                    apply_target_race_reschedule_op(plan, op, phases, milestones)
                )
            elif op.op == MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME:
                top_level_updates.update(
                    apply_target_race_time_op(plan, op, milestones)
                )
            else:
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
        **top_level_updates,
    }
    if phase_affecting_applied:
        update["weeks"] = []
        update["weekly_key_sessions"] = []
        update["training_load_projection"] = None
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
