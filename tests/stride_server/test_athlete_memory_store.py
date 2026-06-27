"""Phase B — AthleteMemoryStore (file backend) + contracts."""

from __future__ import annotations

from pathlib import Path

from coach.contracts import AthleteMemory, MemoryWrite
from stride_server.athlete_memory_store import (
    AthleteMemoryStore,
    backend_from_config,
)


def _store(tmp_path: Path) -> AthleteMemoryStore:
    return AthleteMemoryStore(backend_from_config(data_dir=tmp_path))


def _mem(mid: str, **kw) -> AthleteMemory:
    base = dict(id=mid, kind="life_event", content=f"fact {mid}")
    base.update(kw)
    return AthleteMemory(**base)


def test_contract_roundtrip() -> None:
    m = _mem("m1", affects=["training_load", "pace_target"], salience=0.9, evidence="搬昆明了")
    assert AthleteMemory.model_validate(m.model_dump()) == m
    w = MemoryWrite(op="add", memory=m, confidence=0.8)
    assert MemoryWrite.model_validate(w.model_dump()).op == "add"


def test_upsert_and_list(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert("u1", _mem("m1"))
    store.upsert("u1", _mem("m2"))
    ids = {m.id for m in store.list_all("u1")}
    assert ids == {"m1", "m2"}


def test_upsert_replaces_same_id(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert("u1", _mem("m1", content="old"))
    store.upsert("u1", _mem("m1", content="new"))
    all_m = store.list_all("u1")
    assert len(all_m) == 1 and all_m[0].content == "new"


def test_fetch_active_filters_and_orders_by_salience(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert("u1", _mem("low", salience=0.2))
    store.upsert("u1", _mem("high", salience=0.95))
    store.upsert("u1", _mem("resolved", salience=0.99, status="resolved"))
    active = store.fetch_active("u1")
    assert [m.id for m in active] == ["high", "low"]  # resolved excluded, salience desc


def test_fetch_active_top_k(tmp_path: Path) -> None:
    store = _store(tmp_path)
    for i in range(5):
        store.upsert("u1", _mem(f"m{i}", salience=i / 10))
    assert len(store.fetch_active("u1", top_k=2)) == 2


def test_resolve_marks_resolved(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert("u1", _mem("m1", kind="injury", status="active"))
    assert store.resolve("u1", "m1") is True
    assert store.fetch_active("u1") == []
    assert store.resolve("u1", "missing") is False


def test_affects_list_survives_roundtrip(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert("u1", _mem("m1", affects=["training_load", "session_type"]))
    assert store.list_all("u1")[0].affects == ["training_load", "session_type"]


def test_user_isolation(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.upsert("u1", _mem("m1"))
    assert store.list_all("u2") == []
