"""Deterministic validation gate for ``MasterPlanDiff`` (spec §10 open Q#6).

A season-plan amend turn produces a ``MasterPlanDiff`` from the LLM's draft-tool
call, and the stateless ``/coach/master-plan/{plan_id}/apply`` endpoint accepts a
client-supplied diff. Before either lands, the diff must satisfy a few structural
invariants — otherwise a phase could be inverted, a milestone parked outside the
season, a weekly range flipped, or a stale id edited.

This gate is **pure and deterministic** (no LLM, no DB): it takes the current
:class:`MasterPlan` plus the proposed :class:`MasterPlanDiff` and returns a list
of human-readable violation strings (empty list = valid). ``coach.*`` core may
depend on the ``master_plan`` / ``master_plan_diff`` domain primitives, so this
lives in core and is unit-testable without infrastructure.

Dates are parsed through :func:`datetime.date.fromisoformat` rather than compared
as strings — an LLM-emitted non-ISO / non-zero-padded date (``2026-9-1``) would
otherwise sort lexicographically wrong and slip an inverted window past the gate.

Scope is structural breakage only, never style/quality (that's the LLM's job).
Only *accepted-or-pending* ops are checked — an explicitly rejected op can't land.
"""

from __future__ import annotations

import math
from datetime import date as _date

from stride_core.master_plan import MasterPlan, MilestoneType, PhaseType
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
)

_Kind = MasterPlanDiffOpKind

# Keys ``_apply_op`` indexes with ``[]`` (not ``.get``) when building the new
# object — absent here means a KeyError inside apply, which the stateless apply
# endpoint surfaces as a 500. The gate is the contract apply relies on, so it
# must require them up front.
_REQUIRED_ADD_PHASE_KEYS = ("id", "name", "start_date", "end_date")
_REQUIRED_ADD_MILESTONE_KEYS = ("id", "type", "date", "phase_id")


def _parse(value: object) -> _date | None:
    """ISO ``YYYY-MM-DD`` → ``date``; anything malformed → ``None``."""
    if not isinstance(value, str):
        return None
    try:
        return _date.fromisoformat(value)
    except ValueError:
        return None


def _within(day: _date, lo: _date | None, hi: _date | None) -> bool:
    """True if ``day`` is inside the plan window (unbounded if a bound is None)."""
    if lo is not None and day < lo:
        return False
    if hi is not None and day > hi:
        return False
    return True


def _weekly_bounds_violation(patch: dict) -> str | None:
    """Shared weekly-range guard: bounds must be numeric and ``low <= high``.

    Both ``REPLACE_WEEKLY_RANGE`` and ``ADD_PHASE`` feed these into ``float()`` in
    apply, so a non-numeric value would otherwise ValueError → 500.
    """
    # Key off *presence*, not None-ness: apply branches on ``key in patch`` and
    # then ``float(value)``, so a key present with value None reaches float(None).
    has_lo = "weekly_distance_km_low" in patch
    has_hi = "weekly_distance_km_high" in patch
    if not has_lo and not has_hi:
        return None
    lo, hi = patch.get("weekly_distance_km_low"), patch.get("weekly_distance_km_high")
    try:
        lo_f = float(lo) if has_lo else None
        hi_f = float(hi) if has_hi else None
    except (TypeError, ValueError, OverflowError):  # OverflowError: int too large for float
        return f"周跑量区间不是合法数值：low={lo} high={hi}"
    # nan/inf are numeric to float(), pass an ordering check (nan>x is always
    # False), and serialize to JSON null — persisting that bricks the plan on the
    # next model_validate read. Require finite, non-negative weekly distances.
    for label, f in (("low", lo_f), ("high", hi_f)):
        if f is not None and (not math.isfinite(f) or f < 0):
            return f"周跑量区间数值非法（{label}={f}），必须是有限非负数"
    if lo_f is not None and hi_f is not None and lo_f > hi_f:
        return f"周跑量区间下限 {lo} 高于上限 {hi}"
    return None


def _check_phase_resize(
    op: MasterPlanDiffOp,
    phases: dict,
    plan_lo: _date | None,
    plan_hi: _date | None,
    protected_final_phase_id: str | None,
) -> str | None:
    phase = phases.get(op.phase_id)
    if phase is None:
        return f"调整的阶段（id={op.phase_id}）不在当前赛季计划里"
    patch = op.spec_patch or {}
    start = _parse(patch.get("start_date", phase.start_date))
    end = _parse(patch.get("end_date", phase.end_date))
    if start is None or end is None:
        return f"阶段「{phase.name}」调整后的起止日期不是合法 ISO 日期"
    if start >= end:
        return (
            f"阶段「{phase.name}」调整后起始 {start.isoformat()} 不早于结束 "
            f"{end.isoformat()}，阶段长度为零或为负"
        )
    if op.phase_id == protected_final_phase_id:
        current_start = _parse(phase.start_date)
        current_end = _parse(phase.end_date)
        if (
            current_start is not None
            and current_end is not None
            and (start > current_start or end < current_end)
        ):
            return f"最后 1–2 周的调整期「{phase.name}」必须完整保留，不能再缩短"
    if not _within(start, plan_lo, plan_hi) or not _within(end, plan_lo, plan_hi):
        return f"阶段「{phase.name}」调整后的日期超出赛季范围"
    return None


