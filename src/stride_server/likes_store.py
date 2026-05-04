"""Like storage backend for team activity likes.

Likes are intentionally **NOT** stored in the per-user SQLite databases — they
are cross-user social signals, sit naturally in a key-value store, and the
dominant access pattern is "list all rows for one activity" which maps to a
single Azure Table partition scan.

Schema (single Azure Table named ``stridelikes`` by default):

    PartitionKey = "act:{owner_user_id}:{label_id}"
    RowKey       = "{liker_user_id}"
    Properties:
        liker_display_name: str  (snapshot at write time)
        created_at: ISO-8601 UTC string
        team_id: str             (audit + future per-team scoping)

Env vars:
    STRIDE_LIKES_TABLE_ACCOUNT_URL  e.g. https://authstorage2026.table.core.windows.net
    STRIDE_LIKES_TABLE_NAME         default ``stridelikes``

If ``STRIDE_LIKES_TABLE_ACCOUNT_URL`` is unset, falls back to a JSON file at
``data/.likes.json`` so unit tests + offline dev work without Azure.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from stride_core import db as core_db

logger = logging.getLogger(__name__)

ACCOUNT_URL_ENV = "STRIDE_LIKES_TABLE_ACCOUNT_URL"
TABLE_NAME_ENV = "STRIDE_LIKES_TABLE_NAME"
DEFAULT_TABLE_NAME = "stridelikes"

# Path-traversal / injection guards — caller-supplied IDs go directly into Azure
# Table keys and JSON file paths, so they must be tightly validated.
_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_LABEL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not _UUID4_RE.match(user_id):
        raise ValueError(f"invalid user_id: {user_id!r}")
    return user_id


def _validate_label_id(label_id: str) -> str:
    if not isinstance(label_id, str) or not _LABEL_ID_RE.match(label_id):
        raise ValueError(f"invalid label_id: {label_id!r}")
    return label_id


_TEAM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_team_id(team_id: str) -> str:
    if not isinstance(team_id, str) or not _TEAM_ID_RE.match(team_id):
        raise ValueError(f"invalid team_id: {team_id!r}")
    return team_id


def like_partition(team_id: str, owner_user_id: str, label_id: str) -> str:
    """Compose the Azure Table PartitionKey for an activity within a team.

    Likes are scoped per (team, activity) so the same activity can have
    distinct like counts in two different teams that share the owner. This
    avoids cross-team leakage when a user is in multiple teams that contain
    the same activity owner.
    """
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_label_id(label_id)
    return f"act:{team_id}:{owner_user_id}:{label_id}"


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LikeEntity:
    team_id: str
    owner_user_id: str
    label_id: str
    liker_user_id: str
    liker_display_name: str
    created_at: str


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------


class _Backend:
    """Common interface implemented by file + Azure backends."""

    def put(self, entity: LikeEntity) -> None: ...
    def delete(
        self, team_id: str, owner_user_id: str, label_id: str, liker_user_id: str,
    ) -> bool: ...
    def list_for_activity(
        self, team_id: str, owner_user_id: str, label_id: str,
    ) -> list[LikeEntity]: ...
    def list_bulk(
        self, team_id: str, targets: list[tuple[str, str]],
    ) -> dict[tuple[str, str], list[LikeEntity]]: ...


# ---------------------------------------------------------------------------
# File backend (tests + offline dev)
# ---------------------------------------------------------------------------


def _file_path() -> Path:
    return core_db.USER_DATA_DIR / ".likes.json"


class _FileBackend(_Backend):
    """JSON file at ``data/.likes.json`` keyed by partition string."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict[str, dict]]:
        path = _file_path()
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, dict[str, dict]]) -> None:
        path = _file_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: render to a sibling tmp file, then os.replace so a
        # crash mid-write can't truncate the JSON DB.
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp, path)

    def put(self, entity: LikeEntity) -> None:
        pk = like_partition(entity.team_id, entity.owner_user_id, entity.label_id)
        with self._lock:
            data = self._read()
            partition = data.setdefault(pk, {})
            partition[entity.liker_user_id] = {
                "team_id": entity.team_id,
                "owner_user_id": entity.owner_user_id,
                "label_id": entity.label_id,
                "liker_user_id": entity.liker_user_id,
                "liker_display_name": entity.liker_display_name,
                "created_at": entity.created_at,
            }
            self._write(data)

    def delete(
        self, team_id: str, owner_user_id: str, label_id: str, liker_user_id: str,
    ) -> bool:
        pk = like_partition(team_id, owner_user_id, label_id)
        _validate_user_id(liker_user_id)
        with self._lock:
            data = self._read()
            partition = data.get(pk, {})
            if liker_user_id not in partition:
                return False
            del partition[liker_user_id]
            if not partition:
                data.pop(pk, None)
            self._write(data)
            return True

    def list_for_activity(
        self, team_id: str, owner_user_id: str, label_id: str,
    ) -> list[LikeEntity]:
        pk = like_partition(team_id, owner_user_id, label_id)
        data = self._read()
        rows = list(data.get(pk, {}).values())
        rows.sort(key=lambda r: r.get("created_at") or "")
        return [_dict_to_entity(r) for r in rows]

    def list_bulk(
        self, team_id: str, targets: list[tuple[str, str]],
    ) -> dict[tuple[str, str], list[LikeEntity]]:
        if not targets:
            return {}
        data = self._read()
        out: dict[tuple[str, str], list[LikeEntity]] = {}
        for owner, label in targets:
            pk = like_partition(team_id, owner, label)
            rows = list(data.get(pk, {}).values())
            rows.sort(key=lambda r: r.get("created_at") or "")
            out[(owner, label)] = [_dict_to_entity(r) for r in rows]
        return out


