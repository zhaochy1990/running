from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from stride_storage.sqlite.database import Database
from stride_core.training_load import (
    TRAINING_LOAD_MODEL_VERSION,
    backfill_training_load,
    refresh_training_load_calibration,
)

from .plan import require_internal_token

internal_router = APIRouter()


def _calibration_body(calibration) -> dict:
    return {
        "id": calibration.id,
        "as_of_date": calibration.as_of_date.isoformat(),
        "threshold_hr": calibration.threshold_hr,
        "threshold_speed_mps": calibration.threshold_speed_mps,
        "critical_power_w": calibration.critical_power_w,
    }


@internal_router.post("/internal/training-load/calibration/refresh")
def internal_training_load_calibration_refresh(
    user: str = Query(...),
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
    user: str = Query(...),
    as_of_date: str | None = Query(None),
    calibration_lookback_days: int = Query(180, ge=1, le=730),
    load_lookback_days: int = Query(90, ge=1, le=365),
    only_if_missing: bool = Query(False),
    _token: None = Depends(require_internal_token),
):
    try:
        with Database(user=user) as db:
            if only_if_missing and db.has_daily_training_load_version(
                TRAINING_LOAD_MODEL_VERSION
            ):
                return {
                    "ok": True,
                    "user": user,
                    "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                    "skipped": True,
                    "reason": "algorithm_version_already_present",
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
