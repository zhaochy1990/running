"""S1b — Resolver: intent + deterministic target/clarify arbitration (§4.1)."""

from __future__ import annotations

from coach.contracts import (
    IntentHit,
    ResolverDraft,
    SpecialistCard,
    SpecialistRegistry,
    TargetHint,
    TargetRef,
    Turn,
)
from coach.orchestrator import resolver
from coach.orchestrator.resolver import resolve


def _registry() -> SpecialistRegistry:
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(
            id="status_insight",
            description="回答训练状态 / 疲劳 / 负荷诊断",
            tags=["status", "fatigue"],
            examples=["我最近状态怎么样"],
            writes=False,
        )
    )
    reg.register(
        SpecialistCard(
            id="weekly_plan",
            description="调整本周训练",
            tags=["week", "adjust"],
            examples=["把周三改成轻松跑"],
            writes=True,
        )
    )
    reg.register(
        SpecialistCard(
            id="season_plan",
            description="调整总体训练计划",
            tags=["master", "adjust"],
            examples=["把基础期延长两周"],
            writes=True,
        )
    )
    return reg


def _fixed(draft: ResolverDraft):
    """A draft_fn returning a fixed draft and capturing the prompts it saw."""
    captured: dict[str, str] = {}

    def _fn(system_prompt: str, user_prompt: str) -> ResolverDraft:
        captured["system"] = system_prompt
        captured["user"] = user_prompt
        return draft

    return _fn, captured


def test_single_read_intent_dispatches_no_clarify() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
    )
    fn, _ = _fixed(draft)
    out = resolve("我最近状态如何", registry=_registry(), draft_fn=fn)
    assert out.ambiguity is None
    assert out.is_compound is False
    assert [h.specialist_id for h in out.intents] == ["status_insight"]
    assert out.resolved_from == "default"


def test_hallucinated_specialist_dropped_then_clarify() -> None:
    draft = ResolverDraft(intents=[IntentHit(specialist_id="hotel_booking", action="read", confidence=0.9)])
    fn, _ = _fixed(draft)
    out = resolve("帮我订酒店", registry=_registry(), draft_fn=fn)
    assert out.intents == []
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "intent"


def test_low_confidence_triggers_intent_clarify() -> None:
    draft = ResolverDraft(intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.2)])
    fn, _ = _fixed(draft)
    out = resolve("嗯", registry=_registry(), draft_fn=fn)
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "intent"


def test_tie_between_distinct_specialists_clarifies() -> None:
    draft = ResolverDraft(
        intents=[
            IntentHit(specialist_id="status_insight", action="read", confidence=0.6),
            IntentHit(specialist_id="weekly_plan", action="write", confidence=0.58),
        ],
        is_compound=False,
    )
    fn, _ = _fixed(draft)
    out = resolve("看下这周", registry=_registry(), draft_fn=fn)
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "intent"


def test_tie_clarification_uses_card_descriptions() -> None:
    draft = ResolverDraft(
        intents=[
            IntentHit(specialist_id="status_insight", action="read", confidence=0.6),
            IntentHit(specialist_id="weekly_plan", action="write", confidence=0.58),
        ],
    )
    fn, _ = _fixed(draft)
    out = resolve("看下这周", registry=_registry(), draft_fn=fn)
    assert out.ambiguity is not None
    # Question derived from the tied cards' descriptions (registry-aware).
    assert "回答训练状态" in out.ambiguity.clarification
    assert "调整本周训练" in out.ambiguity.clarification


def _draft_fn_for(structured) -> object:
    class _Model:
        def with_structured_output(self, _schema):
            return structured

    return resolver.make_llm_draft_fn(_Model())


def test_make_llm_draft_fn_degrades_on_parse_failure() -> None:
    """A schema/parse failure → empty self-ambiguous draft → clarify turn."""
    from langchain_core.exceptions import OutputParserException

    class _BadParse:
        def invoke(self, _messages):
            raise OutputParserException("model returned non-JSON garbage")

    draft_fn = _draft_fn_for(_BadParse())
    draft = draft_fn("sys", "user")
    assert draft.intents == []
    assert draft.self_ambiguity is True
    out = resolve("???", registry=_registry(), draft_fn=draft_fn)
    assert out.ambiguity is not None


