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

from pydantic import BaseModel, Field

from coach.contracts import AthleteMemory, MemoryWrite
from .structured_tool import StructuredToolRunner

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


def should_extract(user_text: str) -> bool:
    """Deterministic pre-filter on the **user turn only**.

    Gating on the user utterance (not the coach reply) is load-bearing: the
    coach's answer routinely restates detector output (current altitude, today's
    HRV), and gating on it made the Writer persist the relocation *before* the
    user confirmed it. A lasting fact enters memory only when the athlete says it.
    """
    return any(kw in user_text for kw in _MEMORY_KEYWORDS)


def _format_active_with_ids(active: list[AthleteMemory]) -> str:
    """Render active memories *with ids* so the extractor can target updates."""
    if not active:
        return "（暂无）"
    return "\n".join(f"- id={m.id} [{m.kind}] {m.content}" for m in active)


def build_extraction_prompts(
    conversation_text: str, active: list[AthleteMemory]
) -> tuple[str, str]:
    """System (cache-stable rules/schema) + user (active facts + this turn).

    The active memories are handed to the model so it can emit ``op=update``
    against a real id instead of re-``add``-ing a near-duplicate every turn.
    """
    system = (
        "你从一段跑步教练对话里抽取**值得长期记住的运动员事实**：伤病、身体/生活约束、"
        "偏好、目标、生活变化(如迁居/换训练环境)、装备。\n"
        "硬性规则：\n"
        "1. 只抽**用户本人陈述或明确确认**的事实。教练**推断或工具检测**出来的内容"
        "（当前海拔、今天的 HRV/静息心率/负荷数值等）**不要**抽——那些每轮实时读取，不是长期记忆。\n"
        "2. 只抽**持久**事实，不抽一次性闲聊；当下数值（今日 HRV、今日负荷）一律不记。\n"
        "3. 若某条与下面【已知长期事实】里的某条是**同一件事**，用 op=update 并复用它的 id 修订；"
        "只有全新事实才用 op=add；已恢复/不再成立的用 op=resolve（带该条 id）。\n"
        "4. **不要自己编造 id**：op=add 一律把 id 留空；op=update/resolve 必须用【已知长期事实】里给出的真实 id。\n"
        "每条给 op、kind、规范化 content、affects(影响哪些规划维度，如 training_load/pace_target/"
        "session_type)、evidence(用户原话)、salience(0-1，伤病/重大生活变化给高)。没有可记的就返回空 writes。不要编造。"
    )
    user = (
        f"# 已知长期事实\n{_format_active_with_ids(active)}\n\n"
        f"# 本轮对话\n{conversation_text}\n\n抽取 writes（无则空）。"
    )
    return system, user


def make_llm_memory_extractor(model: object) -> MemoryExtractFn:
    """Wrap a cheap chat model into a structured ``MemoryExtraction`` extractor."""
    structured = StructuredToolRunner(model, MemoryExtraction)

    def _extract(system_prompt: str, user_prompt: str) -> MemoryExtraction:
        try:
            result = structured.invoke(system_prompt, user_prompt)
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
    """Drop ``add`` writes that duplicate an existing active memory (§4.5).

    A deterministic backstop only — the real dedup is the LLM choosing
    ``op=update`` when it's shown the active set. The containment check is
    **kind-agnostic** on purpose: the same fact gets re-tagged across kinds
    (altitude as both ``life_event`` and ``constraint``), so keying on kind
    alone let cross-kind duplicates through.

    Containment is **one-directional**: drop the new fact only when it's a
    *substring* of an existing one (it adds no information). The reverse —
    a new fact that *contains* an existing one (``右膝盖痛，落地加重`` over
    ``膝盖痛``) — is more specific, so it's kept rather than silently lost;
    the ideal path is an LLM ``op=update``, but losing the detail is worse
    than a near-duplicate.
    """
    active_keys = {(m.kind, _norm(m.content)) for m in active}
    out: list[MemoryWrite] = []
    for w in writes:
        if w.op == "add":
            key = (w.memory.kind, _norm(w.memory.content))
            wc = _norm(w.memory.content)
            if key in active_keys or any(wc in _norm(m.content) for m in active):
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
    """Assign id/timestamps deterministically — the LLM never controls them.

    ``add`` **always** gets a fresh server id + ``created_at`` (the LLM emits
    invented ids like ``injury-001`` and hallucinated years; never trust them).
    ``update``/``resolve`` keep their (caller-validated) id and only bump
    ``updated_at``.
    """
    mem = write.memory
    updates: dict[str, object] = {"updated_at": now, "source_session": session_id}
    if write.op == "add":
        updates["id"] = uuid.uuid4().hex
        updates["created_at"] = now
    return write.model_copy(update={"memory": mem.model_copy(update=updates)})


def _reconcile_ids(
    writes: list[MemoryWrite], active_ids: set[str]
) -> list[MemoryWrite]:
    """Validate update/resolve targets against the active set.

    The LLM is told to reuse real ids, but it still invents them. An ``update``
    on an unknown id is a brand-new fact → downgrade to ``add``; a ``resolve`` on
    an unknown id has nothing to resolve → drop it.
    """
    out: list[MemoryWrite] = []
    for w in writes:
        if w.op == "resolve" and w.memory.id not in active_ids:
            continue
        if w.op == "update" and w.memory.id not in active_ids:
            w = w.model_copy(update={"op": "add"})
        out.append(w)
    return out


def write_memories(
    store: MemoryStore,
    extract_fn: MemoryExtractFn,
    *,
    user_id: str,
    session_id: str,
    user_text: str,
    conversation_text: str,
    active: list[AthleteMemory],
    now: str,
) -> tuple[list[MemoryWrite], str]:
    """Pre-filter → extract → reconcile → dedup → persist → receipt (⑤).

    ``user_text`` gates the pre-filter (a lasting fact must come from the
    athlete, not the coach's restated detector output). ``conversation_text``
    (user + coach) is the extractor's context. Returns the applied writes + the
    receipt suffix; persistence failures are swallowed (logged) so a store
    outage never breaks the turn.
    """
    if not should_extract(user_text):
        return [], ""
    system, user = build_extraction_prompts(conversation_text, active)
    extraction = extract_fn(system, user)
    reconciled = _reconcile_ids(extraction.writes, {m.id for m in active})
    fresh = dedup_merge(reconciled, active)
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
