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
    """Step 1 — full historical watch sync. Pure sync, no post-sync chain."""
    uuid = job.partition_key
    heartbeat(stage="syncing", progress_pct=10)
    source = _registry().for_user(uuid)
    if not source.is_logged_in(uuid):
        raise RuntimeError(f"user {uuid} not logged in to watch provider")
    result = source.sync_user(uuid, full=True)
    logger.info("onboarding full_sync %s: %s activities", uuid, result.activities)
    return {"activities": result.activities, "health": result.health}


@job_handler("onboarding_calibration")
def handle_calibration(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Step 2 — persist running-calibration snapshot (writes HRmax)."""
    from stride_core.training_load import refresh_training_load_calibration
    from stride_storage.sqlite.database import Database

    uuid = job.partition_key
    heartbeat(stage="calibrating", progress_pct=50)
    with Database(user=uuid) as db:
        cal = refresh_training_load_calibration(db, lookback_days=180)
    return {
        "hrmax_estimate": cal.hrmax_estimate,
        "threshold_hr": cal.threshold_hr,
        "threshold_speed_mps": cal.threshold_speed_mps,
    }


@job_handler("onboarding_backfill")
def handle_backfill(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Step 3 — unified derived-data compute (ability + zones + PBs).

    Calibration exists now, so ability reads a real HRmax. No commentary
    (expensive; generated lazily elsewhere).
    """
    from stride_core.ability_hook import backfill_ability_snapshots
    from stride_core.pb_records import persist_personal_bests
    from stride_storage.sqlite.database import Database

    uuid = job.partition_key
    heartbeat(stage="scoring", progress_pct=70)
    with Database(user=uuid) as db:
        ability = backfill_ability_snapshots(db, days=180)
        heartbeat(stage="personal_bests", progress_pct=90)
        try:
            persist_personal_bests(db)
        except Exception:
            logger.warning("onboarding PB backfill failed for %s", uuid, exc_info=True)
    return {"ability": ability}
