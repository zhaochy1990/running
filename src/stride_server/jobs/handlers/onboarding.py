"""Onboarding pipeline handlers executed serially in the worker process.

Pipeline order:
  health_sync → full_sync → calibration → backfill

Both watch syncs run in this one worker process. The API never opens the same
SQLite database for onboarding sync, avoiding cross-process WAL writers.
"""

from __future__ import annotations

import logging
from typing import Any

from stride_core.post_sync import run_post_sync_for_result
from stride_storage.interfaces.jobs import JobRecord

from stride_server.jobs import onboarding_notify
from stride_server.jobs.registry import job_handler

logger = logging.getLogger(__name__)


def _registry():
    """Build a provider registry in-process (mirrors main._build_registry)."""
    from coros_sync.adapter import CorosDataSource
    from garmin_sync.adapter import GarminDataSource
    from stride_core.registry import ProviderRegistry

    registry = ProviderRegistry()
    # Serial COROS detail fetch avoids concurrent token refresh overwrites.
    registry.register(CorosDataSource(jobs=1), default=True)
    registry.register(GarminDataSource())
    return registry


def _source_for(job: JobRecord):
    source = _registry().for_user(job.partition_key)
    if not source.is_logged_in(job.partition_key):
        raise RuntimeError(
            f"user {job.partition_key} not logged in to watch provider"
        )
    return source


def _heartbeat_progress(
    heartbeat: Any,
    payload: dict,
    *,
    default_stage: str,
    default_pct: int,
) -> None:
    phase = payload.get("phase")
    percent = payload.get("percent")
    heartbeat(
        stage=str(phase) if phase else default_stage,
        progress_pct=(
            int(percent) if isinstance(percent, (int, float)) else default_pct
        ),
    )


@job_handler("onboarding_health_sync")
def handle_health_sync(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Fast health sync that unlocks the dashboard before history finishes."""
    user_id = job.partition_key
    heartbeat(stage="health_sync", progress_pct=5)
    source = _source_for(job)

    def progress(payload: dict) -> None:
        _heartbeat_progress(
            heartbeat,
            payload,
            default_stage="health_sync",
            default_pct=20,
        )

    result = source.sync_user(
        user_id,
        full=False,
        mode="health_only",
        progress=progress,
    )
    run_post_sync_for_result(
        user=user_id,
        provider=source.info.name,
        operation="onboarding_health_sync",
        result=result,
        progress=progress,
    )
    heartbeat(stage="health_complete", progress_pct=100)
    return {"activities": result.activities, "health": result.health}


@job_handler("onboarding_full_sync")
def handle_full_sync(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Full historical sync, serialized after the fast health sync."""
    user_id = job.partition_key
    heartbeat(stage="syncing", progress_pct=10)
    source = _source_for(job)

    def progress(payload: dict) -> None:
        _heartbeat_progress(
            heartbeat,
            payload,
            default_stage="syncing",
            default_pct=50,
        )
        try:
            if payload.get("phase") == "activity_details":
                current = payload.get("current")
                total = payload.get("total")
                if isinstance(current, int) and isinstance(total, int):
                    onboarding_notify.publish_syncing(user_id, current, total)
        except Exception:  # noqa: BLE001 — notifications are best-effort
            pass

    result = source.sync_user(user_id, full=True, progress=progress)
    heartbeat(stage="full_sync_complete", progress_pct=80)

    logger.info(
        "onboarding full_sync %s: %s activities",
        user_id,
        result.activities,
    )
    return {"activities": result.activities, "health": result.health}


@job_handler("onboarding_calibration")
def handle_calibration(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Persist running calibration and personal bests."""
    from stride_core.pb_records import persist_personal_bests
    from stride_core.training_load import refresh_training_load_calibration
    from stride_storage.sqlite.database import Database

    user_id = job.partition_key
    heartbeat(stage="calibrating", progress_pct=50)
    with Database(user=user_id) as db:
        calibration = refresh_training_load_calibration(db, lookback_days=180)
        heartbeat(stage="personal_bests", progress_pct=60)
        try:
            persist_personal_bests(db)
        except Exception:
            logger.warning(
                "onboarding PB backfill failed for %s",
                user_id,
                exc_info=True,
            )
    return {
        "hrmax_estimate": calibration.hrmax_estimate,
        "threshold_hr": calibration.threshold_hr,
        "threshold_speed_mps": calibration.threshold_speed_mps,
    }


@job_handler("onboarding_backfill")
def handle_backfill(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Backfill current training load and ability snapshots."""
    from datetime import timedelta

    from stride_core.ability_hook import backfill_ability_snapshots
    from stride_core.timefmt import today_shanghai
    from stride_core.training_load import recompute_training_load
    from stride_storage.sqlite.database import Database

    user_id = job.partition_key
    heartbeat(stage="training_load", progress_pct=65)
    with Database(user=user_id) as db:
        as_of = today_shanghai()
        load = recompute_training_load(
            db,
            start=as_of - timedelta(days=365),
            end=as_of,
            persist=True,
        )
        heartbeat(stage="scoring", progress_pct=90)
        ability = backfill_ability_snapshots(db, days=180)

    return {
        "training_load": {
            "activities_processed": load.activities_processed,
            "daily_rows_written": load.daily_rows_written,
        },
        "ability": ability,
    }
