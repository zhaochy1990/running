"""DataSource protocol — pluggable boundary between server and watch adapters.

Multi-provider design (COROS today, Garmin/Polar/Suunto in the future):

  - Adapters implement `DataSource` (typically by inheriting `BaseDataSource`)
    and declare which optional features they support via `info.capabilities`.
  - Translation between provider-specific encodings and our normalized
    domain (`NormalizedSport`, `NormalizedRunWorkout`, …) happens at the
    adapter boundary; stride_core never sees provider quirks.
  - Optional methods (`push_run_workout`, `query_exercises`, …) raise
    `FeatureNotSupported` when the adapter has not declared the matching
    capability. Callers should either check `info.capabilities` first, or
    catch the exception.

Per-user provider model:

  Each user is bound to exactly one provider. The user's provider name is
  stored in their config and used by the `ProviderRegistry` (set up in a
  follow-up task) to dispatch each request to the correct adapter.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, TypeAlias, runtime_checkable

from .workout_spec import NormalizedRunWorkout, NormalizedStrengthWorkout


# ─────────────────────────────────────────────────────────────────────────────
# Sync progress + result (kept stable for back-compat with existing callers)
# ─────────────────────────────────────────────────────────────────────────────


SyncProgress: TypeAlias = dict[str, Any]
SyncProgressCallback: TypeAlias = Callable[[SyncProgress], None]


@dataclass
class SyncResult:
    """Summary of a sync run."""
    activities: int
    health: int


# ─────────────────────────────────────────────────────────────────────────────
# Capabilities & provider info
# ─────────────────────────────────────────────────────────────────────────────


class Capability(str, Enum):
    """Optional features an adapter may support.

    Required features (sync activities, sync basic health) are not capabilities;
    every adapter must implement them. Capabilities cover features that some
    adapters genuinely cannot provide (e.g. an official Garmin Health API
    integration is read-only and cannot push workouts).
    """

    SYNC_HRV_DETAIL        = "sync_hrv_detail"      # daily HRV trend (vs only nightly snapshot)
    SYNC_SLEEP             = "sync_sleep"
    SYNC_BODY_BATTERY      = "sync_body_battery"    # Garmin-style readiness gauge
    PUSH_RUN_WORKOUT       = "push_run_workout"
    PUSH_STRENGTH_WORKOUT  = "push_strength_workout"
    DELETE_WORKOUT         = "delete_workout"
    QUERY_SCHEDULE         = "query_schedule"
    EXERCISE_CATALOG       = "exercise_catalog"
    CUSTOM_EXERCISE        = "custom_exercise"
    WRITE_SPORT_NOTE       = "write_sport_note"     # most APIs are read-only for notes


@dataclass(frozen=True)
class ProviderInfo:
    """Static description of an adapter."""

    name: str                                  # canonical lowercase: "coros", "garmin"
    display_name: str                          # localized: "高驰", "佳明"
    regions: tuple[str, ...]                   # supported login regions, e.g. ("global", "cn")
    capabilities: frozenset[Capability]


# ─────────────────────────────────────────────────────────────────────────────
# Auth
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LoginCredentials:
    """Provider-agnostic login payload.

    `extra` is an escape hatch for provider-specific bits (Garmin SSO ticket,
    pairing code, MFA token, etc.).
    """

    email: str
    password: str
    region: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LoginResult:
    """Outcome of a login call. Tokens are persisted by the adapter side."""

    success: bool
    user_id: str | None = None
    region: str | None = None
    message: str | None = None


# ─────────────────────────────────────────────────────────────────────────────
# Schedule queries (read-side companion to push_*_workout)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScheduledWorkoutSummary:
    """Light-weight summary of a workout already on the watch's schedule."""

    date: str                  # ISO YYYY-MM-DD
    name: str
    sport: str                 # NormalizedSport.value
    provider_workout_id: str   # the watch-side ID
    is_stride_managed: bool    # heuristic: name has the "[STRIDE]" prefix


# ─────────────────────────────────────────────────────────────────────────────
# Exceptions
# ─────────────────────────────────────────────────────────────────────────────


class FeatureNotSupported(Exception):
    """Raised when an adapter is asked to do something its capabilities don't include."""

    def __init__(self, provider: str, capability: Capability) -> None:
        super().__init__(f"{provider!r} does not support {capability.value!r}")
        self.provider = provider
        self.capability = capability


class AuthRequired(Exception):
    """Raised when an adapter call is made for a user without valid credentials."""


