"""Content storage primitives — Blob (injected) + filesystem.

Pure: every function takes a resolved ``ContentStorageConfig`` and a
``container_client`` factory ``(account_url, container) -> ContainerClient``.
No ``azure`` import lives here; the caller injects the blob backend (from
``stride_storage.azure.blob_backend``). The filesystem path resolves
``core_db.USER_DATA_DIR`` at call time so the test monkeypatch seam holds.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from stride_core import db as core_db
from stride_storage.interfaces.config import ContentStorageConfig

logger = logging.getLogger("uvicorn.error")

# A factory that returns an Azure Blob ContainerClient for (account_url, container).
ContainerClientFactory = Callable[[str, str], Any]


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


def _blob_prefix_from_config(config: ContentStorageConfig) -> str:
    return config.prefix.strip().strip("/")


def _blob_name(relative_path: str, config: ContentStorageConfig) -> str:
    clean = _clean_relative_path(relative_path)
    prefix = _blob_prefix_from_config(config)
    return f"{prefix}/{clean}" if prefix else clean


def _blob_config_from_config(config: ContentStorageConfig) -> tuple[str, str] | None:
    account_url = config.account_url.strip()
    container = config.container.strip()
    if not account_url or not container:
        return None
    return account_url, container


def _is_blob_not_found(exc: Exception) -> bool:
    return exc.__class__.__name__ in {"ResourceNotFoundError", "BlobNotFoundError"}


def read_text(
    relative_path: str,
    *,
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> ContentItem | None:
    """Read UTF-8 text from Blob if configured, falling back to local files."""
    blob_config = _blob_config_from_config(config)
    if blob_config is not None:
        account_url, container = blob_config
        try:
            data = container_client(account_url, container).download_blob(
                _blob_name(relative_path, config)
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
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
    content_type: str = "text/plain; charset=utf-8",
) -> str:
    """Write UTF-8 text to Blob if configured, falling back to local files."""
    blob_config = _blob_config_from_config(config)
    data = content.encode("utf-8")
    if blob_config is not None:
        account_url, container = blob_config
        try:
            container_client(account_url, container).upload_blob(
                _blob_name(relative_path, config),
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
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> tuple[Any, str] | None:
    item = read_text(relative_path, config=config, container_client=container_client)
    if item is None:
        return None
    return json.loads(item.content), item.source


def write_json(
    relative_path: str,
    data: Any,
    *,
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> str:
    content = json.dumps(data, indent=2, default=str)
    return write_text(
        relative_path,
        content,
        config=config,
        container_client=container_client,
        content_type="application/json; charset=utf-8",
    )


def exists(
    relative_path: str,
    *,
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> bool:
    blob_config = _blob_config_from_config(config)
    if blob_config is not None:
        account_url, container = blob_config
        try:
            return bool(container_client(account_url, container).get_blob_client(
                _blob_name(relative_path, config)
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
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> list[str]:
    """Return week folder names discovered in Blob and/or the filesystem."""
    folders: set[str] = set()

    blob_config = _blob_config_from_config(config)
    if blob_config is not None:
        account_url, container = blob_config
        prefix = _blob_name(f"{user}/logs", config) + "/"
        try:
            for blob in container_client(account_url, container).list_blobs(name_starts_with=prefix):
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
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> bool:
    return any(
        exists(path, config=config, container_client=container_client)
        for path in relative_paths
    )


def delete_prefix(
    relative_dir: str,
    *,
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> int:
    """Delete every configured Blob below ``relative_dir``.

    Filesystem content remains owned by the account route's atomic directory
    cleanup. Blob failures deliberately propagate so account deletion can stay
    fenced and be retried instead of silently leaving user content behind.
    """
    blob_config = _blob_config_from_config(config)
    if blob_config is None:
        return 0

    account_url, container = blob_config
    client = container_client(account_url, container)
    prefix = _blob_name(relative_dir, config).rstrip("/") + "/"
    names = [blob.name for blob in client.list_blobs(name_starts_with=prefix)]
    for name in names:
        try:
            client.delete_blob(name)
        except Exception as exc:
            if not _is_blob_not_found(exc):
                raise
    logger.info("content delete_prefix source=blob path=%s count=%d", relative_dir, len(names))
    return len(names)


def list_files_in_folder(
    relative_dir: str,
    *,
    config: ContentStorageConfig,
    container_client: ContainerClientFactory,
) -> list[str]:
    """Return basenames of files in ``relative_dir`` from blob + filesystem."""
    files: set[str] = set()
    blob_config = _blob_config_from_config(config)
    if blob_config is not None:
        account_url, container = blob_config
        prefix = _blob_name(relative_dir, config).rstrip("/") + "/"
        try:
            for blob in container_client(account_url, container).list_blobs(name_starts_with=prefix):
                rest = blob.name[len(prefix):]
                if rest and "/" not in rest:
                    files.add(rest)
        except Exception as exc:
            logger.warning(
                "Blob list_files failed for %s; falling back to filesystem: %s",
                relative_dir,
                exc,
            )

    dir_path = _file_path(relative_dir)
    if dir_path.exists() and dir_path.is_dir():
        for p in dir_path.iterdir():
            if p.is_file():
                files.add(p.name)
    return sorted(files)
