"""Shared HTTP-boundary helpers for applying active master-plan diffs."""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator

from fastapi import HTTPException, status
from pydantic import ValidationError

from stride_core.master_plan import MasterPlanStatus
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
    normalise_target_race_time,
)

_MALFORMED_DIFF_ERRORS = (ValidationError, ValueError, TypeError, KeyError, OverflowError)
_GOAL_ROLLBACK_ATTEMPTS = 2
_PLAN_LOCKS_GUARD = threading.Lock()


@dataclass
class _PlanLockEntry:
    lock: threading.Lock


_PLAN_LOCKS: dict[tuple[str, str], _PlanLockEntry] = {}


@contextmanager
def master_plan_apply_lock(user_id: str, plan_id: str) -> Iterator[None]:
    """Fail fast when this process is already applying the same plan."""
    key = (user_id, plan_id)
    with _PLAN_LOCKS_GUARD:
        entry = _PLAN_LOCKS.setdefault(key, _PlanLockEntry(lock=threading.Lock()))
        acquired = entry.lock.acquire(blocking=False)
        if not acquired:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "master_plan_apply_in_progress",
                    "message": "该赛季计划正在应用另一项调整，请稍后重试",
                    "plan_id": plan_id,
                },
            )
    try:
        yield
    finally:
        # Keep the registry guard across release + removal. Otherwise another
        # request can acquire this entry between those operations, after which
        # removing it would let a third request create a second lock for the
        # same plan and enter concurrently.
        with _PLAN_LOCKS_GUARD:
            entry.lock.release()
            if _PLAN_LOCKS.get(key) is entry:
                _PLAN_LOCKS.pop(key, None)


class MasterPlanPersistenceError(RuntimeError):
    """Mark a store failure so it is never reported as malformed client data."""


class MasterStoreBridge:
    """Adapt the server master-plan store to the core diff-apply protocol."""

    def __init__(self, inner: Any, user_id: str, loaded_plan: Any) -> None:
        self._inner = inner
        self._user_id = user_id
        self._loaded_plan = loaded_plan

    def get_plan(self, plan_id: str) -> Any:
        if getattr(self._loaded_plan, "plan_id", None) != plan_id:
            raise MasterPlanPersistenceError("loaded plan does not match requested plan")
        return self._loaded_plan

    def save_plan(self, plan: Any) -> Any:
        if getattr(plan, "user_id", self._user_id) != self._user_id:
            raise PermissionError("refusing to save a plan owned by a different user")
        try:
            current = self._inner.get_plan(self._user_id, plan.plan_id)
        except Exception as exc:  # noqa: BLE001 — preserve infrastructure class
            raise MasterPlanPersistenceError("master plan recheck failed") from exc
        if (
            current is None
            or current.status != MasterPlanStatus.ACTIVE
            or current.version != self._loaded_plan.version
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "stale_master_plan_diff",
                    "message": "赛季计划已发生变化，请刷新并重新生成调整",
                },
            )
        try:
            return self._inner.save_plan(plan)
        except Exception as exc:  # noqa: BLE001 — preserve infrastructure class
            raise MasterPlanPersistenceError("master plan save failed") from exc

    def add_version(self, version: Any) -> Any:
        try:
            return self._inner.save_version(version)
        except Exception as exc:  # noqa: BLE001 — preserve infrastructure class
            raise MasterPlanPersistenceError("master plan version save failed") from exc


def require_active_master_plan(
    store: Any,
    user_id: str,
    plan_id: str,
    *,
    not_found_detail: str | None = None,
    forbidden_detail: str | None = None,
    inactive_detail: str | None = None,
) -> Any:
    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=not_found_detail or f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=forbidden_detail or "Access denied: plan belongs to a different user",
        )
    if plan.status != MasterPlanStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=inactive_detail or "该赛季计划尚未确认（status≠active），不能应用调整",
        )
    return plan


def accepted_master_op_ids(diff: MasterPlanDiff, requested_op_ids: list[str]) -> list[str]:
    op_ids = [op.id for op in diff.ops]
    if len(op_ids) != len(set(op_ids)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整数据非法：diff op id 必须唯一",
        )
    applicable_ids = {op.id for op in diff.ops if op.accepted is not False}
    return list(dict.fromkeys(oid for oid in requested_op_ids if oid in applicable_ids))


