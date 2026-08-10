from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any, Protocol


class CanonicalSeasonPlanDataUnavailable(RuntimeError):
    """Canonical MySQL season-plan context could not be loaded."""


class CanonicalSeasonPlanReader(Protocol):
    contract_version: str

    def read(self, user_id: str, *, goal_id: str | None = None, as_of: date | None = None) -> Mapping[str, Any]: ...
