from __future__ import annotations

from datetime import date
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from stride_storage.sqlite.database import Database
from stride_core.training_load import (
    TRAINING_LOAD_MODEL_VERSION,
    backfill_training_load,
    refresh_training_load_calibration,
)

# Imported at module level so tests can monkeypatch ``route_mod.enqueue`` as a
# seam without patching deep into the jobs package.
from stride_server.jobs import enqueue

from .plan import require_internal_token

internal_router = APIRouter()

_UUID4_DIR_RE = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-"
    r"[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$"
)


def _calibration_body(calibration) -> dict:
    return {
        "id": calibration.id,
        "as_of_date": calibration.as_of_date.isoformat(),
        "threshold_hr": calibration.threshold_hr,
        "threshold_speed_mps": calibration.threshold_speed_mps,
        "critical_power_w": calibration.critical_power_w,
    }


def _production_training_load_users() -> list[str]:
    """Enumerate canonical per-user databases from the live data mount.

    ``data/.slug_aliases.json`` is a convenience mapping and can lag user
    creation. The UUID directory containing ``coros.db`` is the authoritative
    per-user storage shape, so rollout jobs must discover users from it.
    """
    from stride_core.db import USER_DATA_DIR

    if not USER_DATA_DIR.exists():
        return []
    users = [
        entry.name
        for entry in USER_DATA_DIR.iterdir()
        if entry.is_dir()
        and _UUID4_DIR_RE.fullmatch(entry.name)
        and (entry / "coros.db").is_file()
        and (entry / "coros.db").stat().st_size > 0
    ]
    return sorted(users)


@internal_router.get("/internal/training-load/users")
def internal_training_load_users(
    _token: None = Depends(require_internal_token),
):
    users = _production_training_load_users()
    return {"ok": True, "users": users, "count": len(users)}


@internal_router.post("/internal/training-load/calibration/refresh")
def internal_training_load_calibration_refresh(
    user: str = Query(..., pattern=_UUID4_DIR_RE.pattern),
    as_of_date: str | None = Query(None),
    lookback_days: int = Query(180, ge=1, le=730),
    _token: None = Depends(require_internal_token),
):
    try:
        with Database(user=user) as db:
            calibration = refresh_training_load_calibration(
                db,
                as_of_date=as_of_date,
                lookback_days=lookback_days,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "user": user,
        "calibration": _calibration_body(calibration),
        "lookback_days": lookback_days,
    }


@internal_router.post("/internal/training-load/backfill")
def internal_training_load_backfill(
    user: str = Query(..., pattern=_UUID4_DIR_RE.pattern),
    as_of_date: str | None = Query(None),
    calibration_lookback_days: int = Query(180, ge=1, le=730),
    load_lookback_days: int = Query(90, ge=1, le=365),
    only_if_missing: bool = Query(False),
    _token: None = Depends(require_internal_token),
):
    try:
        with Database(user=user) as db:
            if only_if_missing and db.is_training_load_backfill_complete(
                TRAINING_LOAD_MODEL_VERSION
            ):
                return {
                    "ok": True,
                    "user": user,
                    "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                    "skipped": True,
                    "reason": "backfill_already_complete",
                    "calibration_lookback_days": calibration_lookback_days,
                    "load_lookback_days": load_lookback_days,
                }
            summary = backfill_training_load(
                db,
                as_of_date=as_of_date,
                calibration_lookback_days=calibration_lookback_days,
                load_lookback_days=load_lookback_days,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "user": user,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "skipped": False,
        "calibration": _calibration_body(summary.calibration),
        "load": {
            "start": summary.load.start.isoformat() if isinstance(summary.load.start, date) else None,
            "end": summary.load.end.isoformat() if isinstance(summary.load.end, date) else None,
            "activities_processed": summary.load.activities_processed,
            "activity_rows_written": summary.load.activity_rows_written,
            "daily_rows_written": summary.load.daily_rows_written,
            "calibration_id": summary.load.calibration_id,
        },
        "calibration_lookback_days": summary.calibration_lookback_days,
        "load_lookback_days": summary.load_lookback_days,
    }


class TrainingLoadBackfillEnqueue(BaseModel):
    """Body for the async rollout entry point."""

    user: str = Field(pattern=_UUID4_DIR_RE.pattern)
    as_of_date: str | None = None
    calibration_lookback_days: int = Field(365, ge=1, le=730)
    load_lookback_days: int = Field(365, ge=1, le=365)
    only_if_missing: bool = True


@internal_router.post("/internal/training-load/backfill/enqueue")
def internal_training_load_backfill_enqueue(
    body: TrainingLoadBackfillEnqueue,
    _token: None = Depends(require_internal_token),
):
    """Enqueue a ``training_load_backfill`` job and return quickly.

    This is the rollout entry point: it must NOT run the backfill inline (the
    365-day scan over ~1.2M timeseries rows blows past the ACA 240s request
    budget and 504s — the prod regression this endpoint fixes). It only does a
    fast current-version check, then hands the work to the async worker.
    """
    user = body.user
    if body.only_if_missing:
        with Database(user=user) as db:
            if db.is_training_load_backfill_complete(TRAINING_LOAD_MODEL_VERSION):
                return {
                    "ok": True,
                    "user": user,
                    "partition_key": user,
                    "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                    "skipped": True,
                    "reason": "backfill_already_complete",
                    "job_id": None,
                }

    job_id = enqueue(
        job_type="training_load_backfill",
        partition_key=user,
        input_payload={
            "as_of_date": body.as_of_date,
            "calibration_lookback_days": body.calibration_lookback_days,
            "load_lookback_days": body.load_lookback_days,
            "only_if_missing": body.only_if_missing,
        },
    )
    return {
        "ok": True,
        "user": user,
        "partition_key": user,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "skipped": False,
        "job_id": job_id,
    }
