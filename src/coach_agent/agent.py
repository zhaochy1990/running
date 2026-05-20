"""LangChain orchestration for the STRIDE coach agent.

Handles the three coaching tasks (``chat``, ``weekly_plan``, ``plan_adjustment``);
the markdown→JSON reverse parser lives in ``plan_parser.parse_plan_md``.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from plan_parser import STRUCTURED_SCHEMA_HINT, parse_structured, strip_json_block
from stride_core.plan_spec import WeeklyPlan
from stride_core.source import DataSource

from .context import load_coach_context, summarize_context
from .model import get_chat_model, get_generated_by


StatusCb = Callable[[str], None]


def _noop_status(_: str) -> None:
    pass


SYSTEM_PROMPT = """你是 STRIDE 的高级马拉松训练 Agent。

你要基于用户的真实训练数据、健康负荷、周计划、反馈、体测和能力模型给出高质量建议。
默认使用中文，语气直接、专业、可执行。
这是成人耐力跑训练与健康生活方式建议，不是医疗诊断或治疗。你可以生成安全、保守、循序渐进的跑步/力量/营养/恢复计划；如果出现疼痛、伤病风险或异常健康信号，要降低训练负荷并建议必要时咨询医生或物理治疗师，不要直接拒答。

关键规则：
- 不虚构数据；没有数据就明确说缺失。
- 判断训练状态时综合 fatigue、ATI/CTI、TSB、RHR、HRV、近期训练、用户反馈，不依赖单一指标。
- 周计划必须覆盖跑步、力量/灵活性、营养与恢复。
- 不要写"已推送到 COROS 手表的训练"章节。
- 临时调整计划必须保守、说明原因，并保留训练周期目标。
- 除非调用 apply 接口，所有计划调整都只是草稿/预览，不代表已保存。
- 如果 sync 失败或用户未登录 COROS，要说明数据可能不是最新。
"""


# ─────────────────────────────────────────────────────────────────────────────
# Result type
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AgentResult:
    content: str
    model: str
    context_summary: dict[str, Any]
    sync: dict[str, Any]
    # Structured plan parsed out of the model's JSON code block (weekly_plan
    # task only). ``None`` when the task does not request structured output,
    # when no JSON was emitted, or when the JSON failed schema validation.
    # ``parse_error`` carries a human-readable reason in the failure case.
    structured: WeeklyPlan | None = None
    parse_error: str | None = None
    source: str = "fresh"
    llm_calls: int = 0
    schema_version: int | None = None

    # Backwards-compat alias used by existing callers/tests.
    @property
    def content_md(self) -> str:
        return self.content


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


# ─────────────────────────────────────────────────────────────────────────────
# Top-level entry point
# ─────────────────────────────────────────────────────────────────────────────


_TaskName = Literal["chat", "weekly_plan", "plan_adjustment"]


def run_agent(
    user: str,
    *,
    task: _TaskName,
    user_message: str,
    folder: str | None = None,
    source: DataSource | None = None,
    sync_before: bool = True,
    chat_model: Any | None = None,
    status_cb: StatusCb | None = None,
) -> AgentResult:
    """Run a coaching task.

    For the markdown→JSON reverse parse, call ``plan_parser.parse_plan_md``
    directly instead — that path is no longer part of the coach agent surface.
    """
    if task not in ("chat", "weekly_plan", "plan_adjustment"):
        raise ValueError(
            f"unknown task {task!r}; valid: chat, weekly_plan, plan_adjustment. "
            "Use plan_parser.parse_plan_md for markdown→JSON reverse parsing."
        )
    log = status_cb or _noop_status

    log(f"加载上下文 (user={user}, folder={folder or '—'}, sync={sync_before})")
    t_ctx = time.perf_counter()
    context = load_coach_context(
        user, folder=folder, source=source, sync_before=sync_before, status_cb=log
    )
    log(f"上下文就绪 ({time.perf_counter() - t_ctx:.1f}s)")
    context_summary = summarize_context(context)

    if task == "weekly_plan":
        instruction = """请生成一份完整的本周训练计划 Markdown。
要求：
1. 明确周目标、疲劳/负荷判断、跑步安排、力量/灵活性、营养与恢复。
2. 每天给出训练内容、强度/RPE、配速或心率目标、注意事项。
3. 结合当前训练阶段、近期训练执行、健康负荷、体测和用户目标。
4. 不要包含"已推送到 COROS 手表的训练"章节。
5. 输出可直接保存为 plan.md 的 Markdown,然后再追加结构化 JSON 代码块。"""
    elif task == "plan_adjustment":
        instruction = """请根据用户反馈生成"临时调整后的完整周计划"草稿。
要求：
1. 先保护恢复和伤病风险，再保留关键训练目的。
2. 调整幅度要保守，并说明哪些训练被降级、替换或移动。
3. 输出完整 Markdown，可用于用户确认后保存为 DB 计划覆盖。
4. 不要声称已经保存；这是草稿。"""
    else:
        instruction = """请回答用户的日常训练问题。
如果问题涉及当前状态、疲劳、负荷、是否能上强度，必须基于同步状态和上下文给出判断。
需要计划调整时，给出建议和草稿方向，但提醒用户需要确认后再保存。"""

    user_parts = [
        f"# 任务类型\n{task}",
        f"# 指令\n{instruction}",
        f"# 用户输入\n{user_message}",
        f"# STRIDE 上下文 JSON\n{_context_json(context)}",
    ]
    if task == "weekly_plan":
        user_parts.append(f"# 结构化输出说明\n{STRUCTURED_SCHEMA_HINT}")

    messages = [
        ("system", SYSTEM_PROMPT),
        ("user", "\n\n".join(user_parts)),
    ]
    prompt_chars = sum(len(c) for _, c in messages)
    log(f"调用 LLM (task={task}, 输入≈{prompt_chars} chars)")
    t_llm = time.perf_counter()
    raw = _invoke_model(messages, chat_model=chat_model)
    log(f"LLM 响应已收到 ({time.perf_counter() - t_llm:.1f}s, 输出≈{len(raw)} chars)")

    structured: WeeklyPlan | None = None
    parse_error: str | None = None
    content = raw
    if task == "weekly_plan":
        log("解析结构化 JSON 代码块…")
        structured, parse_error = parse_structured(raw, folder=folder)
        if parse_error:
            log(f"  ⚠ 结构化解析失败: {parse_error}")
        elif structured is not None:
            log(
                f"  ✓ 结构化解析成功 ({len(structured.sessions)} sessions, "
                f"{len(structured.nutrition)} nutrition)"
            )
        content = strip_json_block(raw)

    return AgentResult(
        content=content,
        model=get_generated_by(),
        context_summary=context_summary,
        sync=context.get("sync") or {},
        structured=structured,
        parse_error=parse_error,
    )
