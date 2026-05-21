from __future__ import annotations

import os
import tomllib
from pathlib import Path

import pytest

from stride_server.config.loader import (
    clear_server_config_cache,
    load_server_config,
    resolve_config_env,
    resolve_file_layer,
)
from stride_server.config import loader as loader_module
from stride_server.config.models import (
    AuthConfig,
    CoachPersistenceConfig,
    ConfigError,
    ContentStorageConfig,
    JPushConfig,
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


@pytest.fixture(autouse=True)
def clear_config_cache_between_tests():
    clear_server_config_cache()
    try:
        yield
    finally:
        clear_server_config_cache()


def test_server_config_default_shape_keeps_current_defaults() -> None:
    cfg = ServerConfig.default(env="dev")

    assert cfg.env == "dev"
    assert cfg.auth.issuer == "auth-service"
    assert cfg.auth.allow_insecure_without_key is True
    assert cfg.auth_service.timeout_s == 5.0
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


def _mapping_value_at_path(data: dict[str, object], path: str) -> object:
    current: object = data
    for part in path.split("."):
        assert isinstance(current, dict), f"{path} parent is not a table"
        assert part in current, f"{path} is missing from config/server.toml"
        current = current[part]
    return current


def _object_value_at_path(instance: object, path: str) -> object:
    current = instance
    for part in path.split("."):
        current = getattr(current, part)
    return current


def test_repo_base_server_config_declares_all_runtime_defaults() -> None:
    raw = (loader_module.PROJECT_ROOT / "config" / "server.toml").read_text(encoding="utf-8")
    data = tomllib.loads(raw)
    cfg = ServerConfig.default(env="default")

    for path in ["env", *loader_module._known_secret_manifest()]:
        assert _mapping_value_at_path(data, path) == _object_value_at_path(cfg, path)


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


def test_coach_persistence_requires_blob_url_when_table_backend_selected() -> None:
    cfg = ServerConfig.default(env="dev").with_updates(
        coach_persistence=CoachPersistenceConfig(
            table_account_url="https://acct.table.core.windows.net",
            blob_account_url="",
        )
    )

    with pytest.raises(ConfigError, match="coach_persistence.blob_account_url"):
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
    monkeypatch.setenv("STRIDE_STORAGE_LIKES_TABLE_NAME", "customlikes")
    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", "")
    monkeypatch.setenv("STRIDE_PLAN_JSON_PRIORITY", "false")

    data = env_source(os.environ)

    assert data["auth"]["public_key_path"] == "config/auth-public.pem"
    assert data["storage"]["likes"]["table_name"] == "customlikes"
    assert data["internal"]["token"] == ""
    assert data["plan"]["prefer_authored_json"] is False


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", True),
        ("disabled", False),
        ("anything", True),
    ],
)
def test_env_source_plan_json_priority_preserves_legacy_bool_semantics(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: bool
) -> None:
    monkeypatch.setenv("STRIDE_PLAN_JSON_PRIORITY", raw)

    data = env_source(os.environ)

    if raw == "":
        assert "plan" not in data
    else:
        assert data["plan"]["prefer_authored_json"] is expected


def test_toml_file_source_reads_nested_config(tmp_path) -> None:
    path = tmp_path / "stride.toml"
    path.write_text('[storage.likes]\ntable_name = "fromtoml"\n', encoding="utf-8")

    assert toml_file_source(path) == {"storage": {"likes": {"table_name": "fromtoml"}}}


def test_akv_secret_name_normalizes_path_and_prefix() -> None:
    assert akv_secret_name("stride-server", "auth.public_key_pem") == "stride-server--auth-public-key-pem"
    assert akv_secret_name("", "storage.likes.table_account_url") == "storage-likes-table-account-url"


def test_resolve_config_env_prefers_stride_config_env() -> None:
    assert resolve_config_env({"STRIDE_ENV": "prod", "STRIDE_CONFIG_ENV": "local"}) == "local"


