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
import uuid
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
    field_validator,
    model_validator,
)

from coach.schemas import AssistantPart, assistant_parts_from_message
from coach.contracts import CoachEvent, ProposalCard, SeasonImpact, TargetRef
from coach.contracts import WeeklyCreateReviewContext
from coach.orchestrator import TurnConflictError
from coach.season_impact import evaluate_weekly_season_impact

from stride_core.plan_diff import (
    PlanDiff,
    apply_diff_to_weekly_plan,
    op_touched_dates,
    past_dated_op_ids,
    require_whole_plan_op_ids,
)
from stride_core.plan_revision import weekly_plan_fingerprint
from stride_core.weekly_plan_proposal import (
    WeeklyPlanCreateProposal,
    is_supported_weekly_plan_generation,
)
from stride_core.timefmt import today_shanghai
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    apply_master_plan_diff,
)
from coach.graphs.conversation.master_diff_gate import validate_master_diff

from ..bearer import require_bearer
from ..deps import get_server_config
from ..coach_adapters.persistence.weekly_version_store import (
    WeeklyPlanVersion,
    weekly_version_store_from_env,
)
from coach.orchestrator import coach_thread_id

from ..coach_adapters.orchestrator import record_coach_event, run_coach_turn
from ..coach_runtime import get_checkpointer
from ..content_store import read_json, write_json
from ..master_plan_apply import (
    accepted_master_op_ids,
    apply_active_master_diff,
    master_plan_apply_lock,
    require_active_master_plan,
    require_whole_master_op_ids,
)
from ..master_plan_store import get_master_plan_store
from ..weekly_plan_store import (
    create_weekly_plan,
    get_weekly_plan_store,
    save_weekly_plan,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _emit_coach_event(user_id: str, event: CoachEvent, session_id: str) -> None:
    """Record a trusted event on the originating coach thread (best-effort).

    A failed event-write must never fail the apply/abandon it describes (the
    write already committed); log and move on.
    """
    try:
        record_coach_event(user_id=user_id, event=event, session_id=session_id)
    except Exception:  # noqa: BLE001 — event is advisory, apply already committed
        logger.exception("failed to record coach event %s", event.type)


# ---------------------------------------------------------------------------
# request / response models
# ---------------------------------------------------------------------------


# Length is enforced by the Field constraint; fullmatch() anchors both ends, so
# the pattern only needs the allowed character class.
_SESSION_ID_RE = re.compile(r"[A-Za-z0-9_-]+")
# client_turn_id shares the opaque-token character class (idempotency key).
_CLIENT_TURN_ID_RE = re.compile(r"[A-Za-z0-9_-]+")

# Fallbacks used only when the (config-slice–owned) PlanConfig fields are not
# present yet in this build; the merged config supplies the real values.
_DEFAULT_MAX_MESSAGE_CHARS = 8000
_DEFAULT_SESSION_ID = "web-default"

def _validate_session_id(value: str) -> str:
    if not _SESSION_ID_RE.fullmatch(value):
        raise ValueError(
            "session_id must be 1–128 chars of [A-Za-z0-9_-] (no ':' allowed)"
        )
    return value


def _max_message_chars(config: Any) -> int:
    plan = getattr(config, "plan", None)
    return int(
        getattr(plan, "coach_chat_max_message_chars", _DEFAULT_MAX_MESSAGE_CHARS)
        or _DEFAULT_MAX_MESSAGE_CHARS
    )


def _debug_users(config: Any) -> tuple[str, ...]:
    plan = getattr(config, "plan", None)
    return tuple(getattr(plan, "coach_chat_debug_users", ()) or ())


class ChatRequest(BaseModel):
    """Body for POST /coach/chat — the orchestrator-brain entry point.

    ``session_id`` is the user's explicit conversation thread (§5.1). The
    checkpointer key is derived server-side as ``{user}:coach:{session_id}``;
    no client-supplied thread_id is ever honoured.

    ``client_turn_id`` is a mandatory idempotency key: replaying the same turn
    after a dropped connection is safe (same id + request → same response), and
    reusing it with a different request is a 409. ``target`` is the authoritative
    turn target the client is acting on.
    """

    session_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1)
    client_turn_id: str = Field(min_length=1, max_length=128)
    target: TargetRef | None = None
    review_context: WeeklyCreateReviewContext | None = None
    model_config = {"extra": "ignore"}

    @field_validator("session_id")
    @classmethod
    def _session_id_is_opaque_token(cls, value: str) -> str:
        return _validate_session_id(value)

    @field_validator("client_turn_id")
    @classmethod
    def _client_turn_id_is_opaque_token(cls, value: str) -> str:
        if not _CLIENT_TURN_ID_RE.fullmatch(value):
            raise ValueError(
                "client_turn_id must be 1–128 chars of [A-Za-z0-9_-]"
            )
        return value

    @model_validator(mode="after")
    def _review_context_matches_target(self) -> "ChatRequest":
        """A review draft must be anchored to the week it belongs to.

        The draft is authoritative for the turn, so it can only ride a turn that
        targets that same week: ``target.kind == 'week'`` and
        ``target.folder == review_context.proposal.folder``. This makes it
        impossible to answer against a draft for a different week than the one
        the client is acting on. The nested review-context contract separately
        caps the serialised payload size for every consumer path.
        """
        ctx = self.review_context
        if ctx is None:
            return self
        target = self.target
        if target is None or target.kind != "week":
            raise ValueError(
                "review_context requires a target with kind='week'"
            )
        if target.folder != ctx.proposal.folder:
            raise ValueError(
                "review_context.proposal.folder must equal target.folder"
            )
        return self


