"""Athlete long-term memory store — backends + typed facade.

Two-backend (dev JSON / prod Azure Table). PartitionKey=user_id,
RowKey=memory_id. List fields (``affects``) are JSON-encoded for Azure Table
(no list columns). CLAUDE.md storage rule: user-spoken facts are forbidden in
coros.db, so they live here.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from coach.contracts import AthleteMemory
from stride_storage.azure.backend_select import choose_backend
from stride_storage.azure.table_backend import AzureTableConnection
from stride_storage.interfaces.athlete_memory import AthleteMemoryBackend

_MEMORY_FILE = ".athlete_memories.json"
_TABLE_NAME = "strideathletememories"
_LIST_FIELDS = ("affects",)


# ---------------------------------------------------------------------------
# Dev: JSON file
# ---------------------------------------------------------------------------


class FileAthleteMemoryBackend:
    """`{user_id: {memory_id: memory_dict}}` in one JSON file; thread-safe."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict[str, Any]]:
        if not self._path.exists():
            return {}
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — corrupt/empty file → start fresh
            return {}

    def _write(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)

    def upsert(self, user_id: str, memory: dict[str, Any]) -> None:
        with self._lock:
            data = self._read()
            data.setdefault(user_id, {})[memory["id"]] = memory
            self._write(data)

    def list_for_user(self, user_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._read().get(user_id, {}).values())

    def delete(self, user_id: str, memory_id: str) -> None:
        with self._lock:
            data = self._read()
            data.get(user_id, {}).pop(memory_id, None)
            self._write(data)


# ---------------------------------------------------------------------------
# Prod: Azure Table
# ---------------------------------------------------------------------------


class AzureTableAthleteMemoryBackend:
    def __init__(self, account_url: str, table_name: str = _TABLE_NAME) -> None:
        self._conn = AzureTableConnection(account_url, table_name)

    @staticmethod
    def _to_entity(user_id: str, memory: dict[str, Any]) -> dict[str, Any]:
        entity = dict(memory)
        entity["PartitionKey"] = user_id
        entity["RowKey"] = memory["id"]
        for f in _LIST_FIELDS:
            entity[f] = json.dumps(entity.get(f) or [], ensure_ascii=False)
        return entity

    @staticmethod
    def _from_entity(entity: dict[str, Any]) -> dict[str, Any]:
        out = {
            k: v
            for k, v in entity.items()
            if k not in ("PartitionKey", "RowKey", "etag", "Timestamp")
        }
        for f in _LIST_FIELDS:
            if isinstance(out.get(f), str):
                try:
                    out[f] = json.loads(out[f])
                except Exception:  # noqa: BLE001
                    out[f] = []
        return out

    def upsert(self, user_id: str, memory: dict[str, Any]) -> None:
        self._conn.table().upsert_entity(self._to_entity(user_id, memory))

    def list_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._conn.table().query_entities(
            "PartitionKey eq @pk", parameters={"pk": user_id},
        )
        return [self._from_entity(dict(r)) for r in rows]

    def delete(self, user_id: str, memory_id: str) -> None:
        try:
            self._conn.table().delete_entity(partition_key=user_id, row_key=memory_id)
        except Exception:  # noqa: BLE001 — already gone
            pass


def backend_from_config(
    table_account_url: str = "", *, data_dir: Path | None = None,
) -> AthleteMemoryBackend:
    """Azure Table when an account URL is set, else a local JSON file."""

    def _azure() -> AthleteMemoryBackend:
        return AzureTableAthleteMemoryBackend(table_account_url)

    def _file() -> AthleteMemoryBackend:
        from stride_core.db import USER_DATA_DIR

        root = data_dir or USER_DATA_DIR
        return FileAthleteMemoryBackend(Path(root) / _MEMORY_FILE)

    return choose_backend(table_account_url, azure_factory=_azure, file_factory=_file)


# ---------------------------------------------------------------------------
# Public store
# ---------------------------------------------------------------------------


class AthleteMemoryStore:
    """Typed facade over a backend; (de)serialises :class:`AthleteMemory`."""

    def __init__(self, backend: AthleteMemoryBackend) -> None:
        self._backend = backend

    def upsert(self, user_id: str, memory: AthleteMemory) -> AthleteMemory:
        self._backend.upsert(user_id, memory.model_dump())
        return memory

    def list_all(self, user_id: str) -> list[AthleteMemory]:
        return [
            AthleteMemory.model_validate(d)
            for d in self._backend.list_for_user(user_id)
        ]

    def fetch_active(self, user_id: str, *, top_k: int = 10) -> list[AthleteMemory]:
        """Active memories, highest-salience first, capped at ``top_k`` (§4.0)."""
        active = [m for m in self.list_all(user_id) if m.status == "active"]
        active.sort(key=lambda m: m.salience, reverse=True)
        return active[:top_k]

    def resolve(self, user_id: str, memory_id: str) -> bool:
        for m in self.list_all(user_id):
            if m.id == memory_id and m.status != "resolved":
                self.upsert(user_id, m.model_copy(update={"status": "resolved"}))
                return True
        return False
