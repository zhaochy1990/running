"""Unified onboarding compute pass: calibration + PBs, then load/ability backfill.

Shared by both onboarding sync paths so they produce identical baselines:
  - the async worker pipeline (`stride_server.jobs.handlers.onboarding`), and
  - the synchronous API-process onboarding sync (`stride_server.routes.onboarding`).

This is a single unified pass, NOT the per-activity post-sync chain: that chain
is wasteful on a full historical pull and would score ability before calibration
exists. Order matters — calibration (which persists HRmax / threshold) must run
before the backfill, whose ability scoring reads that calibration.

No DB writes are opened here beyond what the passed-in `db` already owns; the
caller is responsible for holding the per-user SQLite writer lock so the API and
worker never write the same `coros.db` concurrently.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

logger = logging.getLogger(__name__)

# Calibration lookback and the training-load warmup / ability backfill windows.
# Kept as module constants so both call sites stay byte-identical.
CALIBRATION_LOOKBACK_DAYS = 180
TRAINING_LOAD_WARMUP_DAYS = 365
ABILITY_BACKFILL_DAYS = 180


def compute_onboarding_calibration(db: Any) -> Any:
    """Persist the running-calibration snapshot (HRmax / threshold) + personal bests.

    Personal bests only depend on the synced activities (not on calibration or
    ability), so they're computed here alongside calibration rather than in the
    backfill step. Returns the calibration snapshot.
    """
    from stride_core.pb_records import persist_personal_bests
    from stride_core.training_load import refresh_training_load_calibration

    cal = refresh_training_load_calibration(db, lookback_days=CALIBRATION_LOOKBACK_DAYS)
    try:
        persist_personal_bests(db)
    except Exception:
        logger.warning("onboarding PB backfill failed", exc_info=True)
    return cal


def compute_onboarding_backfill(db: Any) -> dict[str, Any]:
    """Warm the chronic-load EWMA over 365 days, then backfill ability snapshots.

    Calibration must already be persisted (see :func:`compute_onboarding_calibration`)
    so this one bounded pass warms the 42-day chronic-load EWMA without refitting
    athlete baselines, and ability then reads the same persisted calibration.
    Returns a summary dict of what was written.
    """
    from stride_core.ability_hook import backfill_ability_snapshots
    from stride_core.timefmt import today_shanghai
    from stride_core.training_load import recompute_training_load

    as_of = today_shanghai()
    load = recompute_training_load(
        db,
        start=as_of - timedelta(days=TRAINING_LOAD_WARMUP_DAYS),
        end=as_of,
        persist=True,
    )
    ability = backfill_ability_snapshots(db, days=ABILITY_BACKFILL_DAYS)
    return {
        "training_load": {
            "activities_processed": load.activities_processed,
            "daily_rows_written": load.daily_rows_written,
        },
        "ability": ability,
    }


__all__ = [
    "ABILITY_BACKFILL_DAYS",
    "CALIBRATION_LOOKBACK_DAYS",
    "TRAINING_LOAD_WARMUP_DAYS",
    "compute_onboarding_backfill",
    "compute_onboarding_calibration",
]
