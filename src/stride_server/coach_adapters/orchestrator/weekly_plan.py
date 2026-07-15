"""weekly_plan specialist — wraps the week_chat conversation graph (§4.3, §7, A2).

The weekly_plan expert adjusts *this week's* planned sessions. It already exists
as the ``week_chat`` scope of the conversation graph (7 real draft tools that emit
a ``PlanDiff``), so this adapter dresses it in the SpecialistContract:
``SpecialistTask`` → ``SpecialistResult`` (carrying the proposed ``PlanDiff`` as
``proposals`` — Pattern Y: the diff rides the response, ``/apply`` lands it).

Two adapter-only concerns this module owns:

* **folder resolution** — the draft tools take an explicit ``folder`` arg, so the
  current week's folder (from ``task.active_target``) is seeded into the model's
  context. With no folder we can't act → ``needs_clarification``.
* **current-week lookup** — :func:`resolve_current_week_folder` maps "本周" to the
  display/PlanDiff folder carried by the current canonical ``WeeklyPlanStore`` row;
  injected into the Resolver so a routine "调整本周" dispatches without re-asking.

Stateless per call (the graph is built ``checkpointer=None``): session memory
lives at the orchestrator level (the ``conversation_window`` arrives in the task).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from coach.contracts import (
    SpecialistCard,
    SpecialistResult,
    SpecialistRunner,
    SpecialistTask,
    TargetRef,
    Turn,
)
from coach.graphs.conversation.graph import build_conversation_graph
from coach.schemas import assistant_parts_from_message
from stride_core.plan_diff import PlanDiff
from stride_core.timefmt import today_shanghai

from ...weekly_plan_store import get_weekly_plan_store
from ...week_generator import week_folder
from ..toolkit import build_stride_toolkit

logger = logging.getLogger(__name__)

GraphFactory = Callable[..., Any]


WEEKLY_PLAN_CARD = SpecialistCard(
    id="weekly_plan",
    description=(
        "调整本周训练计划：调换/挪动课时、整周或单日减量、替换课时类型、加力量、"
        "改配速目标、清空重排。产出 typed 修改提案（diff），等用户确认后落地。"
    ),
    tags=["本周", "周计划", "调整", "换课", "减量", "挪动", "改训练"],
    examples=[
        "把周三的间歇换到周四",
        "今天太累，本周量减 20%",
        "周五加一节力量",
        "把明天的配速放慢到 5:30",
        "这周重新安排一下",
    ],
    writes=True,
    data_needs=[],
)


def resolve_current_week_folder(user_id: str) -> str | None:
    """Return the current canonical plan's compatibility/display folder.

    Current-week identity is resolved exclusively by ``WeeklyPlanStore`` using
    today's Shanghai date. Blob/file folder indexes are not a runtime source.
    """
    today = today_shanghai().isoformat()
    try:
        current = get_weekly_plan_store().get_current_plan(user_id, today)
    except Exception:
        logger.exception("weekly_plan: canonical current-week lookup failed")
        return None
    return current.week_folder if current is not None else None


def make_current_week_target_resolver(user_id: str) -> Callable[[TargetRef | None], TargetRef | None]:
    """Build the Resolver's ``target_resolver``: "本周" → current-week TargetRef.

    Existing plans keep their canonical display folder. If the user explicitly
    identified the current week/session but no plan exists yet, the natural
    Shanghai week still has an unambiguous calendar folder; return that instead
    of confusing a missing resource with a missing target. A bare ``None`` still
    resolves only through an existing current plan, so genuinely targetless
    writes continue to clarify.
    """

    def _resolve(target: TargetRef | None) -> TargetRef | None:
        if target is not None and target.kind == "master":
            return None
        folder = resolve_current_week_folder(user_id)
        if folder is None:
            if target is None or target.kind not in ("week", "session"):
                return None
            today = today_shanghai()
            folder = week_folder(today - timedelta(days=today.weekday()))
        kind = target.kind if (target is not None and target.kind in ("week", "session")) else "week"
        return TargetRef(
            kind=kind,
            folder=folder,
            date=target.date if target is not None else None,
            session_index=target.session_index if target is not None else None,
        )

    return _resolve


def _window_to_messages(window: list[Turn]) -> list[Any]:
    messages: list[Any] = []
    for turn in window:
        if turn.role == "user":
            messages.append(HumanMessage(content=turn.content))
        else:
            messages.append(AIMessage(content=turn.content))
    return messages


def _extract_reply(history: list[Any]) -> str:
    """Reply text = the last AIMessage's text parts.

    On a draft-tool turn the graph ends with a ToolMessage, but the explanatory
    text rides the preceding AIMessage — so scan back to the last AIMessage
    rather than reading ``history[-1]`` blindly.
    """
    for msg in reversed(history):
        if isinstance(msg, AIMessage):
            texts = [
                part.text
                for part in assistant_parts_from_message(msg)
                if part.kind == "text"
            ]
            return "\n".join(t for t in texts if t).strip()
    return ""


def make_weekly_plan_runner(
    *,
    user_id: str,
    llm: Any,
    toolkit: Any | None = None,
    graph_factory: GraphFactory = build_conversation_graph,
) -> SpecialistRunner:
    """Build the weekly_plan runner (wraps the week_chat conversation graph)."""

    def _run(task: SpecialistTask) -> SpecialistResult:
        folder = task.active_target.folder if task.active_target else None
        if not folder:
            # No concrete week to act on — the Resolver should have filled this,
            # so reaching here means no current week exists. Ask rather than guess.
            return SpecialistResult(
                status="needs_clarification",
                clarification="你想调整哪一周的训练？我没找到当前周的计划。",
            )

        active_toolkit = toolkit or build_stride_toolkit(user_id)
        graph = graph_factory(
            toolkit=active_toolkit, llm=llm, checkpointer=None, scope="week_chat"
        )

        messages: list[Any] = []
        # Long-term memory (injected by Memory Load, §4.0) as background context.
        if task.context and task.context.notes:
            messages.append(HumanMessage(content=f"（已知长期背景，供参考）\n{task.context.notes}"))
        # The draft tools take an explicit `folder`; hand the model the value so
        # it doesn't have to guess (the week_chat prompt names `folder` but not
        # its value).
        messages.append(
            HumanMessage(
                content=f"【当前周】folder = {folder}（所有 draft 工具的 folder 参数都用这个值）"
            )
        )
        messages.extend(_window_to_messages(task.conversation_window))
        messages.append(HumanMessage(content=task.objective))

        state_in = {
            "history": messages,
            "scope": "week_chat",
            "user_id": user_id,
            "thread_id": "",
            "folder": folder,
            "plan_id": None,
            "constraints": [],
            "last_diff": None,
            "iteration": 0,
        }
        state = graph.invoke(state_in, config={})

        reply = _extract_reply(state.get("history") or [])
        proposals: list[PlanDiff] = []
        last_diff = state.get("last_diff")
        if last_diff is not None:
            try:
                proposals.append(PlanDiff.model_validate(last_diff))
            except Exception:  # noqa: BLE001 — a malformed draft must not crash the turn
                logger.warning("weekly_plan: last_diff did not validate as PlanDiff", exc_info=True)
        # A tool-call-only AIMessage (no accompanying text) leaves an empty reply
        # next to a real proposal. Surface the diff's own explanation so the user
        # never sees a blank bubble beside a change card.
        if not reply and proposals:
            logger.warning(
                "weekly_plan: empty reply with a non-null proposal — "
                "falling back to the diff explanation"
            )
            reply = proposals[0].ai_explanation
        logger.debug(
            "weekly_plan: week_chat done | reply=%dc | proposals=%d | iters=%s",
            len(reply),
            len(proposals),
            state.get("iteration"),
        )
        return SpecialistResult(
            status="completed",
            reply_fragment=reply,
            proposals=proposals,
        )

    return _run
