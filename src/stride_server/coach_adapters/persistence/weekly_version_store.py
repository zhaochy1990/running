"""Shim — moved to stride_storage.coach_persistence.weekly_version_store.

The ``weekly_version_store_from_env`` factory (which loads ServerConfig) stays
server-side to keep stride_storage free of a stride_server dependency.
"""

from stride_storage.coach_persistence.weekly_version_store import *  # noqa: F401,F403
from stride_storage.coach_persistence.weekly_version_store import (  # noqa: F401
    WeeklyVersionStore,
    weekly_version_store_from_config,
)


def weekly_version_store_from_env() -> WeeklyVersionStore:
    from stride_server.config import load_server_config

    return weekly_version_store_from_config(load_server_config().coach_persistence)
