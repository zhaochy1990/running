"""``GET /api/{user}/pbs`` — personal bests auto-detection.

Scans the activities table (running sport types only) and returns the
fastest completion time for each of the four canonical race distances:
5K, 10K, Half Marathon, and Full Marathon.  Also emits a best-so-far
history series per distance so the frontend can render a PB progression
chart without additional queries.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from stride_core.models import RUN_SPORT_SQL_LIST as _RUN_SPORT_SQL
from stride_core.timefmt import utc_iso_to_shanghai_iso

from ..deps import get_db

router = APIRouter()

# ── Distance tolerance table (metres) ────────────────────────────────────────

DISTANCE_TOLERANCE: dict[str, tuple[float, float]] = {
    "5K":  (4800.0, 5200.0),
    "10K": (9800.0, 10200.0),
    "HM":  (20800.0, 21300.0),
    "FM":  (41800.0, 42400.0),
}

# Canonical ordering for the response list.
_DISTANCE_ORDER = ["5K", "10K", "HM", "FM"]


# ── Response schema ───────────────────────────────────────────────────────────


class PBHistoryPoint(BaseModel):
    date: str
    best_so_far_sec: float


class PBEntry(BaseModel):
    distance: str
    pb_time_sec: float
    achieved_at: str
    label_id: str
    history: list[PBHistoryPoint]


class PBsResponse(BaseModel):
    user_id: str
    computed_at: str
    pbs: list[PBEntry]


# ── Detection logic ───────────────────────────────────────────────────────────


def _detect_pbs(
    rows: list[Any],
) -> dict[str, dict]:
    """Scan activities (sorted by date asc) and return best per distance.

    Each entry in the returned dict maps a distance label to::

        {
            "pb_time_sec": float,
            "achieved_at": str,       # YYYY-MM-DD (or raw date if shorter)
            "label_id": str,
            "history": [{"date": str, "best_so_far_sec": float}, ...],
        }
    """
    # running_best[dist] = current best duration_s
    running_best: dict[str, float] = {}
    result: dict[str, dict] = {}

    for row in rows:
        distance_m: float = row["distance_m"] or 0.0
        duration_s: float = row["duration_s"] or 0.0
        date_raw: str = row["date"] or ""
        label_id: str = row["label_id"]

        if duration_s <= 0:
            continue

        # Normalise date to YYYY-MM-DD for display.
        date_disp = _normalise_date(date_raw)

        for dist, (min_m, max_m) in DISTANCE_TOLERANCE.items():
            if not (min_m <= distance_m <= max_m):
                continue

            # This activity is a candidate for `dist`.
            if dist not in running_best or duration_s < running_best[dist]:
                running_best[dist] = duration_s
                if dist not in result:
                    result[dist] = {
                        "pb_time_sec": duration_s,
                        "achieved_at": date_disp,
                        "label_id": label_id,
                        "history": [
                            {"date": date_disp, "best_so_far_sec": duration_s}
                        ],
                    }
                else:
                    result[dist]["pb_time_sec"] = duration_s
                    result[dist]["achieved_at"] = date_disp
                    result[dist]["label_id"] = label_id
                    result[dist]["history"].append(
                        {"date": date_disp, "best_so_far_sec": duration_s}
                    )

    return result


def _normalise_date(raw: str) -> str:
    """Best-effort normalise a date string to YYYY-MM-DD.

    Handles:
    - ISO 8601 strings (``2025-08-15T10:00:00+00:00``)
    - Plain YYYYMMDD strings (``20250815``)
    - Already-formatted YYYY-MM-DD strings
    """
    if not raw:
        return raw
    # ISO 8601 with time component — UTC instant, convert to Shanghai calendar
    # so PB "achieved_at" matches what the user saw on their watch.
    if "T" in raw or (len(raw) > 10 and raw[10] == " "):
        shanghai = utc_iso_to_shanghai_iso(raw)
        if shanghai and shanghai != raw:
            return shanghai[:10]
        # Helper returned unchanged → input wasn't parseable; fall through.
    # Compact YYYYMMDD
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    # Already YYYY-MM-DD (or unknown — return as-is)
    return raw[:10]


# ── Route ─────────────────────────────────────────────────────────────────────


@router.get("/api/{user}/pbs", response_model=PBsResponse)
def get_pbs(user: str) -> PBsResponse:
    """Return personal bests for 5K, 10K, HM, and FM.

    Scans all running activities sorted by date ascending so the
    best-so-far history is built chronologically.  Only activities
    within the distance-tolerance windows are considered candidates.
    """
    db = get_db(user)
    try:
        rows = db.query(
            f"""
            SELECT label_id, date, distance_m, duration_s
            FROM activities
            WHERE sport_type IN ({_RUN_SPORT_SQL})
              AND distance_m IS NOT NULL
              AND duration_s IS NOT NULL
              AND duration_s > 0
            ORDER BY date ASC, label_id ASC
            """
        )
    finally:
        db.close()

    pb_map = _detect_pbs(rows)

    pbs: list[PBEntry] = []
    for dist in _DISTANCE_ORDER:
        if dist not in pb_map:
            continue
        entry = pb_map[dist]
        pbs.append(
            PBEntry(
                distance=dist,
                pb_time_sec=entry["pb_time_sec"],
                achieved_at=entry["achieved_at"],
                label_id=entry["label_id"],
                history=[
                    PBHistoryPoint(**p) for p in entry["history"]
                ],
            )
        )

    return PBsResponse(
        user_id=user,
        computed_at=datetime.now(timezone.utc).isoformat(),
        pbs=pbs,
    )
