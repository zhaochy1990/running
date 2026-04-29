"""LangChain orchestration for the STRIDE coach agent."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

from stride_core.db import Database
from stride_core.source import DataSource

from .context import load_coach_context, summarize_context
from .model import get_chat_model, get_generated_by


SYSTEM_PROMPT = """你是 STRIDE 的高级马拉松训练 Agent。

你要基于用户的真实训练数据、健康负荷、周计划、反馈、InBody 和能力模型给出高质量建议。
默认使用中文，语气直接、专业、可执行。

关键规则：
- 不虚构数据；没有数据就明确说缺失。
- 判断训练状态时综合 fatigue、ATI/CTI、TSB、RHR、HRV、近期训练、用户反馈，不依赖单一指标。
- 周计划必须覆盖跑步、力量/灵活性、营养与恢复。
- 不要写“已推送到 COROS 手表的训练”章节。
- 临时调整计划必须保守、说明原因，并保留训练周期目标。
- 除非调用 apply 接口，所有计划调整都只是草稿/预览，不代表已保存。
- 如果 sync 失败或用户未登录 COROS，要说明数据可能不是最新。
"""


@dataclass(frozen=True)
class AgentResult:
    content: str
    model: str
    context_summary: dict[str, Any]
    sync: dict[str, Any]


def _message_content(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p).strip()
    return str(content or "").strip()


def _invoke_model(messages: list[tuple[str, str]], chat_model: Any | None = None) -> str:
    model = chat_model or get_chat_model()
    response = model.invoke(messages)
    return _message_content(response)


def _context_json(context: dict[str, Any]) -> str:
    return json.dumps(context, ensure_ascii=False, default=str)


def run_agent(
    user: str,
    *,
    task: Literal["chat", "weekly_plan", "plan_adjustment"],
    user_message: str,
    folder: str | None = None,
    source: DataSource | None = None,
    sync_before: bool = True,
    chat_model: Any | None = None,
) -> AgentResult:
    context = load_coach_context(user, folder=folder, source=source, sync_before=sync_before)
    context_summary = summarize_context(context)

    if task == "weekly_plan":
        instruction = """请生成一份完整的本周训练计划 Markdown。
要求：
1. 明确周目标、疲劳/负荷判断、跑步安排、力量/灵活性、营养与恢复。
2. 每天给出训练内容、强度/RPE、配速或心率目标、注意事项。
3. 结合当前训练阶段、近期训练执行、健康负荷、InBody 和用户目标。
4. 不要包含“已推送到 COROS 手表的训练”章节。
5. 只输出可直接保存为 plan.md 的 Markdown。"""
    elif task == "plan_adjustment":
        instruction = """请根据用户反馈生成“临时调整后的完整周计划”草稿。
要求：
1. 先保护恢复和伤病风险，再保留关键训练目的。
2. 调整幅度要保守，并说明哪些训练被降级、替换或移动。
3. 输出完整 Markdown，可用于用户确认后保存为 DB 计划覆盖。
4. 不要声称已经保存；这是草稿。"""
    else:
        instruction = """请回答用户的日常训练问题。
如果问题涉及当前状态、疲劳、负荷、是否能上强度，必须基于同步状态和上下文给出判断。
需要计划调整时，给出建议和草稿方向，但提醒用户需要确认后再保存。"""

    messages = [
        ("system", SYSTEM_PROMPT),
        (
            "user",
            "\n\n".join(
                [
                    f"# 任务类型\n{task}",
                    f"# 指令\n{instruction}",
                    f"# 用户输入\n{user_message}",
                    f"# STRIDE 上下文 JSON\n{_context_json(context)}",
                ]
            ),
        ),
    ]
    content = _invoke_model(messages, chat_model=chat_model)
    return AgentResult(
        content=content,
        model=get_generated_by(),
        context_summary=context_summary,
        sync=context.get("sync") or {},
    )


def apply_weekly_plan(user: str, folder: str, content: str, *, generated_by: str | None = None) -> dict[str, Any]:
    db = Database(user=user)
    try:
        author = generated_by or get_generated_by()
        db.upsert_weekly_plan(folder, content, generated_by=author)
        row = db.get_weekly_plan_row(folder)
        return dict(row) if row else {"week": folder, "content_md": content, "generated_by": author}
    finally:
        db.close()
