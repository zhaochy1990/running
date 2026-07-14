"""Dormant, tenant-scoped reads for the initial MySQL schema slice."""

from __future__ import annotations

from sqlalchemy import Engine, exists, select

from stride_core.identifiers import normalize_unique_uuids
from stride_storage.interfaces.rows import StorageRow
from stride_storage.mysql.row_codec import normalize_activity_row
from stride_storage.mysql.schema import activities, sync_meta

_ACTIVITY_PROJECTION = tuple(
    column
    for column in activities.c
    if column.name not in {"user_id", "shanghai_date"}
)


class MySQLActivityReader:
    """Read activities and sync metadata without exposing cross-user queries."""

    def __init__(self, engine: Engine, user_id: str) -> None:
        normalized_user_id = normalize_unique_uuids((user_id,))[0]
        if normalized_user_id != user_id:
            raise ValueError("user_id must be a canonical UUID")
        self._engine = engine
        self._user_id = user_id

    def fetch_activity(self, label_id: str) -> StorageRow | None:
        statement = select(*_ACTIVITY_PROJECTION).where(
            activities.c.user_id == self._user_id,
            activities.c.label_id == label_id,
        )
        with self._engine.connect() as connection:
            row = connection.execute(statement).mappings().one_or_none()
        return normalize_activity_row(row) if row is not None else None

    def activity_exists(self, label_id: str) -> bool:
        statement = select(
            exists().where(
                activities.c.user_id == self._user_id,
                activities.c.label_id == label_id,
            )
        )
        with self._engine.connect() as connection:
            return bool(connection.execute(statement).scalar_one())

    def get_meta(self, key: str) -> str | None:
        statement = select(sync_meta.c.value).where(
            sync_meta.c.user_id == self._user_id,
            sync_meta.c.key == key,
        )
        with self._engine.connect() as connection:
            return connection.execute(statement).scalar_one_or_none()
