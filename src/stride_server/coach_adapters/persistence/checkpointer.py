"""AzureTableCheckpointSaver — langgraph BaseCheckpointSaver subclass that
persists state through a :class:`CheckpointStore` (file or Azure backend).

The langgraph ``Checkpoint`` and ``CheckpointMetadata`` payloads are passed
through the langgraph ``SerializerProtocol`` to produce ``(type, bytes)``
tuples, which we package as base64-encoded JSON and run through the
:mod:`envelope` (gzip + sha256) before handing to the store.

This gives us:
1. one blob per checkpoint, integrity-verified on every read
2. byte-identical blobs across file and Azure backends for the same state
3. the langgraph public interface (put / get_tuple / list / put_writes)
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
    PendingWrite,
    SerializerProtocol,
)

from stride_server.config.models import CoachPersistenceConfig

from .envelope import (
    CheckpointIntegrityError,
    decode_state,
    encode_state,
)
from .file_backend import FileCheckpointStore
from .store import CheckpointRow, CheckpointStore, CheckpointWrite, make_checkpoint_id


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


def _config_thread_id(config: RunnableConfig) -> str:
    configurable = config.get("configurable", {}) if config else {}
    thread_id = configurable.get("thread_id")
    if not thread_id:
        raise ValueError("RunnableConfig.configurable.thread_id is required")
    return str(thread_id)


def _config_checkpoint_ns(config: RunnableConfig) -> str:
    return str((config.get("configurable", {}) if config else {}).get("checkpoint_ns", ""))


def _config_checkpoint_id(config: RunnableConfig) -> str | None:
    cid = (config.get("configurable", {}) if config else {}).get("checkpoint_id")
    return str(cid) if cid else None


class AzureTableCheckpointSaver(BaseCheckpointSaver):
    """LangGraph-compatible checkpointer backed by a pluggable
    :class:`CheckpointStore` (Azure Table + Blob in prod, JSON file in dev).
    """

    def __init__(
        self,
        store: CheckpointStore,
        *,
        serde: SerializerProtocol | None = None,
    ) -> None:
        super().__init__(serde=serde)
        self._store = store

    # ------------------------------------------------------------------
    # factories
    # ------------------------------------------------------------------

    @classmethod
    def from_env(cls, *, serde: SerializerProtocol | None = None) -> AzureTableCheckpointSaver:
        """Build the saver from env vars.

        If ``STRIDE_COACH_TABLE_ACCOUNT_URL`` is set we wire up the Azure
        backend; otherwise we fall back to a JSON-file backend under
        ``data/_coach_dev/checkpoints/`` so developer machines run without
        any Azure creds.
        """
        from stride_server.config import load_server_config

        return cls.from_config(load_server_config().coach_persistence, serde=serde)

    @classmethod
    def from_config(
        cls,
        config: CoachPersistenceConfig,
        *,
        serde: SerializerProtocol | None = None,
    ) -> AzureTableCheckpointSaver:
        if config.table_account_url:
            from .azure_backend import AzureCheckpointStore

            store: CheckpointStore = AzureCheckpointStore.from_config(config)
        else:
            store = FileCheckpointStore(Path(config.file_backend_dir) / "checkpoints")
        return cls(store=store, serde=serde)

    @property
    def store(self) -> CheckpointStore:
        return self._store

    # ------------------------------------------------------------------
    # serialization helpers
    # ------------------------------------------------------------------

    def _encode_checkpoint(
        self, checkpoint: Checkpoint, metadata: CheckpointMetadata
    ) -> tuple[dict, bytes, str, int]:
        """Return ``(state_dict, blob_bytes, sha256, uncompressed_len)``.

        ``state_dict`` is a JSON-friendly representation that includes the
        langgraph type tags so :meth:`_decode_checkpoint` can reconstruct
        the original ``Checkpoint``/``CheckpointMetadata`` via the serde.
        """
        ck_type, ck_bytes = self.serde.dumps_typed(checkpoint)
        md_type, md_bytes = self.serde.dumps_typed(metadata)
        state_dict: dict[str, Any] = {
            "schema": "coach.checkpoint/v1",
            "checkpoint": {"type": ck_type, "data_b64": _b64(ck_bytes)},
            "metadata": {"type": md_type, "data_b64": _b64(md_bytes)},
        }
        encoded = encode_state(state_dict)
        return (
            state_dict,
            encoded.compressed_bytes,
            encoded.sha256_hexdigest,
            encoded.uncompressed_bytes,
        )

    def _decode_checkpoint(
        self, blob_bytes: bytes, *, expected_sha256: str
    ) -> tuple[Checkpoint, CheckpointMetadata]:
        state_dict = decode_state(blob_bytes, expected_sha256=expected_sha256)
        if state_dict.get("schema") != "coach.checkpoint/v1":
            raise CheckpointIntegrityError(
                f"Unrecognised checkpoint schema {state_dict.get('schema')!r}"
            )
        ck = state_dict["checkpoint"]
        md = state_dict["metadata"]
        checkpoint = self.serde.loads_typed((ck["type"], _unb64(ck["data_b64"])))
        metadata = self.serde.loads_typed((md["type"], _unb64(md["data_b64"])))
        return checkpoint, metadata  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # BaseCheckpointSaver interface
    # ------------------------------------------------------------------

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        thread_id = _config_thread_id(config)
        checkpoint_ns = _config_checkpoint_ns(config)
        parent_checkpoint_id = _config_checkpoint_id(config)

        checkpoint_id = checkpoint.get("id") or make_checkpoint_id()

        _, blob_bytes, sha, uncompressed = self._encode_checkpoint(checkpoint, metadata)
        blob_path = f"{thread_id}/{checkpoint_id}.json.gz"
        # metadata_json is a small, indexable subset of CheckpointMetadata.
        # We keep the full metadata inside the blob (typed) and only mirror a
        # JSON-safe view in the Table row for queries.
        metadata_view = {
            "source": metadata.get("source"),
            "step": metadata.get("step"),
            "writes_keys": sorted((metadata.get("writes") or {}).keys()) if isinstance(metadata.get("writes"), dict) else None,
            "parents": metadata.get("parents", {}),
            "checkpoint_ns": checkpoint_ns,
            "new_versions": new_versions,
        }
        row = CheckpointRow(
            thread_id=thread_id,
            checkpoint_id=checkpoint_id,
            parent_checkpoint_id=parent_checkpoint_id,
            blob_path=blob_path,
            blob_sha256=sha,
            blob_size_bytes=len(blob_bytes),
            state_uncompressed_bytes=uncompressed,
            metadata_json=json.dumps(metadata_view, ensure_ascii=False, default=str, sort_keys=True),
            created_at=_now_iso(),
        )
        self._store.put_checkpoint(row, blob_bytes)
        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": checkpoint_ns,
                "checkpoint_id": checkpoint_id,
            }
        }

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        thread_id = _config_thread_id(config)
        checkpoint_id = _config_checkpoint_id(config)
        if not checkpoint_id:
            raise ValueError("put_writes requires checkpoint_id in config.configurable")
        now = _now_iso()
        for idx, (channel, value) in enumerate(writes):
            v_type, v_bytes = self.serde.dumps_typed(value)
            payload = {"type": v_type, "data_b64": _b64(v_bytes)}
            self._store.put_write(
                CheckpointWrite(
                    thread_id=thread_id,
                    checkpoint_id=checkpoint_id,
                    task_id=task_id,
                    task_path=task_path,
                    write_idx=idx,
                    channel=channel,
                    value_json=json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    created_at=now,
                )
            )

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        thread_id = _config_thread_id(config)
        checkpoint_ns = _config_checkpoint_ns(config)
        requested_id = _config_checkpoint_id(config)
        if requested_id is None:
            row = self._store.get_latest_checkpoint_row(thread_id)
        else:
            row = self._store.get_checkpoint_row(thread_id, requested_id)
        if row is None:
            return None
        blob_bytes = self._store.get_blob(row.blob_path)
        if blob_bytes is None:
            raise CheckpointIntegrityError(
                f"Table row {row.checkpoint_id} references missing blob {row.blob_path!r}"
            )
        checkpoint, metadata = self._decode_checkpoint(
            blob_bytes, expected_sha256=row.blob_sha256
        )
        cfg: RunnableConfig = {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": checkpoint_ns,
                "checkpoint_id": row.checkpoint_id,
            }
        }
        parent_cfg: RunnableConfig | None = None
        if row.parent_checkpoint_id:
            parent_cfg = {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": row.parent_checkpoint_id,
                }
            }
        pending = self._load_pending_writes(thread_id, row.checkpoint_id)
        return CheckpointTuple(
            config=cfg,
            checkpoint=checkpoint,
            metadata=metadata,
            parent_config=parent_cfg,
            pending_writes=pending,
        )

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        if config is None:
            raise ValueError("list() requires a RunnableConfig with thread_id")
        thread_id = _config_thread_id(config)
        checkpoint_ns = _config_checkpoint_ns(config)
        before_id = _config_checkpoint_id(before) if before else None
        rows = self._store.list_checkpoint_rows(
            thread_id, before_checkpoint_id=before_id, limit=limit
        )
        for row in rows:
            blob_bytes = self._store.get_blob(row.blob_path)
            if blob_bytes is None:
                continue
            checkpoint, metadata = self._decode_checkpoint(
                blob_bytes, expected_sha256=row.blob_sha256
            )
            cfg: RunnableConfig = {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": row.checkpoint_id,
                }
            }
            parent_cfg: RunnableConfig | None = None
            if row.parent_checkpoint_id:
                parent_cfg = {
                    "configurable": {
                        "thread_id": thread_id,
                        "checkpoint_ns": checkpoint_ns,
                        "checkpoint_id": row.parent_checkpoint_id,
                    }
                }
            pending = self._load_pending_writes(thread_id, row.checkpoint_id)
            yield CheckpointTuple(
                config=cfg,
                checkpoint=checkpoint,
                metadata=metadata,
                parent_config=parent_cfg,
                pending_writes=pending,
            )

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _load_pending_writes(
        self, thread_id: str, checkpoint_id: str
    ) -> list[PendingWrite]:
        writes = self._store.list_writes(thread_id, checkpoint_id)
        out: list[PendingWrite] = []
        for w in writes:
            payload = json.loads(w.value_json)
            value = self.serde.loads_typed((payload["type"], _unb64(payload["data_b64"])))
            out.append((w.task_id, w.channel, value))
        return out

    def delete_thread(self, thread_id: str) -> None:  # type: ignore[override]
        self._store.delete_thread(thread_id)
