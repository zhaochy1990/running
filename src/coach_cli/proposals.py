"""Proposal presentation helpers for the Coach CLI."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any, Callable

import click
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text

from stride_core.master_plan_diff import MasterPlanDiff
from stride_core.plan_diff import PlanDiff
from stride_core.plan_spec import SessionKind
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal

Proposal = MasterPlanDiff | PlanDiff | WeeklyPlanCreateProposal
APPLICABLE_PROPOSAL_TYPES = (MasterPlanDiff, PlanDiff, WeeklyPlanCreateProposal)

_PROPOSAL_OP_LABELS = {
    "move_session": "移动训练",
    "replace_kind": "更换训练类型",
    "replace_distance": "调整训练量",
    "add_session": "新增训练",
    "remove_session": "删除训练",
    "replace_note": "更新训练说明",
    "add_phase": "新增阶段",
    "remove_phase": "删除阶段",
    "resize_phase": "调整阶段日期",
    "replace_phase_focus": "调整阶段重点",
    "replace_weekly_range": "调整周跑量",
    "add_milestone": "新增里程碑",
    "remove_milestone": "删除里程碑",
    "replace_milestone_date": "调整里程碑日期",
    "replace_milestone_target": "调整里程碑目标",
}
_FIELD_LABELS = {
    "date": "日期",
    "new_date": "新日期",
    "kind": "类型",
    "summary": "内容",
    "focus": "重点",
    "target": "目标",
    "name": "名称",
    "end_date": "结束日期",
    "start_date": "开始日期",
    "total_distance_m": "距离",
    "total_duration_s": "时长",
    "weekly_distance_km_low": "周跑量下限",
    "weekly_distance_km_high": "周跑量上限",
}
_KIND_LABELS: dict[SessionKind, str] = {
    SessionKind.RUN: "跑步",
    SessionKind.STRENGTH: "力量",
    SessionKind.REST: "休息",
    SessionKind.CROSS: "交叉训练",
    SessionKind.NOTE: "说明",
}
_WEEKLY_RANGE_KEYS = {
    "weekly_distance_km_low",
    "weekly_distance_km_high",
}


def _proposal_heading(proposal: object) -> tuple[str, str]:
    if isinstance(proposal, WeeklyPlanCreateProposal):
        return "新建周计划", proposal.folder
    if isinstance(proposal, PlanDiff):
        return "调整周计划", proposal.folder
    if isinstance(proposal, MasterPlanDiff):
        return "调整赛季计划", proposal.plan_id
    return "计划提案", ""


def _format_scalar(key: str, value: object) -> str:
    if value is None:
        return "无"
    if key == "total_distance_m" and isinstance(value, (int, float)):
        return f"{value / 1000:g} km"
    if key == "total_duration_s" and isinstance(value, (int, float)):
        return f"{value / 60:g} 分钟"
    if key in _WEEKLY_RANGE_KEYS:
        return f"{value} km"
    if key == "kind":
        try:
            kind = value if isinstance(value, SessionKind) else SessionKind(str(value))
            return _KIND_LABELS[kind]
        except ValueError:
            return str(value)
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def _format_diff_value(value: dict[str, Any] | None) -> str:
    if not value:
        return "无"

    parts: list[str] = []
    has_weekly_range = _WEEKLY_RANGE_KEYS <= set(value)
    if has_weekly_range:
        parts.append(
            f"周跑量 {value['weekly_distance_km_low']}–"
            f"{value['weekly_distance_km_high']} km"
        )

    for key, item in value.items():
        if key == "session_index" or (has_weekly_range and key in _WEEKLY_RANGE_KEYS):
            continue
        parts.append(f"{_FIELD_LABELS.get(key, key)} {_format_scalar(key, item)}")
    return "；".join(parts) or "无"


def _proposal_change_lines(proposal: object) -> list[str]:
    if isinstance(proposal, WeeklyPlanCreateProposal):
        plan = proposal.to_weekly_plan()
        lines = [
            f"共 {len(plan.sessions)} 项训练 · 计划跑量 {proposal.total_distance_km:g} km"
        ]
        for session in plan.sessions:
            kind = _KIND_LABELS.get(session.kind, session.kind.value)
            details = session.summary or session.notes_md or "未命名训练"
            lines.append(f"{session.date} · {kind} · {details}")
        return lines

    lines: list[str] = []
    for op in getattr(proposal, "ops", []) or []:
        op_name = getattr(op.op, "value", str(op.op))
        label = _PROPOSAL_OP_LABELS.get(op_name, op_name)
        target = (
            getattr(op, "phase_id", None)
            or getattr(op, "milestone_id", None)
            or getattr(op, "date", None)
        )
        target_text = f" · {target}" if target else ""
        old_value = _format_diff_value(getattr(op, "old_value", None))
        new_value = _format_diff_value(
            getattr(op, "new_value", None) or getattr(op, "spec_patch", None)
        )
        lines.append(f"{label}{target_text}: {old_value} → {new_value}")
    return lines


def _proposal_lines(
    proposal: object,
    *,
    index: int,
    total: int,
    show_apply_hint: bool = True,
) -> list[str]:
    heading, scope = _proposal_heading(proposal)
    explanation = getattr(proposal, "ai_explanation", "") or "无摘要"
    changes = _proposal_change_lines(proposal)
    apply_hint = (
        "回复“应用这个提案”确认，或输入 /apply 1"
        if total == 1
        else f"回复“应用第 {index} 个提案”确认，或输入 /apply {index}"
    )
    lines = [
        f"提案 {index} · {heading}",
        f"范围: {scope}",
        f"摘要: {explanation}",
        f"改动 ({len(changes)}):",
        *(
            ["  暂无结构化改动"]
            if not changes
            else [
                f"  {change_index}. {change}"
                for change_index, change in enumerate(changes, 1)
            ]
        ),
    ]
    if show_apply_hint:
        lines.append(f"操作: {apply_hint}")
    return lines


def stdout_is_terminal() -> bool:
    stream = click.get_text_stream("stdout")
    isatty = getattr(stream, "isatty", None)
    return bool(isatty and isatty())


def print_proposals(
    proposals: Sequence[Proposal],
    *,
    console: Console | None = None,
    render_panels: bool | None = None,
    show_apply_hint: bool = True,
) -> None:
    """Render pending proposals consistently for turns and /proposals."""
    should_render = stdout_is_terminal() if render_panels is None else render_panels
    if not should_render:
        for index, proposal in enumerate(proposals, start=1):
            click.echo(
                "\n".join(
                    _proposal_lines(
                        proposal,
                        index=index,
                        total=len(proposals),
                        show_apply_hint=show_apply_hint,
                    )
                )
            )
        return

    output = console or Console(file=click.get_text_stream("stdout"), highlight=False)
    for index, proposal in enumerate(proposals, start=1):
        lines = _proposal_lines(
            proposal,
            index=index,
            total=len(proposals),
            show_apply_hint=show_apply_hint,
        )
        output.print(
            Panel(
                Text("\n".join(lines[1:])),
                title=lines[0],
                title_align="left",
                border_style="cyan",
                padding=(0, 1),
            )
        )


def applicable_proposals(turn: object) -> tuple[Proposal, ...]:
    proposals: list[Proposal] = []
    for card in getattr(turn, "proposals", []) or []:
        proposal = getattr(card, "proposal", None)
        if isinstance(proposal, APPLICABLE_PROPOSAL_TYPES):
            proposals.append(proposal)
    return tuple(proposals)


def _turn_metadata(turn: object) -> list[str]:
    active_target = getattr(turn, "active_target", None)
    if active_target:
        return [f"· 当前对象: {active_target.model_dump(exclude_none=True)}"]
    return []


def format_turn(turn: object, *, show_apply_hint: bool = True) -> str:
    lines: list[str] = []
    clarification = getattr(turn, "clarification", None)
    lines.append(f"❓ {clarification}" if clarification else getattr(turn, "reply", None) or "(空回复)")
    lines.extend(f"  {line}" for line in _turn_metadata(turn))
    proposals = applicable_proposals(turn)
    for index, proposal in enumerate(proposals, start=1):
        lines.append("")
        lines.extend(
            _proposal_lines(
                proposal,
                index=index,
                total=len(proposals),
                show_apply_hint=show_apply_hint,
            )
        )
    return "\n".join(lines)


def print_turn(
    turn: object,
    *,
    interactive: bool,
    render_markdown: bool | None = None,
    console: Console | None = None,
) -> None:
    """Print a turn with stable plain output for pipes and Rich output for TTYs."""
    should_render = stdout_is_terminal() if render_markdown is None else render_markdown
    if not should_render:
        prefix = "\n教练 › " if interactive else ""
        click.echo(f"{prefix}{format_turn(turn, show_apply_hint=interactive)}")
        return

    output = console or Console(file=click.get_text_stream("stdout"), highlight=False)
    if interactive:
        output.print()
        output.print(Text("教练 ›", style="bold cyan"))

    clarification = getattr(turn, "clarification", None)
    if clarification:
        output.print(Text("❓ 需要补充信息", style="bold yellow"))
        output.print(Markdown(clarification))
    else:
        output.print(Markdown(getattr(turn, "reply", None) or "(空回复)"))

    for line in _turn_metadata(turn):
        output.print(Text(f"  {line}", style="dim"))

    proposals = applicable_proposals(turn)
    if proposals:
        output.print()
        print_proposals(
            proposals,
            console=output,
            render_panels=True,
            show_apply_hint=interactive,
        )
