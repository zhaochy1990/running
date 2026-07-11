"""Distance unit helpers.

Canonical storage for activity/lap distance columns is metres. User-facing
payloads can derive kilometres through these helpers at API/UI boundaries.
"""

from __future__ import annotations

from typing import Any


def meters_or_none(value: Any) -> float | None:
    """Return a positive metre value, or ``None`` for blank/non-positive input."""
    if value is None:
        return None
    try:
        metres = float(value)
    except (TypeError, ValueError):
        return None
    return metres if metres > 0 else None


def meters_to_km(value: Any, *, digits: int | None = None) -> float | None:
    """Convert metres to kilometres, preserving ``None``/non-positive blanks."""
    metres = meters_or_none(value)
    if metres is None:
        return None
    km = metres / 1000.0
    return round(km, digits) if digits is not None else km


def meters_to_km_zero(value: Any, *, digits: int = 2) -> float:
    """Convert metres to kilometres, returning ``0`` for missing/zero values."""
    km = meters_to_km(value, digits=digits)
    return km if km is not None else 0.0
