"""Async ``training_load_backfill`` handler.

The deploy rollout enqueues one ``training_load_backfill`` job per user instead
of running the 365-day backfill inline inside an HTTP request (which 504s past
the ACA 240s request budget on a full-history scan over ~1.2M timeseries rows).

Contract (pinned by ``tests/stride_server/test_training_load_job.py``):

- registered under ``training_load_backfill``
- when a current-version ``running_calibration`` snapshot already exists it
  REUSES it (recompute only) instead of refitting athlete baselines
- an empty activities+health DB marks the backfill complete and returns
  ``{"skipped": True, "reason": "no_source_data"}`` (not a 500) — protecting
  old empty prod dbs while stopping re-enqueue churn
- when ``only_if_missing`` and the backfill-completion marker is already set it
  returns ``skipped`` (reason ``backfill_already_complete``) without recomputing
- reports ``stage="training_load"`` progress via ``heartbeat`` (throttled,
  monotonic, final 100)
"""

from __future__ import annotations

import json
import logging
from typing import Any

from stride_storage.interfaces.jobs import JobRecord

from stride_server.jobs.registry import job_handler

logger = logging.getLogger(__name__)

TRAINING_LOAD_BACKFILL_JOB_TYPE = "training_load_backfill"

# Heartbeat only when progress crosses this bucket so a year-long backfill
# doesn't fire two Azure state/queue writes per activity.
_HEARTBEAT_STEP_PCT = 5


def _job_input(job: JobRecord) -> dict[str, Any]:
    if not job.input_json:
        return {}
    try:
        payload = json.loads(job.input_json)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _has_source_data(db: Any) -> bool:
    return db.get_activity_count() > 0 or db.fetch_latest_daily_health_date() is not None


def _has_current_snapshot(db: Any, as_of: Any) -> bool:
    from stride_storage.sqlite.calibration_connector import (
        SQLiteRunningCalibrationRepository,
    )

    repo = SQLiteRunningCalibrationRepository(db)
    repo.ensure_schema()
    return repo.fetch_latest(as_of_date=as_of) is not None


@job_handler(TRAINING_LOAD_BACKFILL_JOB_TYPE)
def handle_training_load_backfill(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    from datetime import timedelta

    from stride_core.timefmt import parse_local_day, today_shanghai
    from stride_core.training_load import (
        TRAINING_LOAD_MODEL_VERSION,
        recompute_training_load,
        refresh_training_load_calibration,
    )
    from stride_core.training_load.types import PriorLoadState
    from stride_storage.sqlite.database import Database

    uuid = job.partition_key
    payload = _job_input(job)
    as_of = parse_local_day(payload.get("as_of_date")) or today_shanghai()
    load_lookback = int(payload.get("load_lookback_days", 365) or 365)
    calibration_lookback = int(payload.get("calibration_lookback_days", 365) or 365)
    only_if_missing = bool(payload.get("only_if_missing", True))

    heartbeat(stage="training_load", progress_pct=0)
    with Database(user=uuid) as db:
        if only_if_missing and db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ):
            return {
                "skipped": True,
                "reason": "backfill_already_complete",
                "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
            }

        if not _has_source_data(db):
            # No data is not a completed backfill. Keep the marker unset so the
            # first future sync performs a full canonical rebuild rather than
            # treating this currently-empty database as permanently complete.
            return {"skipped": True, "reason": "no_source_data"}

        calibration_id: int | None = None
        threshold_speed_mps: float | None = None
        if _has_current_snapshot(db, as_of):
            # A snapshot already carries the athlete baselines — never re-fit.
            refreshed = False
        else:
            calibration = refresh_training_load_calibration(
                db, as_of_date=as_of, lookback_days=calibration_lookback
            )
            calibration_id = calibration.id
            threshold_speed_mps = calibration.threshold_speed_mps
            refreshed = True

        last_pct = {"value": -1}

        def _progress(processed: int, total: int) -> None:
            pct = 100 if total <= 0 else int(processed * 100 / total)
            if pct <= last_pct["value"]:
                return
            if pct - last_pct["value"] < _HEARTBEAT_STEP_PCT and pct < 100:
                return
            last_pct["value"] = pct
            heartbeat(stage="training_load", progress_pct=pct)

        # A full backfill rebuilds the PMC series from a zero prior inside the
        # window — never seed off an older algorithm's canonical prior state.
        load = recompute_training_load(
            db,
            start=as_of - timedelta(days=max(0, load_lookback)),
            end=as_of,
            persist=True,
            prior_state=PriorLoadState(),
            progress=_progress,
        )
        if load.daily_rows_written == 0:
            # Zero rows means the backfill produced nothing usable; do NOT mark
            # completion so a later attempt retries.
            raise RuntimeError(
                "training-load backfill produced no daily training-load rows"
            )
        if load_lookback >= 365:
            db.mark_training_load_backfill_complete(
                TRAINING_LOAD_MODEL_VERSION, as_of.isoformat()
            )

    heartbeat(stage="training_load", progress_pct=100)
    return {
        "skipped": False,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "calibration_refreshed": refreshed,
        "calibration_id": calibration_id,
        "threshold_speed_mps": threshold_speed_mps,
        "load": {
            "activities_processed": load.activities_processed,
            "daily_rows_written": load.daily_rows_written,
            "start": load.start.isoformat() if load.start else None,
            "end": load.end.isoformat() if load.end else None,
        },
    }