def accepted_master_diff(
    diff: MasterPlanDiff, accepted_op_ids: list[str]
) -> MasterPlanDiff:
    accepted_ids = set(accepted_op_ids)
    return diff.model_copy(update={"ops": [op for op in diff.ops if op.id in accepted_ids]})


def _actual_old_value(plan: Any, op: MasterPlanDiffOp) -> dict[str, Any] | None:
    phase = next((item for item in plan.phases if item.id == op.phase_id), None)
    milestone = next(
        (item for item in plan.milestones if item.id == op.milestone_id), None
    )
    if op.op == MasterPlanDiffOpKind.SHIFT_PHASE_BOUNDARY:
        following_id = (op.old_value or {}).get("following_phase_id")
        following = next((item for item in plan.phases if item.id == following_id), None)
        if phase is None or following is None:
            return None
        return {
            "end_date": phase.end_date,
            "following_phase_id": following.id,
            "following_start_date": following.start_date,
        }
    if op.op == MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE:
        if milestone is None:
            return None
        return {
            "race_date": plan.goal.race_date,
            "plan_end_date": plan.end_date,
            "milestone_date": milestone.date,
        }
    if op.op == MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME:
        if milestone is None:
            return None
        return {
            "target_time": plan.goal.target_time,
            "milestone_target": milestone.target,
            "race_date": plan.goal.race_date,
            "plan_end_date": plan.end_date,
            "milestone_date": milestone.date,
        }
    if phase is not None:
        if op.op == MasterPlanDiffOpKind.RESIZE_PHASE:
            return {
                key: getattr(phase, key)
                for key in (op.old_value or {})
                if key in {"start_date", "end_date"}
            }
        if op.op == MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS:
            return {"focus": phase.focus}
        if op.op == MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE:
            return {
                "weekly_distance_km_low": phase.weekly_distance_km_low,
                "weekly_distance_km_high": phase.weekly_distance_km_high,
            }
        if op.op == MasterPlanDiffOpKind.REMOVE_PHASE:
            return {
                key: phase.model_dump(mode="json").get(key)
                for key in (op.old_value or {})
            }
    if milestone is not None:
        if op.op == MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE:
            return {"date": milestone.date}
        if op.op == MasterPlanDiffOpKind.REPLACE_MILESTONE_TARGET:
            return {"target": milestone.target}
        if op.op == MasterPlanDiffOpKind.REMOVE_MILESTONE:
            return {
                key: milestone.model_dump(mode="json").get(key)
                for key in (op.old_value or {})
            }
    return None


def _reject_stale_master_diff(plan: Any, diff: MasterPlanDiff) -> None:
    for op in diff.ops:
        if op.old_value is None:
            if op.op in {
                MasterPlanDiffOpKind.ADD_PHASE,
                MasterPlanDiffOpKind.ADD_MILESTONE,
            }:
                continue
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "stale_master_plan_diff",
                    "message": "调整缺少原计划基线，请重新生成后再应用",
                    "op_id": op.id,
                },
            )
        actual = _actual_old_value(plan, op)
        expected = op.old_value
        if op.op == MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME and actual is not None:
            for key in ("target_time",):
                if key in expected:
                    try:
                        expected = {
                            **expected,
                            key: normalise_target_race_time(str(expected[key])),
                        }
                        actual = {
                            **actual,
                            key: normalise_target_race_time(str(actual[key])),
                        }
                    except ValueError:
                        pass
        if actual is None or any(actual.get(key) != value for key, value in expected.items()):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "stale_master_plan_diff",
                    "message": "赛季计划已发生变化，请刷新并重新生成调整",
                    "op_id": op.id,
                },
            )


def validate_accepted_master_diff(
    plan: Any,
    diff: MasterPlanDiff,
    accepted_op_ids: list[str],
    *,
    validate_diff_func: Callable[[Any, MasterPlanDiff], list[str]],
    logger: logging.Logger,
) -> MasterPlanDiff:
    selected_diff = accepted_master_diff(diff, accepted_op_ids)
    _reject_stale_master_diff(plan, selected_diff)
    try:
        violations = validate_diff_func(plan, selected_diff)
    except _MALFORMED_DIFF_ERRORS as exc:
        logger.warning("master apply: gate raised on malformed diff: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整数据非法，无法应用",
        ) from exc
    if violations:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整结构非法：" + "；".join(violations),
        )
    return selected_diff


