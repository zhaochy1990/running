"""Athlete long-term memory store — back-compat shim.

The implementation now lives in ``stride_storage.azure.athlete_memory_backend``.
Re-exported here so existing ``from stride_server.athlete_memory_store import
...`` call sites (coach_runtime, tests) keep working unchanged.
"""

from __future__ import annotations

from stride_storage.azure.athlete_memory_backend import (  # noqa: F401  (re-export)
    AthleteMemoryStore,
    AzureTableAthleteMemoryBackend,
    FileAthleteMemoryBackend,
    backend_from_config,
)

__all__ = [
    "AthleteMemoryStore",
    "AzureTableAthleteMemoryBackend",
    "FileAthleteMemoryBackend",
    "backend_from_config",
]
