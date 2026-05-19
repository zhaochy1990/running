"""Content storage abstraction for user-owned training artifacts.

Production can read from Azure Blob Storage while local/dev keeps using the
repository data directory. During migration, Blob misses fall back to files.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from stride_core import db as core_db
from stride_server.config import load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, ContentStorageConfig, ServerConfig
from stride_server.config.sources import env_source

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

ACCOUNT_URL_ENV = "STRIDE_CONTENT_BLOB_ACCOUNT_URL"
CONTAINER_ENV = "STRIDE_CONTENT_BLOB_CONTAINER"
PREFIX_ENV = "STRIDE_CONTENT_BLOB_PREFIX"
DEFAULT_PREFIX = "users"


@dataclass(frozen=True)
class ContentItem:
    content: str
    source: str


def _clean_relative_path(relative_path: str) -> str:
    clean = relative_path.replace("\\", "/").lstrip("/")
    parts = [p for p in clean.split("/") if p not in {"", "."}]
    if any(p == ".." for p in parts):
        raise ValueError("Content path cannot contain '..'")
    return "/".join(parts)


def _file_path(relative_path: str) -> Path:
    return core_db.USER_DATA_DIR / _clean_relative_path(relative_path)


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


def _blob_prefix_from_config(config: ContentStorageConfig) -> str:
    return config.prefix.strip().strip("/")


def _blob_prefix(config: ContentStorageConfig | None = None) -> str:
    return _blob_prefix_from_config(_content_config(config))


def _blob_name(
    relative_path: str,
    config: ContentStorageConfig | None = None,
) -> str:
    clean = _clean_relative_path(relative_path)
    prefix = _blob_prefix(config)
    return f"{prefix}/{clean}" if prefix else clean


def _blob_config_from_config(config: ContentStorageConfig) -> tuple[str, str] | None:
    account_url = config.account_url.strip()
    container = config.container.strip()
    if not account_url or not container:
        return None
    return account_url, container


def _blob_config(config: ContentStorageConfig | None = None) -> tuple[str, str] | None:
    return _blob_config_from_config(_content_config(config))


@lru_cache(maxsize=4)
def _container_client(account_url: str, container: str):
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    service = BlobServiceClient(account_url=account_url, credential=DefaultAzureCredential())
    return service.get_container_client(container)


def _is_blob_not_found(exc: Exception) -> bool:
    return exc.__class__.__name__ in {"ResourceNotFoundError", "BlobNotFoundError"}


def read_text(
    relative_path: str,
    *,
    config: ContentStorageConfig | None = None,
) -> ContentItem | None:
    """Read UTF-8 text from Blob if configured, falling back to local files."""
    storage_config = _content_config(config)
    blob_config = _blob_config_from_config(storage_config)
    if blob_config is not None:
        account_url, container = blob_config
        try:
            data = _container_client(account_url, container).download_blob(
                _blob_name(relative_path, storage_config)
            ).readall()
            logger.info("content read source=blob path=%s", relative_path)
            return ContentItem(data.decode("utf-8"), "blob")
        except Exception as exc:
            if not _is_blob_not_found(exc):
                logger.warning(
                    "Blob content read failed for %s; falling back to filesystem: %s",
                    relative_path,
                    exc,
                )

    path = _file_path(relative_path)
    if not path.exists():
        logger.info("content read source=missing path=%s", relative_path)
        return None
    logger.info("content read source=file path=%s", relative_path)
    return ContentItem(path.read_text(encoding="utf-8"), "file")


def write_text(
    relative_path: str,
    content: str,
    *,
    content_type: str = "text/plain; charset=utf-8",
    config: ContentStorageConfig | None = None,
) -> str:
    """Write UTF-8 text to Blob if configured, falling back to local files."""
    storage_config = _content_config(config)
    blob_config = _blob_config_from_config(storage_config)
    data = content.encode("utf-8")
    if blob_config is not None:
        account_url, container = blob_config
        try:
            _container_client(account_url, container).upload_blob(
                _blob_name(relative_path, storage_config),
                data,
                overwrite=True,
            )
            logger.info("content write source=blob path=%s", relative_path)
            return "blob"
        except Exception as exc:
            logger.warning(
                "Blob content write failed for %s; falling back to filesystem: %s",
                relative_path,
                exc,
            )

    path = _file_path(relative_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    logger.info("content write source=file path=%s", relative_path)
    return "file"


def read_json(
    relative_path: str,
    *,
    config: ContentStorageConfig | None = None,
) -> tuple[Any, str] | None:
    item = read_text(relative_path, config=config)
    if item is None:
        return None
    return json.loads(item.content), item.source


def write_json(
    relative_path: str,
    data: Any,
    *,
    config: ContentStorageConfig | None = None,
) -> str:
    content = json.dumps(data, indent=2, default=str)
    return write_text(
        relative_path,
        content,
        content_type="application/json; charset=utf-8",
        config=config,
    )


def exists(
    relative_path: str,
    *,
    config: ContentStorageConfig | None = None,
) -> bool:
    storage_config = _content_config(config)
    blob_config = _blob_config_from_config(storage_config)
    if blob_config is not None:
        account_url, container = blob_config
        try:
            return bool(_container_client(account_url, container).get_blob_client(
                _blob_name(relative_path, storage_config)
            ).exists())
        except Exception as exc:
            logger.warning(
                "Blob content exists check failed for %s; falling back to filesystem: %s",
                relative_path,
                exc,
            )

    return _file_path(relative_path).exists()


def list_week_folders(
    user: str,
    *,
    config: ContentStorageConfig | None = None,
) -> list[str]:
    """Return week folder names discovered in Blob and/or the filesystem."""
    folders: set[str] = set()

    storage_config = _content_config(config)
    blob_config = _blob_config_from_config(storage_config)
    if blob_config is not None:
        account_url, container = blob_config
        prefix = _blob_name(f"{user}/logs", storage_config) + "/"
        try:
            for blob in _container_client(account_url, container).list_blobs(name_starts_with=prefix):
                rest = blob.name[len(prefix):]
                week = rest.split("/", 1)[0]
                if week:
                    folders.add(week)
            logger.info("content list_weeks source=blob user=%s count=%d", user, len(folders))
        except Exception as exc:
            logger.warning("Blob week listing failed for %s; falling back to filesystem: %s", user, exc)

    logs_dir = core_db.USER_DATA_DIR / user / "logs"
    if logs_dir.exists():
        file_folders = {d.name for d in logs_dir.iterdir() if d.is_dir()}
        folders.update(file_folders)
        logger.info("content list_weeks source=file user=%s count=%d", user, len(file_folders))

    return sorted(folders, reverse=True)


def any_exists(
    relative_paths: Iterable[str],
    *,
    config: ContentStorageConfig | None = None,
) -> bool:
    return any(exists(path, config=config) for path in relative_paths)