class AssistantMessageDTO(BaseModel):
    """The assistant turn with a stable identity the client can key on.

    ``turn_id`` echoes the request's ``client_turn_id`` (one assistant message
    per logical turn); ``message_id`` is a server-minted stable id.
    """

    role: str = "assistant"
    message_id: str
    turn_id: str
    created_at: str
    parts: list[AssistantPart] = Field(default_factory=list)


class ChatResponse(BaseModel):
    """Response for POST /coach/chat — one orchestrated turn (§4.4 TurnResponse).

    ``proposals`` are Pattern-Y write proposals (typed diffs) that ride the
    response and are landed only on a later ``/apply`` confirmation. A clarify
    turn carries ``clarification`` and an empty ``proposals`` list.
    """

    session_id: str
    thread_id: str
    reply: str
    assistant_message: AssistantMessageDTO
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
    # Stable identity so the client can key/dedup history rows. ``turn_id`` is
    # best-effort (only assistant/user turns that carried one).
    message_id: str = ""
    turn_id: str | None = None
    created_at: str = ""
    # Populated only for ``role="event"`` rows (trusted system receipts).
    event_type: str | None = None
    status: str | None = None
    summary: str | None = None
    detail: dict | None = None


class ThreadHistoryResponse(BaseModel):
    thread_id: str
    user_id: str
    scope: str
    key: str
    messages: list[ChatMessage]


class SessionMessagesResponse(BaseModel):
    """History for one chat session, thread derived server-side from the JWT.

    The client never assembles ``thread_id`` — it passes only ``session_id`` and
    the server keys ``{user}:coach:{session_id}``. Normal users see only user +
    assistant text/refusal parts; debug users additionally see reasoning /
    tool_meta parts and tool messages.

    ``pending_proposals`` is the latest un-consumed proposal from ``turn_receipts``
    — present only when the most-recent proposal-bearing turn has not yet been
    followed by a ``weekly_plan_applied`` / ``master_plan_applied`` /
    ``proposal_abandoned`` event for the same target. The cards are freshly
    re-enriched so ``base_revision`` and ``season_impact`` reflect current state.
    ``pending_active_target`` and ``pending_proposal_message_id`` accompany it so
    the frontend can restore the full workspace context.
    """

    session_id: str
    thread_id: str
    user_id: str
    debug: bool
    messages: list[ChatMessage]
    # Pending proposal recovery — None when no unresolved proposal exists.
    pending_proposals: list[dict] | None = None
    pending_active_target: dict | None = None
    pending_proposal_message_id: str | None = None


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


# Parts a normal (non-debug) user is allowed to see on assistant turns.
_USER_VISIBLE_PART_KINDS = {"text", "refusal"}


def _stable_message_id(m: BaseMessage, thread_id: str, index: int) -> str:
    """Prefer the langchain message id; fall back to a position-stable id."""
    mid = getattr(m, "id", None)
    return str(mid) if mid else f"{thread_id}#{index}"


def _turn_id_from_message_id(message_id: str) -> str | None:
    """Recover the client_turn_id from a stable ``{turn}:u`` / ``{turn}:a`` id.

    Returns ``None`` for position-fallback ids (``thread#N``) that carry no turn.
    """
    if message_id.endswith(":u") or message_id.endswith(":a"):
        return message_id[:-2]
    return None


def _history_to_chat_messages(
    raw: list[BaseMessage],
    *,
    thread_id: str,
    checkpoint_ts: str,
    debug: bool,
    receipts_by_turn: dict[str, dict] | None = None,
) -> list[ChatMessage]:
    """Project checkpoint history into DTOs with stable ids + debug filtering.

    Normal users get user + assistant text/refusal parts only; debug users
    additionally get reasoning / tool_meta parts and tool messages.

    ``turn_id`` is recovered from the stable message id; ``created_at`` comes
    from the turn receipt (the first-run timestamp, so a replay doesn't shift
    it), falling back to the checkpoint timestamp when no receipt exists.
    """
    receipts_by_turn = receipts_by_turn or {}
    out: list[ChatMessage] = []
    for index, m in enumerate(raw):
        translated = _to_chat_message(m)
        if translated is None:
            continue
        if translated.role == "tool" and not debug:
            continue
        if translated.role == "assistant" and not debug:
            visible = [
                p for p in translated.parts if p.kind in _USER_VISIBLE_PART_KINDS
            ]
            # Drop an assistant turn that has nothing user-visible left.
            if not visible and not translated.content:
                continue
            translated = translated.model_copy(update={"parts": visible})
        message_id = _stable_message_id(m, thread_id, index)
        turn_id = _turn_id_from_message_id(message_id)
        receipt = receipts_by_turn.get(turn_id) if turn_id else None
        created_at = str((receipt or {}).get("created_at") or checkpoint_ts)
        out.append(
            translated.model_copy(
                update={
                    "message_id": message_id,
                    "turn_id": turn_id,
                    "created_at": created_at,
                }
            )
        )
    return out


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/chat  (orchestrator brain — §4, §8 A1)
# ---------------------------------------------------------------------------


