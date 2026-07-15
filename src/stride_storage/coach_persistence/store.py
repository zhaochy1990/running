"""CheckpointStore Protocol + helpers — see plan §4.1.

A ``CheckpointStore`` is the low-level key-value layer the
``AzureTableCheckpointSaver`` (and its file backend twin) sit on top of.
Both backends implement the same Protocol so the BaseCheckpointSaver
subclass can stay agnostic of the actual storage.

Schema (one entity per checkpoint):
    PartitionKey = thread_id
    RowKey       = checkpoint_id  (zero-padded sortable, see _make_checkpoint_id)
    parent_checkpoint_id
    blob_path                     = f"{thread_id}/{checkpoint_id}.json.gz"
    blob_sha256
    blob_size_bytes
    state_uncompressed_bytes
    metadata_json                 = small dict (≤ 30 KB)
    created_at                    = UTC ISO-8601
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


def path_safe(s: str) -> str:
    """Make any storage key safe for use as a filesystem path component.

    Our keys contain delimiters that are illegal in Windows path names:
    ``:`` (thread_id segment separator), ``|`` (composite partition key),
    and ``/`` ``\\`` (general path separators). Replacing them with
    underscores keeps round-trip uniqueness because the replacement
    strings (``__`` / ``___``) never appear in our key formats.
    """
    return (
        s.replace(":", "__")
        .replace("/", "_")
        .replace("\\", "_")
        .replace("|", "___")
    )


def make_checkpoint_id(*, monotonic_ns: int | None = None) -> str:
    """Generate a zero-padded checkpoint id whose lexical order is identical
    to its temporal order. Uses nanoseconds since epoch widened to 20 digits."""
    ns = monotonic_ns if monotonic_ns is not None else time.time_ns()
    return f"{ns:020d}"


@dataclass(frozen=True)
class CheckpointRow:
    """In-memory representation of one ``stridecoachcheckpoints`` Table row.

    The full state lives in the blob at ``blob_path``; this row carries only
    the metadata fields described in plan §4.1.
    """

    thread_id: str
    checkpoint_id: str
    parent_checkpoint_id: str | None
    blob_path: str
    blob_sha256: str
    blob_size_bytes: int
    state_uncompressed_bytes: int
    metadata_json: str
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "PartitionKey": self.thread_id,
            "RowKey": self.checkpoint_id,
            "parent_checkpoint_id": self.parent_checkpoint_id,
            "blob_path": self.blob_path,
            "blob_sha256": self.blob_sha256,
            "blob_size_bytes": self.blob_size_bytes,
            "state_uncompressed_bytes": self.state_uncompressed_bytes,
            "metadata_json": self.metadata_json,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CheckpointRow:
        return cls(
            thread_id=d["PartitionKey"],
            checkpoint_id=d["RowKey"],
            parent_checkpoint_id=d.get("parent_checkpoint_id"),
            blob_path=d["blob_path"],
            blob_sha256=d["blob_sha256"],
            blob_size_bytes=int(d["blob_size_bytes"]),
            state_uncompressed_bytes=int(d["state_uncompressed_bytes"]),
            metadata_json=d.get("metadata_json", "{}"),
            created_at=d["created_at"],
        )


@dataclass(frozen=True)
class CheckpointWrite:
    """One pending write item from the BaseCheckpointSaver.put_writes call."""

    thread_id: str
    checkpoint_id: str
    task_id: str
    task_path: str
    write_idx: int
    channel: str
    value_json: str
    created_at: str


@runtime_checkable
class CheckpointStore(Protocol):
    """Low-level CRUD interface implemented by file and Azure backends."""

    def put_checkpoint(self, row: CheckpointRow, blob_bytes: bytes) -> None: ...

    def get_checkpoint_row(self, thread_id: str, checkpoint_id: str) -> CheckpointRow | None: ...

    def get_blob(self, blob_path: str) -> bytes | None: ...

    def get_latest_checkpoint_row(self, thread_id: str) -> CheckpointRow | None: ...

    def list_checkpoint_rows(
        self,
        thread_id: str,
        *,
        before_checkpoint_id: str | None = None,
        limit: int | None = None,
    ) -> list[CheckpointRow]: ...

    def list_latest_checkpoint_rows(
        self,
        thread_id_prefix: str,
        *,
        limit: int | None = None,
    ) -> list[CheckpointRow]:
        """List the newest checkpoint for each thread matching a prefix."""
        ...

    def put_write(self, write: CheckpointWrite) -> None: ...

    def list_writes(self, thread_id: str, checkpoint_id: str) -> list[CheckpointWrite]: ...

    def delete_thread(self, thread_id: str) -> int:
        """Remove every checkpoint row, blob, and write for one thread.

        Returns the number of checkpoint rows removed. Used both by the
        coach API ``DELETE /threads/{thread_id}`` path (when we add it) and
        by the user-deletion sweep in plan §11.4."""
        ...