def _dict_to_entity(d: dict) -> LikeEntity:
    return LikeEntity(
        team_id=d.get("team_id") or "",
        owner_user_id=d["owner_user_id"],
        label_id=d["label_id"],
        liker_user_id=d["liker_user_id"],
        liker_display_name=d.get("liker_display_name") or "",
        created_at=d.get("created_at") or "",
    )


# ---------------------------------------------------------------------------
# Azure Table backend
# ---------------------------------------------------------------------------


class _AzureTableBackend(_Backend):
    """Backed by Azure Table Storage via ``azure-data-tables`` + DefaultAzureCredential."""

    def __init__(self, account_url: str, table_name: str) -> None:
        self._account_url = account_url
        self._table_name = table_name
        self._client = None  # lazy
        self._lock = threading.Lock()

    def _get_client(self):
        # Lazy + thread-safe: TableClient creation hits the network once for
        # a CreateTable call. We only do that on the first use.
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is not None:
                return self._client
            from azure.core.exceptions import ResourceExistsError
            from azure.data.tables import TableServiceClient
            from azure.identity import DefaultAzureCredential

            service = TableServiceClient(
                endpoint=self._account_url,
                credential=DefaultAzureCredential(),
            )
            try:
                service.create_table(self._table_name)
            except ResourceExistsError:
                pass
            except Exception as exc:  # noqa: BLE001 — log and continue with table client
                logger.warning(
                    "likes_store: create_table failed (assuming it exists): %s", exc,
                )
            self._client = service.get_table_client(self._table_name)
            return self._client

    def put(self, entity: LikeEntity) -> None:
        from azure.data.tables import UpdateMode

        pk = like_partition(entity.team_id, entity.owner_user_id, entity.label_id)
        rk = _validate_user_id(entity.liker_user_id)
        record = {
            "PartitionKey": pk,
            "RowKey": rk,
            "team_id": entity.team_id,
            "owner_user_id": entity.owner_user_id,
            "label_id": entity.label_id,
            "liker_user_id": entity.liker_user_id,
            "liker_display_name": entity.liker_display_name,
            "created_at": entity.created_at,
        }
        client = self._get_client()
        client.upsert_entity(record, mode=UpdateMode.REPLACE)

    def delete(
        self, team_id: str, owner_user_id: str, label_id: str, liker_user_id: str,
    ) -> bool:
        from azure.core.exceptions import ResourceNotFoundError

        pk = like_partition(team_id, owner_user_id, label_id)
        rk = _validate_user_id(liker_user_id)
        client = self._get_client()
        try:
            client.delete_entity(partition_key=pk, row_key=rk)
            return True
        except ResourceNotFoundError:
            return False

    def list_for_activity(
        self, team_id: str, owner_user_id: str, label_id: str,
    ) -> list[LikeEntity]:
        pk = like_partition(team_id, owner_user_id, label_id)
        client = self._get_client()
        rows = list(client.query_entities(
            "PartitionKey eq @pk",
            parameters={"pk": pk},
        ))
        rows.sort(key=lambda r: r.get("created_at") or "")
        return [_entity_from_table(r) for r in rows]

    def list_bulk(
        self, team_id: str, targets: list[tuple[str, str]],
    ) -> dict[tuple[str, str], list[LikeEntity]]:
        # One query per partition keeps the filter expressions simple and
        # avoids OData "or" clause limits. Network-bound but small (≤ ~100
        # activities per feed render). Could be parallelized with a thread
        # pool later if needed.
        out: dict[tuple[str, str], list[LikeEntity]] = {}
        for owner, label in targets:
            try:
                out[(owner, label)] = self.list_for_activity(team_id, owner, label)
            except Exception as exc:  # noqa: BLE001 — keep partial results on failure
                logger.warning(
                    "likes_store: list_for_activity failed for %s/%s/%s: %s",
                    team_id, owner, label, exc,
                )
                out[(owner, label)] = []
        return out


