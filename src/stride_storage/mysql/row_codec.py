"""Normalize MySQL-native values to the legacy storage row contract."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from stride_storage.interfaces.rows import StorageRow

_ACTIVITY_DATETIME_FIELDS = frozenset({"date", "synced_at"})
_ACTIVITY_JSON_FIELDS = frozenset({"pauses", "route_thumb_json"})


def normalize_activity_row(row: Mapping[str, Any]) -> StorageRow:
    """Return SQLite-compatible activity values in a plain dictionary."""
    normalized = dict(row)
    for field in _ACTIVITY_DATETIME_FIELDS:
        value = normalized.get(field)
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            normalized[field] = value.astimezone(timezone.utc).isoformat()

    for field in _ACTIVITY_JSON_FIELDS:
        value = normalized.get(field)
        if value is not None and not isinstance(value, str):
            normalized[field] = json.dumps(value, separators=(",", ":"))
    return normalized


def encode_activity_record(record: Mapping[str, Any]) -> StorageRow:
    """Convert a SQLite-compatible activity record to MySQL-native values."""
    encoded = dict(record)
    date_value = encoded.get("date")
    if not date_value:
        raise ValueError("activity date is required")
    if isinstance(date_value, str):
        try:
            date_value = datetime.fromisoformat(date_value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("activity date must be an ISO 8601 timestamp") from exc
    if not isinstance(date_value, datetime):
        raise TypeError("activity date must be a datetime or ISO 8601 string")
    if date_value.tzinfo is None:
        date_value = date_value.replace(tzinfo=timezone.utc)
    encoded["date"] = date_value.astimezone(timezone.utc).replace(tzinfo=None)

    for field in _ACTIVITY_JSON_FIELDS:
        value = encoded.get(field)
        if isinstance(value, str):
            try:
                encoded[field] = json.loads(value)
            except json.JSONDecodeError as exc:
                raise ValueError(f"activity {field} must contain valid JSON") from exc
    return encoded
