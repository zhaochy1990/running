"""One-time data migrations for Garmin-synced rows.

Garmin now shares the repo-wide activity/lap convention: distance columns store
literal metres. Historical mixed-unit repair is handled by the cross-provider
``scripts/migrate_activity_distances_to_meters.py`` migration, not during sync.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def run_garmin_migrations(db: Any) -> None:
    """Run sync-time Garmin repairs.

    No distance-unit repair runs here. The safe path is the explicit
    cross-provider migration script, first on prod dumps and then in prod.
    """
    return None