def test_resolve_config_env_falls_back_to_stride_env_and_default() -> None:
    assert resolve_config_env({"STRIDE_ENV": "prod"}) == "prod"
    assert resolve_config_env({}) == "default"


def test_resolve_file_layer_uses_default_base_and_optional_env_file(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    base = config_dir / "server.toml"
    prod = config_dir / "server.prod.toml"
    base.write_text("env = 'base'", encoding="utf-8")
    prod.write_text("env = 'prod'", encoding="utf-8")

    assert resolve_file_layer(env="prod", project_root=tmp_path, environ={}) == [base, prod]


def test_resolve_file_layer_allows_missing_default_env_file(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    base = config_dir / "server.toml"
    base.write_text("env = 'base'", encoding="utf-8")

    assert resolve_file_layer(env="local", project_root=tmp_path, environ={}) == [base]


def test_resolve_file_layer_requires_base_file(tmp_path: Path) -> None:
    (tmp_path / "config").mkdir()

    with pytest.raises(ConfigError, match="base server config not found"):
        resolve_file_layer(env="local", project_root=tmp_path, environ={})


def test_resolve_file_layer_explicit_files_replace_discovery_and_support_separators(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text("env = 'base'", encoding="utf-8")
    first = tmp_path / "first.toml"
    second = tmp_path / "second.toml"
    third = tmp_path / "third.toml"
    first.write_text("env = 'first'", encoding="utf-8")
    second.write_text("env = 'second'", encoding="utf-8")
    third.write_text("env = 'third'", encoding="utf-8")
    environ = {"STRIDE_CONFIG_FILES": f"{first};{second},{third}"}

    assert resolve_file_layer(env="prod", project_root=tmp_path, environ=environ) == [first, second, third]


def test_resolve_file_layer_empty_explicit_env_replaces_discovery(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text("env = 'base'", encoding="utf-8")

    with pytest.raises(ConfigError, match="did not contain any config files"):
        resolve_file_layer(env="prod", project_root=tmp_path, environ={"STRIDE_CONFIG_FILES": ""})


def test_resolve_file_layer_empty_explicit_arg_replaces_discovery(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text("env = 'base'", encoding="utf-8")

    with pytest.raises(ConfigError, match="did not contain any config files"):
        resolve_file_layer(env="prod", project_root=tmp_path, environ={}, explicit_files="")


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ('[akv]\nenabled = "maybe"\n', "akv.enabled must be a boolean"),
        ('[sync]\nstale_after_seconds = "soon"\n', "sync.stale_after_seconds must be an integer"),
        ('[auth_service]\ntimeout_s = "slow"\n', "auth_service.timeout_s must be a number"),
    ],
)
def test_load_server_config_wraps_invalid_string_coercions_from_files(
    tmp_path: Path, body: str, message: str
) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text(f"env = 'dev'\n{body}", encoding="utf-8")

    with pytest.raises(ConfigError, match=message):
        load_server_config(project_root=tmp_path, environ={}, use_cache=False)


def test_load_server_config_wraps_invalid_string_coercions_from_akv(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text(
        """
env = "dev"

[akv]
enabled = true
vault_url = "https://vault.example"
""",
        encoding="utf-8",
    )

    def fake_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, object]:
        return {"sync": {"stale_after_seconds": "soon"}}

    with pytest.raises(ConfigError, match="sync.stale_after_seconds must be an integer"):
        load_server_config(
            project_root=tmp_path,
            environ={},
            akv_source=fake_akv_source,
            use_cache=False,
        )


def test_load_server_config_akv_overrides_files(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text(
        """
env = "dev"

[akv]
enabled = true
vault_url = "https://vault.example"
secret_prefix = "stride-server"

[storage.likes]
table_name = "from-file"
""",
        encoding="utf-8",
    )

    def fake_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, object]:
        assert vault_url == "https://vault.example"
        assert secret_prefix == "stride-server"
        assert "storage.likes.table_name" in manifest
        return {"storage": {"likes": {"table_name": "from-akv"}}}

    cfg = load_server_config(
        project_root=tmp_path,
        environ={},
        akv_source=fake_akv_source,
        use_cache=False,
    )

    assert cfg.storage.likes.table_name == "from-akv"


def test_load_server_config_env_overrides_akv(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text(
        """
env = "dev"

[akv]
enabled = true
vault_url = "https://vault.example"

[storage.likes]
table_name = "from-file"
""",
        encoding="utf-8",
    )

    def fake_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, object]:
        return {"storage": {"likes": {"table_name": "from-akv"}}}

    cfg = load_server_config(
        project_root=tmp_path,
        environ={"STRIDE_STORAGE_LIKES_TABLE_NAME": "from-env"},
        akv_source=fake_akv_source,
        use_cache=False,
    )

    assert cfg.storage.likes.table_name == "from-env"


def test_load_server_config_explicit_files_replace_default_layer(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text("[storage.likes]\ntable_name = 'default'", encoding="utf-8")
    explicit = tmp_path / "custom.toml"
    explicit.write_text("env = 'dev'\n[storage.likes]\ntable_name = 'explicit'", encoding="utf-8")

    cfg = load_server_config(
        project_root=tmp_path,
        environ={"STRIDE_CONFIG_FILES": str(explicit)},
        use_cache=False,
    )

    assert cfg.storage.likes.table_name == "explicit"


def test_load_server_config_converts_nested_dicts_to_dataclasses(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text(
        """
env = "dev"

[auth_service]
base_url = "https://auth.example"
timeout_s = 2.5

[storage.content]
account_url = "https://content.example"
prefix = "users-test"
""",
        encoding="utf-8",
    )

    cfg = load_server_config(project_root=tmp_path, environ={}, use_cache=False)

    assert cfg.auth_service.timeout_s == 2.5
    assert cfg.auth_service.base_url == "https://auth.example"
    assert cfg.storage.content.account_url == "https://content.example"
    assert cfg.storage.content.prefix == "users-test"
    assert cfg.storage.likes.table_name == "stridelikes"  # default preserved


def test_clear_server_config_cache_allows_default_reload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.startswith("STRIDE_") or name in {
            "AZURE_OPENAI_ENDPOINT",
            "AZURE_OPENAI_API_KEY",
            "AZURE_OPENAI_API_VERSION",
            "AZURE_OPENAI_DEPLOYMENT",
            "LLM_ENABLED",
            "LLM_DEFAULT_MODEL",
            "AOAI_COMMENTARY_ENABLED",
            "JPUSH_APP_KEY",
            "JPUSH_MASTER_SECRET",
        }:
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(loader_module, "PROJECT_ROOT", tmp_path)
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    base = config_dir / "server.toml"
    base.write_text("env = 'dev'\n[storage.likes]\ntable_name = 'first'", encoding="utf-8")

    clear_server_config_cache()
    first = load_server_config()
    base.write_text("env = 'dev'\n[storage.likes]\ntable_name = 'second'", encoding="utf-8")
    cached = load_server_config()
    clear_server_config_cache()
    second = load_server_config()

    assert first.storage.likes.table_name == "first"
    assert cached.storage.likes.table_name == "first"
    assert second.storage.likes.table_name == "second"
    clear_server_config_cache()


def test_repo_server_config_files_load(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STRIDE_CONFIG_FILES", raising=False)
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "local")

    cfg = load_server_config(use_cache=False)

    assert cfg.env == "local"
    assert cfg.auth.allow_insecure_without_key is True
    assert cfg.storage.likes.table_name == "stridelikes"
    assert cfg.coach_persistence.file_backend_dir == "data/_coach_dev"


def test_default_repo_server_config_loads_without_auth_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STRIDE_CONFIG_FILES", raising=False)
    monkeypatch.delenv("STRIDE_CONFIG_ENV", raising=False)
    monkeypatch.delenv("STRIDE_ENV", raising=False)
    monkeypatch.delenv("STRIDE_AUTH_PUBLIC_KEY_PEM", raising=False)
    monkeypatch.delenv("STRIDE_AUTH_PUBLIC_KEY_PATH", raising=False)
    monkeypatch.delenv("STRIDE_AUTH_ALLOW_INSECURE_WITHOUT_KEY", raising=False)

    cfg = load_server_config(use_cache=False)

    assert cfg.env == "default"
    assert cfg.auth.allow_insecure_without_key is False


def test_repo_prod_config_file_loads_prod_values_without_env_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in {
        "STRIDE_CONFIG_FILES",
        "STRIDE_ENV",
        "STRIDE_AUTH_ALLOW_INSECURE_WITHOUT_KEY",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_AUDIENCE",
        "STRIDE_AUTH_URL",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_DEPLOYMENT",
        "LLM_ENABLED",
        "LLM_DEFAULT_MODEL",
        "AOAI_COMMENTARY_ENABLED",
        "STRIDE_CONTENT_BLOB_ACCOUNT_URL",
        "STRIDE_CONTENT_BLOB_CONTAINER",
        "STRIDE_CONTENT_BLOB_PREFIX",
        "STRIDE_LIKES_TABLE_ACCOUNT_URL",
        "STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL",
        "STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL",
        "JPUSH_APP_KEY",
        "JPUSH_MASTER_SECRET",
    }:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")

    def empty_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, object]:
        assert vault_url == "https://stride-kv-common.vault.azure.net/"
        assert secret_prefix == "stride-server"
        assert "internal.token" in manifest
        return {}

    cfg = load_server_config(akv_source=empty_akv_source, use_cache=False)

    assert cfg.env == "prod"
    assert cfg.akv.enabled is True
    assert cfg.akv.vault_url == "https://stride-kv-common.vault.azure.net/"
    assert cfg.akv.secret_prefix == "stride-server"
    assert cfg.auth.allow_insecure_without_key is False
    assert cfg.auth.public_key_pem.startswith("-----BEGIN PUBLIC KEY-----")
    assert cfg.auth.public_key_path == ""
    assert cfg.auth.audience == "app_62978bf2803346878a2e4805"
    assert cfg.auth_service.base_url == "https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io"
    assert cfg.storage.content.account_url == "https://authstorage2026.blob.core.windows.net/"
    assert cfg.storage.content.container == "stride-data"
    assert cfg.storage.content.prefix == "users"
    assert cfg.storage.likes.table_account_url == "https://authstorage2026.table.core.windows.net/"
    assert cfg.storage.master_plan.table_account_url == "https://authstorage2026.table.core.windows.net/"
    assert cfg.coach_persistence.table_account_url == "https://authstorage2026.table.core.windows.net/"
    assert cfg.coach_persistence.blob_account_url == "https://authstorage2026.blob.core.windows.net/"
    assert cfg.notifications.table_account_url == "https://authstorage2026.table.core.windows.net/"
    assert cfg.notifications.jpush.app_key == "ab305c4addc8f9aa2b5efb4c"
    assert cfg.notifications.jpush.master_secret == ""


def test_repo_prod_config_env_still_overrides_file_and_akv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STRIDE_CONFIG_FILES", raising=False)
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", "prod-public-key-from-env")
    monkeypatch.setenv("STRIDE_LIKES_TABLE_ACCOUNT_URL", "https://env-table.example/")

    def fake_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, object]:
        return {
            "auth": {"public_key_pem": "prod-public-key-from-akv"},
            "storage": {"likes": {"table_account_url": "https://akv-table.example/"}},
        }

    cfg = load_server_config(akv_source=fake_akv_source, use_cache=False)

    assert cfg.auth.public_key_pem == "prod-public-key-from-env"
    assert cfg.storage.likes.table_account_url == "https://env-table.example/"
    assert cfg.notifications.table_account_url == "https://env-table.example/"
