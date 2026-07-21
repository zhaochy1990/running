from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from math import isfinite
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator

from stride_core.training_load import (
    TRAINING_LOAD_MODEL_VERSION,
    backfill_training_load,
    recompute_training_load,
    refresh_training_load_calibration,
)
from stride_core.timefmt import today_shanghai
from stride_core.training_load.types import CalibrationSnapshot, PriorLoadState
from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
from stride_storage.sqlite.database import Database
from stride_storage.sqlite.training_load import has_training_load_source

from stride_server.sqlite_writer import try_user_sqlite_writer

from .plan import require_internal_token

internal_router = APIRouter()

_UUID4_DIR_RE = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-"
    r"[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$"
)
_BACKFILL_WINDOW_DAYS = 365
_BACKFILL_PROGRESS_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class _BackfillProgress:
    window_start: date
    window_end: date
    next_start: date
    acute_load: float
    chronic_load: float
    calibration: CalibrationSnapshot
    restart_token: str | None = None

    @classmethod
    def from_payload(cls, payload: Any) -> _BackfillProgress | None:
        if not isinstance(payload, dict):
            return None
        try:
            if payload.get("schema_version") != _BACKFILL_PROGRESS_SCHEMA_VERSION:
                return None
            if payload.get("algorithm_version") != TRAINING_LOAD_MODEL_VERSION:
                return None
            calibration = _calibration_from_progress(payload["calibration"])
            if calibration is None:
                return None
            progress = cls(
                window_start=date.fromisoformat(str(payload["window_start"])),
                window_end=date.fromisoformat(str(payload["window_end"])),
                next_start=date.fromisoformat(str(payload["next_start"])),
                acute_load=float(payload["acute_load"]),
                chronic_load=float(payload["chronic_load"]),
                calibration=calibration,
                restart_token=(
                    str(payload["restart_token"])
                    if payload.get("restart_token") is not None
                    else None
                ),
            )
        except (KeyError, TypeError, ValueError):
            return None
        if progress.window_end - progress.window_start != timedelta(
            days=_BACKFILL_WINDOW_DAYS
        ):
            return None
        if not progress.window_start <= progress.next_start <= progress.window_end:
            return None
        if progress.calibration.as_of_date > progress.window_end:
            return None
        if (
            not isfinite(progress.acute_load)
            or not isfinite(progress.chronic_load)
            or progress.acute_load < 0
            or progress.chronic_load < 0
        ):
            return None
        return progress

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "schema_version": _BACKFILL_PROGRESS_SCHEMA_VERSION,
            "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "next_start": self.next_start.isoformat(),
            "acute_load": self.acute_load,
            "chronic_load": self.chronic_load,
            "calibration": _calibration_progress(self.calibration),
        }
        if self.restart_token is not None:
            payload["restart_token"] = self.restart_token
        return payload

    def advance(self, *, next_start: date, state: PriorLoadState) -> _BackfillProgress:
        return _BackfillProgress(
            window_start=self.window_start,
            window_end=self.window_end,
            next_start=next_start,
            acute_load=state.acute_load,
            chronic_load=state.chronic_load,
            calibration=self.calibration,
            restart_token=self.restart_token,
        )


def _calibration_body(calibration: CalibrationSnapshot) -> dict[str, Any]:
    return {
        "id": calibration.id,
        "as_of_date": calibration.as_of_date.isoformat(),
        "threshold_hr": calibration.threshold_hr,
        "threshold_speed_mps": calibration.threshold_speed_mps,
        "critical_power_w": calibration.critical_power_w,
    }


def _calibration_progress(calibration: CalibrationSnapshot) -> dict[str, Any]:
    return {
        "id": calibration.id,
        "as_of_date": calibration.as_of_date.isoformat(),
        "algorithm_version": calibration.algorithm_version,
        "rhr_baseline": calibration.rhr_baseline,
        "hrmax_estimate": calibration.hrmax_estimate,
        "threshold_hr": calibration.threshold_hr,
        "threshold_speed_mps": calibration.threshold_speed_mps,
        "critical_power_w": calibration.critical_power_w,
    }


