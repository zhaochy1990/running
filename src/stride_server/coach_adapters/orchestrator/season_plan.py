"""season_plan specialist — wraps the master_chat graph as a SpecialistContract (A3).

The season_plan expert **amends** the athlete's long-term master plan (赛季计划/
总纲): extend/compress a phase, shift or retarget a milestone, propose
alternatives, or clear-for-regeneration. It already exists as the ``master_chat``
scope of the conversation graph (10 real master-scope draft tools that emit one
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
from datetime import date
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from coach.contracts import (
    SpecialistCard,
    SpecialistResult,
    SpecialistRunner,
    SpecialistTask,
    TargetRef,
    Turn,
    TurnResponse,
)
from coach.graphs.conversation.graph import build_conversation_graph
from coach.graphs.conversation.master_diff_gate import validate_master_diff
from coach.graphs.conversation.master_adjustment_direction import (
    master_diff_matches_volume_request,
    requested_weekly_volume_direction,
)
from coach.schemas import assistant_parts_from_message
from stride_core.master_plan_diff import MasterPlanDiff

from ...master_plan_store import get_master_plan_store
from ..toolkit import build_stride_toolkit

logger = logging.getLogger(__name__)

GraphFactory = Callable[..., Any]

_CONCRETE_DIRECTION_RE = re.compile(
    r"(?:延长|缩短|缩到|增加|加大|加到|加量|降低|降到|减少|减量|减轻|提高|提升|"
    r"调高|调低|调整到|设为|前移|后移|往前|往后|提前|推迟|延期|顺延|延后|改为|改成|"
    r"改到|挪到|侧重|聚焦|专注|重点放在|"
    r"取消|删除|保留|重排|重新生成|清空|"
    r"extend|shorten|increase|decrease|reduce|raise|lower|move|shift|postpone|"
    r"change\s+(?:the\s+)?target|focus|emphasi[sz]e|prioriti[sz]e|regenerate)",
    re.IGNORECASE,
)
_UNDECIDED_DIRECTION_RE = re.compile(
    r"(?:还?没想好|还?没决定|不确定|不知道|拿不准|not\s+sure|undecided)"
    r".{0,24}(?:还是|或者|或|要不要|是否|该不该|whether|or)",
    re.IGNORECASE,
)
_CONFLICTING_DIRECTIONS_RE = re.compile(
    r"(?:增加|加大|提高|提升|延长|前移|提前|保留)"
    r".{0,12}(?:还是|或者|或)"
    r"(?:减少|降低|减量|缩短|后移|推迟|删除)"
    r"|(?:减少|降低|减量|缩短|后移|推迟|删除)"
    r".{0,12}(?:还是|或者|或)"
    r"(?:增加|加大|提高|提升|延长|前移|提前|保留)"
    r"|(?:increase|raise|extend|advance|keep)"
    r".{0,24}\b(?:or|versus|vs\.?)\b.{0,24}"
    r"(?:decrease|reduce|lower|shorten|postpone|remove)"
    r"|(?:decrease|reduce|lower|shorten|postpone|remove)"
    r".{0,24}\b(?:or|versus|vs\.?)\b.{0,24}"
    r"(?:increase|raise|extend|advance|keep)",
    re.IGNORECASE,
)
_PHASE_TARGET_REQUIRED_RE = re.compile(
    r"(?:训练重点|重点(?:改|调|放)|侧重|聚焦|专注|"
    r"周跑量|周量区间|跑量|训练量|里程|减量|加量|weekly\s+(?:distance|volume|range)|"
    r"延长|缩短|extend|shorten|compress|"
    r"focus|emphasi[sz]e|prioriti[sz]e)",
    re.IGNORECASE,
)
_EXPLICIT_VOLUME_TARGET_RE = re.compile(
    r"(?:\d+(?:\.\d+)?\s*(?:公里|km)?\s*[–—\-~至到]\s*"
    r"\d+(?:\.\d+)?\s*(?:公里|km)|\d+(?:\.\d+)?\s*%)",
    re.IGNORECASE,
)
_AMBIGUOUS_VOLUME_PERCENT_RE = re.compile(
    r"\d+(?:\.\d+)?\s*%\s*(?:还是|或者|或|/|、)\s*"
    r"\d+(?:\.\d+)?\s*%",
    re.IGNORECASE,
)
_MULTIPLE_OPTIONS_RE = re.compile(
    r"(?:两个|两种|2\s*个|比较|对比|备选|alternatives?|options?|compare)",
    re.IGNORECASE,
)
_EXPLICIT_PHASE_TARGET_RE = re.compile(
    r"(?:基础期|基础阶段|base\s*(?:phase)?|"
    r"专项期|专项阶段|强化期|build\s*(?:phase)?|"
    r"高峰期|赛前期|peak\s*(?:phase)?|"
    r"减量期|调整期|taper\s*(?:phase)?|"
    r"恢复期|恢复阶段|recovery\s*(?:phase)?|"
    r"当前阶段|现阶段|这个阶段|本阶段|下一阶段|下个阶段|后续阶段|"
    r"第\s*[一二三四五六七八九十0-9]+\s*(?:个)?阶段|"
    r"phase[-_ ]?[a-z0-9]+)",
    re.IGNORECASE,
)
_PHASE_ONLY_ANSWER_RE = re.compile(
    r"\s*(?:就|选|选择|目标(?:是|为)?|调整)?\s*"
    r"(?:基础期|基础阶段|base\s*(?:phase)?|"
    r"专项期|专项阶段|强化期|build\s*(?:phase)?|"
    r"高峰期|赛前期|peak\s*(?:phase)?|"
    r"减量期|调整期|taper\s*(?:phase)?|"
    r"恢复期|恢复阶段|recovery\s*(?:phase)?|"
    r"当前阶段|现阶段|这个阶段|本阶段|下一阶段|下个阶段|后续阶段|"
    r"第\s*[一二三四五六七八九十0-9]+\s*(?:个)?阶段|"
    r"phase[-_ ]?[a-z0-9]+)"
    r"\s*(?:吧)?\s*[。.!！]?\s*",
    re.IGNORECASE,
)
_VOLUME_DETAILS_ANSWER_RE = re.compile(
    r"\s*(?:(?:基础|专项|强化|高峰|赛前|减量|调整|恢复|当前|现|这个|本|下一|下个|后续)"
    r"(?:期|阶段)?|第\s*[一二三四五六七八九十0-9]+\s*(?:个)?阶段|"
    r"phase[-_ ]?[a-z0-9]+)?\s*[,，:：]?\s*"
    r"(?:增加|加大|提高|提升|降低|减少|减量|加量)?\s*(?:到|至)?\s*"
    r"(?:\d+(?:\.\d+)?\s*(?:公里|km)?\s*[–—\-~至到]\s*"
    r"\d+(?:\.\d+)?\s*(?:公里|km)|\d+(?:\.\d+)?\s*%)"
    r"\s*[。.!！]?\s*",
    re.IGNORECASE,
)
_DIRECTION_CLARIFICATION = (
    "你希望具体怎么调整整体训练计划？请先告诉我你的调整方向，例如想增加或减少"
    "哪个阶段的训练量、延长或缩短哪个阶段、移动比赛日期，或者修改目标。"
)
_PHASE_TARGET_CLARIFICATION = (
    "你希望调整哪个阶段？请指定阶段，例如基础期、专项期、调整期，"
    "或者明确说当前阶段/下一阶段。确认阶段后我再加载数据评估这个想法。"
)
_VOLUME_DETAILS_CLARIFICATION = (
    "你想调整哪个阶段的周跑量，以及希望调整到什么区间或调整多少百分比？"
    "例如“专项期提高 10%”或“专项期增加到 80–95 公里”。"
    "确认阶段和幅度后我再加载数据评估这个想法。"
)
_VOLUME_TARGET_CLARIFICATION = (
    "你希望把这个阶段的周跑量调整到什么区间，或调整多少百分比？"
    "请给出明确幅度，例如“提高 10%”或“增加到 80–95 公里”。"
    "确认幅度后我再加载数据评估这个想法。"
)
_MASTER_ADJUSTMENT_CONTEXT_RE = re.compile(
    r"(?:总计划|整体训练计划|总纲|赛季计划|master\s*plan|"
    r"训练重点|周跑量|周量区间|跑量|训练量|里程|加量|减量|(?:延长|缩短).{0,12}阶段)",
    re.IGNORECASE,
)
_MASTER_WRITE_CUE_RE = re.compile(
    r"(?:调整|修改|改成|改为|优化|重排|重新生成|增加|加大|加量|提高|提升|调高|降低|减少|减量|调低|"
    r"延长|缩短|前移|后移|推迟|延期|侧重|聚焦|专注|"
    r"adjust|change|modify|regenerate|increase|decrease|reduce|extend|shorten|shift)",
    re.IGNORECASE,
)
_MASTER_ADVICE_QUESTION_RE = re.compile(
    r"(?:要不要|是否(?:需要|应该)?|需不需要|该不该|应不应该|"
    r"你觉得.{0,12}(?:需要|应该|有必要)|"
    r"(?:我|现在|当前).{0,8}(?:需要|有必要).{0,16}(?:吗|么|[?？])|"
    r"do\s+i\s+need|should\s+i)",
    re.IGNORECASE,
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
    """Default-deny proposal work until the user chooses a direction.

    The resolver contract routes read-only master-plan questions to
    ``status_insight``. Reaching this write specialist without a concrete
    direction is therefore always a clarification turn, including unusual
    vague wording that no keyword list could enumerate safely.
    """
    if (
        _UNDECIDED_DIRECTION_RE.search(objective)
        or _CONFLICTING_DIRECTIONS_RE.search(objective)
    ):
        return True
    return not bool(_CONCRETE_DIRECTION_RE.search(objective))


def _clarification_for_objective(objective: str) -> str | None:
    """Return the pre-data clarification needed for this write request."""
    if _needs_direction_clarification(objective):
        return _DIRECTION_CLARIFICATION
    if _AMBIGUOUS_VOLUME_PERCENT_RE.search(objective):
        return _VOLUME_TARGET_CLARIFICATION
    volume_direction = requested_weekly_volume_direction(objective)
    volume_change = volume_direction is not None
    missing_phase = not _EXPLICIT_PHASE_TARGET_RE.search(objective)
    reduction_alternatives = bool(
        volume_direction == "decrease"
        and _MULTIPLE_OPTIONS_RE.search(objective)
    )
    missing_volume_target = bool(
        volume_change
        and not reduction_alternatives
        and not _EXPLICIT_VOLUME_TARGET_RE.search(objective)
    )
    if volume_change and missing_phase and missing_volume_target:
        return _VOLUME_DETAILS_CLARIFICATION
    if volume_change and missing_volume_target:
        return _VOLUME_TARGET_CLARIFICATION
    if volume_change and missing_phase:
        return _PHASE_TARGET_CLARIFICATION
    if (
        _PHASE_TARGET_REQUIRED_RE.search(objective)
        and missing_phase
    ):
        return _PHASE_TARGET_CLARIFICATION
    return None


def _effective_objective_for_task(task: SpecialistTask) -> str:
    """Recover the full request behind a short clarification answer."""
    objective = task.objective.strip()
    if not (
        _PHASE_ONLY_ANSWER_RE.fullmatch(objective)
        or _VOLUME_DETAILS_ANSWER_RE.fullmatch(objective)
    ):
        return objective

    turns = list(task.conversation_window)
    if (
        len(turns) < 2
        or turns[-1].role != "assistant"
        or turns[-2].role != "user"
        or not any(
            marker in turns[-1].content
            for marker in (
                "哪个阶段",
                "调整到什么区间",
                "调整多少百分比",
                "增加到什么区间",
                "增加多少百分比",
            )
        )
        or "再加载数据评估" not in turns[-1].content
    ):
        return objective
    prior_user = turns[-2].content
    if not prior_user:
        return objective
    prior_effective = _effective_objective_for_task(
        SpecialistTask(
            objective=prior_user,
            active_target=task.active_target,
            conversation_window=turns[:-2],
        )
    )
    if (
        _clarification_for_objective(prior_effective)
        not in {
            _PHASE_TARGET_CLARIFICATION,
            _VOLUME_DETAILS_CLARIFICATION,
            _VOLUME_TARGET_CLARIFICATION,
        }
    ):
        return objective
    return f"{objective}：{prior_effective}"


def clarification_for_season_plan_task(task: SpecialistTask) -> str | None:
    """Public deterministic preflight shared by HTTP adapters and the runner.

    It intentionally performs no store, toolkit, or model access.  Adapters can
    therefore answer clarification turns before even looking up the active plan.
    """
    return _clarification_for_objective(_effective_objective_for_task(task))


def preflight_season_plan_turn(
    objective: str, conversation_window: list[Turn]
) -> TurnResponse | None:
    """Short-circuit incomplete master-adjustment turns before orchestration."""
    continuing_clarification = bool(
        conversation_window
        and conversation_window[-1].role == "assistant"
        and (
            "具体怎么调整" in conversation_window[-1].content
            or (
                any(
                    marker in conversation_window[-1].content
                    for marker in (
                        "哪个阶段",
                        "调整到什么区间",
                        "调整多少百分比",
                        "增加到什么区间",
                        "增加多少百分比",
                    )
                )
                and "再加载数据评估" in conversation_window[-1].content
            )
        )
    )
    if not continuing_clarification and _MASTER_ADVICE_QUESTION_RE.search(objective):
        return None
    if not continuing_clarification and not (
        _MASTER_ADJUSTMENT_CONTEXT_RE.search(objective)
        and _MASTER_WRITE_CUE_RE.search(objective)
    ):
        return None
    task = SpecialistTask(
        objective=objective,
        active_target=TargetRef(kind="master"),
        conversation_window=conversation_window,
    )
    clarification = clarification_for_season_plan_task(task)
    if clarification is None:
        return None
    return TurnResponse(
        reply=clarification,
        clarification=clarification,
        active_target=TargetRef(kind="master"),
    )


def _parse_proposals(last_diff: Any) -> list[MasterPlanDiff]:
    """Decode a single diff or a ``propose_reduction_alternatives`` result envelope.

    The conversation graph deliberately keeps draft-tool data opaque.  Most
    master tools return one ``MasterPlanDiff`` mapping, while
    ``propose_reduction_alternatives`` returns ``{"alternatives": [diff, ...]}``.
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
    llm: Any | None = None,
    llm_factory: Callable[[], Any] | None = None,
    toolkit: Any | None = None,
    plan_store: Any | None = None,
    state_observer: Callable[[dict[str, Any]], None] | None = None,
    graph_factory: GraphFactory = build_conversation_graph,
    validation_as_of: date | None = None,
) -> SpecialistRunner:
    """Build the season_plan runner (wraps the master_chat conversation graph)."""
    if llm is None and llm_factory is None:
        raise ValueError("season_plan requires llm or llm_factory")

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

        effective_objective = _effective_objective_for_task(task)
        clarification = clarification_for_season_plan_task(task)
        if clarification is not None:
            return SpecialistResult(
                status="needs_clarification",
                clarification=clarification,
            )

        active_plan_store = plan_store or get_master_plan_store()
        # Keep provider/toolkit construction behind both deterministic
        # clarification gates.  A vague adjustment request must remain a
        # zero-data, zero-LLM turn, including provider initialisation.
        active_llm = llm if llm is not None else llm_factory()
        active_toolkit = toolkit or build_stride_toolkit(user_id)
        graph = graph_factory(
            toolkit=active_toolkit, llm=active_llm, checkpointer=None, scope="master_chat"
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
        messages.append(HumanMessage(content=effective_objective))

        state_in = {
            "history": messages,
            "scope": "master_chat",
            "user_id": user_id,
            "thread_id": "",
            "folder": None,
            "plan_id": plan_id,
            "constraints": [],
            "consulted_tools": [],
            "tool_trace": [],
            "master_adjustment_request": effective_objective,
            "master_adjustment_assessment": None,
            "last_diff": None,
            "iteration": 0,
        }
        state = graph.invoke(state_in, config={})
        if state_observer is not None:
            state_observer(state)

        reply = _extract_reply(state.get("history") or [])
        proposals: list[MasterPlanDiff] = []
        last_diff = state.get("last_diff")
        assessment = state.get("master_adjustment_assessment")
        assessment_matches = (
            isinstance(assessment, dict)
            and assessment.get("adjustment_request") == effective_objective
        )
        verdict = assessment.get("verdict") if assessment_matches else None
        if verdict == "needs_clarification":
            clarification = reply or str(assessment.get("rationale") or "")
            return SpecialistResult(
                status="needs_clarification",
                clarification=clarification or _DIRECTION_CLARIFICATION,
            )

        # Defense in depth at the typed specialist boundary. The conversation
        # graph already blocks draft tools before a matching reasonable
        # assessment; still discard any unexpected diff returned by a custom or
        # degraded graph so no alternate adapter can bypass that contract.
        if last_diff is not None and verdict != "reasonable":
            logger.warning(
                "season_plan: dropping proposal without matching reasonable assessment"
            )
            last_diff = None
        is_alternatives = isinstance(last_diff, dict) and "alternatives" in last_diff
        if last_diff is not None:
            proposals = _parse_proposals(last_diff)
            direction_safe = [
                proposal
                for proposal in proposals
                if master_diff_matches_volume_request(proposal, effective_objective)
            ]
            if len(direction_safe) != len(proposals):
                logger.warning(
                    "season_plan: dropping proposal that mismatches requested volume change"
                )
                proposals = direction_safe
                if not proposals:
                    direction = requested_weekly_volume_direction(effective_objective)
                    requested_label = (
                        "增加" if direction == "increase"
                        else "降低" if direction == "decrease"
                        else "调整"
                    )
                    return SpecialistResult(
                        status="completed",
                        reply_fragment=(
                            f"生成的方案与“{requested_label}周跑量”的方向或幅度不一致，"
                            "已阻止展示和应用。请重新生成这个调整。"
                        ),
                    )

        # Validation gate (§10 Q#6): validate alternatives independently so one
        # malformed choice cannot hide another valid one.
        invalid_details: list[str] = []
        if proposals:
            plan = active_plan_store.get_plan(user_id, plan_id)
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
                violations = validate_master_diff(
                    plan, proposal, as_of=validation_as_of
                )
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
