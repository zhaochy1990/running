"""Draft-tool implementations — see plan §5.2.

* 7 week-scope tools (return ``PlanDiff``) — real impls (US-007).
* 10 master-scope tools (return ``MasterPlanDiff``).

A draft tool's job is to propose a change as a typed diff; it never applies
the change. The route handler accepts the diff back (Pattern Y) and runs
``apply_diff`` against the per-user plan store.

Old/new value rendering is deliberately optional — the UI surfaces the
``spec_patch`` for accepted ops, and the diff's ``ai_explanation`` carries
the human-readable reason. Tools that want to populate ``old_value`` query
the planned_session store; tools that don't (e.g. ``regenerate_week``) leave
it None.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from coach.schemas import ToolResult
from coach.graphs.conversation.master_diff_gate import is_short_taper_phase
from stride_core.plan_diff import DiffOp, DiffOpKind, PlanDiff
from stride_core.timefmt import today_shanghai

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _empty_diff(folder: str, explanation: str) -> PlanDiff:
    return PlanDiff(
        diff_id=str(uuid4()),
        folder=folder,
        ops=[],
        ai_explanation=explanation,
        created_at=_now_iso(),
    )


def _ok(diff: PlanDiff) -> ToolResult:
    return ToolResult(ok=True, data=diff.model_dump())


def _fail(*errors: str) -> ToolResult:
    return ToolResult(ok=False, errors=list(errors))


# ---------------------------------------------------------------------------
# Helpers — look up current planned_session by (date, session_index)
# ---------------------------------------------------------------------------


def _get_plan(user_id: str, folder: str):
    from stride_server.weekly_plan_store import get_weekly_plan_store

    return get_weekly_plan_store().get_plan(user_id, folder)


def _lookup_session(plan: Any, date: str, session_index: int) -> dict | None:
    if plan is None:
        return None
    for session in plan.sessions:
        if session.date == date and session.session_index == session_index:
            return session.to_dict()
    return None


def _session_summary(row: dict | None) -> dict | None:
    """Reduce a planned_session row to a small UI-friendly payload."""
    if row is None:
        return None
    return {
        "date": row.get("date"),
        "session_index": row.get("session_index"),
        "kind": row.get("kind"),
        "summary": row.get("summary"),
        "total_distance_m": row.get("total_distance_m"),
        "total_duration_s": row.get("total_duration_s"),
    }


# ---------------------------------------------------------------------------
# 1. swap_sessions — two MOVE_SESSION ops
# ---------------------------------------------------------------------------


class SwapSessionsImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(self, *, folder: str, date_a: str, date_b: str) -> ToolResult:
        try:
            plan = _get_plan(self._user_id, folder)
            sess_a = _lookup_session(plan, date_a, 0)
            sess_b = _lookup_session(plan, date_b, 0)
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")

        if sess_a is None and sess_b is None:
            return _fail(f"no sessions found on either {date_a} or {date_b}")

        diff = _empty_diff(folder, f"调换 {date_a} 与 {date_b} 的训练")
        ops: list[DiffOp] = []
        # Move A → B
        if sess_a is not None:
            ops.append(
                DiffOp(
                    id=str(uuid4()),
                    op=DiffOpKind.MOVE_SESSION,
                    date=date_a,
                    session_index=0,
                    old_value=_session_summary(sess_a),
                    new_value={"date": date_b, "session_index": 0},
                    spec_patch={"new_date": date_b, "new_session_index": 0},
                    accepted=None,
                )
            )
        # Move B → A
        if sess_b is not None:
            ops.append(
                DiffOp(
                    id=str(uuid4()),
                    op=DiffOpKind.MOVE_SESSION,
                    date=date_b,
                    session_index=0,
                    old_value=_session_summary(sess_b),
                    new_value={"date": date_a, "session_index": 0},
                    spec_patch={"new_date": date_a, "new_session_index": 0},
                    accepted=None,
                )
            )
        diff = diff.model_copy(update={"ops": ops})
        return _ok(diff)


# ---------------------------------------------------------------------------
# 2. shift_session — single MOVE_SESSION
# ---------------------------------------------------------------------------


class ShiftSessionImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(
        self, *, folder: str, date: str, to_date: str, session_index: int = 0
    ) -> ToolResult:
        try:
            sess = _lookup_session(
                _get_plan(self._user_id, folder), date, session_index
            )
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")
        if sess is None:
            return _fail(f"no session at {date} idx={session_index}")
        op = DiffOp(
            id=str(uuid4()),
            op=DiffOpKind.MOVE_SESSION,
            date=date,
            session_index=session_index,
            old_value=_session_summary(sess),
            new_value={"date": to_date, "session_index": session_index},
            spec_patch={"new_date": to_date, "new_session_index": session_index},
            accepted=None,
        )
        diff = _empty_diff(folder, f"把 {date} 的训练挪到 {to_date}")
        return _ok(diff.model_copy(update={"ops": [op]}))


# ---------------------------------------------------------------------------
# 3. reduce_intensity — N REPLACE_DISTANCE / REPLACE_NOTE ops
# ---------------------------------------------------------------------------


class ReduceIntensityImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(
        self, *, folder: str, scope: str, factor: float, reason: str
    ) -> ToolResult:
        if scope not in ("week", "day"):
            return _fail(f"scope must be 'week' or 'day', got {scope!r}")
        if not (0.1 <= factor <= 1.0):
            return _fail(f"factor must be in (0.1, 1.0], got {factor}")

        try:
            plan = _get_plan(self._user_id, folder)
            sessions = [session.to_dict() for session in plan.sessions] if plan else []
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")

        ops: list[DiffOp] = []
        for s in sessions:
            row = dict(s)
            if row.get("kind") != "run":
                continue
            dist_m = row.get("total_distance_m")
            if dist_m is None:
                continue
            new_dist = round(dist_m * factor)
            ops.append(
                DiffOp(
                    id=str(uuid4()),
                    op=DiffOpKind.REPLACE_DISTANCE,
                    date=row["date"],
                    session_index=row.get("session_index", 0),
                    old_value={"total_distance_m": dist_m},
                    new_value={"total_distance_m": new_dist},
                    spec_patch={"total_distance_m": new_dist},
                    accepted=None,
                )
            )
        if not ops:
            return _fail("no run sessions in this week to reduce")
        diff = _empty_diff(folder, f"按 {int(factor*100)}% 强度调整本周训练：{reason}")
        return _ok(diff.model_copy(update={"ops": ops}))


# ---------------------------------------------------------------------------
# 4. replace_session — REPLACE_KIND
# ---------------------------------------------------------------------------


def _normalise_replace_params(params: dict) -> dict:
    """Map common model-friendly units to canonical PlannedSession fields."""
    normalized = dict(params)
    if normalized.get("total_duration_s") is None:
        minutes = normalized.get("duration_min")
        if minutes is None:
            minutes = normalized.get("duration_minutes")
        if minutes is not None:
            try:
                duration_s = round(float(minutes) * 60)
            except (TypeError, ValueError):
                duration_s = 0
            if duration_s > 0:
                normalized["total_duration_s"] = duration_s
    if normalized.get("total_distance_m") is None:
        distance_km = normalized.get("distance_km")
        if distance_km is not None:
            try:
                distance_m = round(float(distance_km) * 1000)
            except (TypeError, ValueError):
                distance_m = 0
            if distance_m > 0:
                normalized["total_distance_m"] = distance_m
    return normalized


class ReplaceSessionImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(
        self,
        *,
        folder: str,
        date: str,
        session_index: int,
        new_kind: str,
        params: dict,
    ) -> ToolResult:
        if new_kind not in ("run", "strength", "rest", "cross", "note"):
            return _fail(f"unknown session kind {new_kind!r}")
        try:
            sess = _lookup_session(
                _get_plan(self._user_id, folder), date, session_index
            )
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")
        if sess is None:
            return _fail(f"no session at {date} idx={session_index}")
        params = _normalise_replace_params(params)
        op = DiffOp(
            id=str(uuid4()),
            op=DiffOpKind.REPLACE_KIND,
            date=date,
            session_index=session_index,
            old_value=_session_summary(sess),
            new_value={"kind": new_kind, **params},
            spec_patch={
                "kind": new_kind,
                "summary": params.get("summary", sess.get("summary") or ""),
                "notes_md": params.get("notes_md"),
                "total_distance_m": params.get("total_distance_m"),
                "total_duration_s": params.get("total_duration_s"),
                "spec_json": params.get("spec_json"),
            },
            accepted=None,
        )
        diff = _empty_diff(folder, f"把 {date} 的训练改为 {new_kind}")
        return _ok(diff.model_copy(update={"ops": [op]}))


# ---------------------------------------------------------------------------
# 5. add_strength_session — ADD_SESSION
# ---------------------------------------------------------------------------


class AddStrengthSessionImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(self, *, folder: str, date: str, focus: str) -> ToolResult:
        try:
            plan = _get_plan(self._user_id, folder)
            existing = [session.to_dict() for session in plan.sessions] if plan else []
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")
        on_day = [s for s in existing if dict(s).get("date") == date]
        new_idx = max((dict(s).get("session_index", 0) for s in on_day), default=-1) + 1

        op = DiffOp(
            id=str(uuid4()),
            op=DiffOpKind.ADD_SESSION,
            date=date,
            session_index=new_idx,
            old_value=None,
            new_value={"kind": "strength", "focus": focus},
            spec_patch={
                "kind": "strength",
                "summary": f"力量训练 — {focus}",
                "notes_md": f"focus: {focus}",
            },
            accepted=None,
        )
        diff = _empty_diff(folder, f"在 {date} 增加力量训练（{focus}）")
        return _ok(diff.model_copy(update={"ops": [op]}))


# ---------------------------------------------------------------------------
# 6. change_pace_target — REPLACE_DISTANCE with new pace embedded in summary
# ---------------------------------------------------------------------------


class ChangePaceTargetImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(
        self,
        *,
        folder: str,
        date: str,
        session_index: int,
        new_pace_s_per_km: int,
    ) -> ToolResult:
        if new_pace_s_per_km <= 0:
            return _fail(f"new_pace_s_per_km must be > 0, got {new_pace_s_per_km}")
        try:
            sess = _lookup_session(
                _get_plan(self._user_id, folder), date, session_index
            )
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")
        if sess is None:
            return _fail(f"no session at {date} idx={session_index}")
        pace_str = f"{new_pace_s_per_km // 60}:{new_pace_s_per_km % 60:02d}/km"
        op = DiffOp(
            id=str(uuid4()),
            op=DiffOpKind.REPLACE_DISTANCE,  # carries pace via summary text
            date=date,
            session_index=session_index,
            old_value=_session_summary(sess),
            new_value={"summary_pace": pace_str, "pace_s_per_km": new_pace_s_per_km},
            spec_patch={
                "summary": f"{sess.get('summary') or '配速跑'} @ {pace_str}",
            },
            accepted=None,
        )
        diff = _empty_diff(folder, f"把 {date} 的配速目标改为 {pace_str}")
        return _ok(diff.model_copy(update={"ops": [op]}))


# ---------------------------------------------------------------------------
# 7. regenerate_week — REMOVE all + ai_explanation pointing at follow-up
# ---------------------------------------------------------------------------


class RegenerateWeekImpl:
    """Produce a 'clear this week' diff. The actual fresh plan is generated by
    the generation pipeline (Phase 5) — this draft tool just records the
    user's intent + constraints so the UI can chain into ``POST /generate``.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def __call__(
        self, *, folder: str, reason: str, constraints: list[str]
    ) -> ToolResult:
        try:
            plan = _get_plan(self._user_id, folder)
            sessions = [session.to_dict() for session in plan.sessions] if plan else []
        except Exception as exc:  # noqa: BLE001
            return _fail(f"db lookup failed: {exc}")
        ops: list[DiffOp] = []
        for s in sessions:
            row = dict(s)
            ops.append(
                DiffOp(
                    id=str(uuid4()),
                    op=DiffOpKind.REMOVE_SESSION,
                    date=row["date"],
                    session_index=row.get("session_index", 0),
                    old_value=_session_summary(row),
                    new_value=None,
                    spec_patch=None,
                    accepted=None,
                )
            )
        diff = _empty_diff(
            folder,
            f"清空本周训练以重新生成 — 原因：{reason}；约束：{', '.join(constraints) or '无'}",
        )
        return _ok(diff.model_copy(update={"ops": ops}))


