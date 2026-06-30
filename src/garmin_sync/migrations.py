"""One-time data migrations for Garmin-synced rows.

These repair rows written by older sync code, keyed on ``sync_meta`` flags so
each runs at most once per user DB (idempotent — a second call is a no-op).
``sync_user`` invokes :func:`run_garmin_migrations` before pulling new data so
existing DBs self-heal on the next sync.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Garmin's API returns distance in METRES; `garmin_sync.models` divides by 1000
# to store kilometres in `activities.distance_m` (the repo-wide convention — see
# CLAUDE.md "activities.distance_m holds KM"). That conversion landed
# 2026-05-10 (commit d72d69f); rows synced BEFORE the fix deployed still hold raw
# metres, so a single DB mixes units (a marathon reads 42609 instead of 42.6).
# That breaks weekly-volume aggregation and marathon PB matching. Any garmin row
# synced before the deploy is metres; rows synced after are already km.
_DISTANCE_FIX_CUTOFF = "2026-05-15"  # after the last pre-fix sync, before the first post-fix sync
_DISTANCE_FIX_FLAG = "garmin_distance_units_m_to_km_v1"


def migrate_distance_units_m_to_km(db: Any) -> int:
    """Convert legacy metres → km for pre-fix Garmin activity rows. Idempotent.

    Returns the number of rows updated (0 if already migrated / nothing to fix).
    Keyed on ``synced_at`` (set server-side at write time, so a row re-synced
    after the fix carries a post-cutoff timestamp and the correct km value, and
    is left alone). The ``sync_meta`` flag guarantees the divide runs only once.
    """
    if db.get_meta(_DISTANCE_FIX_FLAG):
        return 0

    cur = db._conn.execute(
        "UPDATE activities SET distance_m = distance_m / 1000.0 "
        "WHERE provider = 'garmin' AND synced_at < ? AND distance_m > 0",
        (_DISTANCE_FIX_CUTOFF,),
    )
    updated = cur.rowcount or 0
    db._conn.commit()
    db.set_meta(_DISTANCE_FIX_FLAG, "1")
    if updated:
        logger.info(
            "garmin distance migration: converted %d legacy metre rows to km", updated
        )
    return updated


def run_garmin_migrations(db: Any) -> None:
    """Run all one-time Garmin repairs. Each is individually flag-guarded."""
    try:
        migrate_distance_units_m_to_km(db)
    except Exception:  # noqa: BLE001 — a migration must never block a sync
        logger.warning("garmin distance migration failed; continuing sync", exc_info=True)
