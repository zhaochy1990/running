"""Coach chat + cross-thread history endpoints.

Public conversation entry point:

* ``POST /api/users/me/coach/chat`` — session-threaded orchestrator chat.

Audit/history endpoint:

* ``GET /api/users/me/coach/threads/{thread_id}/messages`` — chat history.
  ``thread_id`` is split on ``:`` and the leading segment must equal the
  JWT ``sub`` claim, else 403; malformed ids → 400.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from pydantic import (
    BaseModel,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from coach.schemas import AssistantPart, assistant_parts_from_message

from stride_core.plan_diff import PlanDiff, apply_diff_to_weekly_plan
from stride_core.timefmt import today_shanghai
from stride_core.weekly_plan_proposal import (
    WeeklyPlanCreateProposal,
    is_supported_weekly_plan_generation,
)
from stride_core.master_plan import MasterPlanStatus
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
    apply_master_plan_diff,
    normalise_target_race_time,
)
from coach.graphs.conversation.master_diff_gate import validate_master_diff

from ..bearer import require_bearer
from ..coach_adapters.persistence.weekly_version_store import (
    WeeklyPlanVersion,
    weekly_version_store_from_env,
)
from coach.orchestrator import coach_thread_id

from ..coach_adapters.orchestrator import run_coach_turn
from ..coach_runtime import get_checkpointer
from ..content_store import read_json, write_json
from ..master_plan_store import get_master_plan_store
from ..weekly_plan_store import (
    create_weekly_plan,
    get_weekly_plan_store,
    save_weekly_plan,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# request / response models
# ---------------------------------------------------------------------------


# Length is enforced by the Field constraint; fullmatch() anchors both ends, so
# the pattern only needs the allowed character class.
_SESSION_ID_RE = re.compile(r"[A-Za-z0-9_-]+")


class ChatRequest(BaseModel):
    """Body for POST /coach/chat — the orchestrator-brain entry point.

    ``session_id`` is the user's explicit conversation thread (§5.1). The
    checkpointer key is derived server-side as ``{user}:coach:{session_id}``;
    no client-supplied thread_id is ever honoured.

    ``session_id`` is constrained to ``[A-Za-z0-9_-]`` so a client cannot embed
    ``:`` and manufacture a thread_id that collides with another user's thread
    (the thread id format is colon-delimited).
    """

    session_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1)
    model_config = {"extra": "ignore"}

    @field_validator("session_id")
    @classmethod
    def _session_id_is_opaque_token(cls, value: str) -> str:
        if not _SESSION_ID_RE.fullmatch(value):
            raise ValueError(
                "session_id must be 1–128 chars of [A-Za-z0-9_-] (no ':' allowed)"
            )
        return value


class ChatResponse(BaseModel):
    """Response for POST /coach/chat — one orchestrated turn (§4.4 TurnResponse).

    ``proposals`` are Pattern-Y write proposals (typed diffs) that ride the
    response and are landed only on a later ``/apply`` confirmation. A clarify
    turn carries ``clarification`` and an empty ``proposals`` list.
    """

    session_id: str
    thread_id: str
    reply: str
    clarification: str | None = None
    active_target: dict | None = None
    proposals: list[dict] = Field(default_factory=list)


class ChatMessage(BaseModel):
    role: str
    # For user / tool turns, ``content`` carries the raw text. For assistant
    # turns, ``content`` is empty and ``parts`` carries the renderable pieces.
    content: str = ""
    parts: list[AssistantPart] = []
    name: str | None = None
    tool_call_id: str | None = None


class ThreadHistoryResponse(BaseModel):
    thread_id: str
    user_id: str
    scope: str
    key: str
    messages: list[ChatMessage]


class PlanVersionSummary(BaseModel):
    version_id: str
    parent_version_id: str | None
    created_at: str
    created_by: str
    rationale: str
    applied_op_ids: list[str]


class PlanVersionsListResponse(BaseModel):
    folder: str
    versions: list[PlanVersionSummary]


class PlanVersionDetailResponse(BaseModel):
    folder: str
    version_id: str
    parent_version_id: str | None
    created_at: str
    created_by: str
    rationale: str
    applied_op_ids: list[str]
    artifact: dict | None


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _parse_thread_id(thread_id: str) -> tuple[str, str, str]:
    """Return (user_id, short_scope, key); raise ValueError on malformed."""
    parts = thread_id.split(":", 2)
    if len(parts) == 3 and parts[1] == "coach":
        return parts[0], "coach", parts[2]

    from coach.graphs.conversation.scope import parse_short_thread_id

    return parse_short_thread_id(thread_id)


def _to_chat_message(m: BaseMessage) -> ChatMessage | None:
    """Translate a langchain BaseMessage to the public ChatMessage schema.

    Returns ``None`` for SystemMessage (shouldn't be in history but tolerate
    gracefully). Assistant turns are converted to structured ``parts`` so the
    history endpoint returns the same shape the POST endpoint uses.
    """
    if isinstance(m, SystemMessage):
        return None
    if isinstance(m, HumanMessage):
        return ChatMessage(role="user", content=str(m.content))
    if isinstance(m, AIMessage):
        return ChatMessage(role="assistant", parts=assistant_parts_from_message(m))
    if isinstance(m, ToolMessage):
        return ChatMessage(
            role="tool",
            content=str(m.content),
            name=m.name,
            tool_call_id=m.tool_call_id,
        )
    # Unknown subclass — best effort: try the parts helper, else fall back.
    parts = assistant_parts_from_message(m)
    if parts:
        return ChatMessage(role="assistant", parts=parts)
    return ChatMessage(role="assistant", content=str(getattr(m, "content", "")))


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/chat  (orchestrator brain — §4, §8 A1)
# ---------------------------------------------------------------------------


@router.post("/api/users/me/coach/chat", response_model=ChatResponse)
def post_chat_message(
    body: ChatRequest,
    payload: dict = Depends(require_bearer),
) -> ChatResponse:
    """Session-threaded coach chat: intent-routed through the orchestrator brain.

    This drives the full pipeline (Resolver → Supervisor → specialists →
    Aggregator) so one session carries context across intents (§5.1). The
    thread is keyed ``{user}:coach:{session}``.
    """
    user_id: str = payload["sub"]
    thread_id = coach_thread_id(user_id, body.session_id)
    try:
        turn = run_coach_turn(
            user_id=user_id, session_id=body.session_id, message=body.message
        )
    except Exception:  # noqa: BLE001 — coach endpoint boundary
        # Full exception (may carry internal URLs / resource names) goes to the
        # log only; the client gets a generic message.
        logger.exception("coach chat turn failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI coach temporarily unavailable. Please try again.",
        )

    return ChatResponse(
        session_id=body.session_id,
        thread_id=thread_id,
        reply=turn.reply,
        clarification=turn.clarification,
        active_target=turn.active_target.model_dump() if turn.active_target else None,
        proposals=[card.model_dump() for card in turn.proposals],
    )


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/plan/{folder}/apply  (Pattern Y — land a week diff)
# ---------------------------------------------------------------------------


class CoachWeekApplyRequest(BaseModel):
    """Body for applying a weekly creation proposal or adjustment diff.

    The orchestrator is stateless: a complete creation proposal or ``PlanDiff``
    rides the chat response and the client sends it back after confirmation.
    """

    diff: PlanDiff | None = None
    proposal: WeeklyPlanCreateProposal | None = None
    accepted_op_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exactly_one_payload(self) -> "CoachWeekApplyRequest":
        if (self.diff is None) == (self.proposal is None):
            raise ValueError("provide exactly one of diff or proposal")
        return self


@router.post("/api/users/me/coach/plan/{folder}/apply")
def apply_coach_week_diff(
    folder: str,
    body: CoachWeekApplyRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Create a proposed week or apply accepted ops to an existing week."""
    user_id: str = payload["sub"]
    if body.proposal is not None:
        proposal = body.proposal
        if proposal.folder != folder:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"proposal folder {proposal.folder!r} does not match path "
                    f"folder {folder!r}"
                ),
            )
        if not is_supported_weekly_plan_generation(
            proposal.folder, today=today_shanghai()
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="目前只支持生成当前周和下一周的训练计划",
            )
        try:
            created = create_weekly_plan(
                user_id,
                proposal.to_weekly_plan(),
                expected_folder=folder,
                generated_by="coach-generation",
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not created:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"weekly plan {folder!r} already exists",
            )
        from datetime import datetime, timezone

        return {
            "applied": 1,
            "folder": folder,
            "created": True,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    diff = body.diff
    assert diff is not None
    if diff.folder != folder:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"diff folder {diff.folder!r} does not match path folder {folder!r}",
        )

    # Only land ops the diff actually carries (skip unknown / stale ids).
    known_ids = {op.id for op in diff.ops}
    accepted_op_ids = [oid for oid in body.accepted_op_ids if oid in known_ids]

    plan_store = get_weekly_plan_store()
    current = plan_store.get_plan(user_id, folder)
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"weekly plan {folder!r} not found",
        )
    try:
        adjusted = apply_diff_to_weekly_plan(current, diff, accepted_op_ids)
        save_weekly_plan(
            user_id, adjusted, expected_folder=folder,
            generated_by="coach-adjustment",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from datetime import datetime, timezone

    return {
        "applied": len(accepted_op_ids),
        "folder": folder,
        "created": False,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/master-plan/{plan_id}/apply  (Pattern Y — season diff)
# ---------------------------------------------------------------------------


class CoachMasterApplyRequest(BaseModel):
    """Body for the orchestrator season-plan (master) diff apply.

    Stateless, like the week apply: the ``MasterPlanDiff`` rode the chat response
    (``proposals[].proposal``) and the client sends the whole diff back with the
    accepted op ids. Lands on the ACTIVE plan (bumps version + snapshots prior).
    """

    diff: MasterPlanDiff
    accepted_op_ids: list[str]
    change_reason: str = "coach adjustment"


class _MasterStoreBridge:
    """Adapt ``get_master_plan_store()`` (2-arg ``get_plan(user_id, plan_id)`` +
    ``save_version``) to the ``MasterPlanStore`` protocol ``apply_master_plan_diff``
    expects (1-arg ``get_plan(plan_id)`` + ``add_version``)."""

    def __init__(self, inner: Any, user_id: str) -> None:
        self._inner = inner
        self._user_id = user_id

    def get_plan(self, plan_id: str):
        return self._inner.get_plan(self._user_id, plan_id)

    def save_plan(self, plan):
        # Defense in depth: only ever persist a plan owned by this bridge's user,
        # so a future refactor of apply_master_plan_diff can't write across users.
        if getattr(plan, "user_id", self._user_id) != self._user_id:
            raise PermissionError("refusing to save a plan owned by a different user")
        return self._inner.save_plan(plan)

    def add_version(self, version):
        return self._inner.save_version(version)


def _accepted_race_reschedule(
    diff: MasterPlanDiff, accepted_op_ids: list[str]
) -> MasterPlanDiffOp | None:
    accepted = set(accepted_op_ids)
    matches = [
        op
        for op in diff.ops
        if op.id in accepted
        and op.accepted is not False
        and op.op == MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE
    ]
    return matches[0] if matches else None


def _accepted_target_race_time_update(
    diff: MasterPlanDiff, accepted_op_ids: list[str]
) -> MasterPlanDiffOp | None:
    accepted = set(accepted_op_ids)
    matches = [
        op
        for op in diff.ops
        if op.id in accepted
        and op.accepted is not False
        and op.op == MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME
    ]
    return matches[0] if matches else None


def _prepare_training_goal_reschedule(
    user_id: str, plan: Any, op: MasterPlanDiffOp
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate and prepare the external TrainingGoal half of a race move."""
    item = read_json(f"{user_id}/training_goal.json")
    if item is None or not isinstance(item[0], dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不存在，无法安全同步目标比赛日期",
        )
    original = item[0]
    current = original.get("current")
    if not isinstance(current, dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不存在，无法安全同步目标比赛日期",
        )
    if current.get("type") != "race":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不是比赛目标，无法同步目标比赛日期",
        )
    plan_distance = getattr(plan.goal.distance, "value", str(plan.goal.distance))
    if (
        current.get("goal_id") != plan.goal.goal_id
        or current.get("race_date") != plan.goal.race_date
        or current.get("race_distance") != plan_distance
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Training Goal 与当前 Master Plan 不一致，请刷新后重试",
        )
    new_date = (op.spec_patch or {}).get("race_date")
    updated_current = dict(current)
    updated_current["race_date"] = new_date
    updated_current["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = dict(original)
    updated["current"] = updated_current
    return original, updated


def _prepare_training_goal_time_update(
    user_id: str, plan: Any, op: MasterPlanDiffOp
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate and prepare the external TrainingGoal target-time update."""
    item = read_json(f"{user_id}/training_goal.json")
    if item is None or not isinstance(item[0], dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不存在，无法安全同步目标成绩",
        )
    original = item[0]
    current = original.get("current")
    if not isinstance(current, dict) or current.get("type") != "race":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前 Training Goal 不是比赛目标，无法同步目标成绩",
        )
    external_time_raw = str(current.get("target_finish_time") or "")
    embedded_time_raw = str(plan.goal.target_time or "")
    try:
        external_time = (
            normalise_target_race_time(external_time_raw)
            if external_time_raw
            else ""
        )
        embedded_time = (
            normalise_target_race_time(embedded_time_raw)
            if embedded_time_raw
            else ""
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前目标成绩格式无效，请先修正 Training Goal",
        ) from exc
    plan_distance = getattr(plan.goal.distance, "value", str(plan.goal.distance))
    if (
        current.get("goal_id") != plan.goal.goal_id
        or current.get("race_date") != plan.goal.race_date
        or current.get("race_distance") != plan_distance
        or external_time != embedded_time
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Training Goal 与当前 Master Plan 不一致，请刷新后重试",
        )
    new_time = (op.spec_patch or {}).get("target_time")
    updated_current = dict(current)
    updated_current["target_finish_time"] = new_time
    updated_current["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = dict(original)
    updated["current"] = updated_current
    return original, updated


@router.post("/api/users/me/coach/master-plan/{plan_id}/apply")
def apply_coach_master_diff(
    plan_id: str,
    body: CoachMasterApplyRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Apply the accepted ops of a coach-proposed season ``MasterPlanDiff``."""
    user_id: str = payload["sub"]
    diff = body.diff
    if diff.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"diff plan_id {diff.plan_id!r} does not match path plan_id {plan_id!r}",
        )

    store = get_master_plan_store()
    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"master plan {plan_id!r} not found")
    if plan.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="plan belongs to a different user")
    if plan.status != MasterPlanStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该赛季计划尚未确认（status≠active），不能应用调整",
        )

    # Only land ops the diff actually carries (skip unknown / stale ids). Build
    # the exact accepted subset before validation: safety rules such as the
    # full-regeneration taper exception must be evaluated against what will
    # actually land, not against unselected sibling ops in the same diff.
    known_ids = {op.id for op in diff.ops}
    accepted_op_ids = [oid for oid in body.accepted_op_ids if oid in known_ids]
    accepted_ids = set(accepted_op_ids)
    accepted_diff = diff.model_copy(
        update={"ops": [op for op in diff.ops if op.id in accepted_ids]}
    )

    # Re-run the validation gate: the client supplies the diff body, so don't
    # trust it blindly — refuse a structurally broken diff (defense in depth).
    # The gate is wrapped too: it coerces untyped spec_patch values (float() etc.),
    # so a pathological value that makes the gate itself raise becomes a 400, not
    # a 500.
    try:
        violations = validate_master_diff(plan, accepted_diff)
    except (ValidationError, ValueError, TypeError, KeyError, OverflowError) as exc:
        logger.warning("coach master apply: gate raised on malformed diff: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整数据非法，无法应用",
        )
    if violations:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整结构非法：" + "；".join(violations),
        )

    bridge = _MasterStoreBridge(store, user_id)
    race_op = _accepted_race_reschedule(diff, accepted_op_ids)
    race_time_op = _accepted_target_race_time_update(diff, accepted_op_ids)
    goal_original: dict[str, Any] | None = None
    if race_op is not None:
        goal_original, goal_updated = _prepare_training_goal_reschedule(
            user_id, plan, race_op
        )
    elif race_time_op is not None:
        goal_original, goal_updated = _prepare_training_goal_time_update(
            user_id, plan, race_time_op
        )
    else:
        goal_updated = None
    if goal_updated is not None:
        try:
            write_json(f"{user_id}/training_goal.json", goal_updated)
        except Exception as exc:  # noqa: BLE001 — content-store boundary
            logger.exception("coach master apply: training goal sync failed")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Training Goal 暂时无法更新，请稍后重试",
            ) from exc
    try:
        updated_plan = apply_master_plan_diff(bridge, plan_id, diff, accepted_op_ids, body.change_reason)
    except Exception as exc:  # noqa: BLE001 — compensate cross-store goal write
        if goal_original is not None:
            try:
                write_json(f"{user_id}/training_goal.json", goal_original)
            except Exception:  # noqa: BLE001 — preserve the primary failure
                logger.critical(
                    "coach master apply: failed to roll back Training Goal",
                    exc_info=True,
                )
        if not isinstance(
            exc, (ValidationError, ValueError, TypeError, KeyError, OverflowError)
        ):
            raise
        # The gate validates diff semantics, but spec_patch contents are untyped
        # JSON from the client — a pathological value (wrong type, bad enum,
        # missing construction key) would otherwise raise inside apply and 500.
        # Convert that whole class to a 400; infra/storage errors are other
        # exception types and still propagate as a real 5xx.
        logger.warning("coach master apply: rejecting malformed diff: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="赛季调整数据非法，无法应用",
        )

    return {
        "applied": len(accepted_op_ids),
        "plan_id": plan_id,
        "version": updated_plan.version,
        "updated_at": updated_plan.updated_at,
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/coach/threads/{thread_id}/messages
# ---------------------------------------------------------------------------


@router.get(
    "/api/users/me/coach/threads/{thread_id}/messages",
    response_model=ThreadHistoryResponse,
)
def get_thread_messages(
    thread_id: str,
    payload: dict = Depends(require_bearer),
) -> ThreadHistoryResponse:
    user_id: str = payload["sub"]
    try:
        owner_id, scope, key = _parse_thread_id(thread_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if owner_id != user_id:
        # Path doesn't include a {user} segment, so the global
        # require_bearer + this owner check is what prevents cross-user reads.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="thread does not belong to authenticated user",
        )

    checkpointer = get_checkpointer()
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    tup = checkpointer.get_tuple(config)
    if tup is None:
        return ThreadHistoryResponse(
            thread_id=thread_id,
            user_id=user_id,
            scope=scope,
            key=key,
            messages=[],
        )
    checkpoint: dict[str, Any] = tup.checkpoint or {}
    history_raw = (checkpoint.get("channel_values") or {}).get("history") or []
    messages: list[ChatMessage] = []
    for m in history_raw:
        translated = _to_chat_message(m)
        if translated is not None:
            messages.append(translated)
    return ThreadHistoryResponse(
        thread_id=thread_id,
        user_id=user_id,
        scope=scope,
        key=key,
        messages=messages,
    )


# ---------------------------------------------------------------------------
# Weekly plan version audit endpoints (plan §3.4, §11.3 partition-required)
# ---------------------------------------------------------------------------

_weekly_version_store_cache: object | None = None


def _get_weekly_version_store():
    """Cache the resolved store so test injection via
    ``set_weekly_version_store_for_tests`` is sticky."""
    global _weekly_version_store_cache
    if _weekly_version_store_cache is None:
        _weekly_version_store_cache = weekly_version_store_from_env()
    return _weekly_version_store_cache


def set_weekly_version_store_for_tests(store: object) -> None:
    global _weekly_version_store_cache
    _weekly_version_store_cache = store


def _summarise_version(v: WeeklyPlanVersion) -> PlanVersionSummary:
    return PlanVersionSummary(
        version_id=v.version_id,
        parent_version_id=v.parent_version_id,
        created_at=v.created_at,
        created_by=v.created_by,
        rationale=v.rationale,
        applied_op_ids=v.applied_op_ids,
    )


@router.get(
    "/api/users/me/coach/plan-versions/week/{folder}",
    response_model=PlanVersionsListResponse,
)
def list_weekly_versions(
    folder: str,
    payload: dict = Depends(require_bearer),
) -> PlanVersionsListResponse:
    """List all weekly plan versions for ``folder`` in reverse-chronological order."""
    user_id: str = payload["sub"]
    store = _get_weekly_version_store()
    versions = store.list_versions(user_id, folder)
    return PlanVersionsListResponse(
        folder=folder,
        versions=[_summarise_version(v) for v in versions],
    )


@router.get(
    "/api/users/me/coach/plan-versions/week/{folder}/{version_id}",
    response_model=PlanVersionDetailResponse,
)
def get_weekly_version_detail(
    folder: str,
    version_id: str,
    payload: dict = Depends(require_bearer),
) -> PlanVersionDetailResponse:
    """Return the artifact for a specific weekly plan version.

    The (folder, version_id) path is mandatory — without ``folder`` the
    PartitionKey (``user_id|folder``) is undefined, so the store would have
    to fall back to a full table scan. We refuse that path explicitly.
    """
    user_id: str = payload["sub"]
    store = _get_weekly_version_store()
    version = store.get_version(user_id, folder, version_id)
    if version is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"version {version_id!r} not found for folder {folder!r}",
        )
    artifact = None
    if version.artifact_json:
        try:
            import json as _json

            artifact = _json.loads(version.artifact_json)
        except (ValueError, TypeError):
            artifact = None
    return PlanVersionDetailResponse(
        folder=folder,
        version_id=version.version_id,
        parent_version_id=version.parent_version_id,
        created_at=version.created_at,
        created_by=version.created_by,
        rationale=version.rationale,
        applied_op_ids=version.applied_op_ids,
        artifact=artifact,
    )
