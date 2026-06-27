"""Phase C — Memory Load + Writer logic (pure)."""

from __future__ import annotations

from coach.contracts import AthleteMemory, MemoryWrite
from coach.orchestrator.memory import (
    MemoryExtraction,
    dedup_merge,
    format_memory_context,
    load_active_memories,
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


def test_should_extract_prefilter():
    assert should_extract("对，我搬到昆明了") is True
    assert should_extract("我跟腱有点痛") is True
    assert should_extract("我的目标是破三") is True
    assert should_extract("今天天气不错跑得挺爽") is False


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
        conversation_text="对，我搬昆明了",
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
        conversation_text="今天天气不错", active=[], now="t",
    )
    assert applied == [] and receipt == "" and calls["n"] == 0


def test_load_active_memories():
    store = FakeStore()
    store.upsert("u1", AthleteMemory(id="m1", kind="injury", content="右跟腱不适", salience=0.9))
    mems, ctx = load_active_memories(store, "u1")
    assert len(mems) == 1 and "右跟腱不适" in ctx