def _check_phase_add(
    op: MasterPlanDiffOp, phases: dict, plan_lo: _date | None, plan_hi: _date | None
) -> str | None:
    patch = op.spec_patch or {}
    missing = [k for k in _REQUIRED_ADD_PHASE_KEYS if not patch.get(k)]
    if missing:
        return f"新增阶段缺少必填字段：{', '.join(missing)}"
    if patch.get("id") in phases:
        return f"新增阶段的 id={patch.get('id')} 与现有阶段冲突"
    start = _parse(patch.get("start_date"))
    end = _parse(patch.get("end_date"))
    if start is None or end is None:
        return "新增阶段的起止日期不是合法 ISO 日期"
    if start >= end:
        return f"新增阶段起始 {start.isoformat()} 不早于结束 {end.isoformat()}"
    if not _within(start, plan_lo, plan_hi) or not _within(end, plan_lo, plan_hi):
        return "新增阶段的日期超出赛季范围"
    return _weekly_bounds_violation(patch)


def _check_weekly_range(op: MasterPlanDiffOp, phases: dict) -> str | None:
    phase = phases.get(op.phase_id)
    if phase is None:
        return f"操作引用的阶段（id={op.phase_id}）不存在"
    patch = op.spec_patch or {}
    if not patch:
        return "调整周跑量区间缺少 spec_patch"
    merged = {
        "weekly_distance_km_low": patch.get(
            "weekly_distance_km_low", phase.weekly_distance_km_low
        ),
        "weekly_distance_km_high": patch.get(
            "weekly_distance_km_high", phase.weekly_distance_km_high
        ),
    }
    return _weekly_bounds_violation(merged)


def is_short_taper_phase(phase: object) -> bool:
    """Recognize a protected 1–2 week taper, including legacy plans."""
    phase_type = getattr(phase, "phase_type", None)
    if phase_type is not None:
        is_taper = phase_type == PhaseType.TAPER
    else:
        label = f"{getattr(phase, 'name', '')} {getattr(phase, 'focus', '')}".lower()
        is_taper = any(
            token in label for token in ("taper", "减量", "调整")
        )
    start = _parse(getattr(phase, "start_date", None))
    end = _parse(getattr(phase, "end_date", None))
    return bool(
        is_taper
        and start is not None
        and end is not None
        and 0 < (end - start).days + 1 <= 14
    )


def _check_milestone_date(
    op: MasterPlanDiffOp, milestones: dict, plan_lo: _date | None, plan_hi: _date | None
) -> str | None:
    ms = milestones.get(op.milestone_id)
    if ms is None:
        return f"调整的里程碑（id={op.milestone_id}）不在当前赛季计划里"
    patch = op.spec_patch or {}
    new_date = _parse(patch.get("date", ms.date))
    if new_date is None:
        return f"里程碑「{ms.target}」的新日期不是合法 ISO 日期"
    if not _within(new_date, plan_lo, plan_hi):
        return f"里程碑「{ms.target}」的新日期 {new_date.isoformat()} 超出赛季范围"
    return None


def _check_milestone_add(
    op: MasterPlanDiffOp, phases: dict, milestones: dict, plan_lo: _date | None, plan_hi: _date | None
) -> str | None:
    patch = op.spec_patch or {}
    missing = [k for k in _REQUIRED_ADD_MILESTONE_KEYS if not patch.get(k)]
    if missing:
        return f"新增里程碑缺少必填字段：{', '.join(missing)}"
    try:
        MilestoneType(patch["type"])  # apply does the same; an unknown value 500s
    except ValueError:
        return f"新增里程碑的 type 不是合法类型：{patch.get('type')}"
    if patch.get("id") in milestones:
        return f"新增里程碑的 id={patch.get('id')} 与现有里程碑冲突"
    pid = patch.get("phase_id")
    if pid not in phases:
        return f"新增里程碑引用的阶段（id={pid}）不存在"
    new_date = _parse(patch.get("date"))
    if new_date is None:
        return "新增里程碑的日期不是合法 ISO 日期"
    if not _within(new_date, plan_lo, plan_hi):
        return f"新增里程碑的日期 {new_date.isoformat()} 超出赛季范围"
    return None