@router.post("/api/users/me/coach/chat", response_model=ChatResponse)
def post_chat_message(
    body: ChatRequest,
    payload: dict = Depends(require_bearer),
    config: Any = Depends(get_server_config),
) -> ChatResponse:
    """Session-threaded coach chat: intent-routed through the orchestrator brain.

    This drives the full pipeline (Resolver → Supervisor → specialists →
    Aggregator) so one session carries context across intents (§5.1). The
    thread is keyed ``{user}:coach:{session}``.
    """
    max_chars = _max_message_chars(config)
    if len(body.message) > max_chars:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"message exceeds the {max_chars}-character limit",
        )

    user_id: str = payload["sub"]
    thread_id = coach_thread_id(user_id, body.session_id)
    review_context = (
        body.review_context.model_dump(mode="json")
        if body.review_context is not None
        else None
    )
    try:
        result = run_coach_turn(
            user_id=user_id,
            session_id=body.session_id,
            message=body.message,
            client_turn_id=body.client_turn_id,
            target=body.target,
            review_context=review_context,
        )
    except TurnConflictError as exc:
        # Same client_turn_id reused with a different request — a client bug,
        # not a transient failure. Deterministic 409 (never re-runs the model).
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except Exception:  # noqa: BLE001 — coach endpoint boundary
        # Full exception (may carry internal URLs / resource names) goes to the
        # log only; the client gets a generic message.
        logger.exception("coach chat turn failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI coach temporarily unavailable. Please try again.",
        )

    # ``run_coach_turn`` returns a CoachTurnResult (turn_response + stable
    # assistant_message). Tolerate a bare TurnResponse too (older callers/tests).
    turn = getattr(result, "turn_response", result)
    result_assistant = getattr(result, "assistant_message", None)
    # Prefer the orchestrator's stable-identity assistant message so a replay of
    # the same client_turn_id returns a byte-identical payload; fall back to a
    # freshly minted one only if the graph didn't supply it.
    if result_assistant is not None:
        assistant_message = AssistantMessageDTO.model_validate(result_assistant)
    else:
        assistant_message = AssistantMessageDTO(
            message_id=f"msg-{uuid.uuid4().hex}",
            turn_id=body.client_turn_id,
            created_at=_now_iso(),
            parts=[AssistantPart(kind="text", text=turn.reply)] if turn.reply else [],
        )

    return ChatResponse(
        session_id=body.session_id,
        thread_id=thread_id,
        reply=turn.reply,
        assistant_message=assistant_message,
        clarification=turn.clarification,
        active_target=turn.active_target.model_dump() if turn.active_target else None,
        proposals=_enrich_proposal_cards(user_id, list(turn.proposals)),
    )


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/plan/{folder}/apply  (Pattern Y — land a week diff)
# ---------------------------------------------------------------------------


class CoachWeekApplyRequest(BaseModel):
    """Body for applying a weekly creation proposal or adjustment diff.

    The orchestrator is stateless: a complete creation proposal or ``PlanDiff``
    rides the chat response and the client sends it back after confirmation.
    ``session_id`` binds the resulting trusted event to that conversation.
    """

    session_id: str = Field(default=_DEFAULT_SESSION_ID, min_length=1, max_length=128)
    diff: PlanDiff | None = None
    proposal: WeeklyPlanCreateProposal | None = None
    accepted_op_ids: list[str] = Field(default_factory=list)
    # Optimistic-concurrency handle: the weekly fingerprint the diff was proposed
    # against. When present and no longer current, the apply is rejected (409).
    base_revision: str | None = None
    # Required (value ``"weekly_only"``) when the apply is a *material* deviation
    # from the active season plan — the user is knowingly touching only this week.
    impact_acknowledgement: str | None = None

    @field_validator("session_id")
    @classmethod
    def _session_id_is_opaque_token(cls, value: str) -> str:
        return _validate_session_id(value)

    @model_validator(mode="after")
    def _exactly_one_payload(self) -> "CoachWeekApplyRequest":
        if (self.diff is None) == (self.proposal is None):
            raise ValueError("provide exactly one of diff or proposal")
        return self


def _active_master_for_user(user_id: str) -> Any:
    """Best-effort load of the user's ACTIVE master plan for impact scoring.

    Returns ``None`` (impact = ``none``) when there is no active plan or the
    lookup isn't available — impact scoring must never block on infra hiccups.
    """
    try:
        store = get_master_plan_store()
        return store.get_active_plan(user_id)
    except Exception:  # noqa: BLE001 — scoring is advisory, never fatal here
        return None


