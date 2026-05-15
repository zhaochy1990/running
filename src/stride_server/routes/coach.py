"""Coach Q&A + cross-thread history endpoints — see plan §1.1 S3, §3.4.

Two endpoints today:

* ``POST /api/users/me/coach/conversations/qa/messages`` — S3 daily Q&A.
  Server **generates** ``thread_id`` from ``f"{user_id}:qa:{today_shanghai()}"``;
  the body must NOT contain a thread_id, and any client-supplied value is
  ignored (defense against cross-user thread injection).

* ``GET /api/users/me/coach/threads/{thread_id}/messages`` — chat history.
  ``thread_id`` is split on ``:`` and the leading segment must equal the
  JWT ``sub`` claim, else 403; malformed ids → 400.

Plan-versions endpoints (US-007) land in a follow-up commit.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from pydantic import BaseModel, Field

from coach.schemas import AssistantPart, assistant_parts_from_message

from ..bearer import require_bearer
from ..coach_adapters.persistence.weekly_version_store import (
    WeeklyPlanVersion,
    weekly_version_store_from_env,
)
from ..coach_runtime import build_conversation_graph_for_user, get_checkpointer

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# request / response models
# ---------------------------------------------------------------------------


class QAMessageRequest(BaseModel):
    """Body for POST qa/messages.

    Any ``thread_id`` field a client sends is dropped silently — the server
    always derives it from ``user_id + today_shanghai()`` to prevent
    cross-user thread takeover.
    """

    message: str = Field(min_length=1)
    model_config = {"extra": "ignore"}  # silently drop client-supplied thread_id


class QAMessageResponse(BaseModel):
    thread_id: str
    # Renderable assistant parts (text / reasoning / refusal / tool_meta).
    # See coach.schemas.conversation.AssistantPart for the per-kind contract.
    # Always at least one part for a successful turn; empty list when the
    # turn only produced a draft tool call (in which case `last_diff` carries
    # the proposed change — wired in a follow-up commit).
    parts: list[AssistantPart]
    iteration: int


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


def _short_thread_id_for_qa(user_id: str) -> str:
    from coach.graphs.conversation.scope import Scope, thread_id_for

    return thread_id_for(user_id, Scope.QA)


def _parse_thread_id(thread_id: str) -> tuple[str, str, str]:
    """Return (user_id, short_scope, key); raise ValueError on malformed."""
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
# POST /api/users/me/coach/conversations/qa/messages
# ---------------------------------------------------------------------------


@router.post(
    "/api/users/me/coach/conversations/qa/messages",
    response_model=QAMessageResponse,
)
def post_qa_message(
    body: QAMessageRequest,
    payload: dict = Depends(require_bearer),
) -> QAMessageResponse:
    """S3 daily Q&A: send a message; server-generated thread_id."""
    user_id: str = payload["sub"]
    thread_id = _short_thread_id_for_qa(user_id)
    graph = build_conversation_graph_for_user(user_id=user_id, scope="qa")

    # DEBUG (temporary): trace UTF-8 fidelity of user content end-to-end
    logger.info(
        "QA_DEBUG body.message len=%d utf8_first30hex=%s",
        len(body.message), body.message.encode("utf-8")[:30].hex(),
    )
    hm = HumanMessage(content=body.message)
    logger.info(
        "QA_DEBUG HumanMessage.content utf8_first30hex=%s",
        hm.content.encode("utf-8")[:30].hex(),
    )

    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    state_in = {
        "history": [hm],
        "scope": "qa",
        "user_id": user_id,
        "thread_id": thread_id,
        "folder": None,
        "plan_id": None,
        "constraints": [],
        "last_diff": None,
        "iteration": 0,
    }
    try:
        state = graph.invoke(state_in, config=config)
        _hist = state.get("history") or []
        for _i, _m in enumerate(_hist[:3]):
            _c = getattr(_m, "content", None)
            if isinstance(_c, str):
                logger.info(
                    "QA_DEBUG post-invoke hist[%d] %s utf8_first30hex=%s",
                    _i, type(_m).__name__, _c.encode("utf-8")[:30].hex(),
                )
    except Exception as exc:  # noqa: BLE001 — coach endpoint boundary
        logger.exception("coach qa graph invocation failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"AI coach unavailable: {exc}",
        )

    history = state.get("history") or []
    last = history[-1] if history else None
    parts: list[AssistantPart] = []
    if last is not None:
        parts = assistant_parts_from_message(last)
    return QAMessageResponse(
        thread_id=thread_id,
        parts=parts,
        iteration=int(state.get("iteration") or 0),
    )


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
