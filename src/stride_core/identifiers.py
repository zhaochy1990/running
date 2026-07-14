"""Pure identifier normalization helpers shared by configuration boundaries."""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID


def normalize_unique_uuids(values: Iterable[object]) -> tuple[str, ...]:
    """Return canonical UUID strings, rejecting invalid or duplicate entries."""
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in values:
        try:
            value = str(UUID(str(raw)))
        except (TypeError, ValueError) as exc:
            raise ValueError("entries must be UUIDs") from exc
        if value in seen:
            raise ValueError("contains a duplicate UUID")
        seen.add(value)
        normalized.append(value)
    return tuple(normalized)