def _day_has_matching_actual(activities: list[dict[str, Any]], kind: Any) -> bool:
    """Reuse the plan-vs-actual match heuristic: does today's sync contain an
    activity that fulfils this session kind?"""
    from stride_core.plan_spec import SessionKind

    if kind == SessionKind.RUN:
        return any(a.get("sport") == "run" or a.get("sport_type") == 100 for a in activities)
    if kind == SessionKind.STRENGTH:
        return any(a.get("sport") == "strength" or a.get("sport_type") == 4 for a in activities)
    return False


def _changed_session_keys(
    current: Any,
    proposed: Any,
    *,
    before: str | None = None,
    on: str | None = None,
) -> list[str]:
    """Session identities whose canonical content changes in a full replacement."""
    current_by_key = {
        (session.date, session.session_index): session
        for session in current.sessions
        if (before is None or session.date < before)
        and (on is None or session.date == on)
    }
    proposed_by_key = {
        (session.date, session.session_index): session
        for session in proposed.sessions
        if (before is None or session.date < before)
        and (on is None or session.date == on)
    }
    keys = set(current_by_key) | set(proposed_by_key)
    return [
        f"{date}#{index}"
        for date, index in sorted(keys)
        if current_by_key.get((date, index)) != proposed_by_key.get((date, index))
    ]


def _locked_today_full_plan_keys(
    user_id: str,
    current: Any,
    proposed: Any,
    *,
    today: str,
) -> list[str]:
    """Changed today sessions already backed by a synced actual."""
    changed = set(_changed_session_keys(current, proposed, on=today))
    if not changed:
        return []
    try:
        from ..deps import get_db

        db = get_db(user_id)
        try:
            activities = [
                dict(row) for row in db.get_activities_for_shanghai_day(today)
            ]
        finally:
            db.close()
    except Exception:  # noqa: BLE001 — advisory lock, never fail an apply on I/O
        return []
    if not activities:
        return []

    locked: list[str] = []
    for session in current.sessions:
        key = f"{session.date}#{session.session_index}"
        if key not in changed or session.date != today:
            continue
        if _day_has_matching_actual(activities, session.kind):
            locked.append(key)
    return locked


def _locked_today_op_ids(
    user_id: str, accepted_ops: list[Any], plan: Any, *, today: str
) -> list[str]:
    """Ids of accepted ops that touch a *today* session already backed by a
    synced actual (that session is done — its plan row is frozen).

    Best-effort: any lookup failure returns ``[]`` (the past-date hard gate is
    the load-bearing invariant; this lock is an added protection, not a
    correctness gate that should 500 on an infra hiccup).
    """
    today_ops = [op for op in accepted_ops if today in op_touched_dates(op)]
    if not today_ops or plan is None:
        return []
    try:
        from ..deps import get_db

        db = get_db(user_id)
        activities = [dict(r) for r in db.get_activities_for_shanghai_day(today)]
    except Exception:  # noqa: BLE001 — advisory lock, never fatal
        return []
    if not activities:
        return []

    by_key = {(s.date, s.session_index): s for s in plan.sessions}
    locked: list[str] = []
    for op in today_ops:
        session = by_key.get((op.date, op.session_index))
        if session is None:
            continue
        if _day_has_matching_actual(activities, session.kind):
            locked.append(op.id)
    return locked


def _is_reviewable_proposal_card(user_id: str, card: ProposalCard) -> bool:
    """Whether a proposal can render a non-empty, actionable Review.

    Historical ``regenerate_week`` calls emitted remove-only ``PlanDiff`` values
    that projected an existing week to zero sessions. Those are intermediate
    instructions, not replacement plans; suppress them at the HTTP boundary for
    both live chat and history recovery. Storage failures fail open so an
    unrelated infrastructure hiccup does not silently erase a valid card.
    """
    proposal = card.proposal
    if isinstance(proposal, WeeklyPlanCreateProposal):
        return bool(proposal.to_weekly_plan().sessions)
    if not isinstance(proposal, PlanDiff):
        return True
    try:
        current = get_weekly_plan_store().get_plan(user_id, proposal.folder)
        if current is None or not current.sessions:
            return True
        applicable = [op.id for op in proposal.ops if op.accepted is not False]
        projected = apply_diff_to_weekly_plan(current, proposal, applicable)
        return bool(projected.sessions)
    except Exception:  # noqa: BLE001 — filtering is defensive, not a hard gate
        logger.exception("proposal reviewability check failed")
        return True


def _enrich_proposal_cards(user_id: str, cards: list[ProposalCard]) -> list[dict]:
    """Filter unsafe cards and fill revision + season-impact metadata.

    Enrichment reads infrastructure (weekly / master stores), which core must
    not do — so it happens here at the HTTP boundary. Best-effort per card: a
    lookup failure leaves that card un-enriched rather than failing the turn.
    """
    out: list[dict] = []
    for card in cards:
        if not _is_reviewable_proposal_card(user_id, card):
            logger.warning(
                "suppressing non-reviewable proposal from %s", card.specialist_id
            )
            continue
        try:
            enriched = _enrich_one_card(user_id, card)
        except Exception:  # noqa: BLE001 — enrichment is advisory, never fatal
            logger.exception("proposal enrichment failed for %s", card.specialist_id)
            enriched = card
        out.append(enriched.model_dump())
    return out


