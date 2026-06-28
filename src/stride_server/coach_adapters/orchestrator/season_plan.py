"""season_plan specialist — wraps the master_chat graph as a SpecialistContract (A3).

The season_plan expert **amends** the athlete's long-term master plan (赛季计划/
总纲): extend/compress a phase, shift or retarget a milestone, propose
alternatives, or clear-for-regeneration. It already exists as the ``master_chat``
scope of the conversation graph (6 real master-scope draft tools that emit a
``MasterPlanDiff``), so this adapter dresses it in the SpecialistContract and
returns the diff as a Pattern-Y ``proposal``.

Two adapter-only concerns:

* **plan resolution** — the draft tools take an explicit ``plan_id``; the current
  active master plan is seeded into the model's context. No active plan → can't
  amend → ``needs_clarification`` (generating a *new* season plan stays in its
  own async flow, out of this turn's scope).
* **validation gate** (spec §10 Q#6) — the proposed ``MasterPlanDiff`` is run
  through :func:`validate_master_diff` before it's surfaced. A structurally
  broken diff (inverted phase, milestone outside the season, stale id) is
  dropped with an explanation instead of being offered to the user.

Generation/regeneration of a brand-new plan is an async multi-minute job
(``POST /master-plan/generate``), which can't run inside a synchronous turn, so
it is intentionally not handled here. ``regenerate_master`` as a *diff* (clear
the current plan) is still reachable via the amend path's draft tool.

Stateless per call (graph built ``checkpointer=None``); session memory lives at
the orchestrator level.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
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
from coach.graphs.conversation.master_diff_gate import validate_master_diff
from coach.schemas import assistant_parts_from_message
from stride_core.master_plan_diff import MasterPlanDiff

from ...master_plan_store import get_master_plan_store
from ..toolkit import build_stride_toolkit

logger = logging.getLogger(__name__)

GraphFactory = Callable[..., Any]


SEASON_PLAN_CARD = SpecialistCard(
    id="season_plan",
    description=(
        "调整长期赛季计划/总纲：延长或缩短某个阶段、改里程碑日期或目标、给备选方案、"
        "清空重排。产出 typed 修改提案（diff），等用户确认后落地。不负责从零生成新赛季计划。"
    ),
    tags=["赛季", "总纲", "赛季计划", "阶段", "里程碑", "周期", "macro"],
    examples=[
        "把基础期延长两周",
        "我的比赛推迟了，里程碑往后挪一周",
        "赛季计划的目标改成 sub-3",
        "缩短一下专项期",
        "给我两个赛季调整方案",
    ],
    writes=True,
    data_needs=[],
)


def make_current_master_target_resolver(
    user_id: str,
) -> Callable[[TargetRef | None], TargetRef | None]:
    """Build the Resolver's master-target resolver: "赛季计划/总纲" → active plan.

    Only ``master`` targets are resolved here; a ``None``/week/session target
    returns ``None`` so the combined resolver falls through to the week resolver.
    No active plan → ``None`` (the Resolver then clarifies).
    """

    def _resolve(target: TargetRef | None) -> TargetRef | None:
        if target is None or target.kind != "master":
            return None
        plan = get_master_plan_store().get_active_plan(user_id)
        if plan is None:
            return None
        return TargetRef(kind="master", plan_id=plan.plan_id)

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
    """Reply text = the last AIMessage's text parts (a draft-tool turn ends on a
    ToolMessage, so scan back rather than reading ``history[-1]`` blindly)."""
    for msg in reversed(history):
        if isinstance(msg, AIMessage):
            texts = [
                part.text
                for part in assistant_parts_from_message(msg)
                if part.kind == "text"
            ]
            return "\n".join(t for t in texts if t).strip()
    return ""


def make_season_plan_runner(
    *,
    user_id: str,
    llm: Any,
    toolkit: Any | None = None,
    graph_factory: GraphFactory = build_conversation_graph,
) -> SpecialistRunner:
    """Build the season_plan runner (wraps the master_chat conversation graph)."""

    def _run(task: SpecialistTask) -> SpecialistResult:
        plan_id = task.active_target.plan_id if task.active_target else None
        if not plan_id:
            # No active plan to amend — the Resolver should have filled this.
            return SpecialistResult(
                status="needs_clarification",
                clarification=(
                    "你还没有可调整的赛季计划。如果想生成一个新的赛季计划，"
                    "可以在「赛季计划」页发起生成。"
                ),
            )

        active_toolkit = toolkit or build_stride_toolkit(user_id)
        graph = graph_factory(
            toolkit=active_toolkit, llm=llm, checkpointer=None, scope="master_chat"
        )

        messages: list[Any] = []
        if task.context and task.context.notes:
            messages.append(HumanMessage(content=f"（已知长期背景，供参考）\n{task.context.notes}"))
        # The master draft tools take an explicit `plan_id`; hand the model the
        # value so it doesn't have to guess.
        messages.append(
            HumanMessage(
                content=f"【当前赛季计划】plan_id = {plan_id}（所有 draft 工具的 plan_id 参数都用这个值）"
            )
        )
        messages.extend(_window_to_messages(task.conversation_window))
        messages.append(HumanMessage(content=task.objective))

        state_in = {
            "history": messages,
            "scope": "master_chat",
            "user_id": user_id,
            "thread_id": "",
            "folder": None,
            "plan_id": plan_id,
            "constraints": [],
            "last_diff": None,
            "iteration": 0,
        }
        state = graph.invoke(state_in, config={})

        reply = _extract_reply(state.get("history") or [])
        proposal: MasterPlanDiff | None = None
        last_diff = state.get("last_diff")
        if last_diff is not None:
            try:
                proposal = MasterPlanDiff.model_validate(last_diff)
            except Exception:  # noqa: BLE001 — a malformed draft must not crash the turn
                logger.warning(
                    "season_plan: last_diff did not validate as MasterPlanDiff", exc_info=True
                )
                proposal = None

        # Validation gate (§10 Q#6): never surface a structurally broken diff.
        if proposal is not None:
            plan = get_master_plan_store().get_plan(user_id, plan_id)
            if plan is None:
                # Plan vanished between target resolution and now — don't surface
                # an un-gated proposal for a plan that no longer exists.
                logger.warning("season_plan: plan %s disappeared mid-turn; dropping proposal", plan_id)
                return SpecialistResult(
                    status="completed",
                    reply_fragment="你的赛季计划好像已经不在了，请刷新后再试。",
                    proposal=None,
                )
            violations = validate_master_diff(plan, proposal)
            if violations:
                logger.warning(
                    "season_plan: dropping invalid MasterPlanDiff | %d violation(s): %s",
                    len(violations), violations,
                )
                detail = "；".join(violations)
                return SpecialistResult(
                    status="completed",
                    reply_fragment=(
                        f"我准备的调整有结构问题，没法直接应用：{detail}。"
                        "要不要换个方式说说你想怎么调？"
                    ),
                    proposal=None,
                )

        if not reply and proposal is not None:
            reply = proposal.ai_explanation

        logger.debug(
            "season_plan: master_chat done | reply=%dc | proposal=%s | iters=%s",
            len(reply),
            "yes" if proposal is not None else "no",
            state.get("iteration"),
        )
        return SpecialistResult(status="completed", reply_fragment=reply, proposal=proposal)

    return _run
