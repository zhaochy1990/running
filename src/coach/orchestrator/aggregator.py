"""Aggregator — collapse dispatched results into one TurnResponse (§4.4).

Priority short-circuits (in order):

1. **clarification** — Resolver ambiguity OR any ``needs_clarification`` result →
   a clarify turn (proposals suppressed: ``clarification≠None ⟹ proposals=[]``).
2. **failure fallback** — every result failed/rejected → an honest failure reply,
   never a faked success.
3. **single-result fast path** (no LLM) — one completed, user-ready fragment →
   passthrough + attach its proposal card.
4. **multi-result slow path** — synthesise multiple fragments into one coherent
   reply via injected ``synth_fn`` (S1 has one specialist, so this only fires
   with the degraded multi-intent path; falls back to a deterministic join when
   no ``synth_fn`` is supplied — proper LLM synthesis is S2).

The Aggregator only *organises language* — it never invents numbers absent from a
fragment (§4.4 anti-hallucination). Proposals ride the response (Pattern Y).
"""

from __future__ import annotations

from collections.abc import Callable

from coach.contracts import (
    ProposalCard,
    ResolverOutput,
    TurnResponse,
)
from .dispatcher import DispatchResult

# (fragments, utterance) -> one coherent reply. Injected so the core stays pure.
SynthFn = Callable[[list[str], str], str]

_FAILURE_REPLY = "抱歉，这次没能完成你的请求，请稍后再试或换个说法。"


def _clarification_text(
    dispatched: list[DispatchResult], resolver_output: ResolverOutput
) -> str | None:
    """First clarification to surface: Resolver ambiguity wins, else a result's."""
    if resolver_output.ambiguity is not None:
        return resolver_output.ambiguity.clarification
    for item in dispatched:
        if item.result.status == "needs_clarification" and item.result.clarification:
            return item.result.clarification
    return None


def _proposal_cards(dispatched: list[DispatchResult], resolver_output: ResolverOutput) -> list[ProposalCard]:
    cards: list[ProposalCard] = []
    for item in dispatched:
        proposal = item.result.proposal
        if proposal is None:
            continue
        cards.append(
            ProposalCard(
                specialist_id=item.specialist_id,
                proposal=proposal,
                target=resolver_output.active_target,
                summary=item.result.reply_fragment,
            )
        )
    return cards


def _artifacts(dispatched: list[DispatchResult]) -> list:
    refs: list = []
    for item in dispatched:
        if item.result.status != "completed" or not item.result.artifacts:
            continue
        refs.extend(item.result.artifacts)
    return refs


def aggregate(
    dispatched: list[DispatchResult],
    *,
    resolver_output: ResolverOutput,
    utterance: str,
    synth_fn: SynthFn | None = None,
) -> TurnResponse:
    """Build the final TurnResponse from dispatched specialist results (§4.4)."""
    active_target = resolver_output.active_target

    # Priority 1: clarification short-circuit (no proposals on a clarify turn).
    clarification = _clarification_text(dispatched, resolver_output)
    if clarification is not None:
        return TurnResponse(
            reply=clarification,
            proposals=[],
            clarification=clarification,
            active_target=active_target,
        )

    # Priority 2: honest failure when nothing completed.
    completed = [item for item in dispatched if item.result.status == "completed"]
    if not completed:
        return TurnResponse(reply=_FAILURE_REPLY, proposals=[], active_target=active_target)

    proposals = _proposal_cards(completed, resolver_output)
    artifacts = _artifacts(completed)
    fragments = [item.result.reply_fragment for item in completed if item.result.reply_fragment]

    # Priority 3: single-result fast path — passthrough, no synthesis LLM.
    if len(completed) == 1:
        reply = fragments[0] if fragments else ""
        return TurnResponse(
            reply=reply,
            proposals=proposals,
            artifacts=artifacts,
            active_target=active_target,
        )

    # Priority 4: multi-result — synthesise (or deterministic join fallback).
    if synth_fn is not None:
        reply = synth_fn(fragments, utterance)
    else:
        reply = "\n\n".join(fragments)
    return TurnResponse(
        reply=reply,
        proposals=proposals,
        artifacts=artifacts,
        active_target=active_target,
    )
