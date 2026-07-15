"""season_plan specialist — wraps the master_chat graph as a SpecialistContract (A3).

The season_plan expert **amends** the athlete's long-term master plan (赛季计划/
总纲): extend/compress a phase, shift or retarget a milestone, propose
alternatives, or clear-for-regeneration. It already exists as the ``master_chat``
scope of the conversation graph (6 real master-scope draft tools that emit one
or more ``MasterPlanDiff`` values), so this adapter dresses it in the
SpecialistContract and returns the diffs as Pattern-Y proposals.

Two adapter-only concerns:

* **plan resolution** — the draft tools take an explicit ``plan_id``; the current
  active master plan is seeded into the model's context. No active plan → can't
  amend → ``needs_clarification`` (generating a *new* season plan stays in its
  own async flow, out of this turn's scope).
* **validation gate** (spec §10 Q#6) — every proposed ``MasterPlanDiff`` is run
  independently through :func:`validate_master_diff` before it's surfaced. A
  structurally broken diff (inverted phase, milestone outside the season, stale
  id) is dropped instead of being offered to the user.

Generation/regeneration of a brand-new plan is an async multi-minute job
(``POST /master-plan/generate``), which can't run inside a synchronous turn, so
it is intentionally not handled here. ``regenerate_master`` as a *diff* (clear
the current plan) is still reachable via the amend path's draft tool.

Stateless per call (graph built ``checkpointer=None``); session memory lives at
the orchestrator level.
"""

from __future__ import annotations

import logging
import re
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

_CONCRETE_DIRECTION_RE = re.compile(
    r"(?:延长|缩短|缩到|增加|加大|降低|减少|减量|减轻|提高|提升|调高|调低|"
    r"调整到|设为|前移|后移|往前|往后|提前|推迟|延后|改为|改成|改到|挪到|"
    r"取消|删除|保留|重排|重新生成|清空|"
    r"extend|shorten|increase|decrease|reduce|raise|lower|move|shift|postpone|"
    r"change\s+(?:the\s+)?target|regenerate)",
    re.IGNORECASE,
)
_ADJUSTMENT_REQUEST_RE = re.compile(
    r"(?:调整|修改|优化|改(?:一?下|动)?(?:我的|这个|当前)?(?:整体|长期|赛季|总纲)?训练计划|"
    r"adjust|modify|revise|optimi[sz]e)",
    re.IGNORECASE,
)

_DIRECTION_CLARIFICATION = (
    "你希望具体怎么调整整体训练计划？请先告诉我你的调整方向，例如想增加或减少"
    "哪个阶段的训练量、延长或缩短哪个阶段、移动比赛日期，或者修改目标。"
)


SEASON_PLAN_CARD = SpecialistCard(
    id="season_plan",
    description=(
        "调整长期赛季计划/总纲：延长或缩短某个阶段、改里程碑日期或目标、给备选方案、"
        "修改阶段级周量范围、清空重排。产出 typed 修改提案（diff），等用户确认后落地。"
        "不负责生成总体计划第 N 周的 weekly plan；那是 weekly_plan 专家的 week 目标。"
        "不负责从零生成新赛季计划。"
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


def _needs_direction_clarification(objective: str) -> bool:
    """Whether this is an adjustment request with no user-chosen direction."""
    return bool(_ADJUSTMENT_REQUEST_RE.search(objective)) and not bool(
        _CONCRETE_DIRECTION_RE.search(objective)
    )


def _parse_proposals(last_diff: Any) -> list[MasterPlanDiff]:
    """Decode a single diff or a ``propose_alternatives`` result envelope.

    The conversation graph deliberately keeps draft-tool data opaque.  Most
    master tools return one ``MasterPlanDiff`` mapping, while
    ``propose_alternatives`` returns ``{"alternatives": [diff, ...]}``.
    Normalising that shape belongs at this typed adapter boundary.
    """
    if not isinstance(last_diff, dict):
        logger.warning(
            "season_plan: draft result is not an object | type=%s",
            type(last_diff).__name__,
        )
        return []

    raw_proposals: Any = last_diff.get("alternatives", [last_diff])
    if not isinstance(raw_proposals, list):
        logger.warning("season_plan: alternatives is not a list")
        return []

    proposals: list[MasterPlanDiff] = []
    for index, raw in enumerate(raw_proposals):
        try:
            proposals.append(MasterPlanDiff.model_validate(raw))
        except Exception:  # noqa: BLE001 — contain one malformed alternative
            logger.warning(
                "season_plan: proposal %d did not validate as MasterPlanDiff",
                index,
                exc_info=True,
            )
    return proposals


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

        if _needs_direction_clarification(task.objective):
            return SpecialistResult(
                status="needs_clarification",
                clarification=_DIRECTION_CLARIFICATION,
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
            "consulted_tools": [],
            "master_adjustment_request": task.objective.strip(),
            "master_adjustment_assessment": None,
            "last_diff": None,
            "iteration": 0,
        }
        state = graph.invoke(state_in, config={})

        reply = _extract_reply(state.get("history") or [])
        proposals: list[MasterPlanDiff] = []
        last_diff = state.get("last_diff")
        is_alternatives = isinstance(last_diff, dict) and "alternatives" in last_diff
        if last_diff is not None:
            proposals = _parse_proposals(last_diff)

        # Validation gate (§10 Q#6): validate alternatives independently so one
        # malformed choice cannot hide another valid one.
        invalid_details: list[str] = []
        if proposals:
            plan = get_master_plan_store().get_plan(user_id, plan_id)
            if plan is None:
                # Plan vanished between target resolution and now — don't surface
                # an un-gated proposal for a plan that no longer exists.
                logger.warning("season_plan: plan %s disappeared mid-turn; dropping proposal", plan_id)
                return SpecialistResult(
                    status="completed",
                    reply_fragment="你的赛季计划好像已经不在了，请刷新后再试。",
                )
            valid_proposals: list[MasterPlanDiff] = []
            for index, proposal in enumerate(proposals):
                violations = validate_master_diff(plan, proposal)
                if not violations:
                    valid_proposals.append(proposal)
                    continue
                invalid_details.extend(violations)
                logger.warning(
                    "season_plan: dropping invalid proposal %d | %d violation(s): %s",
                    index,
                    len(violations),
                    violations,
                )
            proposals = valid_proposals

        if last_diff is not None and not proposals:
            detail = "；".join(invalid_details) or "返回的调整方案格式不完整"
            return SpecialistResult(
                status="completed",
                reply_fragment=(
                    f"我准备的调整有结构问题，没法直接应用：{detail}。"
                    "要不要换个方式说说你想怎么调？"
                ),
            )

        if is_alternatives and proposals:
            if len(proposals) == 1:
                reply = (
                    "安全校验后只剩 1 个可应用的调整方向，请确认是否采用："
                    f"{proposals[0].ai_explanation}"
                )
            else:
                reply = f"我准备了 {len(proposals)} 个通过安全校验的调整方向，请选择一个方案。"
        elif not reply and proposals:
            reply = proposals[0].ai_explanation

        logger.debug(
            "season_plan: master_chat done | reply=%dc | proposals=%d | iters=%s",
            len(reply),
            len(proposals),
            state.get("iteration"),
        )
        return SpecialistResult(status="completed", reply_fragment=reply, proposals=proposals)

    return _run
