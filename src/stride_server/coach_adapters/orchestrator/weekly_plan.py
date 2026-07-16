"""weekly_plan specialist — wraps the week_chat conversation graph (§4.3, §7, A2).

The weekly_plan expert creates or adjusts the current/next week's sessions. It uses
as the ``week_chat`` scope of the conversation graph (7 real draft tools that emit
a ``PlanDiff``), so this adapter dresses it in the SpecialistContract:
``SpecialistTask`` → ``SpecialistResult`` (carrying the proposed ``PlanDiff`` as
``proposals`` — Pattern Y: the diff rides the response, ``/apply`` lands it).

Two adapter-only concerns this module owns:

* **folder resolution** — the draft tools take an explicit ``folder`` arg, so the
  target week's folder (from ``task.active_target``) is seeded into the model's
  context. With no folder we can't act → ``needs_clarification``.
* **current-week lookup** — :func:`resolve_current_week_folder` maps "本周" to the
  display/PlanDiff folder carried by the current canonical ``WeeklyPlanStore`` row;
  injected into the Resolver so a routine "调整本周" dispatches without re-asking.

Stateless per call (the graph is built ``checkpointer=None``): session memory
lives at the orchestrator level (the ``conversation_window`` arrives in the task).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage

from coach.contracts import (
    SpecialistCard,
    SpecialistResult,
    SpecialistRunner,
    SpecialistTask,
    TargetHint,
    TargetRef,
    Turn,
)
from coach.graphs.conversation.graph import build_conversation_graph
from coach.schemas import assistant_parts_from_message
from stride_core.plan_diff import PlanDiff
from stride_core.timefmt import parse_week_folder_dates, today_shanghai
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal
from stride_core.weekly_plan_proposal import is_supported_weekly_plan_generation

from ...weekly_plan_store import get_weekly_plan_store
from ...weekly_plan_generator import WeeklyPlanAlreadyExistsError, build_weekly_plan
from ...week_generator import week_folder
from ..toolkit import build_stride_toolkit

logger = logging.getLogger(__name__)

GraphFactory = Callable[..., Any]
_WEEK_NUMBER_RE = re.compile(r"第\s*(\d{1,3})\s*周")
_CURRENT_WEEK_MARKERS = ("本周", "这周", "这一周", "当前周", "本星期", "这个星期")
_NEXT_WEEK_MARKERS = ("下周", "下一周", "下星期", "下个星期")
_WEEK_AFTER_NEXT_MARKERS = ("下下周", "下下星期", "两周后", "两星期后")
_WEEKS_LATER_RE = re.compile(r"(\d{1,2})\s*(?:个)?(?:周|星期)后")


WEEKLY_PLAN_CARD = SpecialistCard(
    id="weekly_plan",
    description=(
        "生成或调整 weekly plan：只支持当前周和下一周；下下周及以后不支持生成。"
        "可调换/挪动课时、整周或单日减量、替换课时类型、加力量、改配速目标、"
        "清空重排。目标是 week，不是修改总纲阶段。产出 typed 创建/修改提案，"
        "等用户确认后落地。"
    ),
    tags=["本周", "下周", "周计划", "生成", "调整", "换课", "减量", "挪动"],
    examples=[
        "把周三的间歇换到周四",
        "今天太累，本周量减 20%",
        "周五加一节力量",
        "把明天的配速放慢到 5:30",
        "这周重新安排一下",
        "生成下周的 weekly plan",
        "生成下下周的计划（应明确拒绝）",
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


def resolve_master_week_folder(user_id: str, week_index: int) -> str | None:
    """Resolve a global master-plan week number to its weekly-plan folder.

    ``MasterPlan.weeks`` is the canonical week-index/date mapping. Reuse an
    existing WeeklyPlanStore folder when one covers that date; otherwise return
    the natural Monday→Sunday folder that a new weekly plan would use.
    """
    from ...master_plan_store import get_master_plan_store

    try:
        master = get_master_plan_store().get_active_plan(user_id)
    except Exception:
        logger.exception("weekly_plan: active master-plan lookup failed")
        return None
    if master is None:
        return None

    weeks = list(master.weeks or master.weekly_key_sessions or [])
    match = next((week for week in weeks if week.week_index == week_index), None)
    if match is not None:
        try:
            week_start = date_cls.fromisoformat(match.week_start)
        except (TypeError, ValueError):
            logger.warning(
                "weekly_plan: master week %s has invalid week_start %r",
                week_index,
                match.week_start,
            )
            return None
    elif not weeks and 1 <= week_index <= master.total_weeks:
        # Legacy plans predate the canonical week skeleton. Their start_date +
        # total_weeks still defines a deterministic global week mapping.
        try:
            plan_start = date_cls.fromisoformat(master.start_date)
        except (TypeError, ValueError):
            logger.warning(
                "weekly_plan: legacy master has invalid start_date %r",
                master.start_date,
            )
            return None
        week_start = plan_start + timedelta(days=(week_index - 1) * 7)
    else:
        return None

    try:
        existing = get_weekly_plan_store().get_current_plan(
            user_id, week_start.isoformat()
        )
    except Exception:
        logger.exception(
            "weekly_plan: canonical lookup failed for master week %s", week_index
        )
        return None
    return existing.week_folder if existing is not None else week_folder(week_start)


def _explicit_week_index(hint: TargetHint | None) -> int | None:
    if hint is None or hint.kind != "week" or not hint.ref_phrase:
        return None
    match = _WEEK_NUMBER_RE.search(hint.ref_phrase)
    return int(match.group(1)) if match else None


def make_current_week_target_resolver(
    user_id: str,
) -> Callable[[TargetRef | None, TargetHint | None], TargetRef | None]:
    """Build the Resolver's ``target_resolver``: "本周" → current-week TargetRef.

    Existing plans keep their canonical display folder. If the user explicitly
    identified the current week/session but no plan exists yet, the natural
    Shanghai week still has an unambiguous calendar folder; return that instead
    of confusing a missing resource with a missing target. A bare ``None`` still
    resolves only through an existing current plan, so genuinely targetless
    writes continue to clarify.
    """

    def _resolve(
        target: TargetRef | None, hint: TargetHint | None = None
    ) -> TargetRef | None:
        if target is not None and target.kind == "master":
            return None
        explicit_week_index = _explicit_week_index(hint)
        if explicit_week_index is not None:
            folder = resolve_master_week_folder(user_id, explicit_week_index)
            return TargetRef(kind="week", folder=folder) if folder else None
        phrase = (hint.ref_phrase if hint is not None else "") or ""
        far_match = _WEEKS_LATER_RE.search(phrase)
        names_week_after_next = any(
            marker in phrase for marker in _WEEK_AFTER_NEXT_MARKERS
        )
        names_next_week = (
            not names_week_after_next
            and far_match is None
            and any(marker in phrase for marker in _NEXT_WEEK_MARKERS)
        )
        if names_week_after_next or far_match is not None:
            weeks = int(far_match.group(1)) if far_match else 2
            today = today_shanghai()
            current_start = today - timedelta(days=today.weekday())
            folder = week_folder(current_start + timedelta(days=7 * weeks))
        elif names_next_week:
            today = today_shanghai()
            next_start = today - timedelta(days=today.weekday()) + timedelta(days=7)
            try:
                existing = get_weekly_plan_store().get_current_plan(
                    user_id, next_start.isoformat()
                )
            except Exception:
                logger.exception("weekly_plan: canonical next-week lookup failed")
                return None
            folder = existing.week_folder if existing else week_folder(next_start)
        else:
            folder = resolve_current_week_folder(user_id)
        if folder is None:
            names_current_week = any(
                marker in phrase for marker in _CURRENT_WEEK_MARKERS
            )
            if (
                target is None
                or target.kind != "week"
                or not names_current_week
            ):
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


def _week_start(folder: str) -> date_cls | None:
    bounds = parse_week_folder_dates(folder)
    if bounds is None:
        return None
    try:
        return date_cls.fromisoformat(bounds[0])
    except ValueError:
        return None


def _creation_rejection(folder: str) -> str | None:
    start = _week_start(folder)
    if start is None:
        return "无法识别目标训练周，请指定本周或下一周。"
    if not is_supported_weekly_plan_generation(
        folder, today=today_shanghai()
    ):
        return "目前只支持生成当前周和下一周的训练计划，不能生成下下周及更远周。"
    return None


def _requests_generation(objective: str) -> bool:
    compact = re.sub(r"\s+", "", objective)
    negated = (
        "不要生成",
        "不生成",
        "别生成",
        "无需生成",
        "不要重新生成",
    )
    if any(marker in compact for marker in negated):
        return False
    return any(marker in compact for marker in ("生成", "创建", "新建"))


def _create_proposal(user_id: str, folder: str) -> WeeklyPlanCreateProposal:
    week_start = _week_start(folder)
    if week_start is None:
        raise ValueError(f"invalid weekly plan folder {folder!r}")
    generated = build_weekly_plan(user_id=user_id, week_start=week_start)
    explanation = (
        f"已生成 {week_start.isoformat()} 开始的一周训练计划，"
        f"目标周跑量约 {generated.total_distance_km:.1f} 公里；确认后才会保存。"
    )
    return WeeklyPlanCreateProposal(
        proposal_id=str(uuid4()),
        folder=generated.plan.week_folder,
        plan=generated.plan.to_dict(),
        total_distance_km=generated.total_distance_km,
        ai_explanation=explanation,
        created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )


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
            # so reaching here means no concrete target week exists. Ask rather than guess.
            return SpecialistResult(
                status="needs_clarification",
                clarification="你想调整哪一周的训练？我没找到当前周的计划。",
            )

        if _requests_generation(task.objective):
            rejection = _creation_rejection(folder)
            if rejection is not None:
                return SpecialistResult(status="rejected", reply_fragment=rejection)

        try:
            existing = get_weekly_plan_store().get_plan(user_id, folder)
        except Exception:
            logger.exception("weekly_plan: canonical target-week lookup failed")
            return SpecialistResult(
                status="failed",
                reply_fragment="暂时无法读取训练周，请稍后再试。",
            )

        if existing is None:
            rejection = _creation_rejection(folder)
            if rejection is not None:
                return SpecialistResult(status="rejected", reply_fragment=rejection)
            if not _requests_generation(task.objective):
                return SpecialistResult(
                    status="needs_clarification",
                    clarification=(
                        f"目标周 {folder} 还没有训练计划。请先创建并应用这一周的"
                        "计划，再重新提出这项调整。请明确回复“创建这一周计划”"
                        "来生成创建提案。"
                    ),
                )
            try:
                proposal = _create_proposal(user_id, folder)
            except WeeklyPlanAlreadyExistsError:
                # The plan appeared between lookup and generation. Continue as
                # an adjustment so this race never creates an overwrite proposal.
                existing = get_weekly_plan_store().get_plan(user_id, folder)
            except (ValueError, OSError):
                logger.exception("weekly_plan: failed to generate creation proposal")
                return SpecialistResult(
                    status="failed",
                    reply_fragment="生成周训练计划失败，请稍后再试。",
                )
            else:
                return SpecialistResult(
                    status="completed",
                    reply_fragment=proposal.ai_explanation,
                    proposals=[proposal],
                )
            if existing is None:
                return SpecialistResult(
                    status="failed",
                    reply_fragment="训练周状态刚刚发生变化，请重试。",
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
                content=f"【目标周】folder = {folder}（所有 draft 工具的 folder 参数都用这个值）"
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
