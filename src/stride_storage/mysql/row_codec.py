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