def test_make_llm_draft_fn_propagates_infra_error() -> None:
    """Auth / tenant / network errors must NOT degrade — they propagate."""
    import pytest

    class _AuthBoom:
        def invoke(self, _messages):
            raise RuntimeError("Tenant provided in token does not match resource token")

    draft_fn = _draft_fn_for(_AuthBoom())
    with pytest.raises(RuntimeError, match="Tenant"):
        draft_fn("sys", "user")


def test_compound_two_distinct_intents_no_tie_clarify() -> None:
    draft = ResolverDraft(
        intents=[
            IntentHit(specialist_id="status_insight", action="read", confidence=0.8),
            IntentHit(specialist_id="weekly_plan", action="write", confidence=0.78),
        ],
        is_compound=True,
    )
    fn, _ = _fixed(draft)
    out = resolve(
        "看下状态，顺便把周三改轻松跑",
        registry=_registry(),
        draft_fn=fn,
        prior_target=TargetRef(kind="week", folder="2026-W26"),
    )
    assert out.is_compound is True
    assert out.ambiguity is None
    assert len(out.intents) == 2


def test_anaphora_reuses_prior_target() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
        target_hint=TargetHint(is_anaphora=True, ref_phrase="它"),
    )
    fn, _ = _fixed(draft)
    prior = TargetRef(kind="week", folder="2026-W26")
    out = resolve("它现在怎么样", registry=_registry(), draft_fn=fn, prior_target=prior)
    assert out.active_target == prior
    assert out.resolved_from == "anaphora"


def test_explicit_kind_hint_yields_kind_only_target() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
        target_hint=TargetHint(kind="master", ref_phrase="赛季计划"),
    )
    fn, _ = _fixed(draft)
    out = resolve("赛季计划进展如何", registry=_registry(), draft_fn=fn)
    assert out.active_target == TargetRef(kind="master")
    assert out.resolved_from == "explicit"


def test_write_intent_without_target_clarifies_target() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="weekly_plan", action="write", confidence=0.9)],
    )
    fn, _ = _fixed(draft)
    out = resolve("帮我改一下", registry=_registry(), draft_fn=fn)
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "target"


def test_read_only_master_plan_query_routes_to_status_insight_from_model() -> None:
    draft = ResolverDraft(
        intents=[
            IntentHit(
                specialist_id="status_insight", action="read", confidence=0.93
            )
        ],
        target_hint=TargetHint(kind="master", ref_phrase="总体训练计划"),
    )
    fn, _ = _fixed(draft)

    out = resolve(
        "我当前的总体训练计划是什么？",
        registry=_registry(),
        draft_fn=fn,
    )

    assert out.ambiguity is None
    assert [hit.specialist_id for hit in out.intents] == ["status_insight"]
    assert out.active_target == TargetRef(kind="master")
    assert out.resolved_from == "explicit"


def test_action_mismatch_is_rejected_instead_of_rewriting_specialist() -> None:
    draft = ResolverDraft(
        intents=[
            IntentHit(
                specialist_id="season_plan", action="read", confidence=0.93
            )
        ],
        target_hint=TargetHint(kind="master", ref_phrase="总体训练计划"),
    )
    fn, _ = _fixed(draft)

    out = resolve(
        "我当前的总体训练计划是什么？", registry=_registry(), draft_fn=fn
    )

    assert out.intents == []
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "intent"


def test_write_action_on_read_specialist_is_rejected() -> None:
    draft = ResolverDraft(
        intents=[
            IntentHit(
                specialist_id="status_insight", action="write", confidence=0.91
            )
        ]
    )
    fn, _ = _fixed(draft)

    out = resolve("修改我的状态", registry=_registry(), draft_fn=fn)

    assert out.intents == []
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "intent"


def test_explicit_master_plan_edit_stays_on_write_specialist() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="season_plan", action="write", confidence=0.93)],
        target_hint=TargetHint(kind="master", ref_phrase="总体训练计划"),
    )
    fn, _ = _fixed(draft)

    out = resolve(
        "把我的总体训练计划基础期延长两周",
        registry=_registry(),
        draft_fn=fn,
        target_resolver=lambda _target: TargetRef(kind="master", plan_id="mp-1"),
    )

    assert [hit.specialist_id for hit in out.intents] == ["season_plan"]
    assert out.active_target == TargetRef(kind="master", plan_id="mp-1")


