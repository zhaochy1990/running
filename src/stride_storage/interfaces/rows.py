"""Backend-neutral row shape exposed by SQL storage adapters."""

from __future__ import annotations

from typing import Any

type StorageRow = dict[str, Any]