# ---------------------------------------------------------------------------
# Master-scope (10) — emit MasterPlanDiff
# ---------------------------------------------------------------------------

from datetime import date as _date, timedelta as _timedelta
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
    build_target_race_time_patch,
    build_target_race_reschedule_patch,
)


def _open_master_plan(user_id: str, plan_id: str):
    """Return the MasterPlan or None if absent."""
    from stride_server.master_plan_store import get_master_plan_store

    return get_master_plan_store().get_plan(user_id, plan_id)


def _resolve_master_plan_loader(
    user_id: str, plan_loader: Callable[[str], Any] | None
) -> Callable[[str], Any]:
    return plan_loader or (lambda plan_id: _open_master_plan(user_id, plan_id))


def _empty_master_diff(plan_id: str, explanation: str) -> MasterPlanDiff:
    return MasterPlanDiff(
        diff_id=str(uuid4()),
        plan_id=plan_id,
        ops=[],
        ai_explanation=explanation,
        created_at=_now_iso(),
    )


def _ok_master(diff: MasterPlanDiff) -> ToolResult:
    return ToolResult(ok=True, data=diff.model_dump())


def _shift_phase_end(end_date: str, weeks: int) -> str:
    d = _date.fromisoformat(end_date) + _timedelta(weeks=weeks)
    return d.isoformat()


