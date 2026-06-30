"""Content storage — server-side facade.

The read/write/list primitives now live in ``stride_storage.content.store``
(pure: they take a resolved ``ContentStorageConfig`` + an injected blob
container-client factory). This module keeps the *server* concerns: resolving
``ContentStorageConfig`` from ``ServerConfig`` and supplying the real Azure
blob factory (``stride_storage.azure.blob_backend.get_container_client``).

``_container_client`` stays a module attribute here so the existing test seam
``monkeypatch.setattr(content_store, "_container_client", fake)`` keeps working.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from stride_server.config import load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, ContentStorageConfig, ServerConfig
from stride_server.config.sources import env_source

# Real blob backend (Azure) + pure primitives live in stride_storage.
from stride_storage.azure.blob_backend import get_container_client as _container_client
from stride_storage.content import store as _store
from stride_storage.content.store import ContentItem  # noqa: F401  (re-export)

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

ACCOUNT_URL_ENV = "STRIDE_CONTENT_BLOB_ACCOUNT_URL"
CONTAINER_ENV = "STRIDE_CONTENT_BLOB_CONTAINER"
PREFIX_ENV = "STRIDE_CONTENT_BLOB_PREFIX"
DEFAULT_PREFIX = "users"


# ---------------------------------------------------------------------------
# Config resolution (server policy — stays here)
# ---------------------------------------------------------------------------


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _content_config_from_env() -> ContentStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).storage.content
    storage = env_source().get("storage", {})
    content = storage.get("content", {}) if isinstance(storage, dict) else {}
    if isinstance(content, dict):
        return config.with_updates(**content)
    return config


def _content_config(config: ContentStorageConfig | None = None) -> ContentStorageConfig:
    if config is not None:
        return config
    try:
        return load_server_config().storage.content
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _content_config_from_env()


# ---------------------------------------------------------------------------
# Public API — resolve config + inject the blob factory, delegate to stride_storage
# ---------------------------------------------------------------------------


def read_text(
    relative_path: str,
    *,
    config: ContentStorageConfig | None = None,
) -> ContentItem | None:
    return _store.read_text(
        relative_path,
        config=_content_config(config),
        container_client=_container_client,
    )


def write_text(
    relative_path: str,
    content: str,
    *,
    content_type: str = "text/plain; charset=utf-8",
    config: ContentStorageConfig | None = None,
) -> str:
    return _store.write_text(
        relative_path,
        content,
        config=_content_config(config),
        container_client=_container_client,
        content_type=content_type,
    )


def read_json(
    relative_path: str,
    *,
    config: ContentStorageConfig | None = None,
) -> tuple[Any, str] | None:
    return _store.read_json(
        relative_path,
        config=_content_config(config),
        container_client=_container_client,
    )


def write_json(
    relative_path: str,
    data: Any,
    *,
    config: ContentStorageConfig | None = None,
) -> str:
    return _store.write_json(
        relative_path,
        data,
        config=_content_config(config),
        container_client=_container_client,
    )


def exists(
    relative_path: str,
    *,
    config: ContentStorageConfig | None = None,
) -> bool:
    return _store.exists(
        relative_path,
        config=_content_config(config),
        container_client=_container_client,
    )


def list_week_folders(
    user: str,
    *,
    config: ContentStorageConfig | None = None,
) -> list[str]:
    return _store.list_week_folders(
        user,
        config=_content_config(config),
        container_client=_container_client,
    )


def any_exists(
    relative_paths: Iterable[str],
    *,
    config: ContentStorageConfig | None = None,
) -> bool:
    return _store.any_exists(
        relative_paths,
        config=_content_config(config),
        container_client=_container_client,
    )


def list_files_in_folder(
    relative_dir: str,
    *,
    config: ContentStorageConfig | None = None,
) -> list[str]:
    return _store.list_files_in_folder(
        relative_dir,
        config=_content_config(config),
        container_client=_container_client,
    )
