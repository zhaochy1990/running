"""Dormant, tenant-scoped writes for the initial MySQL schema slice."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import Engine
from sqlalchemy.dialects.mysql import insert

from stride_core.identifiers import normalize_unique_uuids
from stride_storage.mysql.row_codec import encode_activity_record
from stride_storage.mysql.schema import activities, sync_meta

_WRITABLE_ACTIVITY_COLUMNS = frozenset(
    column.name
    for column in activities.c
    if column.name not in {"user_id", "synced_at", "shanghai_date"}
)


class MySQLActivityWriter:
    """Upsert parent activity records and sync metadata for one user."""

    def __init__(self, engine: Engine, user_id: str) -> None:
        normalized_user_id = normalize_unique_uuids((user_id,))[0]
        if normalized_user_id != user_id:
            raise ValueError("user_id must be a canonical UUID")
        self._engine = engine
        self._user_id = user_id

    def upsert_activity_record(self, record: Mapping[str, Any]) -> None:
        unknown = set(record) - _WRITABLE_ACTIVITY_COLUMNS
        if unknown:
            raise ValueError(f"unknown or generated activity fields: {', '.join(sorted(unknown))}")
        missing = {"label_id", "sport_type", "date"} - set(record)
        if missing:
            raise ValueError(f"missing required activity fields: {', '.join(sorted(missing))}")

        values = encode_activity_record(record)
        values["user_id"] = self._user_id
        statement = insert(activities).values(**values)
        updates = {
            column: statement.inserted[column]
            for column in values
            if column not in {"user_id", "label_id"}
        }
        updates["synced_at"] = statement.inserted.synced_at
        statement = statement.on_duplicate_key_update(**updates)
        with self._engine.begin() as connection:
            connection.execute(statement)

    def set_meta(self, key: str, value: str) -> None:
        statement = insert(sync_meta).values(user_id=self._user_id, key=key, value=value)
        statement = statement.on_duplicate_key_update(value=statement.inserted.value)
        with self._engine.begin() as connection:
            connection.execute(statement)