class ExtendPhaseImpl:
    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(self, *, plan_id: str, phase_id: str, weeks: int) -> ToolResult:
        if weeks <= 0:
            return _fail(f"weeks must be positive, got {weeks}")
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        phase = next((p for p in plan.phases if p.id == phase_id), None)
        if phase is None:
            return _fail(f"phase {phase_id!r} not in plan")
        new_end = _shift_phase_end(phase.end_date, weeks)
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.RESIZE_PHASE,
            phase_id=phase_id,
            old_value={"end_date": phase.end_date},
            new_value={"end_date": new_end},
            spec_patch={"end_date": new_end},
        )
        diff = _empty_master_diff(plan_id, f"将 {phase.name} 延长 {weeks} 周至 {new_end}")
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class CompressPhaseImpl:
    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(self, *, plan_id: str, phase_id: str, weeks: int) -> ToolResult:
        if weeks <= 0:
            return _fail(f"weeks must be positive, got {weeks}")
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        phase = next((p for p in plan.phases if p.id == phase_id), None)
        if phase is None:
            return _fail(f"phase {phase_id!r} not in plan")
        if phase is plan.phases[-1] and is_short_taper_phase(phase):
            return _fail(
                f"最后 1–2 周的调整期「{phase.name}」必须完整保留，不能再缩短；"
                "请调整更早阶段的周跑量，或拒绝这次要求"
            )
        new_end = _shift_phase_end(phase.end_date, -weeks)
        # Refuse a compress that would collapse the phase below its start
        if _date.fromisoformat(new_end) <= _date.fromisoformat(phase.start_date):
            return _fail(
                f"compressing {phase.name} by {weeks} weeks would end on/before its start"
            )
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.RESIZE_PHASE,
            phase_id=phase_id,
            old_value={"end_date": phase.end_date},
            new_value={"end_date": new_end},
            spec_patch={"end_date": new_end},
        )
        diff = _empty_master_diff(plan_id, f"将 {phase.name} 缩短 {weeks} 周至 {new_end}")
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class ShiftMilestoneImpl:
    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(
        self, *, plan_id: str, milestone_id: str, new_date: str
    ) -> ToolResult:
        try:
            _date.fromisoformat(new_date)
        except ValueError:
            return _fail(f"new_date must be ISO YYYY-MM-DD, got {new_date!r}")
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        ms = next((m for m in plan.milestones if m.id == milestone_id), None)
        if ms is None:
            return _fail(f"milestone {milestone_id!r} not in plan")
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE,
            milestone_id=milestone_id,
            old_value={"date": ms.date},
            new_value={"date": new_date},
            spec_patch={"date": new_date},
        )
        diff = _empty_master_diff(plan_id, f"将里程碑 {ms.target} 改到 {new_date}")
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class RescheduleTargetRaceImpl:
    """Move the target race as one indivisible season-plan operation."""

    def __init__(
        self,
        user_id: str,
        *,
        plan_loader: Callable[[str], Any] | None = None,
        as_of: _date | None = None,
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)
        self._as_of = as_of

    def __call__(
        self, *, plan_id: str, milestone_id: str, new_date: str, reason: str
    ) -> ToolResult:
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        try:
            patch = build_target_race_reschedule_patch(
                plan, milestone_id, new_date, as_of=self._as_of
            )
        except (TypeError, ValueError) as exc:
            return _fail(str(exc))

        milestone = next(item for item in plan.milestones if item.id == milestone_id)
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id=milestone_id,
            old_value={
                "race_date": plan.goal.race_date,
                "plan_end_date": plan.end_date,
                "milestone_date": milestone.date,
            },
            new_value=patch,
            spec_patch=patch,
        )
        diff = _empty_master_diff(
            plan_id,
            f"将目标比赛从 {milestone.date} 调整到 {new_date}，并原子同步赛季和 taper 边界"
            f"（原因：{reason}）",
        )
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class ChangeTargetImpl:
    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(
        self, *, plan_id: str, milestone_id: str, new_target_time: str
    ) -> ToolResult:
        if not new_target_time:
            return _fail("new_target_time must be non-empty")
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        ms = next((m for m in plan.milestones if m.id == milestone_id), None)
        if ms is None:
            return _fail(f"milestone {milestone_id!r} not in plan")
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.REPLACE_MILESTONE_TARGET,
            milestone_id=milestone_id,
            old_value={"target": ms.target},
            new_value={"target": new_target_time},
            spec_patch={"target": new_target_time},
        )
        diff = _empty_master_diff(plan_id, f"把目标 {ms.target} 改为 {new_target_time}")
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class UpdateTargetRaceTimeImpl:
    """Change the season goal race time as one indivisible operation."""

    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(
        self,
        *,
        plan_id: str,
        milestone_id: str,
        new_target_time: str,
        reason: str,
    ) -> ToolResult:
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        try:
            patch = build_target_race_time_patch(
                plan, milestone_id, new_target_time
            )
        except (TypeError, ValueError) as exc:
            return _fail(str(exc))

        milestone = next(item for item in plan.milestones if item.id == milestone_id)
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME,
            milestone_id=milestone_id,
            old_value={
                "target_time": plan.goal.target_time,
                "milestone_target": milestone.target,
            },
            new_value=patch,
            spec_patch=patch,
        )
        diff = _empty_master_diff(
            plan_id,
            f"将目标比赛成绩从 {plan.goal.target_time} 调整到 {patch['target_time']}"
            f"，并原子同步目标状态（原因：{reason}）",
        )
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class SetPhaseWeeklyRangeImpl:
    """Propose one exact weekly-distance range for a master-plan phase."""

    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(
        self,
        *,
        plan_id: str,
        phase_id: str,
        weekly_distance_km_low: float,
        weekly_distance_km_high: float,
        adjustment_request: str,
        reason: str,
    ) -> ToolResult:
        low = float(weekly_distance_km_low)
        high = float(weekly_distance_km_high)
        if (
            not math.isfinite(low)
            or not math.isfinite(high)
            or low < 0
            or high <= 0
            or low > high
        ):
            return _fail(
                "weekly distance range must be finite and satisfy "
                "0 <= low <= high and high > 0"
            )
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        phase = next((item for item in plan.phases if item.id == phase_id), None)
        if phase is None:
            return _fail(f"phase {phase_id!r} not in plan")
        if (
            round(low, 1) == round(float(phase.weekly_distance_km_low), 1)
            and round(high, 1) == round(float(phase.weekly_distance_km_high), 1)
        ):
            return _fail(
                f"phase {phase_id!r} already has weekly distance range "
                f"{low:g}-{high:g} km; no proposal is needed"
            )
        old_range = {
            "weekly_distance_km_low": phase.weekly_distance_km_low,
            "weekly_distance_km_high": phase.weekly_distance_km_high,
        }
        new_range = {
            "weekly_distance_km_low": round(low, 1),
            "weekly_distance_km_high": round(high, 1),
        }
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
            phase_id=phase_id,
            old_value=old_range,
            new_value=new_range,
            spec_patch=new_range,
        )
        from coach.graphs.conversation.master_adjustment_direction import (
            master_diff_matches_volume_request,
        )

        candidate = _empty_master_diff(plan_id, "").model_copy(
            update={"ops": [op]}
        )
        if not master_diff_matches_volume_request(candidate, adjustment_request):
            return _fail(
                "weekly distance range does not match the exact range or percentage "
                "in adjustment_request"
            )
        explanation = (
            f"将「{phase.name}」周跑量从 "
            f"{phase.weekly_distance_km_low:g}–{phase.weekly_distance_km_high:g} km "
            f"调整为 {low:g}–{high:g} km"
            f"（用户请求：{adjustment_request}；原因：{reason}）"
        )
        diff = candidate.model_copy(update={"ai_explanation": explanation})
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class SetPhaseFocusImpl:
    """Propose one exact training-focus description for a plan phase."""

    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(
        self,
        *,
        plan_id: str,
        phase_id: str,
        focus: str,
        reason: str,
    ) -> ToolResult:
        if not isinstance(focus, str):
            return _fail("focus must be text")
        requested_focus = focus.strip()
        if not requested_focus:
            return _fail("focus must be non-empty")
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        phase = next((item for item in plan.phases if item.id == phase_id), None)
        if phase is None:
            return _fail(f"phase {phase_id!r} not in plan")
        if requested_focus == phase.focus.strip():
            return _fail(
                f"phase {phase_id!r} already uses the requested focus; "
                "no proposal is needed"
            )

        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
            phase_id=phase_id,
            old_value={"focus": phase.focus},
            new_value={"focus": requested_focus},
            spec_patch={"focus": requested_focus},
        )
        diff = _empty_master_diff(
            plan_id,
            f"将「{phase.name}」训练重点从“{phase.focus}”调整为"
            f"“{requested_focus}”（原因：{reason}）",
        )
        return _ok_master(diff.model_copy(update={"ops": [op]}))


