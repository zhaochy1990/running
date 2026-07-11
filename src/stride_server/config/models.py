from __future__ import annotations

from dataclasses import dataclass, field, replace

# Storage configuration dataclasses + generic validators now live in the
# data-access package. Re-exported here so existing
# ``from stride_server.config.models import StorageConfig`` (and friends)
# call sites keep working unchanged.
from stride_storage.interfaces.config import (  # noqa: F401  (re-export)
    AzureKeyVaultConfig,
    CoachPersistenceConfig,
    ConfigError,
    ContentStorageConfig,
    JPushConfig,
    LikesStorageConfig,
    MasterPlanStorageConfig,
    NotificationConfig,
    NotificationStorageConfig,
    QueueStorageConfig,
    StorageConfig,
    validate_optional_url,
    validate_positive,
    validate_required_when,
)


def validate_auth(env: str, auth: AuthConfig) -> None:
    if env.lower() in {"dev", "local", "default"}:
        return
    if auth.public_key_pem or auth.public_key_path or auth.allow_insecure_without_key:
        return
    raise ConfigError("auth.public_key is required outside dev")


@dataclass(frozen=True)
class AuthConfig:
    public_key_pem: str = ""
    public_key_path: str = ""
    issuer: str = "auth-service"
    audience: str = ""
    allow_insecure_without_key: bool = False

    def with_updates(self, **updates: object) -> AuthConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class AuthServiceConfig:
    base_url: str = ""
    timeout_s: float = 5.0

    def with_updates(self, **updates: object) -> AuthServiceConfig:
        return replace(self, **updates)


# NOTE: AzureOpenAIConfig / LLMConfig / CommentaryConfig were removed.
# All LLM configuration now lives in `config/coach.{toml,local.toml,
# prod.toml}` and is consumed via `coach.runtime.config`. The dead path
# is documented in commit history; if you're looking for "where does
# the runtime talk to Azure OpenAI?", start at
# `stride_server.coach_runtime.get_generator_llm`.
#
# Storage config dataclasses (ContentStorageConfig / LikesStorageConfig /
# MasterPlanStorageConfig / StorageConfig / CoachPersistenceConfig /
# JPushConfig / NotificationConfig / AzureKeyVaultConfig) now live in
# `stride_storage.interfaces.config` and are re-exported at the top of this module.


@dataclass(frozen=True)
class SyncConfig:
    stale_after_seconds: int = 300

    def with_updates(self, **updates: object) -> SyncConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class InternalConfig:
    token: str = ""

    def with_updates(self, **updates: object) -> InternalConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class PlanConfig:
    prefer_authored_json: bool = True

    def with_updates(self, **updates: object) -> PlanConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class ServerConfig:
    env: str
    akv: AzureKeyVaultConfig = field(default_factory=AzureKeyVaultConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    auth_service: AuthServiceConfig = field(default_factory=AuthServiceConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    coach_persistence: CoachPersistenceConfig = field(default_factory=CoachPersistenceConfig)
    notifications: NotificationConfig = field(default_factory=NotificationConfig)
    sync: SyncConfig = field(default_factory=SyncConfig)
    internal: InternalConfig = field(default_factory=InternalConfig)
    plan: PlanConfig = field(default_factory=PlanConfig)

    @classmethod
    def default(cls, *, env: str) -> ServerConfig:
        return cls(env=env)

    def __post_init__(self) -> None:
        if self.env.lower() in {"dev", "local"} and not self.auth.allow_insecure_without_key:
            object.__setattr__(
                self,
                "auth",
                self.auth.with_updates(allow_insecure_without_key=True),
            )

    def with_updates(self, **updates: object) -> ServerConfig:
        return replace(self, **updates)

    def validate(self) -> None:
        validate_auth(self.env, self.auth)
        validate_positive("auth_service.timeout_s", self.auth_service.timeout_s)
        validate_positive("coach_persistence.jobs_stale_after_seconds", self.coach_persistence.jobs_stale_after_seconds)
        validate_positive("notifications.jpush.timeout_s", self.notifications.jpush.timeout_s)
        validate_positive("sync.stale_after_seconds", self.sync.stale_after_seconds)
        validate_optional_url("akv.vault_url", self.akv.vault_url)
        validate_optional_url("auth_service.base_url", self.auth_service.base_url)
        validate_optional_url("storage.content.account_url", self.storage.content.account_url)
        validate_optional_url("storage.likes.table_account_url", self.storage.likes.table_account_url)
        validate_optional_url("storage.master_plan.table_account_url", self.storage.master_plan.table_account_url)
        validate_optional_url("storage.jobs.queue_account_url", self.storage.jobs.queue_account_url)
        validate_optional_url("storage.jobs.table_account_url", self.storage.jobs.table_account_url)
        validate_optional_url("coach_persistence.table_account_url", self.coach_persistence.table_account_url)
        validate_optional_url("coach_persistence.blob_account_url", self.coach_persistence.blob_account_url)
        validate_optional_url("notifications.table_account_url", self.notifications.table_account_url)
        validate_optional_url("notifications.jpush.url", self.notifications.jpush.url)
        validate_required_when(
            "coach_persistence.blob_account_url",
            self.coach_persistence.blob_account_url,
            when_path="coach_persistence.table_account_url",
            when_value=self.coach_persistence.table_account_url,
        )
