"""Shim — moved to stride_storage.coach_persistence.jobs_store.

The ``jobs_store_from_env`` factory (which loads ServerConfig) stays server-side
to keep stride_storage free of a stride_server dependency.
"""

from stride_storage.coach_persistence.jobs_store import *  # noqa: F401,F403
from stride_storage.coach_persistence.jobs_store import (  # noqa: F401
    JobsStore,
    jobs_store_from_config,
)


def jobs_store_from_env() -> JobsStore:
    from stride_server.config import load_server_config

    return jobs_store_from_config(load_server_config().coach_persistence)
