"""Composition root — wires watch adapters into the server at boot.

This is the only module that imports both stride_server and concrete adapters.
Adding a new provider (Garmin/Polar/...) means: build the adapter, register
it here, done — no other file changes required.
"""

from __future__ import annotations

from coros_sync.adapter import CorosDataSource
from garmin_sync.adapter import GarminDataSource
from stride_core.registry import ProviderRegistry

from stride_server.config import load_server_config

from .app import create_app


def _build_registry() -> ProviderRegistry:
    registry = ProviderRegistry()
    # jobs=1 (serial detail fetch): the onboarding full sync runs in-process in
    # the single-replica API container (1–2Gi). Parallel fetch kept 4 activity
    # details + timeseries resident at once and drove WorkingSet to the memory
    # limit → OOM (exit 137) mid-sync. Matches the worker's own jobs=1 choice
    # (see stride_server/jobs/handlers/onboarding.py). COROS also issues one
    # valid token per account, so serial fetch avoids re-login churn.
    registry.register(CorosDataSource(jobs=1), default=True)
    registry.register(GarminDataSource())
    return registry


app = create_app(_build_registry(), config=load_server_config())