# ─────────────────────────────────────────────────────────────────────────────
# Protocol
# ─────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class DataSource(Protocol):
    """Watch-data source adapter contract.

    Implementations must be safe to call from a FastAPI request handler:
    they may hit the network and open per-user sqlite connections, and must
    translate adapter-specific errors into return values or exceptions the
    server layer can surface.

    Required: `name`, `info`, `is_logged_in`, `sync_user`, `resync_activity`.
    All other methods are optional; concrete adapters that don't support them
    should inherit `BaseDataSource` (which provides default `FeatureNotSupported`
    raises) or implement equivalent stubs.
    """

    name: str  # back-compat: equal to info.name; new code should prefer info

    @property
    def info(self) -> ProviderInfo: ...

    # ── auth ────────────────────────────────────────────────────────────────
    def is_logged_in(self, user: str) -> bool: ...
    def login(self, user: str, creds: LoginCredentials) -> LoginResult: ...
    def logout(self, user: str) -> None: ...

    # ── sync ────────────────────────────────────────────────────────────────
    def sync_user(
        self,
        user: str,
        *,
        full: bool = False,
        progress: SyncProgressCallback | None = None,
    ) -> SyncResult: ...

    def resync_activity(self, user: str, label_id: str) -> bool: ...

    # ── workout push (optional, capability-gated) ───────────────────────────
    def push_run_workout(self, user: str, workout: NormalizedRunWorkout) -> str: ...
    def push_strength_workout(self, user: str, workout: NormalizedStrengthWorkout) -> str: ...
    def delete_scheduled_workout(
        self, user: str, date: str, name: str | None = None,
    ) -> bool: ...
    def query_schedule(
        self, user: str, start: str, end: str
    ) -> list[ScheduledWorkoutSummary]: ...

    # ── exercise catalog (optional, capability-gated) ───────────────────────
    def query_exercises(self, user: str, sport: str) -> list[dict[str, Any]]: ...
    def add_custom_exercise(self, user: str, exercise: dict[str, Any]) -> str: ...


# ─────────────────────────────────────────────────────────────────────────────
# BaseDataSource — concrete base with default unsupported impls
# ─────────────────────────────────────────────────────────────────────────────


class BaseDataSource:
    """Default adapter base class.

    Subclasses override only the methods matching their declared capabilities.
    Optional methods raise `FeatureNotSupported` by default, surfacing missing
    implementations cleanly at the call site rather than via `AttributeError`
    or silent no-op.

    Subclasses MUST set `name` and override `info` (to declare capabilities)
    plus the required methods (`is_logged_in`, `sync_user`, `resync_activity`,
    `login`).

    There is intentionally no metaprogramming sanity-check that capabilities
    match overridden methods — adapters are unit-tested separately.
    """

    name: str = "unknown"

    @property
    def info(self) -> ProviderInfo:
        return ProviderInfo(
            name=self.name,
            display_name=self.name,
            regions=(),
            capabilities=frozenset(),
        )

    # ── auth (subclasses must implement login + is_logged_in) ───────────────
    def is_logged_in(self, user: str) -> bool:
        raise NotImplementedError

    def login(self, user: str, creds: LoginCredentials) -> LoginResult:
        raise NotImplementedError

    def logout(self, user: str) -> None:
        # Default: silent no-op. Most adapters either delete the local
        # creds file or invalidate a server-side token; subclasses override.
        return None

    # ── sync (required) ─────────────────────────────────────────────────────
    def sync_user(
        self,
        user: str,
        *,
        full: bool = False,
        progress: SyncProgressCallback | None = None,
    ) -> SyncResult:
        raise NotImplementedError

    def resync_activity(self, user: str, label_id: str) -> bool:
        raise NotImplementedError

    # ── workout push (optional, raise FeatureNotSupported by default) ──────
    def push_run_workout(self, user: str, workout: NormalizedRunWorkout) -> str:
        raise FeatureNotSupported(self.name, Capability.PUSH_RUN_WORKOUT)

    def push_strength_workout(self, user: str, workout: NormalizedStrengthWorkout) -> str:
        raise FeatureNotSupported(self.name, Capability.PUSH_STRENGTH_WORKOUT)

    def delete_scheduled_workout(
        self, user: str, date: str, name: str | None = None,
    ) -> bool:
        """Delete previously-pushed [STRIDE] workouts on ``date``.

        Args:
            name: Optional exact-match filter on the program name. When
                provided, only entries whose program name == ``name`` are
                deleted (e.g. only the prior push of THIS session). When
                ``None``, all ``[STRIDE]``-prefixed entries on the date
                are removed (legacy aggressive sweep — CLI use).
        """
        raise FeatureNotSupported(self.name, Capability.DELETE_WORKOUT)

    def query_schedule(
        self, user: str, start: str, end: str
    ) -> list[ScheduledWorkoutSummary]:
        raise FeatureNotSupported(self.name, Capability.QUERY_SCHEDULE)

    # ── exercise catalog (optional) ─────────────────────────────────────────
    def query_exercises(self, user: str, sport: str) -> list[dict[str, Any]]:
        raise FeatureNotSupported(self.name, Capability.EXERCISE_CATALOG)

    def add_custom_exercise(self, user: str, exercise: dict[str, Any]) -> str:
        raise FeatureNotSupported(self.name, Capability.CUSTOM_EXERCISE)


# ─────────────────────────────────────────────────────────────────────────────
# Convenience: capability check helper for callers
# ─────────────────────────────────────────────────────────────────────────────


def require_capability(source: DataSource, capability: Capability) -> None:
    """Raise FeatureNotSupported up-front if the source doesn't declare a capability.

    Useful for routes/CLI commands that want to fail fast with a clean error
    before doing any work.
    """
    if capability not in source.info.capabilities:
        raise FeatureNotSupported(source.info.name, capability)
