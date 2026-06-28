"""Resolver I/O contracts (§4.1).

The Resolver runs one LLM call (intent recognition, an understanding problem)
plus deterministic post-processing (target resolution + clarify arbitration,
state problems). ``ResolverDraft`` is the raw structured LLM output;
``ResolverOutput`` is the deterministic result handed to the Supervisor.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .target import TargetKind, TargetRef


class IntentHit(BaseModel):
    """One recognised intent, locked to a registered specialist id.

    ``specialist_id`` is constrained to the ``SpecialistRegistry`` id set at
    decode/validation time — the model cannot invent an unregistered expert.
    """

    specialist_id: str
    confidence: float


class TargetHint(BaseModel):
    """Referring phrase the LLM extracts; resolved to a ``TargetRef`` in code.

    The LLM only surfaces *what the user pointed at* ("第3周" / "它"); turning the
    phrase into a concrete handle is deterministic (session state + DB index).
    """

    kind: TargetKind | None = None
    ref_phrase: str | None = None
    is_anaphora: bool = False


class ResolverDraft(BaseModel):
    """Raw structured LLM output of the Resolver (before deterministic pass)."""

    intents: list[IntentHit] = Field(default_factory=list)
    is_compound: bool = False
    target_hint: TargetHint | None = None
    self_ambiguity: bool = False


class Ambiguity(BaseModel):
    """A clarification the orchestrator must ask before dispatching (§4.1)."""

    kind: Literal["intent", "target"]
    clarification: str


class ResolverOutput(BaseModel):
    """Deterministic Resolver result handed to the Supervisor (§4.1).

    ``ambiguity`` non-None short-circuits to a clarify turn — no specialists are
    dispatched. ``resolved_from`` records how the target was derived for tracing.
    """

    intents: list[IntentHit]
    is_compound: bool = False
    active_target: TargetRef | None = None
    ambiguity: Ambiguity | None = None
    resolved_from: Literal["anaphora", "explicit", "default", "resolved"] = "default"
