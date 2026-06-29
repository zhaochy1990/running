"""Storage configuration dataclasses + generic config validators.

Moved out of ``stride_server.config.models`` so that the data-access layer
owns the shape of its own configuration. These are pure frozen dataclasses
(no ``azure``/``sqlite3`` import) → Tier A; any package may import them.

``stride_server.config.models`` re-exports every name here so existing
``from stride_server.config.models import StorageConfig`` call sites keep
working through the transition.

Server-policy config (``ServerConfig``, ``AuthConfig``, ``AuthServiceConfig``)
and the TOML/env loader stay in ``stride_server.config`` — they are not
storage concerns.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from urllib.parse import urlparse


class ConfigError(RuntimeError):
    pass


def validate_positive(path: str, value: float) -> None:
    if value <= 0:
        raise ConfigError(f"{path} must be positive")


def validate_optional_url(path: str, value: str) -> None:
    if not value:
        return
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigError(f"{path} must be an http(s) URL")


def validate_required_when(path: str, value: str, *, when_path: str, when_value: str) -> None:
    if when_value and not value:
        raise ConfigError(f"{path} is required when {when_path} is configured")


@dataclass(frozen=True)
class AzureKeyVaultConfig:
    enabled: bool = False
    vault_url: str = ""
    secret_prefix: str = "stride-server"

    def with_updates(self, **updates: object) -> AzureKeyVaultConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class ContentStorageConfig:
    account_url: str = ""
    container: str = ""
    prefix: str = "users"

    def with_updates(self, **updates: object) -> ContentStorageConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class LikesStorageConfig:
    table_account_url: str = ""
    table_name: str = "stridelikes"

    def with_updates(self, **updates: object) -> LikesStorageConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class MasterPlanStorageConfig:
    table_account_url: str = ""
    table_name: str = "stridemasterplan"

    def with_updates(self, **updates: object) -> MasterPlanStorageConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class StorageConfig:
    content: ContentStorageConfig = field(default_factory=ContentStorageConfig)
    likes: LikesStorageConfig = field(default_factory=LikesStorageConfig)
    master_plan: MasterPlanStorageConfig = field(default_factory=MasterPlanStorageConfig)

    def with_updates(self, **updates: object) -> StorageConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class CoachPersistenceConfig:
    table_account_url: str = ""
    blob_account_url: str = ""
    checkpoints_table_name: str = "stridecoachcheckpoints"
    checkpoint_writes_table_name: str = "stridecoachcheckpointwrites"
    jobs_table_name: str = "stridecoachjobs"
    weekly_versions_table_name: str = "strideweeklyversions"
    blob_container: str = "coach-checkpoints"
    file_backend_dir: str = "data/_coach_dev"
    jobs_stale_after_seconds: int = 120

    def with_updates(self, **updates: object) -> CoachPersistenceConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class JPushConfig:
    app_key: str = ""
    master_secret: str = ""
    url: str = "https://api.jpush.cn/v3/push"
    timeout_s: float = 10.0
    apns_production: bool = True

    def with_updates(self, **updates: object) -> JPushConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class NotificationConfig:
    table_account_url: str = ""
    devices_table: str = "stridedevices"
    prefs_table: str = "strideprefs"
    jpush: JPushConfig = field(default_factory=JPushConfig)

    def with_updates(self, **updates: object) -> NotificationConfig:
        return replace(self, **updates)


NotificationStorageConfig = NotificationConfig
