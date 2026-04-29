"""DataSource protocol — the pluggable boundary between server and watch adapters.

Any watch-sync adapter (COROS today, potentially Garmin/Suunto later) implements
this Protocol. The server wires a concrete adapter at composition-root time and
exposes it to routes via request.app.state.source — so routes never import a
specific adapter.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol, TypeAlias, runtime_checkable


SyncProgress: TypeAlias = dict[str, Any]
SyncProgressCallback: TypeAlias = Callable[[SyncProgress], None]


@dataclass
class SyncResult:
    """Summary of a sync run."""
    activities: int
    health: int


@runtime_checkable
class DataSource(Protocol):
    """Watch-data source adapter contract.

    Implementations must be safe to call from a FastAPI request handler:
    they may hit the network, open per-user sqlite connections, and must
    translate adapter-specific errors into return values or raise exceptions
    the server layer can surface.
    """

    name: str

    def sync_user(
        self,
        user: str,
        *,
        full: bool = False,
        progress: SyncProgressCallback | None = None,
    ) -> SyncResult:
        """Run a full or incremental sync for the given user profile."""
        ...

    def resync_activity(self, user: str, label_id: str) -> bool:
        """Re-fetch and upsert a single activity. Returns True on success."""
        ...

    def is_logged_in(self, user: str) -> bool:
        """Cheap check whether the user has valid credentials for this source."""
        ...