def _entity_from_table(row) -> LikeEntity:
    """Convert an Azure ``TableEntity`` (dict-like) to ``LikeEntity``."""
    return LikeEntity(
        team_id=row.get("team_id") or "",
        owner_user_id=row.get("owner_user_id") or "",
        label_id=row.get("label_id") or "",
        liker_user_id=row.get("liker_user_id") or row.get("RowKey") or "",
        liker_display_name=row.get("liker_display_name") or "",
        created_at=row.get("created_at") or "",
    )


# ---------------------------------------------------------------------------
# Public API — choose backend by env, expose simple module-level functions
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _get_backend() -> _Backend:
    account_url = os.environ.get(ACCOUNT_URL_ENV, "").strip()
    table_name = os.environ.get(TABLE_NAME_ENV, DEFAULT_TABLE_NAME).strip() or DEFAULT_TABLE_NAME
    if account_url:
        logger.info("likes_store: using Azure Table backend table=%s", table_name)
        return _AzureTableBackend(account_url, table_name)
    logger.info("likes_store: using JSON file backend at %s", _file_path())
    return _FileBackend()


def reset_backend_cache() -> None:
    """Test helper — drop the cached backend so env changes take effect."""
    _get_backend.cache_clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def put_like(
    *,
    team_id: str,
    owner_user_id: str,
    label_id: str,
    liker_user_id: str,
    liker_display_name: str,
) -> LikeEntity:
    """Idempotent like — re-pressing the button overwrites the same row."""
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_user_id(liker_user_id)
    _validate_label_id(label_id)
    entity = LikeEntity(
        team_id=team_id,
        owner_user_id=owner_user_id,
        label_id=label_id,
        liker_user_id=liker_user_id,
        liker_display_name=(liker_display_name or "").strip()[:200],
        created_at=_now_iso(),
    )
    _get_backend().put(entity)
    return entity


def delete_like(
    *,
    team_id: str,
    owner_user_id: str,
    label_id: str,
    liker_user_id: str,
) -> bool:
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_user_id(liker_user_id)
    _validate_label_id(label_id)
    return _get_backend().delete(team_id, owner_user_id, label_id, liker_user_id)


def list_likes(
    *, team_id: str, owner_user_id: str, label_id: str,
) -> list[LikeEntity]:
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_label_id(label_id)
    return _get_backend().list_for_activity(team_id, owner_user_id, label_id)


def list_likes_bulk(
    *, team_id: str, targets: Iterable[tuple[str, str]],
) -> dict[tuple[str, str], list[LikeEntity]]:
    """Bulk lookup for feed enrichment, scoped to a single team.

    Invalid targets are silently skipped (so one bad activity row doesn't break
    the entire feed).
    """
    _validate_team_id(team_id)
    cleaned: list[tuple[str, str]] = []
    for owner, label in targets:
        try:
            _validate_user_id(owner)
            _validate_label_id(label)
        except ValueError:
            continue
        cleaned.append((owner, label))
    return _get_backend().list_bulk(team_id, cleaned)
