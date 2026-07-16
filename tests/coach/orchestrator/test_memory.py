"""Phase C — Memory Load + Writer logic (pure)."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from coach.contracts import AthleteMemory, MemoryWrite
from coach.orchestrator.memory import (
    MemoryExtraction,
    build_extraction_prompts,
    dedup_merge,
    format_memory_context,
    load_active_memories,
    make_llm_memory_extractor,
    memory_receipt,
    should_extract,
    write_memories,
)


class FakeStore:
    def __init__(self) -> None:
        self.mems: dict[str, dict[str, AthleteMemory]] = {}

    def fetch_active(self, user_id: str, *, top_k: int = 10) -> list[AthleteMemory]:
        ms = [m for m in self.mems.get(user_id, {}).values() if m.status == "active"]
        ms.sort(key=lambda m: m.salience, reverse=True)
        return ms[:top_k]

    def upsert(self, user_id: str, memory: AthleteMemory) -> AthleteMemory:
        self.mems.setdefault(user_id, {})[memory.id] = memory
        return memory

    def resolve(self, user_id: str, memory_id: str) -> bool:
        m = self.mems.get(user_id, {}).get(memory_id)
        if m and m.status != "resolved":
            self.mems[user_id][memory_id] = m.model_copy(update={"status": "resolved"})
            return True
        return False


def test_memory_extractor_uses_portable_schema_tool() -> None:
    captured: dict[str, object] = {}

    class _Structured:
        def invoke(self, _messages):
            return AIMessage(
                content="",
                tool_calls=[{
                    "name": "MemoryExtraction",
                    "args": {"writes": []},
                    "id": "call-1",
                    "type": "tool_call",
                }],
            )

    class _Model:
        def bind_tools(self, schemas, **kwargs):
            captured.update(schemas=schemas, kwargs=kwargs)
            return _Structured()

    extractor = make_llm_memory_extractor(_Model())

    extractor("sys", "user")

    assert captured["schemas"] == [MemoryExtraction]
    assert captured["kwargs"] == {"parallel_tool_calls": False}


def test_should_extract_prefilter():
    assert should_extract("对，我搬到昆明了") is True
    assert should_extract("我跟腱有点痛") is True
    assert should_extract("我的目标是破三") is True
    assert should_extract("今天天气不错跑得挺爽") is False
    # The gate is the *user* turn — a bare status question holds no lasting fact,
    # even though the coach's reply will mention 海拔/HRV (over-extraction guard).
    assert should_extract("我最近练得怎么样？状态如何？") is False


def test_format_memory_context():
    assert format_memory_context([]) == ""
    ctx = format_memory_context(
        [AthleteMemory(id="m1", kind="injury", content="右跟腱不适", affects=["training_load"])]
    )
    assert "右跟腱不适" in ctx and "training_load" in ctx


def test_dedup_drops_duplicate_add():
    active = [AthleteMemory(id="m1", kind="injury", content="右跟腱不适")]
    writes = [MemoryWrite(op="add", memory=AthleteMemory(id="", kind="injury", content="右跟腱不适"))]
    assert dedup_merge(writes, active) == []


def test_dedup_keeps_new_fact():
    active = [AthleteMemory(id="m1", kind="injury", content="右跟腱不适")]
    w = MemoryWrite(op="add", memory=AthleteMemory(id="", kind="life_event", content="迁居昆明"))
    assert dedup_merge([w], active) == [w]


def test_dedup_keeps_more_specific_superstring_fact():
    """A new fact that *contains* an existing one is more specific → keep it.

    Regression: bidirectional containment dropped ``右膝盖痛，落地加重`` because
    the active ``膝盖痛`` was a substring of it — silently losing the detail.
    """
    active = [AthleteMemory(id="m1", kind="injury", content="膝盖痛")]
    w = MemoryWrite(op="add", memory=AthleteMemory(id="", kind="injury", content="右膝盖痛，跑步落地时加重"))
    assert dedup_merge([w], active) == [w]


def test_dedup_drops_less_specific_substring_fact():
    """A new fact that is a *substring* of an existing one adds nothing → drop."""
    active = [AthleteMemory(id="m1", kind="injury", content="右膝盖痛，跑步落地时加重")]
    w = MemoryWrite(op="add", memory=AthleteMemory(id="", kind="injury", content="膝盖痛"))
    assert dedup_merge([w], active) == []


def test_memory_receipt():
    w = MemoryWrite(op="add", memory=AthleteMemory(id="x", kind="life_event", content="迁居昆明~1900m"))
    receipt = memory_receipt([w])
    assert "已记住" in receipt and "迁居昆明" in receipt
    assert memory_receipt([]) == ""


def test_write_memories_persists_assigns_id_and_receipt():
    store = FakeStore()

    def extract(_s, _u):
        return MemoryExtraction(
            writes=[
                MemoryWrite(
                    op="add",
                    memory=AthleteMemory(id="", kind="life_event", content="现迁昆明高原训练~1900m"),
                )
            ]
        )

    applied, receipt = write_memories(
        store,
        extract,
        user_id="u1",
        session_id="s1",
        user_text="对，我搬昆明了",
        conversation_text="用户：对，我搬昆明了\n教练：好的",
        active=[],
        now="2026-06-27T00:00:00Z",
    )
    assert len(applied) == 1
    assert applied[0].memory.id  # uuid assigned deterministically
    assert applied[0].memory.created_at == "2026-06-27T00:00:00Z"
    assert store.fetch_active("u1")[0].content.startswith("现迁昆明")
    assert "已记住" in receipt


def test_write_memories_skips_extractor_when_prefilter_misses():
    store = FakeStore()
    calls = {"n": 0}

    def extract(_s, _u):
        calls["n"] += 1
        return MemoryExtraction(writes=[])

    applied, receipt = write_memories(
        store, extract, user_id="u1", session_id="s1",
        user_text="今天天气不错", conversation_text="今天天气不错", active=[], now="t",
    )
    assert applied == [] and receipt == "" and calls["n"] == 0


def test_write_memories_gates_on_user_text_not_coach_reply():
    """A status question must NOT extract, even if the coach reply mentions 海拔/HRV.

    Regression for the over-extraction bug: the pre-filter ran on
    ``用户：…\\n教练：…`` so the detector's own altitude/HRV output got persisted
    as a confirmed fact before the user ever confirmed it.
    """
    store = FakeStore()
    calls = {"n": 0}

    def extract(_s, _u):
        calls["n"] += 1
        return MemoryExtraction(
            writes=[MemoryWrite(op="add", memory=AthleteMemory(id="", kind="life_event", content="迁居昆明"))]
        )

    applied, receipt = write_memories(
        store,
        extract,
        user_id="u1",
        session_id="s1",
        user_text="我最近练得怎么样？状态如何？",
        conversation_text="用户：我最近练得怎么样？\n教练：你当前在约1900m中等海拔，HRV偏低…",
        active=[],
        now="t",
    )
    assert applied == [] and receipt == "" and calls["n"] == 0
    assert store.fetch_active("u1") == []


def test_write_memories_strips_llm_invented_id_and_date():
    """``add`` always gets a server id + ``now`` — never the LLM's invented id/date.

    Regression: the LLM emitted ``id='injury-001'`` and ``created_at='2024-…'``;
    ``_finalize`` only reassigned when ``not mem.id``, so the garbage survived.
    """
    store = FakeStore()

    def extract(_s, _u):
        return MemoryExtraction(
            writes=[
                MemoryWrite(
                    op="add",
                    memory=AthleteMemory(
                        id="injury-001", kind="life_event",
                        content="迁居昆明~1900m", created_at="2024-06-27T00:00:00Z",
                    ),
                )
            ]
        )

    applied, _ = write_memories(
        store, extract, user_id="u1", session_id="s1",
        user_text="我搬昆明了", conversation_text="用户：我搬昆明了", active=[],
        now="2026-06-27T00:00:00Z",
    )
    assert applied[0].memory.id != "injury-001"
    assert applied[0].memory.created_at == "2026-06-27T00:00:00Z"


def test_update_with_unknown_id_becomes_add():
    """An ``update`` whose id isn't an active memory is a hallucination → new add."""
    store = FakeStore()

    def extract(_s, _u):
        return MemoryExtraction(
            writes=[
                MemoryWrite(
                    op="update",
                    memory=AthleteMemory(id="ghost-id", kind="goal", content="目标破三"),
                )
            ]
        )

    applied, _ = write_memories(
        store, extract, user_id="u1", session_id="s1",
        user_text="我的目标是破三", conversation_text="用户：我的目标是破三",
        active=[], now="t",
    )
    assert len(applied) == 1
    assert applied[0].op == "add"
    assert applied[0].memory.id != "ghost-id"