def _raise_inconsistency(
    *, plan_id: str, diff_id: str, message: str, cause: Exception
) -> None:
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "master_plan_goal_inconsistent",
            "message": message,
            "plan_id": plan_id,
            "diff_id": diff_id,
        },
    ) from cause


def _read_goal_item(
    user_id: str, read_json_func: Callable[[str], Any]
) -> tuple[dict[str, Any], str] | None:
    item = read_json_func(f"{user_id}/training_goal.json")
    if item is None or not isinstance(item[0], dict):
        return None
    return item[0], str(item[1])


def _read_goal_after_error(
    user_id: str, read_json_func: Callable[[str], Any]
) -> dict[str, Any] | None:
    item = _read_goal_item(user_id, read_json_func)
    return item[0] if item is not None else None


def _plan_matches_atomic_goal_update(
    plan: Any, race_op: MasterPlanDiffOp | None, race_time_op: MasterPlanDiffOp | None
) -> bool:
    if race_op is not None:
        patch = race_op.spec_patch or {}
        return (
            plan.goal.race_date == patch.get("race_date")
            and plan.end_date == patch.get("plan_end_date")
            and any(
                milestone.id == race_op.milestone_id
                and milestone.date == patch.get("milestone_date")
                for milestone in plan.milestones
            )
        )
    if race_time_op is not None:
        patch = race_time_op.spec_patch or {}
        return (
            plan.goal.target_time == patch.get("target_time")
            and any(
                milestone.id == race_time_op.milestone_id
                and milestone.target == patch.get("milestone_target")
                for milestone in plan.milestones
            )
        )
    return True


def _rollback_training_goal(
    *,
    user_id: str,
    plan_id: str,
    diff_id: str,
    original: dict[str, Any],
    read_json_func: Callable[[str], Any],
    write_json_func: Callable[[str, Any], Any],
    logger: logging.Logger,
) -> None:
    rollback_error: Exception | None = None
    for attempt in range(1, _GOAL_ROLLBACK_ATTEMPTS + 1):
        try:
            write_json_func(f"{user_id}/training_goal.json", original)
            observed = _read_goal_after_error(user_id, read_json_func)
            if observed == original:
                return
            rollback_error = RuntimeError("Training Goal rollback verification failed")
        except Exception as exc:  # noqa: BLE001 — bounded compensation
            rollback_error = exc
            logger.error(
                "master apply: Training Goal rollback attempt %d/%d failed",
                attempt,
                _GOAL_ROLLBACK_ATTEMPTS,
                exc_info=True,
            )
    assert rollback_error is not None
    logger.critical(
        "master apply: Training Goal remains potentially inconsistent "
        "for plan_id=%s diff_id=%s",
        plan_id,
        diff_id,
    )
    _raise_inconsistency(
        plan_id=plan_id,
        diff_id=diff_id,
        message=(
            "Master Plan 更新失败，且 Training Goal 回滚失败；"
            "数据可能暂时不一致，请联系支持后再重试"
        ),
        cause=rollback_error,
    )