def _check_phase_focus(op: MasterPlanDiffOp, phases: dict) -> str | None:
    if op.phase_id not in phases:
        return f"操作引用的阶段（id={op.phase_id}）不存在"
    patch = op.spec_patch or {}
    # focus is written via model_copy (no re-validation) — a non-str value would
    # neither raise nor be caught, persisting a plan that bricks on next read.
    if "focus" in patch and not isinstance(patch["focus"], str):
        return "阶段 focus 必须是文本"
    return None


def _check_milestone_target(op: MasterPlanDiffOp, milestones: dict) -> str | None:
    if op.milestone_id not in milestones:
        return f"操作引用的里程碑（id={op.milestone_id}）不存在"
    patch = op.spec_patch or {}
    if "target" in patch and not isinstance(patch["target"], str):
        return "里程碑 target 必须是文本"
    return None


def _check_ref(op: MasterPlanDiffOp, phases: dict, milestones: dict) -> str | None:
    """Reference integrity — a REMOVE must target an existing object."""
    if op.op == _Kind.REMOVE_PHASE and op.phase_id not in phases:
        return f"操作引用的阶段（id={op.phase_id}）不存在"
    if op.op == _Kind.REMOVE_MILESTONE and op.milestone_id not in milestones:
        return f"操作引用的里程碑（id={op.milestone_id}）不存在"
    return None


def validate_master_diff(plan: MasterPlan, diff: MasterPlanDiff) -> list[str]:
    """Return structural violations of ``diff`` against ``plan`` (empty = valid).

    Invariants (deterministic, date-parsed):

    * **RESIZE_PHASE / ADD_PHASE** — start strictly before end; ADD also stays
      within the season window.
    * **REPLACE_MILESTONE_DATE / ADD_MILESTONE** — the date stays within the
      season's ``[start_date, end_date]`` window.
    * **REPLACE_WEEKLY_RANGE** — ``low <= high``.
    * **Protected final taper** — a final phase of at most 14 inclusive days
      cannot be shortened or removed.
    * **Reference integrity** — REMOVE/REPLACE ops target an existing phase /
      milestone (a stale id can't be applied).
    * Any unparseable ISO date in a relevant patch is itself a violation.
    """
    phases = {p.id: p for p in plan.phases}
    milestones = {m.id: m for m in plan.milestones}
    plan_lo, plan_hi = _parse(plan.start_date), _parse(plan.end_date)
    violations: list[str] = []
    if diff.plan_id != plan.plan_id:
        violations.append(
            f"调整提案属于 plan_id={diff.plan_id}，不是当前计划 {plan.plan_id}"
        )

    active_ops = [op for op in diff.ops if op.accepted is not False]
    removed_phase_ids = {
        op.phase_id
        for op in active_ops
        if op.op == _Kind.REMOVE_PHASE and op.phase_id is not None
    }
    removed_milestone_ids = {
        op.milestone_id
        for op in active_ops
        if op.op == _Kind.REMOVE_MILESTONE and op.milestone_id is not None
    }
    is_full_regeneration = (
        bool(phases)
        and removed_phase_ids == set(phases)
        and removed_milestone_ids == set(milestones)
    )
    protected_final_phase_id: str | None = None
    if plan.phases:
        final_phase = plan.phases[-1]
        if is_short_taper_phase(final_phase):
            protected_final_phase_id = final_phase.id

    for op in diff.ops:
        if op.accepted is False:
            continue  # an explicitly rejected op can't land

        if op.op == _Kind.RESIZE_PHASE:
            v = _check_phase_resize(
                op, phases, plan_lo, plan_hi, protected_final_phase_id
            )
        elif (
            op.op == _Kind.REMOVE_PHASE
            and op.phase_id == protected_final_phase_id
            and not is_full_regeneration
        ):
            phase = phases[op.phase_id]
            v = f"最后 1–2 周的调整期「{phase.name}」必须完整保留，不能删除"
        elif op.op == _Kind.ADD_PHASE:
            v = _check_phase_add(op, phases, plan_lo, plan_hi)
        elif op.op == _Kind.REPLACE_WEEKLY_RANGE:
            v = _check_weekly_range(op, phases)
        elif op.op == _Kind.REPLACE_MILESTONE_DATE:
            v = _check_milestone_date(op, milestones, plan_lo, plan_hi)
        elif op.op == _Kind.ADD_MILESTONE:
            v = _check_milestone_add(op, phases, milestones, plan_lo, plan_hi)
        elif op.op == _Kind.REPLACE_PHASE_FOCUS:
            v = _check_phase_focus(op, phases)
        elif op.op == _Kind.REPLACE_MILESTONE_TARGET:
            v = _check_milestone_target(op, milestones)
        else:
            v = _check_ref(op, phases, milestones)

        if v is not None:
            violations.append(v)

    return violations