def _calibration_from_progress(payload: Any) -> CalibrationSnapshot | None:
    if not isinstance(payload, dict):
        return None
    try:
        return CalibrationSnapshot(
            id=int(payload["id"]) if payload.get("id") is not None else None,
            as_of_date=date.fromisoformat(str(payload["as_of_date"])),
            algorithm_version=int(payload["algorithm_version"]),
            rhr_baseline=(
                float(payload["rhr_baseline"])
                if payload.get("rhr_baseline") is not None
                else None
            ),
            hrmax_estimate=(
                float(payload["hrmax_estimate"])
                if payload.get("hrmax_estimate") is not None
                else None
            ),
            threshold_hr=(
                float(payload["threshold_hr"])
                if payload.get("threshold_hr") is not None
                else None
            ),
            threshold_speed_mps=(
                float(payload["threshold_speed_mps"])
                if payload.get("threshold_speed_mps") is not None
                else None
            ),
            critical_power_w=(
                float(payload["critical_power_w"])
                if payload.get("critical_power_w") is not None
                else None
            ),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _calibration_from_running_snapshot(snapshot: Any) -> CalibrationSnapshot:
    return CalibrationSnapshot(
        id=int(snapshot.id) if snapshot.id is not None else None,
        as_of_date=snapshot.as_of_date,
        algorithm_version=snapshot.algorithm_version,
        rhr_baseline=snapshot.rhr_baseline,
        hrmax_estimate=snapshot.hrmax_estimate,
        threshold_hr=snapshot.threshold_hr,
        threshold_speed_mps=snapshot.threshold_speed_mps,
        critical_power_w=snapshot.critical_power_w,
        source=snapshot.source if isinstance(snapshot.source, dict) else {},
    )


def _get_or_refresh_calibration(
    db: Database, *, as_of: date, lookback_days: int
) -> CalibrationSnapshot:
    snapshot = SQLiteRunningCalibrationRepository(db).fetch_latest(as_of_date=as_of)
    if snapshot is not None:
        return _calibration_from_running_snapshot(snapshot)
    return refresh_training_load_calibration(
        db,
        as_of_date=as_of,
        lookback_days=lookback_days,
        persist=True,
    )


def _is_locked(exc: sqlite3.OperationalError) -> bool:
    return "locked" in str(exc).lower()


def _raise_writer_busy(detail: str = "SQLite writer is busy") -> None:
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=detail,
        headers={"Retry-After": "2"},
    )


def _production_training_load_users() -> list[str]:
    """Enumerate canonical per-user databases with rollout source data."""
    from stride_core.db import USER_DATA_DIR

    if not USER_DATA_DIR.exists():
        return []
    users = []
    for entry in USER_DATA_DIR.iterdir():
        db_path = entry / "coros.db"
        if (
            entry.is_dir()
            and _UUID4_DIR_RE.fullmatch(entry.name)
            and db_path.is_file()
            and db_path.stat().st_size > 0
            and has_training_load_source(db_path)
        ):
            users.append(entry.name)
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
    with try_user_sqlite_writer(user) as acquired:
        if not acquired:
            _raise_writer_busy()
        try:
            with Database(user=user) as db:
                calibration = refresh_training_load_calibration(
                    db,
                    as_of_date=as_of_date,
                    lookback_days=lookback_days,
                )
        except sqlite3.OperationalError as exc:
            if _is_locked(exc):
                _raise_writer_busy(str(exc))
            raise
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
    load_lookback_days: int = Query(90, ge=1, le=90),
    only_if_missing: bool = Query(False),
    _token: None = Depends(require_internal_token),
):
    """Manual bounded backfill. Production rollout uses ``/backfill/step``."""
    with try_user_sqlite_writer(user) as acquired:
        if not acquired:
            _raise_writer_busy()
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
        except sqlite3.OperationalError as exc:
            if _is_locked(exc):
                _raise_writer_busy(str(exc))
            raise
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "user": user,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "skipped": False,
        "calibration": _calibration_body(summary.calibration),
        "load": {
            "start": summary.load.start.isoformat() if summary.load.start else None,
            "end": summary.load.end.isoformat() if summary.load.end else None,
            "activities_processed": summary.load.activities_processed,
            "activity_rows_written": summary.load.activity_rows_written,
            "daily_rows_written": summary.load.daily_rows_written,
            "calibration_id": summary.load.calibration_id,
        },
        "calibration_lookback_days": summary.calibration_lookback_days,
        "load_lookback_days": summary.load_lookback_days,
    }


class TrainingLoadBackfillStep(BaseModel):
    """Advance one API-owned shard of the resumable full backfill."""

    user: str = Field(pattern=_UUID4_DIR_RE.pattern)
    as_of_date: date | None = None
    shard_days: int = Field(default=30, ge=1, le=45)
    calibration_lookback_days: int = Field(default=180, ge=1, le=730)
    only_if_missing: bool = True
    restart: bool = False
    restart_token: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )

    @model_validator(mode="after")
    def validate_restart(self) -> "TrainingLoadBackfillStep":
        if self.restart and self.only_if_missing:
            raise ValueError("restart requires only_if_missing=false")
        if self.restart != (self.restart_token is not None):
            raise ValueError("restart and restart_token must be provided together")
        return self


