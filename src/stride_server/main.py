"""Composition root — wires CorosDataSource into the server at boot.

This is the only module that imports both stride_server and a specific adapter.
Swapping adapters (e.g., to add Garmin) means changing this file only.
"""

from __future__ import annotations

from coros_sync.adapter import CorosDataSource

from .app import create_app

app = create_app(CorosDataSource())
