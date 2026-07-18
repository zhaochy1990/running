"""Resolver — intent recognition (LLM) + target/clarify resolution (§4.1).

One LLM call produces a :class:`ResolverDraft` (intent recognition, constrained
to the registered specialist ids); deterministic post-processing turns the
referring-phrase hint into a concrete :class:`TargetRef` and arbitrates whether
to clarify. The LLM is injected as ``draft_fn`` so the core stays pure and the
node is unit-testable without a live model.

Prompt-role discipline (HARD, §4.1): the *system* prompt carries the classifier
persona + decision rules + the Card catalog (byte-stable across users/turns,
changes only when specialists are added → caches); the *user* prompt carries the
turn's utterance + conversation window.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from langchain_core.exceptions import OutputParserException
from pydantic import ValidationError

from coach.contracts import (
    Ambiguity,
    IntentHit,
    ResolverDraft,
    ResolverOutput,
    SpecialistRegistry,
    TargetHint,
    TargetRef,
    Turn,
)
from coach.skills.loader import render_skill
from .structured_tool import StructuredToolRunner

logger = logging.getLogger(__name__)

# A draft producer: (system_prompt, user_prompt) -> ResolverDraft. The adapter
# wires this to the orchestrator LLM via :func:`make_llm_draft_fn`; tests inject
# a fake.
ResolverDraftFn = Callable[[str, str], ResolverDraft]

# A concrete-target resolver: (kind-only/None TargetRef, original TargetHint)
# -> concrete TargetRef. The hint preserves phrases such as "本周" vs "下周"
# that collapse to the same kind-only TargetRef but require different lookup.
# (with folder/plan_id filled) or None. The core can only derive a *kind* from
# the referring phrase; turning "本周" into a real folder needs the DB index, so
# the adapter injects this (DB-backed) to keep ``coach.*`` pure. Returning None
# means "couldn't resolve" → the arbitrator falls back to a target clarify.
TargetResolverFn = Callable[[TargetRef | None, TargetHint | None], TargetRef | None]

# --- Arbitration thresholds (§4.1 "clarify only when ambiguity changes result")
CONFIDENCE_FLOOR = 0.35   # below this, the top intent is too weak to dispatch
TIE_MARGIN = 0.12         # two distinct specialists within this margin = a tie
MAX_INTENTS = 3           # hallucination / runaway-compound cap

# ---------------------------------------------------------------------------
# Prompt construction (role-split)
# ---------------------------------------------------------------------------


def render_card_catalog(registry: SpecialistRegistry) -> str:
    """Render the routing menu from the registry cards (id/desc/tags/examples).

    Deterministic + ordered → byte-stable for a given specialist set, so it can
    live in the cache-stable *system* prompt.
    """
    lines: list[str] = []
    for card in registry.cards():
        lines.append(f"- id: {card.id}")
        lines.append(f"  action: {'write' if card.writes else 'read'}")
        lines.append(f"  description: {card.description}")
        if card.tags:
            lines.append(f"  tags: {', '.join(card.tags)}")
        for ex in card.examples:
            lines.append(f"  example: {ex}")
    return "\n".join(lines)


def build_resolver_system_prompt(registry: SpecialistRegistry) -> str:
    """System prompt = persona + rules + Card catalog (cache-stable)."""
    return render_skill("resolver", {"card_catalog": render_card_catalog(registry)})


def build_resolver_user_prompt(
    utterance: str, conversation_window: list[Turn], memory_context: str = ""
) -> str:
    """User prompt = this turn's utterance + recent window + injected memory.

    ``memory_context`` (active long-term facts, §4.0) goes in the *user* turn —
    per-athlete data never enters the cache-stable system prompt.
    """
    parts: list[str] = []
    if memory_context:
        parts.append(memory_context)
        parts.append("")
    if conversation_window:
        parts.append("# 最近对话")
        for turn in conversation_window:
            speaker = "用户" if turn.role == "user" else "教练"
            parts.append(f"{speaker}: {turn.content}")
        parts.append("")
    parts.append("# 本轮用户消息")
    parts.append(utterance)
    return "\n".join(parts)


def make_llm_draft_fn(model: object) -> ResolverDraftFn:
    """Wrap a chat model into a ``ResolverDraftFn`` via one schema tool call.

    Ordinary tool calling is portable across providers that reject
    ``response_format`` or forced ``tool_choice`` in thinking mode.
    """
    structured = StructuredToolRunner(model, ResolverDraft)

    def _draft_fn(system_prompt: str, user_prompt: str) -> ResolverDraft:
        try:
            result = structured.invoke(system_prompt, user_prompt)
            if isinstance(result, ResolverDraft):
                return result
            return ResolverDraft.model_validate(result)
        except (ValidationError, OutputParserException):
            # ONLY a genuine output-parse failure (the model returned something
            # that doesn't match ResolverDraft) degrades to a clarify turn.
            # Infra failures — auth / tenant mismatch / network / rate limit —
            # are NOT caught here: they propagate so the operator sees the real
            # cause instead of a misleading "想了解还是调整？" question.
            logger.warning(
                "resolver: LLM output did not match ResolverDraft schema; degrading to clarify",
                exc_info=True,
            )
            return ResolverDraft(intents=[], self_ambiguity=True)

    return _draft_fn


# ---------------------------------------------------------------------------
# Deterministic post-processing
# ---------------------------------------------------------------------------


def _resolve_target(
    hint: TargetHint | None, prior_target: TargetRef | None
) -> tuple[TargetRef | None, str]:
    """Map a referring-phrase hint to a concrete TargetRef (§4.1 step ②).

    Anaphora ("它/这个") reuses the prior turn's target; an explicit kind mention
    yields a kind-only TargetRef (full plan_id/folder resolution needs the DB
    index, which the adapter layer completes); otherwise default to the prior
    target. Returns ``(target, resolved_from)``.
    """
    if hint is None:
        return prior_target, "default"
    if hint.is_anaphora:
        return prior_target, "anaphora"
    if hint.kind is not None:
        return TargetRef(kind=hint.kind), "explicit"
    return prior_target, "default"


def _valid_intents(
    draft_intents: list[IntentHit], registry: SpecialistRegistry
) -> list[IntentHit]:
    """Keep registered intents whose action matches specialist capability."""
    valid = [
        hit
        for hit in draft_intents
        if hit.specialist_id in registry
        and (hit.action == "write") == registry.get_card(hit.specialist_id).writes
    ]
    valid.sort(key=lambda h: h.confidence, reverse=True)
    return valid[:MAX_INTENTS]


def _writes(intents: list[IntentHit], registry: SpecialistRegistry) -> bool:
    return any(registry.get_card(h.specialist_id).writes for h in intents)


def _needs_target_clarify(target: TargetRef | None, writes: bool) -> bool:
    """A write needs a concrete target; a read defaults to most-recent (§4.1)."""
    if not writes:
        return False
    if target is None:
        return True
    if target.kind == "master":
        return not target.plan_id
    return not target.folder  # week / session need a folder


def _arbitrate(
    valid: list[IntentHit],
    *,
    is_compound: bool,
    target: TargetRef | None,
    registry: SpecialistRegistry,
) -> Ambiguity | None:
    """Decide whether to clarify (§4.1 step ③) — only when it changes the result."""
    if not valid:
        return Ambiguity(kind="intent", clarification="你想了解训练状态，还是调整某个计划？")

    if not is_compound:
        top = valid[0]
        if top.confidence < CONFIDENCE_FLOOR:
            return Ambiguity(kind="intent", clarification="能再具体说说你想了解或调整什么吗？")
        if (
            len(valid) >= 2
            and valid[0].specialist_id != valid[1].specialist_id
            and (valid[0].confidence - valid[1].confidence) < TIE_MARGIN
        ):
            # Derive the question from the tied cards' descriptions so it stays
            # correct as the registry grows (not a hardcoded two-specialist text).
            a = registry.get_card(valid[0].specialist_id).description
            b = registry.get_card(valid[1].specialist_id).description
            return Ambiguity(kind="intent", clarification=f"你是想「{a}」，还是「{b}」？")

    if _needs_target_clarify(target, _writes(valid, registry)):
        return Ambiguity(kind="target", clarification="你指的是哪一个计划 / 哪一周？")
    return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def resolve(
    utterance: str,
    *,
    registry: SpecialistRegistry,
    draft_fn: ResolverDraftFn,
    conversation_window: list[Turn] | None = None,
    prior_target: TargetRef | None = None,
    memory_context: str = "",
    target_resolver: TargetResolverFn | None = None,
) -> ResolverOutput:
    """Run the Resolver: LLM intent draft → deterministic target + clarify (§4.1).

    ``target_resolver`` (injected by the adapter) upgrades a kind-only / missing
    target to a concrete one (e.g. "本周" → the current week's folder). Writes
    need this before arbitration; explicit reads use it so queries such as
    "下一周计划是什么" do not silently fall back to the current week.
    """
    window = conversation_window or []
    system_prompt = build_resolver_system_prompt(registry)
    user_prompt = build_resolver_user_prompt(utterance, window, memory_context)

    draft = draft_fn(system_prompt, user_prompt)
    logger.debug(
        "resolver draft (raw LLM) | intents=%s | compound=%s | "
        "target_kind=%s | target_anaphora=%s | self_ambiguity=%s",
        [(h.specialist_id, h.action, round(h.confidence, 2)) for h in draft.intents],
        draft.is_compound,
        draft.target_hint.kind if draft.target_hint else None,
        draft.target_hint.is_anaphora if draft.target_hint else False,
        draft.self_ambiguity,
    )

    valid = _valid_intents(draft.intents, registry)
    target, resolved_from = _resolve_target(draft.target_hint, prior_target)

    # Fill a concrete target from the DB index before arbitration. Reads without
    # an explicit target still default to most-recent; explicit week/master reads
    # are resolved so they query the requested object. For writes, only fire when
    # exactly one distinct write specialist is in play: with two different
    # writers a single current-week folder cannot be right for both.
    write_ids = {h.specialist_id for h in valid if registry.get_card(h.specialist_id).writes}
    explicit_unresolved_read = (
        bool(valid)
        and not write_ids
        and draft.target_hint is not None
        and draft.target_hint.kind is not None
        and target is not None
        and _needs_target_clarify(target, True)
    )
    if (
        target_resolver is not None
        and (
            (len(write_ids) == 1 and _needs_target_clarify(target, True))
            or explicit_unresolved_read
        )
    ):
        upgraded = target_resolver(target, draft.target_hint)
        if upgraded is not None:
            target, resolved_from = upgraded, "resolved"

    distinct_ids = {hit.specialist_id for hit in valid}
    is_compound = draft.is_compound and len(distinct_ids) >= 2

    ambiguity = _arbitrate(
        valid, is_compound=is_compound, target=target, registry=registry
    )

    return ResolverOutput(
        intents=valid,
        is_compound=is_compound,
        active_target=target,
        ambiguity=ambiguity,
        resolved_from=resolved_from,  # type: ignore[arg-type]
    )
