"""Contracts for dormant, tenant-scoped MySQL reads."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy.dialects import mysql

from stride_storage.mysql.activity_reader import MySQLActivityReader
from stride_storage.mysql.row_codec import normalize_activity_row

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


class _MappingsResult:
    def __init__(self, value: Any) -> None:
        self._value = value

    def mappings(self) -> _MappingsResult:
        return self

    def one_or_none(self) -> Any:
        return self._value

    def scalar_one(self) -> Any:
        return self._value

    def scalar_one_or_none(self) -> Any:
        return self._value


class _Connection:
    def __init__(self, values: list[Any], statements: list[Any]) -> None:
        self._values = values
        self._statements = statements

    def __enter__(self) -> _Connection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: Any) -> _MappingsResult:
        self._statements.append(statement)
        return _MappingsResult(self._values.pop(0))


class _Engine:
    def __init__(self, *values: Any) -> None:
        self.values = list(values)
        self.statements: list[Any] = []

    def connect(self) -> _Connection:
        return _Connection(self.values, self.statements)


def _compiled(statement: Any) -> tuple[str, dict[str, Any]]:
    compiled = statement.compile(dialect=mysql.dialect())
    return str(compiled), compiled.params


def test_normalize_activity_row_converts_datetime_and_json_values() -> None:
    row = normalize_activity_row(
        {
            "label_id": "activity-1",
            "date": datetime(2026, 7, 14, 1, 2, 3, 456789),
            "synced_at": datetime(
                2026, 7, 14, 9, 2, 3, tzinfo=timezone(timedelta(hours=8))
            ),
            "pauses": [{"start_ts": 1, "end_ts": 2, "type": 3}],
            "route_thumb_json": {"points": [[1.2, 3.4]]},
        }
    )

    assert row["date"] == "2026-07-14T01:02:03.456789+00:00"
    assert row["synced_at"] == "2026-07-14T01:02:03+00:00"
    assert json.loads(row["pauses"]) == [{"start_ts": 1, "end_ts": 2, "type": 3}]
    assert row["route_thumb_json"] == '{"points":[[1.2,3.4]]}'


def test_normalize_activity_row_preserves_null_and_serialized_json() -> None:
    row = normalize_activity_row({"pauses": None, "route_thumb_json": "[]"})
    assert row == {"pauses": None, "route_thumb_json": "[]"}


def test_reader_rejects_noncanonical_user_id() -> None:
    with pytest.raises(ValueError, match="canonical UUID"):
        MySQLActivityReader(_Engine(), USER_ID.upper())  # type: ignore[arg-type]


def test_fetch_activity_is_tenant_scoped_and_normalized() -> None:
    engine = _Engine({"label_id": "activity-1", "date": datetime(2026, 7, 14), "pauses": []})
    reader = MySQLActivityReader(engine, USER_ID)  # type: ignore[arg-type]

    row = reader.fetch_activity("activity-1")

    assert row == {
        "label_id": "activity-1",
        "date": "2026-07-14T00:00:00+00:00",
        "pauses": "[]",
    }
    sql, params = _compiled(engine.statements[0])
    assert "activities.user_id = %s" in sql
    assert "activities.label_id = %s" in sql
    assert "activities.user_id" not in sql.partition("FROM")[0]
    assert "shanghai_date" not in sql.partition("FROM")[0]
    assert set(params.values()) == {USER_ID, "activity-1"}


def test_missing_activity_returns_none() -> None:
    reader = MySQLActivityReader(_Engine(None), USER_ID)  # type: ignore[arg-type]
    assert reader.fetch_activity("missing") is None


def test_activity_exists_is_tenant_scoped() -> None:
    engine = _Engine(1)
    reader = MySQLActivityReader(engine, USER_ID)  # type: ignore[arg-type]

    assert reader.activity_exists("activity-1") is True
    sql, params = _compiled(engine.statements[0])
    assert "activities.user_id = %s" in sql
    assert "activities.label_id = %s" in sql
    assert set(params.values()) == {USER_ID, "activity-1"}


def test_get_meta_is_tenant_scoped_and_preserves_empty_values() -> None:
    engine = _Engine("")
    reader = MySQLActivityReader(engine, USER_ID)  # type: ignore[arg-type]

    assert reader.get_meta("last_sync") == ""
    sql, params = _compiled(engine.statements[0])
    assert "sync_meta.user_id = %s" in sql
    assert "sync_meta.`key` = %s" in sql
    assert set(params.values()) == {USER_ID, "last_sync"}
