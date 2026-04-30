"""Provider registry — dispatches a request to the right adapter for a user.

Per-user provider model: every user is bound to exactly one watch provider,
recorded in `data/{user_id}/config.json` as a top-level `provider` field.
Legacy users (config.json missing or no provider field) default to `'coros'`,
which is correct for all existing data — see DB migration v1's matching default.

The registry is constructed once at composition root (stride_server/main.py),
populated with one adapter per supported provider, and stored in
`app.state.registry`. Routes look up `for_user(user_id)` via a FastAPI
dependency to get the right adapter without ever importing a specific one.

Adding a new provider (Garmin/Polar/Suunto/...): build a new adapter that
implements DataSource, register it at composition root, done — no core or
route code changes.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

from .source import DataSource, ProviderInfo


# Default provider for users with no explicit setting. Matches the
# `provider TEXT NOT NULL DEFAULT 'coros'` SQL default in db.py — both are
# tied together by the assumption that all pre-multi-provider data is COROS.
DEFAULT_PROVIDER = "coros"


class UnknownProvider(KeyError):
    """Raised when ProviderRegistry.get() is called with an unregistered name."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name

    def __str__(self) -> str:
        return f"No adapter registered for provider {self.name!r}"


class ProviderRegistry:
    """In-process registry of available DataSource adapters.

    Construct one at app boot, register all known adapters, hand to
    `create_app`. `for_user(user_id)` resolves the user's configured provider
    (default `'coros'`) and returns the matching adapter.
    """

    def __init__(self) -> None:
        self._sources: dict[str, DataSource] = {}
        self._default: str | None = None

    def register(self, source: DataSource, *, default: bool = False) -> None:
        """Add an adapter. If `default=True` (or this is the first registration),
        the adapter becomes the fallback for users without an explicit provider
        setting — which currently means *everyone*, since onboarding doesn't
        write the field yet."""
        name = source.info.name
        if name in self._sources:
            raise ValueError(f"Provider {name!r} already registered")
        self._sources[name] = source
        if default or self._default is None:
            self._default = name

    def get(self, name: str) -> DataSource:
        if name not in self._sources:
            raise UnknownProvider(name)
        return self._sources[name]

    def for_user(self, user: str) -> DataSource:
        """Resolve the adapter the given user is bound to.

        Reads the user's `provider` field from config.json; falls back to the
        registry's default (typically the first registered adapter) if the
        user has no setting. Raises `UnknownProvider` if the resolved name
        isn't registered (e.g. user's config references a provider this
        deployment doesn't support).
        """
        provider = read_user_provider(user, default=self._default or DEFAULT_PROVIDER)
        return self.get(provider)

    def names(self) -> Iterable[str]:
        return self._sources.keys()

    def all_infos(self) -> list[ProviderInfo]:
        return [src.info for src in self._sources.values()]

    def default_name(self) -> str | None:
        return self._default

    def __contains__(self, name: str) -> bool:
        return name in self._sources

    def __len__(self) -> int:
        return len(self._sources)


# ─────────────────────────────────────────────────────────────────────────────
# config.json provider field — read/write helpers
# ─────────────────────────────────────────────────────────────────────────────


def _user_config_path(user: str, base_dir: Path | None = None) -> Path:
    # Imported lazily so this module stays importable without forcing the
    # `data/` directory layout into stride_core's surface area.
    from .db import USER_DATA_DIR
    return (base_dir or USER_DATA_DIR) / user / "config.json"


def read_user_provider(
    user: str,
    *,
    default: str = DEFAULT_PROVIDER,
    base_dir: Path | None = None,
) -> str:
    """Resolve the watch provider for a user.

    Returns the `provider` field from `data/{user}/config.json`, or `default`
    if:
      - config.json is missing (e.g. user freshly created, not onboarded yet)
      - config.json is malformed (corrupt JSON, not a dict)
      - config.json has no `provider` field (legacy users — pre-multi-provider)

    Never raises on file/JSON errors; returning the default is the safer
    behavior for a sync request where forcing the user through re-onboarding
    would be worse than just trying COROS.
    """
    path = _user_config_path(user, base_dir)
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    if not isinstance(data, dict):
        return default
    value = data.get("provider")
    return str(value) if value else default


def write_user_provider(
    user: str,
    provider: str,
    *,
    base_dir: Path | None = None,
) -> None:
    """Persist a user's provider preference, preserving any other fields.

    config.json is shared with adapter-specific credentials (COROS stores
    `email` / `pwd_hash` / `access_token` here today). This helper only
    touches the `provider` key; everything else round-trips unchanged.
    Creates parent directories and the file itself if missing.
    """
    path = _user_config_path(user, base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except (OSError, json.JSONDecodeError):
            data = {}
    else:
        data = {}
    data["provider"] = provider
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
