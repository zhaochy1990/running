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

from stride_core.identifiers import normalize_unique_uuids


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
class QueueStorageConfig:
    """Resolved config for the async-job queue + state store.

    ``queue_account_url`` empty → dev in-memory/file backends; set → Azure
    Storage Queue + Azure Table. ``poison_max_attempts`` is the dequeue-count
    ceiling past which a message is dead-lettered instead of retried.
    """

    queue_account_url: str = ""
    queue_name: str = "stridejobs"
    poison_queue_name: str = "stridejobs-poison"
    table_account_url: str = ""
    jobs_table_name: str = "stridejobs"
    pipeline_runs_table_name: str = "stridepipelineruns"
    file_backend_dir: str = "data/_jobs_dev"
    visibility_timeout_s: int = 300
    poison_max_attempts: int = 5
    stale_after_seconds: int = 600

    def with_updates(self, **updates: object) -> QueueStorageConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class DatabaseStorageConfig:
    """Resolved connection + traffic controls for the core activity database.

    The foundation is dormant by default (``mode='sqlite'``). ``mysql_users``
    controls reads only; after the migration gate, ``dual_write_enabled`` makes
    every write target MySQL first and the SQLite rollback mirror second.
    """

    mode: str = "sqlite"
    host: str = ""
    port: int = 3306
    database: str = ""
    username: str = ""
    password: str = field(default="", repr=False)
    tls_ca_path: str = ""
    dual_write_enabled: bool = False
    mysql_read_all: bool = False
    mysql_users: tuple[str, ...] = ()
    pool_size: int = 5
    max_overflow: int = 5
    pool_timeout_s: int = 5
    pool_recycle_s: int = 900
    connect_timeout_s: int = 5
    read_timeout_s: int = 30
    write_timeout_s: int = 30

    def with_updates(self, **updates: object) -> DatabaseStorageConfig:
        return replace(self, **updates)

    def validate_mysql_connection(self) -> None:
        """Validate fields needed by an explicit MySQL engine caller."""
        for path, value in (
            ("storage.database.host", self.host),
            ("storage.database.database", self.database),
            ("storage.database.username", self.username),
            ("storage.database.password", self.password),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ConfigError(f"{path} is required to create a MySQL engine")

    def validate(self) -> None:
        if self.mode not in {"sqlite", "hybrid"}:
            raise ConfigError("storage.database.mode must be 'sqlite' or 'hybrid'")
        if not 1 <= self.port <= 65535:
            raise ConfigError("storage.database.port must be between 1 and 65535")
        for path, value in (
            ("storage.database.pool_size", self.pool_size),
            ("storage.database.pool_timeout_s", self.pool_timeout_s),
            ("storage.database.pool_recycle_s", self.pool_recycle_s),
            ("storage.database.connect_timeout_s", self.connect_timeout_s),
            ("storage.database.read_timeout_s", self.read_timeout_s),
            ("storage.database.write_timeout_s", self.write_timeout_s),
        ):
            validate_positive(path, value)
        if self.max_overflow < 0:
            raise ConfigError("storage.database.max_overflow must be >= 0")
        try:
            normalized_users = normalize_unique_uuids(self.mysql_users)
        except ValueError as exc:
            raise ConfigError(f"storage.database.mysql_users {exc}") from exc
        if normalized_users != self.mysql_users:
            raise ConfigError("storage.database.mysql_users must contain canonical UUIDs")
        mysql_routing_enabled = (
            self.dual_write_enabled or self.mysql_read_all or bool(self.mysql_users)
        )
        if mysql_routing_enabled and self.mode != "hybrid":
            raise ConfigError(
                "storage.database.mode must be 'hybrid' when MySQL routing is enabled"
            )
        if self.mode == "hybrid":
            self.validate_mysql_connection()


@dataclass(frozen=True)
class StorageConfig:
    content: ContentStorageConfig = field(default_factory=ContentStorageConfig)
    likes: LikesStorageConfig = field(default_factory=LikesStorageConfig)
    master_plan: MasterPlanStorageConfig = field(default_factory=MasterPlanStorageConfig)
    jobs: QueueStorageConfig = field(default_factory=QueueStorageConfig)
    database: DatabaseStorageConfig = field(default_factory=DatabaseStorageConfig)

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