def _enrich_one_card(user_id: str, card: ProposalCard) -> ProposalCard:
    proposal = card.proposal
    if isinstance(proposal, PlanDiff):
        return _enrich_weekly_diff_card(user_id, card, proposal)
    if isinstance(proposal, WeeklyPlanCreateProposal):
        return _enrich_weekly_create_card(user_id, card, proposal)
    if isinstance(proposal, MasterPlanDiff):
        return _enrich_master_card(user_id, card, proposal)
    return card


def _enrich_weekly_diff_card(
    user_id: str, card: ProposalCard, diff: PlanDiff
) -> ProposalCard:
    current = get_weekly_plan_store().get_plan(user_id, diff.folder)
    if current is None:
        return card
    base_revision = (
        diff.base_revision
        or card.base_revision
        or weekly_plan_fingerprint(current)
    )
    pinned_diff = diff.model_copy(update={"base_revision": base_revision})
    impact: SeasonImpact | None = None
    try:
        applicable = [op.id for op in pinned_diff.ops if op.accepted is not False]
        adjusted = apply_diff_to_weekly_plan(current, pinned_diff, applicable)
        impact = evaluate_weekly_season_impact(
            adjusted, master=_active_master_for_user(user_id), previous=current
        )
    except ValueError:
        impact = None
    return card.model_copy(
        update={
            "proposal": pinned_diff,
            "base_revision": base_revision,
            "season_impact": impact,
            "target": card.target or TargetRef(kind="week", folder=diff.folder),
        }
    )


def _enrich_weekly_create_card(
    user_id: str, card: ProposalCard, proposal: WeeklyPlanCreateProposal
) -> ProposalCard:
    impact: SeasonImpact | None = None
    try:
        proposed = proposal.to_weekly_plan()
        current = get_weekly_plan_store().get_plan(user_id, proposal.folder)
        impact = evaluate_weekly_season_impact(
            proposed,
            master=_active_master_for_user(user_id),
            previous=current if proposal.base_revision is not None else None,
        )
    except Exception:  # noqa: BLE001 — advisory
        impact = None
    return card.model_copy(
        update={
            # The revision lives inside the durable proposal so history recovery
            # reuses the generation-time snapshot instead of recomputing it.
            "base_revision": proposal.base_revision,
            "season_impact": impact,
            "target": card.target or TargetRef(kind="week", folder=proposal.folder),
        }
    )


