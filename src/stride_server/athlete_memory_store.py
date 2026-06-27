"""Athlete long-term memory store — two-backend (dev JSON / prod Azure Table).

Mirrors the ``likes_store.py`` pattern (CLAUDE.md storage rule: user-spoken facts
are forbidden in coros.db). PartitionKey=user_id, RowKey=memory_id. List fields
(``affects``) are JSON-encoded for Azure Table, which has no list columns.

Backend selection: a non-empty Azure Table account URL → Azure; else a local
JSON file under the data dir. Auth via ``DefaultAzureCredential`` (same chain as
likes_store / the coach LLMs).
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Protocol

from coach.contracts import AthleteMemory

_MEMORY_FILE = ".athlete_memories.json"
_TABLE_NAME = "strideathletememories"
_LIST_FIELDS = ("affects",)


class _Backend(Protocol):
    def upsert(self, user_id: str, memory: dict[str, Any]) -> None: ...
    def list_for_user(self, user_id: str) -> list[dict[str, Any]]: ...
    def delete(self, user_id: str, memory_id: str) -> None: ...


# ---------------------------------------------------------------------------
# Dev: JSON file
# ---------------------------------------------------------------------------


class _FileBackend:
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


class _AzureTableBackend:
    def __init__(self, account_url: str, table_name: str = _TABLE_NAME) -> None:
        self._account_url = account_url
        self._table_name = table_name
        self._client: Any = None
        self._lock = threading.Lock()

    def _table(self) -> Any:
        if self._client is None:
            with self._lock:
                if self._client is None:
                    from azure.data.tables import TableServiceClient
                    from azure.identity import DefaultAzureCredential

                    svc = TableServiceClient(
                        endpoint=self._account_url, credential=DefaultAzureCredential()
                    )
                    svc.create_table_if_not_exists(self._table_name)
                    self._client = svc.get_table_client(self._table_name)
        return self._client

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
        out = {k: v for k, v in entity.items() if k not in ("PartitionKey", "RowKey", "etag", "Timestamp")}
        for f in _LIST_FIELDS:
            if isinstance(out.get(f), str):
                try:
                    out[f] = json.loads(out[f])
                except Exception:  # noqa: BLE001
                    out[f] = []
        return out

    def upsert(self, user_id: str, memory: dict[str, Any]) -> None:
        self._table().upsert_entity(self._to_entity(user_id, memory))

    def list_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._table().query_entities(f"PartitionKey eq '{user_id}'")
        return [self._from_entity(dict(r)) for r in rows]

    def delete(self, user_id: str, memory_id: str) -> None:
        try:
            self._table().delete_entity(partition_key=user_id, row_key=memory_id)
        except Exception:  # noqa: BLE001 — already gone
            pass


def backend_from_config(table_account_url: str = "", *, data_dir: Path | None = None) -> _Backend:
    """Azure Table when an account URL is set, else a local JSON file."""
    if table_account_url:
        return _AzureTableBackend(table_account_url)
    from stride_core.db import USER_DATA_DIR

    root = data_dir or USER_DATA_DIR
    return _FileBackend(Path(root) / _MEMORY_FILE)


# ---------------------------------------------------------------------------
# Public store
# ---------------------------------------------------------------------------


class AthleteMemoryStore:
    """Typed facade over a backend; (de)serialises :class:`AthleteMemory`."""

    def __init__(self, backend: _Backend) -> None:
        self._backend = backend

    def upsert(self, user_id: str, memory: AthleteMemory) -> AthleteMemory:
        self._backend.upsert(user_id, memory.model_dump())
        return memory

    def list_all(self, user_id: str) -> list[AthleteMemory]:
        return [AthleteMemory.model_validate(d) for d in self._backend.list_for_user(user_id)]

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