@internal_router.post("/internal/training-load/backfill/step")
def internal_training_load_backfill_step(
    body: TrainingLoadBackfillStep,
    _token: None = Depends(require_internal_token),
) -> dict[str, Any]:
    """Advance one resumable training-load shard inside the API process.

    This endpoint owns the dedicated production rollout. It never delegates
    rollout shards to the separate async worker, avoiding a second long-lived
    writer for the same per-user SQLite database.
    """
    user = body.user
    with try_user_sqlite_writer(user) as acquired:
        if not acquired:
            _raise_writer_busy()
        try:
            with Database(user=user) as db:
                completion = db.get_training_load_backfill_completion()
                progress = _BackfillProgress.from_payload(
                    db.get_training_load_backfill_progress()
                )
                if body.restart:
                    is_same_completed_run = bool(
                        completion
                        and completion.get("algorithm_version")
                        == TRAINING_LOAD_MODEL_VERSION
                        and completion.get("restart_token") == body.restart_token
                    )
                    is_same_active_run = bool(
                        progress and progress.restart_token == body.restart_token
                    )
                    if is_same_completed_run:
                        db.clear_training_load_backfill_progress()
                        return {
                            "ok": True,
                            "user": user,
                            "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                            "done": True,
                            "skipped": True,
                            "reason": "restart_already_complete",
                        }
                    if not is_same_active_run:
                        db.clear_training_load_backfill_progress()
                        db.clear_training_load_backfill_complete()
                        progress = None
                        completion = None
                if (
                    completion
                    and completion.get("algorithm_version")
                    == TRAINING_LOAD_MODEL_VERSION
                ):
                    db.clear_training_load_backfill_progress()
                    return {
                        "ok": True,
                        "user": user,
                        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                        "done": True,
                        "skipped": True,
                        "reason": "backfill_already_complete",
                    }

                if progress is None:
                    as_of = body.as_of_date or today_shanghai()
                    window_start = as_of - timedelta(days=_BACKFILL_WINDOW_DAYS)
                    if not db.has_training_load_source(
                        window_start.isoformat(), as_of.isoformat()
                    ):
                        db.clear_training_load_backfill_progress()
                        return {
                            "ok": True,
                            "user": user,
                            "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                            "done": True,
                            "skipped": True,
                            "reason": "no_source_data",
                        }
                    progress = _BackfillProgress(
                        window_start=window_start,
                        window_end=as_of,
                        next_start=window_start,
                        acute_load=0.0,
                        chronic_load=0.0,
                        calibration=_get_or_refresh_calibration(
                            db,
                            as_of=as_of,
                            lookback_days=body.calibration_lookback_days,
                        ),
                        restart_token=body.restart_token,
                    )
                    db.set_training_load_backfill_progress(progress.to_payload())
                elif not db.has_training_load_source(
                    progress.window_start.isoformat(), progress.window_end.isoformat()
                ):
                    db.clear_training_load_backfill_progress()
                    return {
                        "ok": True,
                        "user": user,
                        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                        "done": True,
                        "skipped": True,
                        "reason": "no_source_data",
                    }

                shard_start = progress.next_start
                shard_end = min(
                    shard_start + timedelta(days=body.shard_days - 1),
                    progress.window_end,
                )
                calibration = progress.calibration
                prior_state = PriorLoadState(
                    acute_load=progress.acute_load,
                    chronic_load=progress.chronic_load,
                )
                load = recompute_training_load(
                    db,
                    start=shard_start,
                    end=shard_end,
                    persist=True,
                    prior_state=prior_state,
                    calibration_override=calibration,
                )
                if load.daily_rows_written == 0 or load.final_state is None:
                    raise RuntimeError("training-load shard produced no daily rows")

                next_start = shard_end + timedelta(days=1)
                if next_start > progress.window_end:
                    db.mark_training_load_backfill_complete(
                        TRAINING_LOAD_MODEL_VERSION,
                        progress.window_end.isoformat(),
                        restart_token=progress.restart_token,
                    )
                    db.clear_training_load_backfill_progress()
                    done = True
                    next_start_value = None
                else:
                    progress = progress.advance(
                        next_start=next_start,
                        state=load.final_state,
                    )
                    db.set_training_load_backfill_progress(progress.to_payload())
                    done = False
                    next_start_value = next_start.isoformat()
        except sqlite3.OperationalError as exc:
            if _is_locked(exc):
                _raise_writer_busy(str(exc))
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "ok": True,
        "user": user,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "done": done,
        "next_shard_start": next_start_value,
        "calibration_id": calibration.id,
        "shard": {
            "start": shard_start.isoformat(),
            "end": shard_end.isoformat(),
            "activities_processed": load.activities_processed,
            "daily_rows_written": load.daily_rows_written,
        },
    }
