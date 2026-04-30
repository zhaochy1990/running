"""Composition root — wires watch adapters into the server at boot.

This is the only module that imports both stride_server and concrete adapters.
Adding a new provider (Garmin/Polar/...) means: build the adapter, register
it here, done — no other file changes required.
"""

from __future__ import annotations

from coros_sync.adapter import CorosDataSource
from garmin_sync.adapter import GarminDataSource
from stride_core.registry import ProviderRegistry

from .app import create_app


def _build_registry() -> ProviderRegistry:
    registry = ProviderRegistry()
    registry.register(CorosDataSource(), default=True)
    registry.register(GarminDataSource())
    return registry


app = create_app(_build_registry())
