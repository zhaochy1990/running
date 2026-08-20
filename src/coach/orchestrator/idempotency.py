"""client_turn_id idempotency for the orchestrator pipeline (pure, core layer).

One logical turn is made retry-safe by a client-supplied ``client_turn_id``.
Receipts are kept in the checkpointed graph state (not a new backend); each
records the request fingerprint and the exact turn output — including stable
message identity — so a replay reproduces the response byte-for-byte without
re-invoking the model.

Semantics:

* same ``client_turn_id`` + same request  → replay the stored output
* same ``client_turn_id`` + different request → :class:`TurnConflictError`
* new ``client_turn_id`` → run normally and append a receipt (evicting the
  oldest beyond :data:`MAX_TURN_RECEIPTS`)

Stable identity: the human/assistant messages for a turn derive their ids from
``client_turn_id`` (``{id}:u`` / ``{id}:a``). Because ``add_messages`` replaces a
message that shares an id, replaying a turn *overwrites* its history rows rather
than appending duplicates. ``created_at`` is minted once (first run) and reused
on replay, so the HTTP ``assistant_message`` is identical across retries.

The request fingerprint is computed from the *request* inputs (message + the
target the client sent this turn) — never the promoted ``active_target``, which
the pipeline mutates, so a first-run target resolution wouldn't spuriously
conflict on replay.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# Bounded so the checkpoint payload can't grow without limit on a long session.
MAX_TURN_RECEIPTS = 50


class TurnConflictError(Exception):
    """Raised when a ``client_turn_id`` is reused with a different request."""

    def __init__(self, client_turn_id: str) -> None:
        super().__init__(
            f"client_turn_id {client_turn_id!r} was reused with a different request"
        )
        self.client_turn_id = client_turn_id


def human_message_id(client_turn_id: str) -> str:
    return f"{client_turn_id}:u"


def assistant_message_id(client_turn_id: str) -> str:
    return f"{client_turn_id}:a"


def request_fingerprint(
    *,
    message: str,
    request_target: dict[str, Any] | None,
    request_context: dict[str, Any] | None = None,
) -> str:
    """Stable hash of the turn's request-defining inputs.

    ``request_target`` is the target the client supplied *this* turn (or
    ``None``) — deliberately not the pipeline-promoted ``active_target``.
    ``request_context`` is the review draft the client anchored this turn to (or
    ``None``); it is part of the request identity, so a replay carrying the same
    id with a different draft is a conflict, not a silent replay of the old one.
    """
    payload = json.dumps(
        {"message": message, "target": request_target, "context": request_context},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def find_receipt(
    receipts: list[dict[str, Any]], client_turn_id: str
) -> dict[str, Any] | None:
    for receipt in receipts:
        if receipt.get("client_turn_id") == client_turn_id:
            return receipt
    return None


def resolve_replay(
    receipts: list[dict[str, Any]],
    *,
    client_turn_id: str,
    fingerprint: str,
) -> dict[str, Any] | None:
    """Return the stored receipt for a matching replay, else ``None``.

    Raises :class:`TurnConflictError` when the id was seen with a different
    request fingerprint.
    """
    receipt = find_receipt(receipts, client_turn_id)
    if receipt is None:
        return None
    if receipt.get("fingerprint") != fingerprint:
        raise TurnConflictError(client_turn_id)
    return receipt


def append_receipt(
    receipts: list[dict[str, Any]],
    *,
    client_turn_id: str,
    fingerprint: str,
    turn_response: dict[str, Any],
    message_id: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Return a new receipts list with this turn appended (bounded, no mutation)."""
    kept = [r for r in receipts if r.get("client_turn_id") != client_turn_id]
    kept.append(
        {
            "client_turn_id": client_turn_id,
            "fingerprint": fingerprint,
            "turn_response": turn_response,
            "message_id": message_id,
            "created_at": created_at,
        }
    )
    if len(kept) > MAX_TURN_RECEIPTS:
        kept = kept[-MAX_TURN_RECEIPTS:]
    return kept
