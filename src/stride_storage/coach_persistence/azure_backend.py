"""Azure Table + Blob-backed CheckpointStore — see plan §4.1 / §4.2.

Reads/writes one entity per checkpoint in ``stridecoachcheckpoints`` and one
blob per checkpoint in container ``coach-checkpoints``. Pending writes go in
a sibling Azure Table (``{checkpoints_table}_writes``) keyed by
``thread_id|checkpoint_id`` partition.

The Azure SDK is imported lazily so unit tests on the file backend don't
need azure-data-tables / azure-storage-blob installed.
"""

from __future__ import annotations

from typing import Any

from stride_storage.interfaces.config import CoachPersistenceConfig

from .store import CheckpointRow, CheckpointStore, CheckpointWrite


class AzureCheckpointStore(CheckpointStore):
    def __init__(
        self,
        *,
        table_account_url: str,
        checkpoints_table_name: str,
        writes_table_name: str,
        blob_account_url: str,
        blob_container_name: str,
        credential: Any | None = None,
    ) -> None:
        self._table_account_url = table_account_url
        self._checkpoints_table_name = checkpoints_table_name
        self._writes_table_name = writes_table_name
        self._blob_account_url = blob_account_url
        self._blob_container_name = blob_container_name
        self._credential = credential or _default_credential()
        self._init_clients()

    @classmethod
    def from_config(cls, config: CoachPersistenceConfig) -> AzureCheckpointStore:
        return cls(
            table_account_url=config.table_account_url,
            checkpoints_table_name=config.checkpoints_table_name,
            writes_table_name=config.checkpoint_writes_table_name,
            blob_account_url=config.blob_account_url,
            blob_container_name=config.blob_container,
        )

    def _init_clients(self) -> None:
        # Lazy import: don't drag the SDK into the import graph when unused.
        from azure.data.tables import TableServiceClient
        from azure.storage.blob import BlobServiceClient

        table_service = TableServiceClient(
            endpoint=self._table_account_url, credential=self._credential
        )
        self._checkpoints_table = table_service.create_table_if_not_exists(
            self._checkpoints_table_name
        )
        self._writes_table = table_service.create_table_if_not_exists(
            self._writes_table_name
        )
        blob_service = BlobServiceClient(
            account_url=self._blob_account_url, credential=self._credential
        )
        self._blob_container = blob_service.get_container_client(self._blob_container_name)
        try:
            self._blob_container.create_container()
        except Exception:  # noqa: BLE001 — already exists is fine
            pass

    # ------------------------------------------------------------------
    # checkpoints
    # ------------------------------------------------------------------

    def put_checkpoint(self, row: CheckpointRow, blob_bytes: bytes) -> None:
        # Blob first — if Table write fails after a Blob success the orphan
        # blob is harmless; the inverse would leave a Table row pointing at a
        # missing blob (which the read path treats as a hard integrity error).
        self._blob_container.upload_blob(
            name=row.blob_path, data=blob_bytes, overwrite=True
        )
        self._checkpoints_table.upsert_entity(row.to_dict())

    def get_checkpoint_row(self, thread_id: str, checkpoint_id: str) -> CheckpointRow | None:
        try:
            entity = self._checkpoints_table.get_entity(thread_id, checkpoint_id)
        except Exception:  # noqa: BLE001 — ResourceNotFoundError or other
            return None
        return CheckpointRow.from_dict(dict(entity))

    def get_blob(self, blob_path: str) -> bytes | None:
        try:
            return self._blob_container.download_blob(blob_path).readall()
        except Exception:  # noqa: BLE001
            return None

    def get_latest_checkpoint_row(self, thread_id: str) -> CheckpointRow | None:
        # RowKey is zero-padded → max RowKey == newest. Azure Table query is
        # cheap enough for one PartitionKey lookup; no need to maintain an
        # auxiliary "latest" pointer.
        rows = list(
            self._checkpoints_table.query_entities(
                f"PartitionKey eq '{_q(thread_id)}'"
            )
        )
        if not rows:
            return None
        rows.sort(key=lambda r: r["RowKey"], reverse=True)
        return CheckpointRow.from_dict(dict(rows[0]))

    def list_checkpoint_rows(
        self,
        thread_id: str,
        *,
        before_checkpoint_id: str | None = None,
        limit: int | None = None,
    ) -> list[CheckpointRow]:
        f = f"PartitionKey eq '{_q(thread_id)}'"
        if before_checkpoint_id is not None:
            f += f" and RowKey lt '{_q(before_checkpoint_id)}'"
        results = list(self._checkpoints_table.query_entities(f))
        results.sort(key=lambda r: r["RowKey"], reverse=True)
        if limit is not None:
            results = results[:limit]
        return [CheckpointRow.from_dict(dict(r)) for r in results]

    # ------------------------------------------------------------------
    # pending writes
    # ------------------------------------------------------------------

    def put_write(self, write: CheckpointWrite) -> None:
        entity = {
            "PartitionKey": f"{write.thread_id}|{write.checkpoint_id}",
            "RowKey": f"{write.task_id}|{write.write_idx:08d}",
            "task_id": write.task_id,
            "task_path": write.task_path,
            "write_idx": write.write_idx,
            "channel": write.channel,
            "value_json": write.value_json,
            "created_at": write.created_at,
        }
        self._writes_table.upsert_entity(entity)

    def list_writes(self, thread_id: str, checkpoint_id: str) -> list[CheckpointWrite]:
        partition = f"{thread_id}|{checkpoint_id}"
        results = list(
            self._writes_table.query_entities(f"PartitionKey eq '{_q(partition)}'")
        )
        return [
            CheckpointWrite(
                thread_id=thread_id,
                checkpoint_id=checkpoint_id,
                task_id=r["task_id"],
                task_path=r.get("task_path", ""),
                write_idx=int(r["write_idx"]),
                channel=r["channel"],
                value_json=r["value_json"],
                created_at=r["created_at"],
            )
            for r in results
        ]

    # ------------------------------------------------------------------
    # delete (user-deletion sweep)
    # ------------------------------------------------------------------

    def delete_thread(self, thread_id: str) -> int:
        deleted = 0
        # 1. checkpoint rows
        rows = list(
            self._checkpoints_table.query_entities(
                f"PartitionKey eq '{_q(thread_id)}'"
            )
        )
        for row in rows:
            try:
                self._checkpoints_table.delete_entity(thread_id, row["RowKey"])
                # 2. matching blob
                blob_path = row.get("blob_path") or f"{thread_id}/{row['RowKey']}.json.gz"
                try:
                    self._blob_container.delete_blob(blob_path)
                except Exception:  # noqa: BLE001 — already gone
                    pass
                deleted += 1
            except Exception:  # noqa: BLE001
                pass
        # 3. pending writes — partition pattern thread_id|*
        write_rows = list(
            self._writes_table.query_entities(
                # ``}`` (0x7D) is the byte immediately after ``|`` (0x7C) in
                # ASCII; ``;`` (0x3B) is LESS than ``|`` and silently matches
                # nothing. Keep this fence post correct or sweeps drop rows.
                f"PartitionKey ge '{_q(thread_id)}|' and PartitionKey lt '{_q(thread_id)}}}'"
            )
        )
        for r in write_rows:
            try:
                self._writes_table.delete_entity(r["PartitionKey"], r["RowKey"])
            except Exception:  # noqa: BLE001
                pass
        return deleted


def _q(s: str) -> str:
    """Single-quote escape for Azure Table OData filter literals."""
    return s.replace("'", "''")


def _default_credential() -> Any:
    """Shared, cached credential — only constructed when a real Azure backend
    is wired up, so tests on the file backend don't need azure-identity."""
    from stride_storage.azure.credentials import get_credential

    return get_credential()
