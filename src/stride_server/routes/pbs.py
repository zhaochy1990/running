"""``GET /api/{user}/pbs`` — personal bests auto-detection."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from stride_core.pb_records import (
    ACTIVITY_DISTANCE_TOLERANCE_M,
    DISTANCE_ORDER,
    best_effort_candidates_for_activity,
    load_personal_bests,
)
from stride_core.pb_records import _normalise_date as _core_normalise_date

from ..deps import get_db

router = APIRouter()

# ── Distance tolerance table (metres) ────────────────────────────────────────

DISTANCE_TOLERANCE = ACTIVITY_DISTANCE_TOLERANCE_M

# Canonical ordering for the response list.
_DISTANCE_ORDER = DISTANCE_ORDER


# ── Response schema ───────────────────────────────────────────────────────────


class PBHistoryPoint(BaseModel):
    date: str
    best_so_far_sec: float
    label_id: str | None = None
    source: str | None = None
    segment_start_s: float | None = None
    segment_end_s: float | None = None


class PBEntry(BaseModel):
    distance: str
    race_type: str | None = None
    pb_time_sec: float
    achieved_at: str
    label_id: str
    source: str | None = None
    name: str | None = None
    segment_start_s: float | None = None
    segment_end_s: float | None = None
    history: list[PBHistoryPoint]


class PBsResponse(BaseModel):
    user_id: str
    computed_at: str
    pbs: list[PBEntry]


# ── Detection logic ───────────────────────────────────────────────────────────


def _detect_pbs(
    rows: list[Any],
) -> dict[str, dict]:
    """Compatibility wrapper for old row-only callers.

    Route and coach code use ``load_personal_bests(db)`` so they can scan
    activity timeseries. This wrapper keeps legacy tests/imports working with
    activity-level fallback only.
    """
    running_best: dict[str, float] = {}
    result: dict[str, dict] = {}
    history_by_distance: dict[str, list[dict[str, Any]]] = {}

    for row in rows:
        for candidate in best_effort_candidates_for_activity(
            _NoTimeseriesDb(), row, include_activity_fallback=True,
        ):
            dist = candidate.distance
            if dist in running_best and candidate.duration_s >= running_best[dist]:
                continue
            running_best[dist] = candidate.duration_s
            history = history_by_distance.setdefault(dist, [])
            history.append(candidate.history_point())
            result[dist] = candidate.pb_entry(history)

    return result


class _NoTimeseriesDb:
    def fetch_timeseries(self, _label_id: str) -> list[Any]:
        return []


def _normalise_date(raw: str) -> str:
    return _core_normalise_date(raw)


# ── Route ─────────────────────────────────────────────────────────────────────


@router.get("/api/{user}/pbs", response_model=PBsResponse)
def get_pbs(user: str) -> PBsResponse:
    """Return best-effort PBs for 1K, 3K, 5K, 10K, HM, and FM.

    Reads the persisted ``personal_bests`` table (populated post-sync) instead of
    recomputing the ~7s best-effort scan per request. ``load_personal_bests``
    self-heals when the table was never scanned (idempotent; not guarded
    in-process), and records PB-less users so they aren't re-scanned every call.
    """
    db = get_db(user)
    try:
        pb_map = load_personal_bests(db)
    finally:
        db.close()

    pbs: list[PBEntry] = []
    for dist in _DISTANCE_ORDER:
        if dist not in pb_map:
            continue
        entry = pb_map[dist]
        pbs.append(PBEntry(**entry))

    return PBsResponse(
        user_id=user,
        computed_at=datetime.now(timezone.utc).isoformat(),
        pbs=pbs,
    )
