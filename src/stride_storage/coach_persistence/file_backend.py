"""Filesystem-backed CheckpointStore for local dev + tests.

Mirrors the Azure-backed schema exactly so unit tests can prove dual-backend
byte equivalence (plan §4.1 dual-backend contract).

Layout under ``base_dir``:
    {base_dir}/
        rows/{thread_id}/{checkpoint_id}.json    — Table-equivalent metadata
        blobs/{thread_id}/{checkpoint_id}.json.gz — full state envelope
        writes/{thread_id}/{checkpoint_id}/{task_id}-{write_idx}.json
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from .store import CheckpointRow, CheckpointStore, CheckpointWrite, path_safe


class FileCheckpointStore(CheckpointStore):
    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)
        (self._base / "rows").mkdir(parents=True, exist_ok=True)
        (self._base / "blobs").mkdir(parents=True, exist_ok=True)
        (self._base / "writes").mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # checkpoints
    # ------------------------------------------------------------------

    def _row_path(self, thread_id: str, checkpoint_id: str) -> Path:
        return self._base / "rows" / path_safe(thread_id) / f"{checkpoint_id}.json"

    def _blob_path_for(self, thread_id: str, checkpoint_id: str) -> str:
        return f"{thread_id}/{checkpoint_id}.json.gz"

    def _blob_file(self, blob_path: str) -> Path:
        # blob_path is `{thread_id}/{checkpoint_id}.json.gz`; map directly under blobs/
        parts = blob_path.split("/", 1)
        if len(parts) != 2:
            raise ValueError(f"invalid blob_path {blob_path!r}")
        return self._base / "blobs" / path_safe(parts[0]) / parts[1]

    def put_checkpoint(self, row: CheckpointRow, blob_bytes: bytes) -> None:
        blob_file = self._blob_file(row.blob_path)
        blob_file.parent.mkdir(parents=True, exist_ok=True)
        # atomic-ish: write to .tmp then rename
        tmp = blob_file.with_suffix(blob_file.suffix + ".tmp")
        tmp.write_bytes(blob_bytes)
        os.replace(tmp, blob_file)

        row_file = self._row_path(row.thread_id, row.checkpoint_id)
        row_file.parent.mkdir(parents=True, exist_ok=True)
        row_tmp = row_file.with_suffix(row_file.suffix + ".tmp")
        row_tmp.write_text(json.dumps(row.to_dict(), ensure_ascii=False, sort_keys=True))
        os.replace(row_tmp, row_file)

    def get_checkpoint_row(self, thread_id: str, checkpoint_id: str) -> CheckpointRow | None:
        f = self._row_path(thread_id, checkpoint_id)
        if not f.exists():
            return None
        return CheckpointRow.from_dict(json.loads(f.read_text()))

    def get_blob(self, blob_path: str) -> bytes | None:
        f = self._blob_file(blob_path)
        if not f.exists():
            return None
        return f.read_bytes()

    def get_latest_checkpoint_row(self, thread_id: str) -> CheckpointRow | None:
        thread_dir = self._base / "rows" / path_safe(thread_id)
        if not thread_dir.exists():
            return None
        # RowKey is zero-padded so lexical max == newest
        files = sorted(thread_dir.glob("*.json"), reverse=True)
        if not files:
            return None
        return CheckpointRow.from_dict(json.loads(files[0].read_text()))

    def list_checkpoint_rows(
        self,
        thread_id: str,
        *,
        before_checkpoint_id: str | None = None,
        limit: int | None = None,
    ) -> list[CheckpointRow]:
        thread_dir = self._base / "rows" / path_safe(thread_id)
        if not thread_dir.exists():
            return []
        files = sorted(thread_dir.glob("*.json"), reverse=True)
        rows: list[CheckpointRow] = []
        for f in files:
            row = CheckpointRow.from_dict(json.loads(f.read_text()))
            if before_checkpoint_id is not None and row.checkpoint_id >= before_checkpoint_id:
                continue
            rows.append(row)
            if limit is not None and len(rows) >= limit:
                break
        return rows

    def list_latest_checkpoint_rows(
        self,
        thread_id_prefix: str,
        *,
        limit: int | None = None,
    ) -> list[CheckpointRow]:
        rows_dir = self._base / "rows"
        latest: list[CheckpointRow] = []
        for thread_dir in rows_dir.iterdir():
            if not thread_dir.is_dir():
                continue
            files = sorted(thread_dir.glob("*.json"), reverse=True)
            if not files:
                continue
            row = CheckpointRow.from_dict(json.loads(files[0].read_text()))
            if row.thread_id.startswith(thread_id_prefix):
                latest.append(row)
        latest.sort(
            key=lambda row: (row.created_at, row.checkpoint_id),
            reverse=True,
        )
        return latest[:limit] if limit is not None else latest

    # ------------------------------------------------------------------
    # pending writes
    # ------------------------------------------------------------------

    def _writes_dir(self, thread_id: str, checkpoint_id: str) -> Path:
        return self._base / "writes" / path_safe(thread_id) / checkpoint_id

    def put_write(self, write: CheckpointWrite) -> None:
        d = self._writes_dir(write.thread_id, write.checkpoint_id)
        d.mkdir(parents=True, exist_ok=True)
        # Filename collisions across (task_id, write_idx) overwrite by design
        # (matches BaseCheckpointSaver.put_writes idempotent contract).
        fname = f"{path_safe(write.task_id)}-{write.write_idx:08d}.json"
        (d / fname).write_text(
            json.dumps(
                {
                    "thread_id": write.thread_id,
                    "checkpoint_id": write.checkpoint_id,
                    "task_id": write.task_id,
                    "task_path": write.task_path,
                    "write_idx": write.write_idx,
                    "channel": write.channel,
                    "value_json": write.value_json,
                    "created_at": write.created_at,
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )

    def list_writes(self, thread_id: str, checkpoint_id: str) -> list[CheckpointWrite]:
        d = self._writes_dir(thread_id, checkpoint_id)
        if not d.exists():
            return []
        out: list[CheckpointWrite] = []
        for f in sorted(d.glob("*.json")):
            data = json.loads(f.read_text())
            out.append(CheckpointWrite(**data))
        return out

    # ------------------------------------------------------------------
    # delete (used by user-deletion sweep + tests)
    # ------------------------------------------------------------------

    def delete_thread(self, thread_id: str) -> int:
        deleted = 0
        for subdir in ("rows", "blobs", "writes"):
            d = self._base / subdir / path_safe(thread_id)
            if d.exists():
                if subdir == "rows":
                    deleted = sum(1 for _ in d.glob("*.json"))
                shutil.rmtree(d)
        return deleted

