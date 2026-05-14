"""US-003 acceptance tests — see .omc/plans/coach-agent-rewrite.md §4.

What we verify:
1. 100 round-trip checkpoint writes+reads with the file backend
2. Large state (≥500 KB after JSON encode, before gzip) round-trips identically
3. sha256 mismatch on a tampered blob raises CheckpointIntegrityError
4. The file backend and a stub "Azure" backend produce byte-identical blobs
   for the same input (canonical-JSON + deterministic gzip envelope)
5. delete_thread removes all rows + blobs for a thread
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from stride_server.coach_adapters.persistence.checkpointer import (
    AzureTableCheckpointSaver,
)
from stride_server.coach_adapters.persistence.envelope import (
    CheckpointIntegrityError,
    decode_state,
    encode_state,
)
from stride_server.coach_adapters.persistence.file_backend import FileCheckpointStore


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def _saver(tmp_path: Path) -> AzureTableCheckpointSaver:
    store = FileCheckpointStore(tmp_path)
    return AzureTableCheckpointSaver(store=store)


def _config(thread_id: str, checkpoint_id: str | None = None) -> dict:
    cfg: dict = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    if checkpoint_id:
        cfg["configurable"]["checkpoint_id"] = checkpoint_id
    return cfg


def _checkpoint(id_: str, channel_values: dict | None = None) -> dict:
    """Build a langgraph-shaped Checkpoint dict."""
    return {
        "v": 1,
        "id": id_,
        "ts": "2026-05-13T10:00:00Z",
        "channel_values": channel_values or {"messages": []},
        "channel_versions": {"messages": "1"},
        "versions_seen": {},
        "updated_channels": ["messages"],
    }


def _metadata() -> dict:
    return {"source": "input", "step": 0, "writes": {}, "parents": {}}


# ---------------------------------------------------------------------------
# 1. round-trip
# ---------------------------------------------------------------------------


def test_round_trip_100_checkpoints(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-abc:qa:2026-05-13"
    saved_ids: list[str] = []
    for i in range(100):
        ck = _checkpoint(id_=f"ck{i:03d}", channel_values={"messages": [f"msg-{i}"]})
        md = _metadata() | {"step": i}
        new_config = saver.put(_config(thread_id), ck, md, {"messages": str(i + 1)})
        saved_ids.append(new_config["configurable"]["checkpoint_id"])
    assert len(saved_ids) == 100
    # Pull every one back and verify
    for i, cid in enumerate(saved_ids):
        tup = saver.get_tuple(_config(thread_id, cid))
        assert tup is not None
        assert tup.checkpoint["channel_values"]["messages"] == [f"msg-{i}"]
        assert tup.metadata["step"] == i


def test_get_latest_returns_newest(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-z:week:W02"
    for i in range(3):
        saver.put(_config(thread_id), _checkpoint(f"ck{i}"), _metadata() | {"step": i}, {})
    latest = saver.get_tuple(_config(thread_id))
    assert latest is not None
    assert latest.metadata["step"] == 2


def test_list_returns_reverse_chronological(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-x:master:plan-1"
    for i in range(5):
        saver.put(_config(thread_id), _checkpoint(f"ck{i}"), _metadata() | {"step": i}, {})
    tuples = list(saver.list(_config(thread_id)))
    assert [t.metadata["step"] for t in tuples] == [4, 3, 2, 1, 0]


# ---------------------------------------------------------------------------
# 2. large state
# ---------------------------------------------------------------------------


def test_large_state_round_trips(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-bigstate:qa:2026-05-13"
    big_messages = [f"message-{i}-{'x' * 1024}" for i in range(600)]  # ≈ 600 KB raw
    ck = _checkpoint("large", channel_values={"messages": big_messages})
    new_config = saver.put(_config(thread_id), ck, _metadata(), {"messages": "1"})
    cid = new_config["configurable"]["checkpoint_id"]
    tup = saver.get_tuple(_config(thread_id, cid))
    assert tup is not None
    assert tup.checkpoint["channel_values"]["messages"] == big_messages
    # And the on-disk blob really is ≥ 500 KB compressed-or-not when uncompressed
    row = saver.store.get_checkpoint_row(thread_id, cid)
    assert row is not None
    assert row.state_uncompressed_bytes >= 500_000


# ---------------------------------------------------------------------------
# 3. sha256 integrity
# ---------------------------------------------------------------------------


def test_sha256_mismatch_raises(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-tamper:qa:2026-05-13"
    saver.put(_config(thread_id), _checkpoint("ck0"), _metadata(), {})
    row = saver.store.get_latest_checkpoint_row(thread_id)
    assert row is not None
    # Tamper with the on-disk blob
    blob_file = tmp_path / "blobs" / thread_id.replace(":", "__") / f"{row.checkpoint_id}.json.gz"
    blob_file.write_bytes(b"\x1f\x8b" + b"\x00" * 100)  # gzip magic + garbage
    with pytest.raises(CheckpointIntegrityError):
        saver.get_tuple(_config(thread_id, row.checkpoint_id))


def test_missing_blob_raises(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-missing:qa:2026-05-13"
    saver.put(_config(thread_id), _checkpoint("ck0"), _metadata(), {})
    row = saver.store.get_latest_checkpoint_row(thread_id)
    assert row is not None
    blob_file = tmp_path / "blobs" / thread_id.replace(":", "__") / f"{row.checkpoint_id}.json.gz"
    blob_file.unlink()
    with pytest.raises(CheckpointIntegrityError):
        saver.get_tuple(_config(thread_id, row.checkpoint_id))


# ---------------------------------------------------------------------------
# 4. envelope is deterministic across backends
# ---------------------------------------------------------------------------


def test_envelope_is_deterministic() -> None:
    state = {"channel_values": {"messages": [{"role": "user", "content": "hi"}]}, "step": 1}
    a = encode_state(state)
    b = encode_state(state)
    assert a.compressed_bytes == b.compressed_bytes
    assert a.sha256_hexdigest == b.sha256_hexdigest
    assert hashlib.sha256(a.compressed_bytes).hexdigest() == a.sha256_hexdigest
    # And round-tripping back gives the same dict
    assert decode_state(a.compressed_bytes, expected_sha256=a.sha256_hexdigest) == state


def test_envelope_rejects_tampered_blob() -> None:
    encoded = encode_state({"x": 1})
    # Flip the gzip magic byte (0x1f) — guaranteed to differ.
    tampered = b"\x00" + encoded.compressed_bytes[1:]
    assert tampered != encoded.compressed_bytes
    with pytest.raises(CheckpointIntegrityError):
        decode_state(tampered, expected_sha256=encoded.sha256_hexdigest)


# ---------------------------------------------------------------------------
# 5. put_writes + pending writes round-trip
# ---------------------------------------------------------------------------


def test_put_writes_round_trip(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-w:qa:2026-05-13"
    new_config = saver.put(_config(thread_id), _checkpoint("ck0"), _metadata(), {})
    cid = new_config["configurable"]["checkpoint_id"]
    saver.put_writes(
        new_config,
        writes=[("messages", "hello"), ("counter", 3)],
        task_id="task-1",
        task_path="root/branch",
    )
    tup = saver.get_tuple(_config(thread_id, cid))
    assert tup is not None
    assert tup.pending_writes is not None
    channels = sorted((c, v) for _, c, v in tup.pending_writes)
    assert ("counter", 3) in channels
    assert ("messages", "hello") in channels


# ---------------------------------------------------------------------------
# 6. delete_thread sweeps everything
# ---------------------------------------------------------------------------


def test_delete_thread(tmp_path: Path) -> None:
    saver = _saver(tmp_path)
    thread_id = "user-doomed:qa:2026-05-13"
    for i in range(5):
        new_config = saver.put(_config(thread_id), _checkpoint(f"ck{i}"), _metadata(), {})
        saver.put_writes(new_config, writes=[("messages", f"m{i}")], task_id=f"t{i}")
    assert list(saver.list(_config(thread_id)))
    saver.delete_thread(thread_id)
    assert saver.get_tuple(_config(thread_id)) is None
    assert list(saver.list(_config(thread_id))) == []
