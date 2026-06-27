"""Memory Load (⓪) + Memory Writer (⑤) — long-term athlete memory (§4.0, §4.5).

Pure core: the store and the extraction LLM are injected (Protocol + callable),
so the logic is unit-testable without infra and the ``coach.*`` import boundary
stays intact. The adapter supplies a concrete ``AthleteMemoryStore`` and a cheap
orchestrator-LLM extractor.

Load: fetch active memories (salience-ranked) → format a user-prompt context
block injected into the Resolver + the specialist task. Writer: a deterministic
keyword pre-filter (skip the LLM on most turns) → structured extraction → dedup
vs active → persist (best-effort) → a transparent receipt appended to the reply.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import Protocol

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from coach.contracts import AthleteMemory, MemoryWrite

logger = logging.getLogger(__name__)


class MemoryStore(Protocol):
    """Structural type satisfied by the adapter's ``AthleteMemoryStore``."""

    def fetch_active(self, user_id: str, *, top_k: int = 10) -> list[AthleteMemory]: ...
    def upsert(self, user_id: str, memory: AthleteMemory) -> AthleteMemory: ...
    def resolve(self, user_id: str, memory_id: str) -> bool: ...


# (system_prompt, user_prompt) -> structured extraction
MemoryExtractFn = Callable[[str, str], "MemoryExtraction"]

# Deterministic pre-filter: terms that *might* signal a persistent fact. Cheap;
# a miss skips the extraction LLM entirely (most turns).
_MEMORY_KEYWORDS = (
    "伤", "痛", "受伤", "拉伤", "跟腱", "膝", "足底", "髂胫束", "骨折", "扭", "酸",
    "搬", "迁", "移居", "海拔", "高原", "换城市", "出差", "旅居",
    "不能", "只能", "没法", "医生说", "怀孕", "手术", "过敏", "禁忌",
    "喜欢", "讨厌", "偏好", "习惯", "目标", "想跑", "报名", "比赛", "赛",
    "鞋", "碳板", "装备",
)


class MemoryExtraction(BaseModel):
    """Structured LLM output for the Memory Writer."""

    writes: list[MemoryWrite] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Memory Load (⓪)
# ---------------------------------------------------------------------------


def format_memory_context(memories: list[AthleteMemory]) -> str:
    """Render active memories as a user-prompt block (per-athlete → user turn)."""
    if not memories:
        return ""
    lines = ["# 已知长期事实（伤病 / 约束 / 偏好 / 目标 / 生活变化）"]
    for m in memories:
        affects = f"（影响：{', '.join(m.affects)}）" if m.affects else ""
        lines.append(f"- [{m.kind}] {m.content}{affects}")
    return "\n".join(lines)


def load_active_memories(
    store: MemoryStore, user_id: str, *, top_k: int = 5
) -> tuple[list[AthleteMemory], str]:
    """Fetch active memories + a formatted context block (⓪)."""
    memories = store.fetch_active(user_id, top_k=top_k)
    return memories, format_memory_context(memories)


# ---------------------------------------------------------------------------
# Memory Writer (⑤)
# ---------------------------------------------------------------------------


def should_extract(text: str) -> bool:
    """Deterministic pre-filter: does this turn *plausibly* hold a lasting fact?"""
    return any(kw in text for kw in _MEMORY_KEYWORDS)


def build_extraction_prompts(conversation_text: str) -> tuple[str, str]:
    """System (cache-stable rules/schema) + user (this turn's text)."""
    system = (
        "你从一段跑步教练对话里抽取**值得长期记住的运动员事实**：伤病、身体/生活约束、"
        "偏好、目标、生活变化(如迁居/换训练环境)、装备。只抽**持久**事实，不抽一次性闲聊或"
        "当下数值。每条给 op(add/update/resolve)、kind、规范化的 content、affects(影响哪些规划"
        "维度，如 training_load/pace_target/session_type)、evidence(原话)、salience(0-1，伤病/"
        "重大生活变化给高)。没有可记的就返回空 writes。不要编造。"
    )
    user = f"# 本轮对话\n{conversation_text}\n\n抽取 writes（无则空）。"
    return system, user


def make_llm_memory_extractor(model: object) -> MemoryExtractFn:
    """Wrap a cheap chat model into a structured ``MemoryExtraction`` extractor."""
    structured = model.with_structured_output(MemoryExtraction)  # type: ignore[attr-defined]

    def _extract(system_prompt: str, user_prompt: str) -> MemoryExtraction:
        try:
            result = structured.invoke(
                [SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)]
            )
            if isinstance(result, MemoryExtraction):
                return result
            return MemoryExtraction.model_validate(result)
        except Exception:  # noqa: BLE001 — extraction is best-effort, never breaks the turn
            logger.warning("memory extraction failed; skipping", exc_info=True)
            return MemoryExtraction(writes=[])

    return _extract


def _norm(text: str) -> str:
    return "".join(text.split()).lower()


def dedup_merge(writes: list[MemoryWrite], active: list[AthleteMemory]) -> list[MemoryWrite]:
    """Drop ``add`` writes that duplicate an existing active memory (§4.5)."""
    active_keys = {(m.kind, _norm(m.content)) for m in active}
    out: list[MemoryWrite] = []
    for w in writes:
        if w.op == "add":
            key = (w.memory.kind, _norm(w.memory.content))
            if key in active_keys or any(
                _norm(w.memory.content) in _norm(m.content) or _norm(m.content) in _norm(w.memory.content)
                for m in active
                if m.kind == w.memory.kind
            ):
                continue
            active_keys.add(key)
        out.append(w)
    return out


def memory_receipt(writes: list[MemoryWrite]) -> str:
    """Deterministic receipt suffix for added/updated memories (§4.5)."""
    recorded = [w.memory.content for w in writes if w.op in ("add", "update")]
    if not recorded:
        return ""
    return "\n\n（已记住：" + "；".join(recorded) + "，后续计划会据此调整。）"


def _finalize(write: MemoryWrite, *, session_id: str, now: str) -> MemoryWrite:
    """Assign id/timestamps deterministically (the LLM must not invent ids)."""
    mem = write.memory
    updates: dict[str, object] = {"updated_at": now, "source_session": session_id}
    if write.op == "add" and not mem.id:
        updates["id"] = uuid.uuid4().hex
        updates["created_at"] = now
    return write.model_copy(update={"memory": mem.model_copy(update=updates)})


def write_memories(
    store: MemoryStore,
    extract_fn: MemoryExtractFn,
    *,
    user_id: str,
    session_id: str,
    conversation_text: str,
    active: list[AthleteMemory],
    now: str,
) -> tuple[list[MemoryWrite], str]:
    """Pre-filter → extract → dedup → persist (best-effort) → receipt (⑤).

    Returns the applied writes + the receipt suffix. Persistence failures are
    swallowed (logged) so a store outage never breaks the turn.
    """
    if not should_extract(conversation_text):
        return [], ""
    system, user = build_extraction_prompts(conversation_text)
    extraction = extract_fn(system, user)
    fresh = dedup_merge(extraction.writes, active)
    applied: list[MemoryWrite] = []
    for w in fresh:
        final = _finalize(w, session_id=session_id, now=now)
        try:
            if final.op == "resolve":
                store.resolve(user_id, final.memory.id)
            else:
                store.upsert(user_id, final.memory)
            applied.append(final)
        except Exception:  # noqa: BLE001 — best-effort persist
            logger.warning("memory persist failed for %s", final.memory.id, exc_info=True)
    return applied, memory_receipt(applied)