def apply_active_master_diff(
    *,
    store: Any,
    user_id: str,
    plan_id: str,
    plan: Any,
    diff: MasterPlanDiff,
    requested_op_ids: list[str],
    change_reason: str,
    read_json_func: Callable[[str], Any],
    write_json_func: Callable[[str, Any], Any],
    validate_diff_func: Callable[[Any, MasterPlanDiff], list[str]],
    apply_diff_func: Callable[[Any, str, MasterPlanDiff, list[str], str], Any],
    logger: logging.Logger,
) -> tuple[Any, list[str]]:
    accepted_op_ids = accepted_master_op_ids(diff, requested_op_ids)
    selected_diff = validate_accepted_master_diff(
        plan,
        diff,
        accepted_op_ids,
        validate_diff_func=validate_diff_func,
        logger=logger,
    )
    race_op = _accepted_race_reschedule(selected_diff, accepted_op_ids)
    race_time_op = _accepted_target_race_time_update(selected_diff, accepted_op_ids)
    goal_original: dict[str, Any] | None = None
    goal_updated: dict[str, Any] | None = None
    goal_source: str | None = None
    if race_op is not None:
        goal_original, goal_updated, goal_source = _prepare_training_goal_reschedule(
            user_id, plan, race_op, read_json_func=read_json_func
        )
    elif race_time_op is not None:
        goal_original, goal_updated, goal_source = _prepare_training_goal_time_update(
            user_id, plan, race_time_op, read_json_func=read_json_func
        )

    goal_path = f"{user_id}/training_goal.json"
    if goal_updated is not None:
        try:
            write_source = str(write_json_func(goal_path, goal_updated))
            if write_source != goal_source:
                # A blob read followed by a file fallback write did not update the
                # durable source that the plan is synchronized against.
                try:
                    write_json_func(goal_path, goal_original)
                except Exception:
                    logger.error(
                        "master apply: failed to clean fallback Training Goal write",
                        exc_info=True,
                    )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail={
                        "code": "training_goal_source_mismatch",
                        "message": "Training Goal 未写入原存储源，请稍后重试",
                        "expected_source": goal_source,
                        "write_source": write_source,
                    },
                )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — resolve ambiguous write
            logger.exception(
                "master apply: Training Goal write raised plan_id=%s diff_id=%s",
                plan_id,
                diff.diff_id,
            )
            try:
                observed_goal = _read_goal_after_error(user_id, read_json_func)
            except Exception as read_exc:  # noqa: BLE001 — state is unknowable
                _raise_inconsistency(
                    plan_id=plan_id,
                    diff_id=diff.diff_id,
                    message="Training Goal 写入结果无法确认，请联系支持后再重试",
                    cause=read_exc,
                )
            if observed_goal == goal_original:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Training Goal 暂时无法更新，请稍后重试",
                ) from exc
            if observed_goal == goal_updated:
                _rollback_training_goal(
                    user_id=user_id,
                    plan_id=plan_id,
                    diff_id=diff.diff_id,
                    original=goal_original,
                    read_json_func=read_json_func,
                    write_json_func=write_json_func,
                    logger=logger,
                )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Training Goal 暂时无法更新，请稍后重试",
                ) from exc
            _raise_inconsistency(
                plan_id=plan_id,
                diff_id=diff.diff_id,
                message="Training Goal 写入结果不明确，请联系支持后再重试",
                cause=exc,
            )

    bridge = MasterStoreBridge(store, user_id, plan)
    try:
        updated_plan = apply_diff_func(
            bridge, plan_id, diff, accepted_op_ids, change_reason
        )
    except Exception as exc:  # noqa: BLE001 — resolve ambiguous plan write
        try:
            observed_plan = store.get_plan(user_id, plan_id)
        except Exception as read_exc:  # noqa: BLE001 — state is unknowable
            _raise_inconsistency(
                plan_id=plan_id,
                diff_id=diff.diff_id,
                message="Master Plan 更新结果无法确认，请联系支持后再重试",
                cause=read_exc,
            )
        if (
            observed_plan is not None
            and observed_plan.version == plan.version + 1
            and _plan_matches_atomic_goal_update(observed_plan, race_op, race_time_op)
        ):
            if goal_updated is not None:
                try:
                    observed_goal = _read_goal_after_error(user_id, read_json_func)
                except Exception as read_exc:  # noqa: BLE001 — cannot prove atomic success
                    _raise_inconsistency(
                        plan_id=plan_id,
                        diff_id=diff.diff_id,
                        message="Training Goal 更新结果无法确认，请联系支持后再重试",
                        cause=read_exc,
                    )
                if observed_goal != goal_updated:
                    _raise_inconsistency(
                        plan_id=plan_id,
                        diff_id=diff.diff_id,
                        message="Master Plan 已更新但 Training Goal 未同步，请联系支持",
                        cause=exc,
                    )
            return observed_plan, accepted_op_ids
        if observed_plan is None or observed_plan.version != plan.version:
            _raise_inconsistency(
                plan_id=plan_id,
                diff_id=diff.diff_id,
                message="Master Plan 更新结果不明确，请联系支持后再重试",
                cause=exc,
            )
        if goal_original is not None:
            _rollback_training_goal(
                user_id=user_id,
                plan_id=plan_id,
                diff_id=diff.diff_id,
                original=goal_original,
                read_json_func=read_json_func,
                write_json_func=write_json_func,
                logger=logger,
            )
        if not isinstance(exc, _MALFORMED_DIFF_ERRORS):
            raise
        logger.warning("master apply: rejecting malformed diff: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整数据非法，无法应用",
        ) from exc
    return updated_plan, accepted_op_ids