def test_resolve_with_unknown_id_dropped():
    """A ``resolve`` targeting a non-existent memory is dropped (nothing to resolve)."""
    store = FakeStore()

    def extract(_s, _u):
        return MemoryExtraction(
            writes=[
                MemoryWrite(
                    op="resolve",
                    memory=AthleteMemory(id="ghost-id", kind="injury", content="跟腱已好"),
                )
            ]
        )

    applied, receipt = write_memories(
        store, extract, user_id="u1", session_id="s1",
        user_text="跟腱已经不痛了", conversation_text="用户：跟腱已经不痛了",
        active=[], now="t",
    )
    assert applied == [] and receipt == ""


def test_extraction_prompt_exposes_active_ids_for_update():
    """The extractor must see active memories + their ids so it can update, not re-add."""
    active = [AthleteMemory(id="mem-kunming", kind="life_event", content="迁居昆明~1900m")]
    system, user = build_extraction_prompts("用户：我还在昆明", active)
    assert "mem-kunming" in user  # the id is visible for op=update
    assert "迁居昆明" in user
    assert "update" in system  # the instruction to reuse ids exists


def test_load_active_memories():
    store = FakeStore()
    store.upsert("u1", AthleteMemory(id="m1", kind="injury", content="右跟腱不适", salience=0.9))
    mems, ctx = load_active_memories(store, "u1")
    assert len(mems) == 1 and "右跟腱不适" in ctx
