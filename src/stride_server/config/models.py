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


def validate_auth(env: str, auth: AuthConfig) -> None:
    if env.lower() in {"dev", "local", "default"}:
        return
    if auth.public_key_pem or auth.public_key_path or auth.allow_insecure_without_key:
        return
    raise ConfigError("auth.public_key is required outside dev")


@dataclass(frozen=True)
class AzureKeyVaultConfig:
    enabled: bool = False
    vault_url: str = ""
    secret_prefix: str = "stride-server"

    def with_updates(self, **updates: object) -> AzureKeyVaultConfig:
        return replace(self, **updates)


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


@dataclass(frozen=True)
class AzureOpenAIConfig:
    endpoint: str = ""
    api_key: str = ""
    api_version: str = "2024-10-21"
    deployment: str = "gpt-4.1"
    timeout_s: float = 60.0

    def with_updates(self, **updates: object) -> AzureOpenAIConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class LLMConfig:
    enabled: bool = False
    default_model: str = "gpt-4.1"
    azure_openai: AzureOpenAIConfig = field(default_factory=AzureOpenAIConfig)

    def with_updates(self, **updates: object) -> LLMConfig:
        return replace(self, **updates)


@dataclass(frozen=True)
class CommentaryConfig:
    enabled: bool = False
    azure_openai: AzureOpenAIConfig = field(default_factory=AzureOpenAIConfig)

    def with_updates(self, **updates: object) -> CommentaryConfig:
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
    llm: LLMConfig = field(default_factory=LLMConfig)
    commentary: CommentaryConfig = field(default_factory=CommentaryConfig)
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
        validate_positive("llm.azure_openai.timeout_s", self.llm.azure_openai.timeout_s)
        validate_positive("commentary.azure_openai.timeout_s", self.commentary.azure_openai.timeout_s)
        validate_positive("coach_persistence.jobs_stale_after_seconds", self.coach_persistence.jobs_stale_after_seconds)
        validate_positive("notifications.jpush.timeout_s", self.notifications.jpush.timeout_s)
        validate_positive("sync.stale_after_seconds", self.sync.stale_after_seconds)
        validate_optional_url("akv.vault_url", self.akv.vault_url)
        validate_optional_url("auth_service.base_url", self.auth_service.base_url)
        validate_optional_url("llm.azure_openai.endpoint", self.llm.azure_openai.endpoint)
        validate_optional_url("commentary.azure_openai.endpoint", self.commentary.azure_openai.endpoint)
        validate_optional_url("storage.content.account_url", self.storage.content.account_url)
        validate_optional_url("storage.likes.table_account_url", self.storage.likes.table_account_url)
        validate_optional_url("storage.master_plan.table_account_url", self.storage.master_plan.table_account_url)
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
