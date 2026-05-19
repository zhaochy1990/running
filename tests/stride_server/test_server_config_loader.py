from __future__ import annotations

import os

import pytest

from stride_server.config.models import (
    AuthConfig,
    AzureOpenAIConfig,
    CoachPersistenceConfig,
    ConfigError,
    CommentaryConfig,
    ContentStorageConfig,
    JPushConfig,
    LLMConfig,
    NotificationConfig,
    ServerConfig,
)
from stride_server.config.sources import (
    akv_secret_name,
    deep_merge,
    env_source,
    parse_bool,
    parse_env_value,
    set_path,
    toml_file_source,
)


def test_server_config_default_shape_keeps_current_defaults() -> None:
    cfg = ServerConfig.default(env="dev")

    assert cfg.env == "dev"
    assert cfg.auth.issuer == "auth-service"
    assert cfg.auth.allow_insecure_without_key is True
    assert cfg.auth_service.timeout_s == 5.0
    assert cfg.llm.default_model == "gpt-4.1"
    assert cfg.llm.azure_openai.api_version == "2024-10-21"
    assert cfg.llm.azure_openai.timeout_s == 60.0
    assert cfg.commentary.azure_openai.deployment == "gpt-4.1"
    assert cfg.storage.content.prefix == "users"
    assert cfg.storage.likes.table_name == "stridelikes"
    assert cfg.storage.master_plan.table_name == "stridemasterplan"
    assert cfg.coach_persistence.checkpoints_table_name == "stridecoachcheckpoints"
    assert cfg.coach_persistence.checkpoint_writes_table_name == "stridecoachcheckpointwrites"
    assert cfg.coach_persistence.jobs_table_name == "stridecoachjobs"
    assert cfg.coach_persistence.weekly_versions_table_name == "strideweeklyversions"
    assert cfg.coach_persistence.blob_container == "coach-checkpoints"
    assert cfg.notifications.devices_table == "stridedevices"
    assert cfg.notifications.prefs_table == "strideprefs"
    assert cfg.sync.stale_after_seconds == 300


def test_non_dev_auth_requires_public_key_or_explicit_insecure_flag() -> None:
    cfg = ServerConfig.default(env="prod")

    with pytest.raises(ConfigError, match="auth.public_key"):
        cfg.validate()


def test_non_dev_auth_allows_explicit_insecure_flag() -> None:
    cfg = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(allow_insecure_without_key=True)
    )

    cfg.validate()


def test_positive_number_validation_names_config_path() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        coach_persistence=CoachPersistenceConfig(file_backend_dir="data/_coach_dev", jobs_stale_after_seconds=0)
    )

    with pytest.raises(ConfigError, match="coach_persistence.jobs_stale_after_seconds"):
        cfg.validate()


def test_url_validation_names_config_path() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        storage=ServerConfig.default(env="dev").storage.with_updates(
            content=ContentStorageConfig(account_url="not-a-url", container="stride-data")
        )
    )

    with pytest.raises(ConfigError, match="storage.content.account_url"):
        cfg.validate()


def test_llm_azure_openai_timeout_validation_names_config_path() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        llm=LLMConfig(azure_openai=AzureOpenAIConfig(timeout_s=0))
    )

    with pytest.raises(ConfigError, match="llm.azure_openai.timeout_s"):
        cfg.validate()


def test_commentary_azure_openai_timeout_validation_names_config_path() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        commentary=CommentaryConfig(azure_openai=AzureOpenAIConfig(timeout_s=0))
    )

    with pytest.raises(ConfigError, match="commentary.azure_openai.timeout_s"):
        cfg.validate()


def test_notifications_jpush_timeout_validation_names_config_path() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        notifications=NotificationConfig(jpush=JPushConfig(timeout_s=0))
    )

    with pytest.raises(ConfigError, match="notifications.jpush.timeout_s"):
        cfg.validate()


def test_notifications_jpush_url_validation_names_config_path() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        notifications=NotificationConfig(jpush=JPushConfig(url="not-a-url"))
    )

    with pytest.raises(ConfigError, match="notifications.jpush.url"):
        cfg.validate()


def test_deep_merge_recurses_and_replaces_lists() -> None:
    left = {"storage": {"likes": {"table_name": "a", "tags": ["old"]}}}
    right = {"storage": {"likes": {"table_account_url": "https://x", "tags": ["new"]}}}

    assert deep_merge(left, right) == {
        "storage": {
            "likes": {
                "table_name": "a",
                "table_account_url": "https://x",
                "tags": ["new"],
            }
        }
    }


def test_set_path_builds_nested_dict() -> None:
    data: dict[str, object] = {}

    set_path(data, "storage.likes.table_name", "stridelikes")

    assert data == {"storage": {"likes": {"table_name": "stridelikes"}}}


def test_parse_bool_is_strict() -> None:
    assert parse_bool("true") is True
    assert parse_bool("1") is True
    assert parse_bool("false") is False
    assert parse_bool("0") is False

    with pytest.raises(ValueError, match="boolean"):
        parse_bool("maybe")


def test_parse_env_value_preserves_empty_string() -> None:
    assert parse_env_value("", "str") == ""
    assert parse_env_value("300", "int") == 300
    assert parse_env_value("5.5", "float") == 5.5
    assert parse_env_value("true", "bool") is True


def test_env_source_maps_legacy_names_and_specific_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PATH", "config/auth-public.pem")
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://aoai.example")
    monkeypatch.setenv("STRIDE_STORAGE_LIKES_TABLE_NAME", "customlikes")
    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", "")

    data = env_source(os.environ)

    assert data["auth"]["public_key_path"] == "config/auth-public.pem"
    assert data["llm"]["enabled"] is True
    assert data["llm"]["azure_openai"]["endpoint"] == "https://aoai.example"
    assert data["commentary"]["azure_openai"]["endpoint"] == "https://aoai.example"
    assert data["storage"]["likes"]["table_name"] == "customlikes"
    assert data["internal"]["token"] == ""


def test_toml_file_source_reads_nested_config(tmp_path) -> None:
    path = tmp_path / "stride.toml"
    path.write_text('[storage.likes]\ntable_name = "fromtoml"\n', encoding="utf-8")

    assert toml_file_source(path) == {"storage": {"likes": {"table_name": "fromtoml"}}}


def test_akv_secret_name_normalizes_path_and_prefix() -> None:
    assert akv_secret_name("stride-server", "llm.azure_openai.api_key") == "stride-server--llm-azure-openai-api-key"
    assert akv_secret_name("", "storage.likes.table_account_url") == "storage-likes-table-account-url"
