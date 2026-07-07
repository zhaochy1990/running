"""Likes storage backends (JSON file + Azure Table) + backend selection.

Likes are cross-user social signals — deliberately NOT in per-user SQLite.
Schema (single Azure Table, default ``stridelikes``):

    PartitionKey = "act:{team_id}:{owner_user_id}:{label_id}"
    RowKey       = "{liker_user_id}"

If the configured ``table_account_url`` is empty, falls back to a JSON file at
``data/.likes.json`` so unit tests + offline dev work without Azure.

Config *loading* (ServerConfig / TOML / env) stays in ``stride_server``; this
module only takes a resolved :class:`LikesStorageConfig`.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from pathlib import Path

from stride_core import db as core_db
from stride_storage.azure.backend_select import choose_backend
from stride_storage.azure.table_backend import AzureTableConnection
from stride_storage.interfaces.config import LikesStorageConfig
from stride_storage.interfaces.likes import LikeEntity, LikesBackend

logger = logging.getLogger(__name__)

DEFAULT_TABLE_NAME = "stridelikes"

# Path-traversal / injection guards — caller-supplied IDs go directly into
# Azure Table keys and JSON file paths, so they must be tightly validated.
_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_LABEL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_TEAM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not _UUID4_RE.match(user_id):
        raise ValueError(f"invalid user_id: {user_id!r}")
    return user_id


def _validate_label_id(label_id: str) -> str:
    if not isinstance(label_id, str) or not _LABEL_ID_RE.match(label_id):
        raise ValueError(f"invalid label_id: {label_id!r}")
    return label_id


def _validate_team_id(team_id: str) -> str:
    if not isinstance(team_id, str) or not _TEAM_ID_RE.match(team_id):
        raise ValueError(f"invalid team_id: {team_id!r}")
    return team_id


def like_partition(team_id: str, owner_user_id: str, label_id: str) -> str:
    """Compose the Azure Table PartitionKey for an activity within a team.

    Likes are scoped per (team, activity) so the same activity can have
    distinct like counts in two teams that share the owner — avoids
    cross-team leakage.
    """
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_label_id(label_id)
    return f"act:{team_id}:{owner_user_id}:{label_id}"


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
# File backend (tests + offline dev)
# ---------------------------------------------------------------------------


def _file_path() -> Path:
    # Resolved at call time so tests that monkeypatch ``USER_DATA_DIR`` take
    # effect (and so the path survives the Phase-5 move to stride_storage.paths).
    return core_db.USER_DATA_DIR / ".likes.json"


class FileLikesBackend(LikesBackend):
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


# ---------------------------------------------------------------------------
# Azure Table backend
# ---------------------------------------------------------------------------


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


class AzureTableLikesBackend(LikesBackend):
    """Backed by Azure Table Storage via the shared ``AzureTableConnection``."""

    def __init__(self, account_url: str, table_name: str) -> None:
        self._conn = AzureTableConnection(account_url, table_name)

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
        self._conn.table().upsert_entity(record, mode=UpdateMode.REPLACE)

    def delete(
        self, team_id: str, owner_user_id: str, label_id: str, liker_user_id: str,
    ) -> bool:
        from azure.core.exceptions import ResourceNotFoundError

        pk = like_partition(team_id, owner_user_id, label_id)
        rk = _validate_user_id(liker_user_id)
        try:
            self._conn.table().delete_entity(partition_key=pk, row_key=rk)
            return True
        except ResourceNotFoundError:
            return False

    def list_for_activity(
        self, team_id: str, owner_user_id: str, label_id: str,
    ) -> list[LikeEntity]:
        pk = like_partition(team_id, owner_user_id, label_id)
        rows = list(self._conn.table().query_entities(
            "PartitionKey eq @pk",
            parameters={"pk": pk},
        ))
        rows.sort(key=lambda r: r.get("created_at") or "")
        return [_entity_from_table(r) for r in rows]

    def list_bulk(
        self, team_id: str, targets: list[tuple[str, str]],
    ) -> dict[tuple[str, str], list[LikeEntity]]:
        # One query per partition keeps filter expressions simple and avoids
        # OData "or" clause limits. Network-bound but small (≤ ~100 activities
        # per feed render).
        out: dict[tuple[str, str], list[LikeEntity]] = {}
        for owner, label in targets:
            try:
                out[(owner, label)] = self.list_for_activity(team_id, owner, label)
            except Exception as exc:  # noqa: BLE001 — keep partial results
                logger.warning(
                    "likes_store: list_for_activity failed for %s/%s/%s: %s",
                    team_id, owner, label, exc,
                )
                out[(owner, label)] = []
        return out


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------


def backend_from_config(config: LikesStorageConfig) -> LikesBackend:
    account_url = config.table_account_url.strip()
    table_name = config.table_name.strip() or DEFAULT_TABLE_NAME

    def _azure() -> LikesBackend:
        logger.info("likes_store: using Azure Table backend table=%s", table_name)
        return AzureTableLikesBackend(account_url, table_name)

    def _file() -> LikesBackend:
        logger.info("likes_store: using JSON file backend at %s", _file_path())
        return FileLikesBackend()

    return choose_backend(account_url, azure_factory=_azure, file_factory=_file)