class ProposeReductionAlternativesImpl:
    """Return 2 distinct load-reduction alternatives (5% and 10%).

    Preserve the final taper/adjustment phase and offer two load-reduction
    magnitudes for the current Shanghai-day phase (or the nearest upcoming
    phase when the plan has a gap).  If no current/upcoming phase has a usable
    weekly-distance range, refusing is safer than removing the taper or
    rewriting completed history.
    """

    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(self, *, plan_id: str, reduction_request: str) -> ToolResult:
        from coach.graphs.conversation.master_adjustment_direction import (
            requested_weekly_volume_direction,
        )

        if requested_weekly_volume_direction(reduction_request) != "decrease":
            return _fail(
                "propose_reduction_alternatives requires an explicit weekly-volume "
                "reduction request; increases are not supported by this tool"
            )
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        if not plan.phases:
            return _fail("plan has no phases to alternate over")
        final_phase = plan.phases[-1]
        has_protected_taper = is_short_taper_phase(final_phase)
        candidates = (
            plan.phases[:-1]
            if has_protected_taper
            else plan.phases
        )
        today = today_shanghai()
        adjustable: list[tuple[_date, _date, Any]] = []
        for phase in candidates:
            try:
                phase_start = _date.fromisoformat(phase.start_date)
                phase_end = _date.fromisoformat(phase.end_date)
            except ValueError:
                continue
            if (
                not phase.is_completed
                and phase_end >= today
                and 0 <= phase.weekly_distance_km_low <= phase.weekly_distance_km_high
                and phase.weekly_distance_km_high > 0
            ):
                adjustable.append((phase_start, phase_end, phase))

        current = [
            item for item in adjustable if item[0] <= today <= item[1]
        ]
        upcoming = [item for item in adjustable if item[0] > today]
        selected = (
            max(current, key=lambda item: item[0])
            if current
            else (min(upcoming, key=lambda item: item[0]) if upcoming else None)
        )
        target = selected[2] if selected is not None else None
        if target is None:
            prefix = (
                "为保护最后 1–2 周必须保留的调整期，"
                if has_protected_taper
                else ""
            )
            return _fail(
                f"{prefix}当前计划没有可安全降低周跑量的当前或后续阶段；"
                "无法生成可应用的替代方案，请保留现有计划或重新评估该要求"
            )

        alternatives: list[dict] = []
        old_range = {
            "weekly_distance_km_low": target.weekly_distance_km_low,
            "weekly_distance_km_high": target.weekly_distance_km_high,
        }
        for label, reduction in (
            ("方案 A（温和减量）", 0.05),
            ("方案 B（明显减量）", 0.10),
        ):
            new_range = {
                "weekly_distance_km_low": round(
                    target.weekly_distance_km_low * (1 - reduction), 1
                ),
                "weekly_distance_km_high": round(
                    target.weekly_distance_km_high * (1 - reduction), 1
                ),
            }
            op = MasterPlanDiffOp(
                id=str(uuid4()),
                op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
                phase_id=target.id,
                old_value=old_range,
                new_value=new_range,
                spec_patch=new_range,
            )
            diff = MasterPlanDiff(
                diff_id=str(uuid4()),
                plan_id=plan_id,
                ops=[op],
                ai_explanation=(
                    f"{label}："
                    f"{'保留最后的调整期不变，' if has_protected_taper else ''}"
                    f"将「{target.name}」周跑量降低"
                    f" {int(reduction * 100)}%（用户减量请求：{reduction_request}）"
                ),
                created_at=_now_iso(),
            )
            alternatives.append(diff.model_dump())
        return ToolResult(
            ok=True,
            data={
                "alternatives": alternatives,
                "reduction_request": reduction_request,
            },
        )


