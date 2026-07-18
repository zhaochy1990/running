"""Onboarding pipeline step handlers.

Three sequential jobs, orchestrated by the pipeline layer:
  full_sync   → onboarding_calibration → onboarding_backfill

Each runs in the worker process (no FastAPI request). Following the no-request
patterns in ``routes/sync.py::_run_sync`` and ``routes/training_load.py``:
build a registry in-process, open ``Database(user=...)`` directly.

``job.partition_key`` is the user_id. Onboarding is pure sync + one unified
compute pass — the sync step deliberately does NOT run the incremental
post-sync chain (that逐条 recompute would be wasteful on a full historical
pull and would compute ability before calibration exists). Daily incremental
sync keeps its post-sync chain unchanged.
"""

from __future__ import annotations

import logging
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
    # jobs=1 (serial detail fetch) for onboarding: COROS allows only one valid
    # access token per account, and the concurrent fetch threads share a single
    # Credentials object. Parallel fetches each hit an expired token, re-login,
    # and overwrite each other's token → a re-login storm that stalls the sync
    # (observed: full_sync wedging ~1/4 of the way through and never finishing).
    # Serial fetch is slower but avoids the token contention entirely.
    reg.register(CorosDataSource(jobs=1), default=True)
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
    """Step 3 — current training-load and ability snapshot backfill.

    Calibration exists now, so one bounded 365-day pass can warm up the
    42-day chronic-load EWMA without refitting athlete baselines. Ability then
    reads the same persisted calibration. No commentary (expensive; generated
    lazily elsewhere).
    """
    from datetime import timedelta

    from stride_core.ability_hook import backfill_ability_snapshots
    from stride_core.timefmt import today_shanghai
    from stride_core.training_load import recompute_training_load
    from stride_storage.sqlite.database import Database

    uuid = job.partition_key
    heartbeat(stage="training_load", progress_pct=65)
    with Database(user=uuid) as db:
        as_of = today_shanghai()
        load = recompute_training_load(
            db,
            start=as_of - timedelta(days=365),
            end=as_of,
            persist=True,
        )
        heartbeat(stage="scoring", progress_pct=70)
        ability = backfill_ability_snapshots(db, days=180)
    return {
        "training_load": {
            "activities_processed": load.activities_processed,
            "daily_rows_written": load.daily_rows_written,
        },
        "ability": ability,
    }
