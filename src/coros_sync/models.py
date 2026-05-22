"""COROS API JSON → stride_core domain models (provider-specific builders).

Mirrors `garmin_sync.models` for COROS-only payload shapes that don't fit the
generic `stride_core.models.<X>.from_api` boundary. The dataclasses themselves
still live in `stride_core.models`; this module only provides COROS adapters.
"""

from __future__ import annotations

from typing import Any

from stride_core.models import DailyHrv


def _is_real_number(x: Any) -> bool:
    # `isinstance(True, int) is True` in Python — bools must be rejected
    # explicitly so a stray boolean doesn't get persisted as `last_night_avg=1`.
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _happen_day_to_iso(happen_day: Any) -> str:
    """COROS encodes calendar days as YYYYMMDD ints; normalize to ISO.

    Returns an empty string for any input the caller's empty-date filter
    should drop (None, malformed strings, NaN-shaped floats). This keeps
    a stray null from being written to the DB as the literal text "None".
    """
    if happen_day is None:
        return ""
    if isinstance(happen_day, float):
        # Some COROS endpoints return calendar days as floats (e.g. 20260516.0).
        # Treat as int; reject NaN / inf which would otherwise survive str().
        if happen_day != happen_day or happen_day in (float("inf"), float("-inf")):
            return ""
        happen_day = int(happen_day)
    s = str(happen_day)
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return ""


def _derive_status(value: float | None, intervals: list[int] | None) -> str | None:
    """Classify a daily HRV value against COROS's per-day baseline bands.

    COROS doesn't return a Garmin-style status string per day, but the watch
    UI itself colors the value by where it falls in `sleepHrvIntervalList`,
    a 4-tuple `[absolute_floor, low_upper, balanced_low, balanced_upper]`.
    Replicating that classification keeps `daily_hrv.status` semantics
    consistent across providers (downstream `training_load.core` reads
    status before falling back to a raw value-vs-baseline comparison).
    """
    if value is None or not intervals or len(intervals) < 4:
        return None
    head = intervals[:4]
    if not all(_is_real_number(x) for x in head):
        return None
    floor, low_upper, balanced_low, balanced_upper = head
    if value < floor:
        return "POOR"
    if value < low_upper:
        return "LOW"
    if value < balanced_low:
        return "UNBALANCED"
    if value <= balanced_upper:
        return "BALANCED"
    return "UNBALANCED"


def _baseline_field(intervals: list[int] | None, index: int) -> int | None:
    if not intervals or len(intervals) <= index:
        return None
    val = intervals[index]
    return val if _is_real_number(val) else None


def daily_hrv_from_coros(item: dict[str, Any]) -> DailyHrv:
    """Build a `DailyHrv` row from one entry in `sleepHrvData.sleepHrvList`.

    Source shape (captured from /dashboard/query for trainingcn.coros.com):

        {"avgSleepHrv": 42, "happenDay": 20260516, "sleepHrvBase": 34,
         "sleepHrvIntervalList": [5, 26, 30, 38], "sleepHrvSd": 3.77,
         "userId": ...}

    `sleepHrvIntervalList` is `[absolute_floor, low_upper, balanced_low,
    balanced_upper]` — the per-day baseline thresholds the watch UI uses
    to bucket the night's reading.
    """
    intervals = item.get("sleepHrvIntervalList")
    raw_value = item.get("avgSleepHrv")
    value = raw_value if _is_real_number(raw_value) else None
    return DailyHrv(
        date=_happen_day_to_iso(item.get("happenDay")),
        weekly_avg=None,
        last_night_avg=value,
        last_night_5min_high=None,
        status=_derive_status(value, intervals),
        baseline_low_upper=_baseline_field(intervals, 1),
        baseline_balanced_low=_baseline_field(intervals, 2),
        baseline_balanced_upper=_baseline_field(intervals, 3),
        feedback_phrase=None,
    )


def hrv_list_from_dashboard(summary: dict[str, Any]) -> list[DailyHrv]:
    """Extract per-day HRV rows from a `/dashboard/query` `data.summaryInfo`.

    Returns the rows ready for `db.upsert_daily_hrv`. Skips entries that
    can't produce a usable date.
    """
    raw = (summary.get("sleepHrvData") or {}).get("sleepHrvList") or []
    out: list[DailyHrv] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        row = daily_hrv_from_coros(item)
        if not row.date:
            continue
        out.append(row)
    return out