def test_write_intent_with_concrete_target_no_clarify() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="weekly_plan", action="write", confidence=0.9)],
    )
    fn, _ = _fixed(draft)
    out = resolve(
        "把周三改轻松跑",
        registry=_registry(),
        draft_fn=fn,
        prior_target=TargetRef(kind="week", folder="2026-W26"),
    )
    assert out.ambiguity is None
    assert [h.specialist_id for h in out.intents] == ["weekly_plan"]


def test_target_resolver_fills_current_week_for_write_no_clarify() -> None:
    """A write intent with no target → injected resolver fills the current-week
    folder, so the turn dispatches instead of asking '哪一周?'."""
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="weekly_plan", action="write", confidence=0.9)],
    )
    fn, _ = _fixed(draft)

    def _resolver(target: TargetRef | None) -> TargetRef | None:
        return TargetRef(kind="week", folder="2026-06-22_06-28(W8)")

    out = resolve(
        "把周三改轻松跑",
        registry=_registry(),
        draft_fn=fn,
        target_resolver=_resolver,
    )
    assert out.ambiguity is None
    assert out.active_target == TargetRef(kind="week", folder="2026-06-22_06-28(W8)")
    assert out.resolved_from == "resolved"


def test_target_resolver_returning_none_still_clarifies() -> None:
    """If the resolver can't find a current week, fall back to a target clarify."""
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="weekly_plan", action="write", confidence=0.9)],
    )
    fn, _ = _fixed(draft)
    out = resolve(
        "帮我改一下",
        registry=_registry(),
        draft_fn=fn,
        target_resolver=lambda _t: None,
    )
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "target"


def test_target_resolver_not_called_for_read_intent() -> None:
    """Reads default to most-recent; the resolver must not fire for them."""
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
    )
    fn, _ = _fixed(draft)
    calls: list[TargetRef | None] = []

    def _resolver(target: TargetRef | None) -> TargetRef | None:
        calls.append(target)
        return TargetRef(kind="week", folder="x")

    out = resolve("我最近状态如何", registry=_registry(), draft_fn=fn, target_resolver=_resolver)
    assert calls == []
    assert out.ambiguity is None
    assert out.active_target is None


def test_target_resolver_skipped_when_target_already_concrete() -> None:
    """A write that already has a folder (anaphora / prior turn) skips the resolver."""
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="weekly_plan", action="write", confidence=0.9)],
    )
    fn, _ = _fixed(draft)
    calls: list[TargetRef | None] = []

    def _resolver(target: TargetRef | None) -> TargetRef | None:
        calls.append(target)
        return None

    out = resolve(
        "把周三改轻松跑",
        registry=_registry(),
        draft_fn=fn,
        prior_target=TargetRef(kind="week", folder="2026-W26"),
        target_resolver=_resolver,
    )
    assert calls == []
    assert out.ambiguity is None
    assert out.active_target == TargetRef(kind="week", folder="2026-W26")


def test_prompt_role_split_is_hard_invariant() -> None:
    """System = persona + Card catalog (no utterance); User = utterance (no catalog)."""
    draft = ResolverDraft(intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)])
    fn, captured = _fixed(draft)
    utterance = "我最近状态如何且这是一句很独特的话XYZ"
    resolve(
        utterance,
        registry=_registry(),
        draft_fn=fn,
        conversation_window=[Turn(role="user", content="昨天我跑了10公里")],
    )
    system, user = captured["system"], captured["user"]
    # Card catalog lives in system, not user.
    assert "status_insight" in system
    assert "weekly_plan" in system
    assert "status_insight" not in user
    # This turn's utterance lives in user, not system (cache-stable system).
    assert utterance in user
    assert utterance not in system
    assert "昨天我跑了10公里" in user


def test_resolver_prompt_distinguishes_reading_from_editing_plans() -> None:
    system = resolver.build_resolver_system_prompt(_registry())

    assert "询问、查看、总结或解释" in system
    assert "只有明确要求调整、生成、重排" in system
    assert "我当前的总体训练计划是什么？" in system
    assert "不要仅凭句子出现" in system


def test_card_catalog_renders_ids_and_descriptions() -> None:
    catalog = resolver.render_card_catalog(_registry())
    assert "id: status_insight" in catalog
    assert "action: read" in catalog
    assert "回答训练状态" in catalog
    assert "id: weekly_plan" in catalog
    assert "action: write" in catalog