def _enrich_master_card(
    user_id: str, card: ProposalCard, diff: MasterPlanDiff
) -> ProposalCard:
    plan = _active_master_for_user(user_id)
    base_revision = diff.base_revision or card.base_revision or (
        str(plan.version) if plan is not None else None
    )
    pinned_diff = diff.model_copy(update={"base_revision": base_revision})
    return card.model_copy(
        update={
            "proposal": pinned_diff,
            "base_revision": base_revision,
            "target": card.target or TargetRef(kind="master", plan_id=diff.plan_id),
        }
    )


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

        request_revision = body.base_revision or None
        if request_revision != proposal.base_revision:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="request base_revision does not match proposal base_revision",
            )

        proposed_plan = proposal.to_weekly_plan()
        plan_store = get_weekly_plan_store()
        current = plan_store.get_plan(user_id, folder)
        is_replacement = proposal.base_revision is not None

        if is_replacement:
            if (
                current is None
                or weekly_plan_fingerprint(current) != proposal.base_revision
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="weekly plan changed since this proposal was created",
                )

            today = today_shanghai().isoformat()
            past_keys = _changed_session_keys(
                current,
                proposed_plan,
                before=today,
            )
            if past_keys:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "past_day_immutable",
                        "message": "不能修改今天之前的训练日",
                        "session_keys": past_keys,
                    },
                )
            locked_today_keys = _locked_today_full_plan_keys(
                user_id,
                current,
                proposed_plan,
                today=today,
            )
            if locked_today_keys:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "today_session_locked",
                        "message": "今天的这节训练已有完成记录，不能再改动",
                        "session_keys": locked_today_keys,
                    },
                )

            impact = evaluate_weekly_season_impact(
                proposed_plan,
                master=_active_master_for_user(user_id),
                previous=current,
            )
            if (
                impact.level == "material"
                and body.impact_acknowledgement != "weekly_only"
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "season_impact_material",
                        "message": "该调整明显偏离赛季计划，需要确认仅改本周",
                        "season_impact": impact.model_dump(),
                    },
                )
            try:
                save_weekly_plan(
                    user_id,
                    proposed_plan,
                    expected_folder=folder,
                    generated_by="coach-regeneration",
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            created = False
            summary = "已替换并启用本周课表"
        else:
            try:
                created = create_weekly_plan(
                    user_id,
                    proposed_plan,
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
            impact = evaluate_weekly_season_impact(
                proposed_plan,
                master=_active_master_for_user(user_id),
                previous=None,
            )
            summary = "已创建并启用本周课表"

        _emit_coach_event(
            user_id,
            CoachEvent(
                type="weekly_plan_applied",
                status="applied",
                created_at=_now_iso(),
                summary=summary,
                target=TargetRef(kind="week", folder=folder),
                detail={"folder": folder, "created": created},
            ),
            body.session_id,
        )
        return {
            "applied": 1,
            "folder": folder,
            "created": created,
            "season_impact": impact.model_dump(),
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    diff = body.diff
    assert diff is not None
    if diff.folder != folder:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"diff folder {diff.folder!r} does not match path folder {folder!r}",
        )
    request_revision = body.base_revision or None
    if diff.base_revision is None or request_revision is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="weekly diff and request must carry base_revision",
        )
    if request_revision != diff.base_revision:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="request base_revision does not match diff base_revision",
        )

    # Whole-plan apply: the client must accept exactly the applicable ops
    # (accepted != False). Partial / unknown / duplicate / rejected → 400.
    try:
        accepted_op_ids = require_whole_plan_op_ids(diff.ops, body.accepted_op_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # History immutability (hard gate): an accepted op may not touch a Shanghai
    # day earlier than today. The past is a record, not an editable plan.
    accepted_ops = [op for op in diff.ops if op.id in set(accepted_op_ids)]
    today = today_shanghai().isoformat()
    past_ids = past_dated_op_ids(accepted_ops, today=today)
    if past_ids:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "past_day_immutable",
                "message": "不能修改今天之前的训练日",
                "op_ids": past_ids,
            },
        )

    # Today lock: a session on today that already has a synced actual is done —
    # its op is refused so the record and the plan can't diverge.
    plan_store = get_weekly_plan_store()
    current = plan_store.get_plan(user_id, folder)
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"weekly plan {folder!r} not found",
        )
    locked_ids = _locked_today_op_ids(user_id, accepted_ops, current, today=today)
    if locked_ids:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "today_session_locked",
                "message": "今天的这节训练已有完成记录，不能再改动",
                "op_ids": locked_ids,
            },
        )

    # Optimistic concurrency: reject a proposal built against a stale snapshot.
    if body.base_revision is not None:
        current_revision = weekly_plan_fingerprint(current)
        if body.base_revision != current_revision:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="weekly plan changed since this proposal was created",
            )

    try:
        adjusted = apply_diff_to_weekly_plan(current, diff, accepted_op_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Season-impact gate: a material deviation from the active master plan must
    # be explicitly acknowledged as a week-only change before it lands.
    impact = evaluate_weekly_season_impact(
        adjusted, master=_active_master_for_user(user_id), previous=current
    )
    if impact.level == "material" and body.impact_acknowledgement != "weekly_only":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "season_impact_material",
                "message": "该调整明显偏离赛季计划，需要确认仅改本周",
                "season_impact": impact.model_dump(),
            },
        )

    try:
        save_weekly_plan(
            user_id, adjusted, expected_folder=folder,
            generated_by="coach-adjustment",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _emit_coach_event(
        user_id,
        CoachEvent(
            type="weekly_plan_applied",
            status="applied",
            created_at=_now_iso(),
            summary=f"已应用本周调整（{len(accepted_op_ids)} 项）",
            target=TargetRef(kind="week", folder=folder),
            detail={"folder": folder, "applied_op_ids": accepted_op_ids},
        ),
        body.session_id,
    )

    return {
        "applied": len(accepted_op_ids),
        "folder": folder,
        "created": False,
        "season_impact": impact.model_dump(),
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
    ``session_id`` binds the resulting trusted event to that conversation.
    """

    session_id: str = Field(default=_DEFAULT_SESSION_ID, min_length=1, max_length=128)
    diff: MasterPlanDiff
    accepted_op_ids: list[str]
    change_reason: str = "coach adjustment"
    # Optimistic-concurrency handle: the master ``version`` the diff was proposed
    # against (as a string). Stale → 409.
    base_revision: str | None = None

    @field_validator("session_id")
    @classmethod
    def _session_id_is_opaque_token(cls, value: str) -> str:
        return _validate_session_id(value)


def _affected_weeks_for_coach_master_apply(
    plan: Any, diff: MasterPlanDiff, accepted_op_ids: list[str]
) -> list[dict[str, str]]:
    """Report canonical weekly plans that may contain stale master guidance."""
    accepted = set(accepted_op_ids)
    accepted_ops = [
        op
        for op in diff.ops
        if op.id in accepted and op.accepted is not False
    ]
    if not accepted_ops:
        return []

    from .master_plan import _compute_affected_weeks
    return _compute_affected_weeks(
        accepted_ops, plan, as_of=today_shanghai()
    )


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
    request_revision = body.base_revision or None
    if diff.base_revision is None or request_revision is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="master diff and request must carry base_revision",
        )
    if request_revision != diff.base_revision:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="request base_revision does not match diff base_revision",
        )

    store = get_master_plan_store()
    with master_plan_apply_lock(user_id, plan_id):
        plan = require_active_master_plan(
            store,
            user_id,
            plan_id,
            not_found_detail=f"master plan {plan_id!r} not found",
            forbidden_detail="plan belongs to a different user",
            inactive_detail="该赛季计划尚未确认（status≠active），不能应用调整",
        )
        # Optimistic concurrency: reject a proposal built against a stale version.
        if body.base_revision is not None and body.base_revision != str(plan.version):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="master plan changed since this proposal was created",
            )
        # Whole-plan apply: the client must accept exactly the applicable ops
        # (accepted != False). Partial / unknown / duplicate / rejected → 400.
        accepted_op_ids = require_whole_master_op_ids(diff, body.accepted_op_ids)
        affected_weeks = _affected_weeks_for_coach_master_apply(
            plan, diff, accepted_op_ids
        )
        updated_plan, accepted_op_ids = apply_active_master_diff(
            store=store,
            user_id=user_id,
            plan_id=plan_id,
            plan=plan,
            diff=diff,
            requested_op_ids=body.accepted_op_ids,
            change_reason=body.change_reason,
            read_json_func=read_json,
            write_json_func=write_json,
            validate_diff_func=validate_master_diff,
            apply_diff_func=apply_master_plan_diff,
            logger=logger,
        )

    _emit_coach_event(
        user_id,
        CoachEvent(
            type="master_plan_applied",
            status="applied",
            created_at=_now_iso(),
            summary=f"已应用赛季计划调整（{len(accepted_op_ids)} 项）",
            target=TargetRef(kind="master", plan_id=plan_id),
            detail={
                "plan_id": plan_id,
                "version": updated_plan.version,
                "applied_op_ids": accepted_op_ids,
            },
        ),
        body.session_id,
    )

    return {
        "applied": len(accepted_op_ids),
        "plan_id": plan_id,
        "version": updated_plan.version,
        "updated_at": updated_plan.updated_at,
        "affected_weeks": affected_weeks,
    }


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/proposals/abandon  (record an abandoned proposal)
# ---------------------------------------------------------------------------


class CoachAbandonRequest(BaseModel):
    """Body for recording that the user abandoned a surfaced proposal.

    An explicit user action (dismissed the adjust workspace without applying) is
    a real signal for the coach — recorded as a trusted ``proposal_abandoned``
    event on the originating session, never a faked system message.
    """

    session_id: str = Field(default=_DEFAULT_SESSION_ID, min_length=1, max_length=128)
    target: TargetRef | None = None
    summary: str = Field(default="", max_length=512)

    @field_validator("session_id")
    @classmethod
    def _session_id_is_opaque_token(cls, value: str) -> str:
        return _validate_session_id(value)


@router.post("/api/users/me/coach/proposals/abandon")
def abandon_coach_proposal(
    body: CoachAbandonRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Record that the user abandoned a proposal (trusted event, no apply)."""
    user_id: str = payload["sub"]
    event = CoachEvent(
        type="proposal_abandoned",
        status="abandoned",
        created_at=_now_iso(),
        summary=body.summary or "用户放弃了本次调整方案",
        target=body.target,
        detail=(body.target.model_dump() if body.target is not None else {}),
    )
    _emit_coach_event(user_id, event, body.session_id)
    return {"recorded": True, "created_at": event.created_at}


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
# Pending-proposal recovery helper
# ---------------------------------------------------------------------------

_TERMINAL_EVENT_TYPES = frozenset(
    {"weekly_plan_applied", "master_plan_applied", "proposal_abandoned"}
)


def _target_identity(target: Any) -> tuple[str, str] | None:
    if not isinstance(target, dict):
        return None
    kind = str(target.get("kind") or "")
    if kind in {"week", "session"}:
        folder = str(target.get("folder") or "")
        return ("week", folder) if folder else None
    if kind == "master":
        plan_id = str(target.get("plan_id") or "")
        return ("master", plan_id) if plan_id else None
    return None


def _event_resolves_target(
    event: dict,
    *,
    target: tuple[str, str] | None,
    proposed_at: str,
) -> bool:
    if target is None or event.get("type") not in _TERMINAL_EVENT_TYPES:
        return False
    event_target = _target_identity(event.get("target") or event.get("detail"))
    if event_target != target:
        return False
    event_at = str(event.get("created_at") or "")
    # A terminal event may consume a proposal only when their ordering is
    # provable. Legacy/corrupt checkpoints can lack either timestamp; in that
    # case preserve the Review card rather than silently discarding user work.
    if not proposed_at or not event_at:
        return False
    return event_at >= proposed_at


def _recoverable_proposal_cards(raw_proposals: list[Any]) -> list[ProposalCard]:
    cards: list[ProposalCard] = []
    for raw in raw_proposals:
        card = ProposalCard.model_validate(raw)
        proposal = card.proposal
        if isinstance(proposal, WeeklyPlanCreateProposal):
            # Historical regenerate markers could contain a valid-but-empty plan.
            # They are intermediate instructions, never a reviewable proposal.
            if not proposal.to_weekly_plan().sessions:
                continue
            if card.base_revision != proposal.base_revision:
                continue
        elif isinstance(proposal, (PlanDiff, MasterPlanDiff)):
            # Old receipts predate durable revision pinning. Rebinding such a diff
            # to today's plan/version would let refresh bypass stale protection.
            if (
                proposal.base_revision is None
                or card.base_revision != proposal.base_revision
            ):
                continue
        cards.append(card)
    return cards


def _extract_pending_proposals(
    user_id: str,
    turn_receipts: list[dict],
    events: list[dict],
) -> tuple[list[dict] | None, dict | None, str | None]:
    """Return the latest reviewable proposal unresolved for the same target.

    Later read-only turns do not consume a proposal. Only an applied/abandoned
    event for the same target, timestamped after the proposal, closes it.
    """
    for receipt in reversed(turn_receipts):
        tr = receipt.get("turn_response") or {}
        raw_proposals = tr.get("proposals") or []
        if not raw_proposals:
            continue
        try:
            cards = _recoverable_proposal_cards(list(raw_proposals))
        except Exception:  # noqa: BLE001
            logger.exception("pending proposal validation failed")
            continue
        if not cards:
            continue

        active_target = tr.get("active_target")
        card_target = cards[0].target.model_dump() if cards[0].target else None
        target = _target_identity(active_target or card_target)
        proposed_at = str(receipt.get("created_at") or "")
        if any(
            _event_resolves_target(
                event,
                target=target,
                proposed_at=proposed_at,
            )
            for event in events
        ):
            continue
        try:
            enriched = _enrich_proposal_cards(user_id, cards)
        except Exception:  # noqa: BLE001
            logger.exception("pending proposal re-enrichment failed")
            continue
        if not enriched:
            continue
        return enriched, active_target or card_target, receipt.get("message_id")

    return None, None, None


# ---------------------------------------------------------------------------
# GET /api/users/me/coach/sessions/{session_id}/messages
# ---------------------------------------------------------------------------


@router.get(
    "/api/users/me/coach/sessions/{session_id}/messages",
    response_model=SessionMessagesResponse,
)
def get_session_messages(
    session_id: str,
    payload: dict = Depends(require_bearer),
    config: Any = Depends(get_server_config),
) -> SessionMessagesResponse:
    """History for one chat session; the thread is derived from the JWT.

    The client passes only ``session_id`` (never a ``thread_id``); the server
    keys ``{user}:coach:{session_id}`` so a client can't reach another user's
    thread. Debug users (config ``coach_chat_debug_users``) additionally see
    reasoning / tool_meta parts and tool messages.
    """
    if not _SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="session_id must be [A-Za-z0-9_-]",
        )
    user_id: str = payload["sub"]
    thread_id = coach_thread_id(user_id, session_id)
    debug = user_id in _debug_users(config)

    checkpointer = get_checkpointer()
    cfg = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    tup = checkpointer.get_tuple(cfg)
    if tup is None:
        return SessionMessagesResponse(
            session_id=session_id,
            thread_id=thread_id,
            user_id=user_id,
            debug=debug,
            messages=[],
        )
    checkpoint: dict[str, Any] = tup.checkpoint or {}
    channel_values = checkpoint.get("channel_values") or {}
    history_raw = channel_values.get("history") or []
    checkpoint_ts = str(checkpoint.get("ts") or "")
    receipts_by_turn = {
        r.get("client_turn_id"): r
        for r in (channel_values.get("turn_receipts") or [])
        if r.get("client_turn_id")
    }
    messages = _history_to_chat_messages(
        history_raw,
        thread_id=thread_id,
        checkpoint_ts=checkpoint_ts,
        debug=debug,
        receipts_by_turn=receipts_by_turn,
    )
    # Trusted events (applied / abandoned) are surfaced as role="event" rows —
    # never disguised as model turns.
    for i, ev in enumerate(channel_values.get("events") or []):
        messages.append(
            ChatMessage(
                role="event",
                message_id=f"{thread_id}#event#{i}",
                created_at=str(ev.get("created_at") or checkpoint_ts),
                event_type=ev.get("type"),
                status=ev.get("status"),
                summary=ev.get("summary") or "",
                detail=ev.get("detail") or {},
            )
        )
    # Recover the latest unresolved proposal so a fresh tab re-shows the card.
    pending_proposals, pending_active_target, pending_proposal_message_id = (
        _extract_pending_proposals(
            user_id,
            list(channel_values.get("turn_receipts") or []),
            list(channel_values.get("events") or []),
        )
    )
    return SessionMessagesResponse(
        session_id=session_id,
        thread_id=thread_id,
        user_id=user_id,
        debug=debug,
        messages=messages,
        pending_proposals=pending_proposals,
        pending_active_target=pending_active_target,
        pending_proposal_message_id=pending_proposal_message_id,
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