class RegenerateMasterImpl:
    """Mark every existing phase + milestone for removal so the user can chain
    into a fresh ``POST /master-plan/generate`` job. Like regenerate_week, this
    is a draft-only signal — the generation pipeline (US-008/Phase 5) runs
    separately."""

    def __init__(
        self, user_id: str, *, plan_loader: Callable[[str], Any] | None = None
    ) -> None:
        self._load_plan = _resolve_master_plan_loader(user_id, plan_loader)

    def __call__(self, *, plan_id: str, reason: str) -> ToolResult:
        plan = self._load_plan(plan_id)
        if plan is None:
            return _fail(f"master plan {plan_id!r} not found")
        ops: list[MasterPlanDiffOp] = []
        for phase in plan.phases:
            ops.append(
                MasterPlanDiffOp(
                    id=str(uuid4()),
                    op=MasterPlanDiffOpKind.REMOVE_PHASE,
                    phase_id=phase.id,
                    old_value={"name": phase.name, "end_date": phase.end_date},
                )
            )
        for ms in plan.milestones:
            ops.append(
                MasterPlanDiffOp(
                    id=str(uuid4()),
                    op=MasterPlanDiffOpKind.REMOVE_MILESTONE,
                    milestone_id=ms.id,
                    old_value={"date": ms.date, "target": ms.target},
                )
            )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan_id,
            ops=ops,
            ai_explanation=f"清空当前总纲, 准备重新生成 — 原因: {reason}",
            created_at=_now_iso(),
        )
        return _ok_master(diff)
