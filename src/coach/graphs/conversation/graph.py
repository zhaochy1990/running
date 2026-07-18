"""``build_conversation_graph`` — the S1/S2/S3 conversation StateGraph.

Flow (see plan §6.2)::

                ┌───────────┐
        START → │  reason   │  ←──────────┐
                └───┬───────┘             │
            tool_calls? │                 │
                ┌───────┴───────┐         │
                │     no        │  yes    │
                ▼               ▼         │
              END            ┌──────┐     │
                             │tools │     │
                             └──┬───┘     │
                                │         │
                  draft tool? ──┴── read tool? ─┘
                       │
                       ▼
                      END (last_diff set)

Persistence: a ``BaseCheckpointSaver`` (typically our
:class:`AzureTableCheckpointSaver`) is wired via ``compile(checkpointer=...)``
so each thread can resume mid-multi-turn.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from coach.runtime.toolkit import Toolkit
from coach.schemas import ConversationState

from .prompts.master_chat import MASTER_CHAT_PROMPT
from .prompts.qa import QA_PROMPT
from .prompts.week_chat import WEEK_CHAT_PROMPT
from .master_adjustment_direction import (
    proposal_payload_matches_adjustment_request,
    requested_phase_focus,
    requested_phase_resize_weeks,
    requested_weekly_volume_direction,
)
from .tool_bridge import (
    MASTER_ASSESSMENT_TOOL_NAME,
    MASTER_DRAFT_TOOL_NAMES,
    READ_TOOL_NAMES,
    build_langchain_tools,
    is_draft_tool,
)

logger = logging.getLogger(__name__)

_MASTER_ASSESSMENT_REQUIRED_READS = frozenset(
    {
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
    }
)
_TARGET_TIME_REQUEST_RE = re.compile(
    r"(?:目标|比赛|完赛|成绩|target|goal|finish)"
    r".{0,24}(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s*小时(?:\s*\d{1,2}\s*分)?|sub[- ]?\d)"
    r"|(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s*小时(?:\s*\d{1,2}\s*分)?|sub[- ]?\d)"
    r".{0,24}(?:目标|比赛|完赛|成绩|target|goal|finish)",
    re.IGNORECASE,
)
_TARGET_TIME_REQUIRED_READS = frozenset({"get_race_predictions", "get_pbs"})
_ALTERNATIVES_REQUEST_RE = re.compile(
    r"(?:两个|两种|2\s*个|比较|对比|备选|alternatives?|options?|compare)",
    re.IGNORECASE,
)
_ALTERNATIVES_REJECTION_RE = re.compile(
    r"(?:不要|别|无需|不需要|不想|拒绝|只(?:要|给)?(?:一|1)个)"
    r".{0,16}(?:两个|两种|2\s*个|比较|对比|备选|方案|建议)"
    r"|(?:两个|两种|2\s*个|比较|对比|备选)"
    r".{0,16}(?:不要|别|无需|不需要|不想|拒绝|只(?:要|给)?(?:一|1)个)"
    r"|(?:do\s+not|don't|no|without|only\s+(?:one|1))"
    r".{0,24}(?:alternatives?|options?|compare|comparison)",
    re.IGNORECASE,
)


def _explicitly_requests_alternatives(request: str) -> bool:
    return (
        requested_weekly_volume_direction(request) == "decrease"
        and bool(_ALTERNATIVES_REQUEST_RE.search(request))
        and not bool(_ALTERNATIVES_REJECTION_RE.search(request))
    )


def _current_user_request(state: ConversationState) -> str:
    for message in reversed(state.get("history") or []):
        if isinstance(message, HumanMessage):
            content = message.content
            return content.strip() if isinstance(content, str) else str(content).strip()
    return ""


def _current_plan_id(state: ConversationState) -> str | None:
    plan_id = state.get("plan_id")
    return str(plan_id).strip() if plan_id else None


def _is_same_master_request(state: ConversationState, request: str) -> bool:
    tracked_plan_id = state.get("master_adjustment_plan_id")
    return (
        state.get("master_adjustment_request") == request
        and tracked_plan_id is not None
        and tracked_plan_id == _current_plan_id(state)
    )


def _required_master_adjustment_reads(request: str) -> frozenset[str]:
    required = set(_MASTER_ASSESSMENT_REQUIRED_READS)
    if _TARGET_TIME_REQUEST_RE.search(request):
        required.update(_TARGET_TIME_REQUIRED_READS)
    return frozenset(required)


def _master_stage_instruction(state: ConversationState) -> str:
    """Tell the model which adjustment protocol stage is allowed now.

    The deterministic tool gate remains the authority. This per-iteration
    instruction prevents models that support parallel tool calls from placing
    the assessment in the same batch as its prerequisite reads.
    """
    current_request = _current_user_request(state)
    same_request = _is_same_master_request(state, current_request)
    consulted = set(state.get("consulted_tools") or []) if same_request else set()
    required_reads = _required_master_adjustment_reads(current_request)
    missing_reads = sorted(required_reads - consulted)
    if missing_reads:
        return (
            "【本轮工具阶段：读取】只调用以下尚缺的 read tools："
            + ", ".join(missing_reads)
            + "。本轮不要调用 assess_master_adjustment，也不要调用任何 draft tool；"
            "读取结果会在下一轮提供。"
        )

    assessment = (
        state.get("master_adjustment_assessment") if same_request else None
    )
    if not assessment:
        return (
            "【本轮工具阶段：评估】必需数据已经读完。只调用 "
            "assess_master_adjustment，且 adjustment_request 必须逐字等于用户当前请求；"
            "本轮不要调用任何 draft tool。"
        )

    verdict = assessment.get("verdict")
    if verdict == "reasonable":
        return (
            "【本轮工具阶段：提案】当前请求已经评估为 reasonable。"
            "现在只调用一个忠实实现用户方向的 draft tool；不要再次读取或评估。"
        )
    return (
        f"【本轮工具阶段：结束】当前评估 verdict={verdict!r}，禁止调用 draft tool。"
        "直接解释依据；若需要澄清则向用户追问。"
    )


_SCOPE_PROMPTS = {
    "qa": QA_PROMPT,
    "week_chat": WEEK_CHAT_PROMPT,
    "master_chat": MASTER_CHAT_PROMPT,
}


def build_conversation_graph(
    *,
    toolkit: Toolkit,
    llm: BaseChatModel,
    checkpointer: BaseCheckpointSaver | None,
    scope: str,
    tool_names: tuple[str, ...] | None = None,
) -> Any:
    """Construct a compiled langgraph for the given scope.

    Returns the compiled graph (langgraph ``CompiledStateGraph``); call
    ``.invoke({"history": [HumanMessage(...)], "scope": scope, ...},
    config={"configurable": {"thread_id": ...}})``.
    """
    if scope not in _SCOPE_PROMPTS:
        raise ValueError(f"unknown scope {scope!r}")

    tools = build_langchain_tools(toolkit, scope, selected_names=tool_names)
    llm_with_tools = llm.bind_tools(tools)
    tool_map: dict[str, Any] = {t.name: t for t in tools}

    system_prompt = _SCOPE_PROMPTS[scope]

    def reason(state: ConversationState) -> dict[str, Any]:
        msgs = [SystemMessage(content=system_prompt), *state.get("history", [])]
        if scope == "master_chat":
            # Runtime protocol state varies per turn, so it belongs in a user
            # message. Keep the system prompt byte-identical for prompt caching.
            stage_message = HumanMessage(content=_master_stage_instruction(state))
            insert_at = next(
                (
                    index
                    for index in range(len(msgs) - 1, 0, -1)
                    if isinstance(msgs[index], HumanMessage)
                ),
                len(msgs),
            )
            msgs.insert(insert_at, stage_message)
        started = time.perf_counter()
        resp = llm_with_tools.invoke(msgs)
        iteration = state.get("iteration", 0) + 1
        logger.debug(
            "qa reason | iteration=%d elapsed=%.0fms messages=%d tool_calls=%s",
            iteration,
            (time.perf_counter() - started) * 1000.0,
            len(msgs),
            [call.get("name") for call in (getattr(resp, "tool_calls", None) or [])],
        )
        update: dict[str, Any] = {"history": [resp], "iteration": iteration}
        if state.get("last_diff") is not None:
            update["last_diff"] = None
        if scope == "master_chat":
            update["master_mandatory_read_failed"] = False
            current_request = _current_user_request(state)
            if not _is_same_master_request(state, current_request):
                update.update(
                    {
                        "consulted_tools": [],
                        "tool_trace": [],
                        "master_adjustment_request": current_request,
                        "master_adjustment_plan_id": _current_plan_id(state),
                        "master_adjustment_assessment": None,
                    }
                )
        return update

    def tools_node(state: ConversationState) -> dict[str, Any]:
        history = state.get("history", [])
        last = history[-1] if history else None
        tool_calls = getattr(last, "tool_calls", None) or []
        new_messages: list[Any] = []
        last_diff: dict | None = None
        current_request = _current_user_request(state)
        same_request = _is_same_master_request(state, current_request)
        consulted_before = (
            set(state.get("consulted_tools") or []) if same_request else set()
        )
        consulted_after = set(consulted_before)
        assessment_before = (
            state.get("master_adjustment_assessment") if same_request else None
        )
        assessment_after = assessment_before
        tool_trace = list(state.get("tool_trace") or []) if same_request else []
        mandatory_read_failed = False
        for tc in tool_calls:
            name = tc["name"]
            args = tc.get("args") or {}
            if mandatory_read_failed:
                tool_trace.append(
                    {
                        "name": name,
                        "outcome": "blocked",
                        "reason": "mandatory_read_failed",
                    }
                )
                new_messages.append(
                    ToolMessage(
                        content=json.dumps(
                            {
                                "ok": False,
                                "errors": ["blocked_after_mandatory_read_failed"],
                            },
                            ensure_ascii=False,
                        ),
                        tool_call_id=tc["id"],
                        name=name,
                    )
                )
                continue
            impl = tool_map.get(name)
            if impl is None:
                tool_trace.append(
                    {"name": name, "outcome": "blocked", "reason": "unknown_tool"}
                )
                new_messages.append(
                    ToolMessage(
                        content=json.dumps({"ok": False, "errors": [f"unknown tool {name}"]}),
                        tool_call_id=tc["id"],
                        name=name,
                    )
                )
                continue
            if scope == "master_chat" and name == MASTER_ASSESSMENT_TOOL_NAME:
                required_reads = _required_master_adjustment_reads(current_request)
                missing = sorted(required_reads - consulted_before)
                request_mismatch = str(args.get("adjustment_request") or "").strip() != current_request
                if missing or request_mismatch:
                    errors = []
                    if missing:
                        errors.append(
                            "assessment_requires_prior_read_results: " + ", ".join(missing)
                        )
                    if request_mismatch:
                        errors.append("assessment_request_does_not_match_current_user_request")
                    tool_trace.append(
                        {
                            "name": name,
                            "outcome": "blocked",
                            "reason": "assessment_gate",
                        }
                    )
                    payload = json.dumps(
                        {"ok": False, "errors": errors},
                        ensure_ascii=False,
                    )
                    new_messages.append(
                        ToolMessage(
                            content=payload,
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
            if scope == "master_chat" and name in MASTER_DRAFT_TOOL_NAMES:
                verdict = (assessment_before or {}).get("verdict")
                assessed_request = (assessment_before or {}).get("adjustment_request")
                if verdict != "reasonable" or assessed_request != current_request:
                    tool_trace.append(
                        {
                            "name": name,
                            "outcome": "blocked",
                            "reason": "proposal_gate",
                        }
                    )
                    payload = json.dumps(
                        {
                            "ok": False,
                            "errors": [
                                "proposal_requires_prior_reasonable_assessment"
                            ],
                        },
                        ensure_ascii=False,
                    )
                    new_messages.append(
                        ToolMessage(
                            content=payload,
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
                if (
                    name == "propose_reduction_alternatives"
                    and not _explicitly_requests_alternatives(current_request)
                ):
                    tool_trace.append(
                        {
                            "name": name,
                            "outcome": "blocked",
                            "reason": "alternatives_gate",
                        }
                    )
                    payload = json.dumps(
                        {
                            "ok": False,
                            "errors": [
                                "reduction_alternatives_require_explicit_comparison_request"
                            ],
                        },
                        ensure_ascii=False,
                    )
                    new_messages.append(
                        ToolMessage(
                            content=payload,
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
                if (
                    name == "set_phase_weekly_range"
                    and str(args.get("adjustment_request") or "").strip()
                    != current_request
                ):
                    tool_trace.append(
                        {
                            "name": name,
                            "outcome": "blocked",
                            "reason": "volume_request_gate",
                        }
                    )
                    new_messages.append(
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "ok": False,
                                    "errors": [
                                        "weekly_range_adjustment_request_does_not_match_current_user_request"
                                    ],
                                },
                                ensure_ascii=False,
                            ),
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
                if (
                    name == "set_phase_focus"
                    and str(args.get("adjustment_request") or "").strip()
                    != current_request
                ):
                    tool_trace.append(
                        {
                            "name": name,
                            "outcome": "blocked",
                            "reason": "focus_request_gate",
                        }
                    )
                    new_messages.append(
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "ok": False,
                                    "errors": [
                                        "phase_focus_adjustment_request_does_not_match_current_user_request"
                                    ],
                                },
                                ensure_ascii=False,
                            ),
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
                if name == "set_phase_focus" and requested_phase_focus(
                    current_request
                ) is None:
                    tool_trace.append(
                        {
                            "name": name,
                            "outcome": "blocked",
                            "reason": "focus_request_gate",
                        }
                    )
                    new_messages.append(
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "ok": False,
                                    "errors": [
                                        "phase_focus_requires_explicit_requested_focus"
                                    ],
                                },
                                ensure_ascii=False,
                            ),
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
                if name in {"extend_phase", "compress_phase"}:
                    request_mismatch = (
                        str(args.get("adjustment_request") or "").strip()
                        != current_request
                    )
                    requested_weeks = requested_phase_resize_weeks(current_request)
                    try:
                        supplied_weeks = int(args.get("weeks"))
                    except (TypeError, ValueError):
                        supplied_weeks = None
                    if request_mismatch or requested_weeks != supplied_weeks:
                        tool_trace.append(
                            {
                                "name": name,
                                "outcome": "blocked",
                                "reason": "phase_resize_request_gate",
                            }
                        )
                        errors = []
                        if request_mismatch:
                            errors.append(
                                "phase_resize_adjustment_request_does_not_match_current_user_request"
                            )
                        if requested_weeks is None:
                            errors.append(
                                "phase_resize_requires_one_explicit_whole_week_duration"
                            )
                        elif requested_weeks != supplied_weeks:
                            errors.append(
                                "phase_resize_weeks_do_not_match_current_user_request"
                            )
                        new_messages.append(
                            ToolMessage(
                                content=json.dumps(
                                    {"ok": False, "errors": errors},
                                    ensure_ascii=False,
                                ),
                                tool_call_id=tc["id"],
                                name=name,
                            )
                        )
                        continue
            try:
                payload = impl.invoke(args)
            except Exception as exc:  # noqa: BLE001 — tool boundary
                payload = json.dumps({"ok": False, "errors": [f"{type(exc).__name__}: {exc}"]})
            new_messages.append(
                ToolMessage(content=str(payload), tool_call_id=tc["id"], name=name)
            )
            parsed_payload: Any = None
            try:
                parsed_payload = json.loads(payload) if isinstance(payload, str) else payload
            except (json.JSONDecodeError, TypeError):
                pass
            tool_trace.append(
                {
                    "name": name,
                    "outcome": (
                        "ok"
                        if isinstance(parsed_payload, dict) and parsed_payload.get("ok")
                        else "error"
                    ),
                }
            )
            if name in READ_TOOL_NAMES and isinstance(parsed_payload, dict):
                if parsed_payload.get("ok"):
                    consulted_after.add(name)
                elif scope == "master_chat" and name in _required_master_adjustment_reads(
                    current_request
                ):
                    tool_trace[-1] = {
                        "name": name,
                        "outcome": "error",
                        "reason": "mandatory_read_failed",
                    }
                    mandatory_read_failed = True
                    continue
            if name == MASTER_ASSESSMENT_TOOL_NAME:
                try:
                    data = parsed_payload.get("data")
                    if parsed_payload.get("ok") and isinstance(data, dict):
                        assessment_after = data
                except AttributeError:
                    pass
            if is_draft_tool(name):
                try:
                    if parsed_payload.get("ok") and parsed_payload.get("data") is not None:
                        candidate = parsed_payload["data"]
                        if scope != "master_chat" or proposal_payload_matches_adjustment_request(
                            candidate, current_request
                        ):
                            last_diff = candidate
                        else:
                            tool_trace[-1] = {
                                "name": name,
                                "outcome": "blocked",
                                "reason": "proposal_direction_gate",
                            }
                            new_messages[-1] = ToolMessage(
                                content=json.dumps(
                                    {
                                        "ok": False,
                                        "errors": [
                                            "proposal_does_not_match_current_adjustment_request"
                                        ],
                                    },
                                    ensure_ascii=False,
                                ),
                                tool_call_id=tc["id"],
                                name=name,
                            )
                except AttributeError:
                    pass

        update: dict[str, Any] = {
            "history": new_messages,
            "consulted_tools": sorted(consulted_after),
            "tool_trace": tool_trace,
        }
        if scope == "master_chat":
            update.update(
                {
                    "consulted_tools": sorted(consulted_after),
                    "tool_trace": tool_trace,
                    "master_adjustment_request": current_request,
                    "master_adjustment_plan_id": _current_plan_id(state),
                    "master_adjustment_assessment": assessment_after,
                    "master_mandatory_read_failed": mandatory_read_failed,
                }
            )
        update["last_diff"] = last_diff
        return update

    def after_reason(state: ConversationState) -> str:
        last = (state.get("history") or [None])[-1]
        tool_calls = getattr(last, "tool_calls", None) if isinstance(last, AIMessage) else None
        if tool_calls:
            return "tools"
        return END

    def after_tools(state: ConversationState) -> str:
        # Draft tool result lands in last_diff; that ends the turn so the user
        # can review the proposed diff (Pattern Y — server stays stateless after
        # this point; the diff travels through the HTTP response).
        if state.get("last_diff") is not None:
            return END
        if state.get("master_mandatory_read_failed"):
            return END
        if state.get("iteration", 0) >= 8:
            return END
        return "reason"

    graph = StateGraph(ConversationState)
    graph.add_node("reason", reason)
    graph.add_node("tools", tools_node)
    graph.add_edge(START, "reason")
    graph.add_conditional_edges("reason", after_reason, {"tools": "tools", END: END})
    graph.add_conditional_edges("tools", after_tools, {"reason": "reason", END: END})

    return graph.compile(checkpointer=checkpointer)
