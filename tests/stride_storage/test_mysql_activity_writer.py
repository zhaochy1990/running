"""Contracts for dormant, tenant-scoped MySQL writes."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest
from sqlalchemy.dialects import mysql

from stride_storage.mysql.activity_writer import MySQLActivityWriter
from stride_storage.mysql.row_codec import encode_activity_record

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


class _Transaction:
    def __init__(self, statements: list[Any]) -> None:
        self._statements = statements

    def __enter__(self) -> _Transaction:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: Any) -> None:
        self._statements.append(statement)


class _Engine:
    def __init__(self) -> None:
        self.statements: list[Any] = []

    def begin(self) -> _Transaction:
        return _Transaction(self.statements)


def _compiled(statement: Any) -> tuple[str, dict[str, Any]]:
    compiled = statement.compile(dialect=mysql.dialect())
    return str(compiled), compiled.params


def test_encode_activity_record_converts_utc_datetime_and_json() -> None:
    record = encode_activity_record(
        {
            "date": "2026-07-14T09:02:03.456789+08:00",
            "pauses": '[{"start_ts":1,"end_ts":2,"type":3}]',
            "route_thumb_json": "null",
        }
    )

    assert record["date"] == datetime(2026, 7, 14, 1, 2, 3, 456789)
    assert record["pauses"] == [{"start_ts": 1, "end_ts": 2, "type": 3}]
    assert record["route_thumb_json"] is None


@pytest.mark.parametrize("date_value", [None, "", "not-a-date"])
def test_encode_activity_record_rejects_invalid_dates(date_value: object) -> None:
    with pytest.raises(ValueError, match="activity date"):
        encode_activity_record({"date": date_value})


def test_encode_activity_record_rejects_invalid_json() -> None:
    with pytest.raises(ValueError, match="route_thumb_json"):
        encode_activity_record({"date": "2026-07-14T01:02:03Z", "route_thumb_json": "{"})


def test_writer_rejects_noncanonical_user_id() -> None:
    with pytest.raises(ValueError, match="canonical UUID"):
        MySQLActivityWriter(_Engine(), USER_ID.upper())  # type: ignore[arg-type]


def test_upsert_activity_record_is_tenant_scoped_and_idempotent() -> None:
    engine = _Engine()
    writer = MySQLActivityWriter(engine, USER_ID)  # type: ignore[arg-type]

    writer.upsert_activity_record(
        {
            "label_id": "activity-1",
            "name": None,
            "sport_type": 100,
            "sport_name": "Run",
            "date": "2026-07-14T01:02:03Z",
            "distance_m": 10000.0,
            "pauses": "[]",
        }
    )

    sql, params = _compiled(engine.statements[0])
    assert sql.startswith("INSERT INTO activities")
    assert "ON DUPLICATE KEY UPDATE" in sql
    assert "REPLACE" not in sql
    assert "user_id = VALUES(user_id)" not in sql
    assert "label_id = VALUES(label_id)" not in sql
    assert "name = VALUES(name)" in sql
    assert "synced_at = VALUES(synced_at)" in sql
    assert USER_ID in params.values()
    assert datetime(2026, 7, 14, 1, 2, 3) in params.values()
    assert None in params.values()


def test_upsert_activity_record_rejects_missing_and_generated_fields() -> None:
    writer = MySQLActivityWriter(_Engine(), USER_ID)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="missing required.*sport_type"):
        writer.upsert_activity_record({"label_id": "a", "date": "2026-07-14T01:02:03Z"})
    with pytest.raises(ValueError, match="unknown or generated.*shanghai_date"):
        writer.upsert_activity_record(
            {
                "label_id": "a",
                "sport_type": 100,
                "date": "2026-07-14T01:02:03Z",
                "shanghai_date": "2026-07-14",
            }
        )


def test_set_meta_is_tenant_scoped_and_idempotent() -> None:
    engine = _Engine()
    writer = MySQLActivityWriter(engine, USER_ID)  # type: ignore[arg-type]

    writer.set_meta("last_sync", "")

    sql, params = _compiled(engine.statements[0])
    assert sql.startswith("INSERT INTO sync_meta")
    assert "ON DUPLICATE KEY UPDATE value = VALUES(value)" in sql
    assert "user_id = VALUES(user_id)" not in sql
    assert set(params.values()) == {USER_ID, "last_sync", ""}
