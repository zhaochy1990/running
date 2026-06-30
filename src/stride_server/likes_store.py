"""Likes storage — server-side facade.

The real implementation (file + Azure Table backends, ``LikeEntity``,
validators, ``backend_from_config``) now lives in the unified data-access
package ``stride_storage``. This module keeps only the *server* concerns:
resolving ``LikesStorageConfig`` from ``ServerConfig`` (TOML/env/Key Vault),
caching the chosen backend, and exposing the module-level functions that the
route handlers call.

Re-exports ``LikeEntity`` / ``like_partition`` / ``backend_from_config`` /
validators so existing ``from stride_server.likes_store import ...`` call
sites keep working unchanged.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Iterable

from stride_server.config import clear_server_config_cache, load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, LikesStorageConfig, ServerConfig
from stride_server.config.sources import env_source

# Implementation lives in stride_storage; re-exported for backward-compat.
from stride_storage.azure.likes_backend import (  # noqa: F401  (re-export)
    DEFAULT_TABLE_NAME,
    AzureTableLikesBackend,
    FileLikesBackend,
    backend_from_config,
    like_partition,
    _LABEL_ID_RE,
    _TEAM_ID_RE,
    _UUID4_RE,
    _validate_label_id,
    _validate_team_id,
    _validate_user_id,
)
from stride_storage.interfaces.likes import LikeEntity, LikesBackend  # noqa: F401

logger = logging.getLogger(__name__)

ACCOUNT_URL_ENV = "STRIDE_LIKES_TABLE_ACCOUNT_URL"
TABLE_NAME_ENV = "STRIDE_LIKES_TABLE_NAME"


# ---------------------------------------------------------------------------
# Config resolution + cached backend (server policy — stays here)
# ---------------------------------------------------------------------------


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _likes_config_from_env() -> LikesStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).storage.likes
    storage = env_source().get("storage", {})
    likes = storage.get("likes", {}) if isinstance(storage, dict) else {}
    if isinstance(likes, dict):
        return config.with_updates(**likes)
    return config


def _likes_config() -> LikesStorageConfig:
    try:
        return load_server_config().storage.likes
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _likes_config_from_env()


@lru_cache(maxsize=1)
def _get_backend() -> LikesBackend:
    return backend_from_config(_likes_config())


def reset_backend_cache() -> None:
    """Test helper — drop the cached backend so env changes take effect."""
    _get_backend.cache_clear()
    clear_server_config_cache()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def put_like(
    *,
    team_id: str,
    owner_user_id: str,
    label_id: str,
    liker_user_id: str,
    liker_display_name: str,
) -> LikeEntity:
    """Idempotent like — re-pressing the button overwrites the same row."""
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_user_id(liker_user_id)
    _validate_label_id(label_id)
    entity = LikeEntity(
        team_id=team_id,
        owner_user_id=owner_user_id,
        label_id=label_id,
        liker_user_id=liker_user_id,
        liker_display_name=(liker_display_name or "").strip()[:200],
        created_at=_now_iso(),
    )
    _get_backend().put(entity)
    return entity


def delete_like(
    *,
    team_id: str,
    owner_user_id: str,
    label_id: str,
    liker_user_id: str,
) -> bool:
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_user_id(liker_user_id)
    _validate_label_id(label_id)
    return _get_backend().delete(team_id, owner_user_id, label_id, liker_user_id)


def list_likes(
    *, team_id: str, owner_user_id: str, label_id: str,
) -> list[LikeEntity]:
    _validate_team_id(team_id)
    _validate_user_id(owner_user_id)
    _validate_label_id(label_id)
    return _get_backend().list_for_activity(team_id, owner_user_id, label_id)


def list_likes_bulk(
    *, team_id: str, targets: Iterable[tuple[str, str]],
) -> dict[tuple[str, str], list[LikeEntity]]:
    """Bulk lookup for feed enrichment, scoped to a single team.

    Invalid targets are silently skipped (so one bad activity row doesn't break
    the entire feed).
    """
    _validate_team_id(team_id)
    cleaned: list[tuple[str, str]] = []
    for owner, label in targets:
        try:
            _validate_user_id(owner)
            _validate_label_id(label)
        except ValueError:
            continue
        cleaned.append((owner, label))
    return _get_backend().list_bulk(team_id, cleaned)