def _accepted_race_reschedule(
    diff: MasterPlanDiff, accepted_op_ids: list[str]
) -> MasterPlanDiffOp | None:
    accepted = set(accepted_op_ids)
    matches = [
        op
        for op in diff.ops
        if op.id in accepted
        and op.accepted is not False
        and op.op == MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE
    ]
    return matches[0] if matches else None


def _accepted_target_race_time_update(
    diff: MasterPlanDiff, accepted_op_ids: list[str]
) -> MasterPlanDiffOp | None:
    accepted = set(accepted_op_ids)
    matches = [
        op
        for op in diff.ops
        if op.id in accepted
        and op.accepted is not False
        and op.op == MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME
    ]
    return matches[0] if matches else None


def _prepare_training_goal_reschedule(
    user_id: str,
    plan: Any,
    op: MasterPlanDiffOp,
    *,
    read_json_func: Callable[[str], Any],
) -> tuple[dict[str, Any], dict[str, Any], str]:
    item = _read_goal_item(user_id, read_json_func)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不存在，无法安全同步目标比赛日期",
        )
    original, source = item
    current = original.get("current")
    if not isinstance(current, dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不存在，无法安全同步目标比赛日期",
        )
    if current.get("type") != "race":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不是比赛目标，无法同步目标比赛日期",
        )
    external_time_raw = str(current.get("target_finish_time") or "")
    embedded_time_raw = str(plan.goal.target_time or "")
    try:
        external_time = (
            normalise_target_race_time(external_time_raw)
            if external_time_raw
            else ""
        )
        embedded_time = (
            normalise_target_race_time(embedded_time_raw)
            if embedded_time_raw
            else ""
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前目标成绩格式无效，请先修正 Training Goal",
        ) from exc
    plan_distance = getattr(plan.goal.distance, "value", str(plan.goal.distance))
    if (
        current.get("goal_id") != plan.goal.goal_id
        or current.get("race_date") != plan.goal.race_date
        or current.get("race_distance") != plan_distance
        or external_time != embedded_time
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Training Goal 与当前 Master Plan 不一致，请刷新后重试",
        )
    new_date = (op.spec_patch or {}).get("race_date")
    updated_current = dict(current)
    updated_current["race_date"] = new_date
    updated_current["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = dict(original)
    updated["current"] = updated_current
    return original, updated, source


def _prepare_training_goal_time_update(
    user_id: str,
    plan: Any,
    op: MasterPlanDiffOp,
    *,
    read_json_func: Callable[[str], Any],
) -> tuple[dict[str, Any], dict[str, Any], str]:
    item = _read_goal_item(user_id, read_json_func)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不存在，无法安全同步目标成绩",
        )
    original, source = item
    current = original.get("current")
    if not isinstance(current, dict) or current.get("type") != "race":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不是比赛目标，无法同步目标成绩",
        )
    external_time_raw = str(current.get("target_finish_time") or "")
    embedded_time_raw = str(plan.goal.target_time or "")
    try:
        external_time = normalise_target_race_time(external_time_raw) if external_time_raw else ""
        embedded_time = normalise_target_race_time(embedded_time_raw) if embedded_time_raw else ""
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前目标成绩格式无效，请先修正 Training Goal",
        ) from exc
    plan_distance = getattr(plan.goal.distance, "value", str(plan.goal.distance))
    if (
        current.get("goal_id") != plan.goal.goal_id
        or current.get("race_date") != plan.goal.race_date
        or current.get("race_distance") != plan_distance
        or external_time != embedded_time
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Training Goal 与当前 Master Plan 不一致，请刷新后重试",
        )
    new_time = (op.spec_patch or {}).get("target_time")
    updated_current = dict(current)
    updated_current["target_finish_time"] = new_time
    updated_current["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = dict(original)
    updated["current"] = updated_current
    return original, updated, source
