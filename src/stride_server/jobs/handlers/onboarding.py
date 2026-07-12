"""Onboarding pipeline step handlers.

Three sequential jobs, orchestrated by the pipeline layer:
  full_sync   → onboarding_calibration → onboarding_backfill

Each runs in the worker process (no FastAPI request). Following the no-request
patterns in ``routes/sync.py::_run_sync`` and ``routes/training_load.py``:
build a registry in-process, open ``Database(user=...)`` directly.

``job.partition_key`` is the user_id. Onboarding is pure sync + one unified
compute pass — the sync step deliberately does NOT run the incremental
post-sync chain (that逐条 recompute would be wasteful on a full historical
pull and would compute ability before calibration exists). The backfill step
then writes training-load + ability rows once the calibration snapshot exists.
Daily incremental sync keeps its post-sync chain unchanged.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from stride_storage.interfaces.jobs import JobRecord

from stride_server.jobs import onboarding_notify
from stride_server.jobs.registry import job_handler

logger = logging.getLogger(__name__)


def _registry():
    """Build a provider registry in-process (mirrors main._build_registry)."""
    from coros_sync.adapter import CorosDataSource
    from garmin_sync.adapter import GarminDataSource
    from stride_core.registry import ProviderRegistry

    reg = ProviderRegistry()
    reg.register(CorosDataSource(), default=True)
    reg.register(GarminDataSource())
    return reg


@job_handler("onboarding_full_sync")
def handle_full_sync(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Step 1 — full historical watch sync. Pure sync, no post-sync chain.

    Full sync of 3+ years is minutes-long — longer than a single queue
    visibility window. We drive ``heartbeat`` from the sync's own progress
    callback so every synced page both reports progress AND renews the queue
    lease (the worker's heartbeat extends visibility), preventing mid-sync
    re-delivery + a duplicate run.
    """
    uuid = job.partition_key
    heartbeat(stage="syncing", progress_pct=10)
    source = _registry().for_user(uuid)
    if not source.is_logged_in(uuid):
        raise RuntimeError(f"user {uuid} not logged in to watch provider")

    def _progress(payload: dict) -> None:
        # Every sync progress tick (a) renews the queue lease via heartbeat so a
        # multi-minute full sync isn't re-delivered mid-flight, and (b) surfaces
        # live sync progress to the notification center. Both are best-effort — a
        # progress update must never abort the sync.
        try:
            phase = payload.get("phase")
            percent = payload.get("percent")
            heartbeat(
                stage=str(phase) if phase else "syncing",
                progress_pct=int(percent) if isinstance(percent, (int, float)) else 50,
            )
        except Exception:  # noqa: BLE001
            pass
        # The activity-details phase carries current/total (e.g. 59/783) — the
        # only place with a real count for the "当前进度 59/783" message.
        try:
            if payload.get("phase") == "activity_details":
                current = payload.get("current")
                total = payload.get("total")
                if isinstance(current, int) and isinstance(total, int):
                    onboarding_notify.publish_syncing(uuid, current, total)
        except Exception:  # noqa: BLE001
            pass

    result = source.sync_user(uuid, full=True, progress=_progress)
    logger.info("onboarding full_sync %s: %s activities", uuid, result.activities)
    return {"activities": result.activities, "health": result.health}


@job_handler("onboarding_calibration")
def handle_calibration(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Step 2 — persist running-calibration snapshot (writes HRmax) + PBs.

    Personal bests only depend on the synced activities (not on calibration or
    ability), so they're computed here alongside calibration rather than waiting
    for the backfill step.
    """
    from stride_core.pb_records import persist_personal_bests
    from stride_core.training_load import refresh_training_load_calibration
    from stride_storage.sqlite.database import Database

    uuid = job.partition_key
    heartbeat(stage="calibrating", progress_pct=50)
    with Database(user=uuid) as db:
        cal = refresh_training_load_calibration(db, lookback_days=180)
        heartbeat(stage="personal_bests", progress_pct=60)
        try:
            persist_personal_bests(db)
        except Exception:
            logger.warning("onboarding PB backfill failed for %s", uuid, exc_info=True)
    return {
        "hrmax_estimate": cal.hrmax_estimate,
        "threshold_hr": cal.threshold_hr,
        "threshold_speed_mps": cal.threshold_speed_mps,
    }


@job_handler("onboarding_backfill")
def handle_backfill(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Step 3 — training-load and ability snapshot backfill.

    Calibration exists now, so training status can be materialized and ability
    reads a real HRmax. No commentary (expensive; generated lazily elsewhere).
    """
    from stride_core.ability_hook import backfill_ability_snapshots
    from stride_core.training_load import recompute_training_load
    from stride_core.timefmt import today_shanghai
    from stride_storage.sqlite.database import Database

    uuid = job.partition_key
    heartbeat(stage="training_load", progress_pct=65)
    with Database(user=uuid) as db:
        today = today_shanghai()
        load = recompute_training_load(db, start=today - timedelta(days=180), end=today)
        heartbeat(stage="scoring", progress_pct=80)
        ability = backfill_ability_snapshots(db, days=180)
    return {
        "training_load": {
            "activities_processed": load.activities_processed,
            "activity_rows_written": load.activity_rows_written,
            "daily_rows_written": load.daily_rows_written,
        },
        "ability": ability,
    }
