# Server Runtime Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move backend runtime configuration behind typed `stride_server.config` classes with multi-environment TOML, Azure Key Vault, and environment-variable override support.

**Architecture:** Add a backend-only configuration package under `src/stride_server/config`, then migrate existing server modules from direct `os.environ` reads to config-aware factories and request dependencies. Config source precedence is file layer, Azure Key Vault, then environment variables; `coach.runtime.config` remains separate to preserve import boundaries.

**Tech Stack:** Python 3.11 dataclasses, `tomllib`, FastAPI app state/dependencies, Azure Key Vault via `azure-keyvault-secrets`, pytest, import-linter.

---

## File Structure

Create:

- `src/stride_server/config/__init__.py`: public config API exports.
- `src/stride_server/config/models.py`: immutable dataclasses, defaults, validation helpers.
- `src/stride_server/config/sources.py`: file, env, AKV source readers plus deep merge.
- `src/stride_server/config/loader.py`: environment resolution, source orchestration, cached `load_server_config()`.
- `tests/stride_server/test_server_config_loader.py`: source precedence, parsing, validation, AKV bootstrap tests.
- `config/server.toml`: shared backend defaults.
- `config/server.local.toml`: local development overrides.
- `config/server.prod.toml`: production runtime values and backend selections.

Modify:

- `src/stride_server/app.py`: accept `ServerConfig`, store on `app.state.config`, use auth config for startup fail-closed check.
- `src/stride_server/main.py`: load config before app factory.
- `src/stride_server/deps.py`: add `get_server_config(request)` dependency.
- `src/stride_server/bearer.py`: read auth settings from `AuthConfig` with compatibility wrappers.
- `src/stride_server/auth_service_client.py`: accept `AuthServiceConfig` for base URL and timeout.
- `src/stride_server/llm_client.py`: build `LLMClient` from `LLMConfig`.
- `src/stride_server/aoai_client.py`: build commentary AOAI client from `CommentaryConfig`.
- `src/stride_server/content_store.py`: choose file/blob backend from `ContentStorageConfig`.
- `src/stride_server/likes_store.py`: choose JSON/Azure backend from `LikesStorageConfig`.
- `src/stride_server/master_plan_store.py`: choose JSON/Azure backend from `MasterPlanStorageConfig`.
- `src/stride_server/notifications/store.py`: choose file/Azure backend from `NotificationStorageConfig`.
- `src/stride_server/notifications/jpush_client.py`: read JPush credentials from `JPushConfig`.
- `src/stride_server/coach_adapters/persistence/azure_backend.py`: add `AzureCheckpointStore.from_config()`.
- `src/stride_server/coach_adapters/persistence/checkpointer.py`: add `AzureTableCheckpointSaver.from_config()`.
- `src/stride_server/coach_adapters/persistence/jobs_store.py`: add `jobs_store_from_config()`.
- `src/stride_server/coach_adapters/persistence/weekly_version_store.py`: add `weekly_version_store_from_config()`.
- `src/stride_server/coach_runtime.py`: get persistence config from server config for checkpointer construction.
- `src/stride_server/routes/plan.py`: validate internal token through `InternalConfig`.
- `src/stride_server/routes/onboarding.py`: read sync stale threshold through `SyncConfig`.

Do not modify frontend, mobile, `coach.runtime.config`, or per-user watch credential files.

---

### Task 1: Typed Config Models

**Files:**
- Create: `src/stride_server/config/__init__.py`
- Create: `src/stride_server/config/models.py`
- Test: `tests/stride_server/test_server_config_loader.py`

- [ ] **Step 1: Write failing tests for defaults and validation**

Append these tests to `tests/stride_server/test_server_config_loader.py`:

```python
from __future__ import annotations

import pytest

from stride_server.config.models import (
    AuthConfig,
    CoachPersistenceConfig,
    ConfigError,
    ContentStorageConfig,
    ServerConfig,
)


def test_server_config_default_shape_keeps_current_defaults() -> None:
    cfg = ServerConfig.default(env="dev")

    assert cfg.env == "dev"
    assert cfg.auth.issuer == "auth-service"
    assert cfg.auth.allow_insecure_without_key is True
    assert cfg.auth_service.timeout_s == 5.0
    assert cfg.llm.default_model == "gpt-4.1"
    assert cfg.llm.azure_openai.api_version == "2024-10-21"
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: FAIL with `ModuleNotFoundError: No module named 'stride_server.config'`.

- [ ] **Step 3: Create config dataclasses and validation helpers**

Create `src/stride_server/config/models.py` with immutable dataclasses for every field used by the tests. Implement these public members exactly:

```python
class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class ServerConfig:
    @classmethod
    def default(cls, *, env: str) -> "ServerConfig":
        return cls(env=env)

    def with_updates(self, **updates: object) -> "ServerConfig":
        return replace(self, **updates)

    def validate(self) -> None:
        validate_auth(self.env, self.auth)
        validate_positive("auth_service.timeout_s", self.auth_service.timeout_s)
        validate_positive("coach_persistence.jobs_stale_after_seconds", self.coach_persistence.jobs_stale_after_seconds)
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
```

The full file should include child dataclasses named in the file structure section. Use `replace(self, **updates)` for every child `with_updates()` method.

- [ ] **Step 4: Export public API**

Create `src/stride_server/config/__init__.py` with model exports only for this task:

```python
from .models import ConfigError, ServerConfig

__all__ = ["ConfigError", "ServerConfig"]
```

- [ ] **Step 5: Run model tests**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: PASS for the five model tests in this task.

- [ ] **Step 6: Commit model foundation**

```bash
git add src/stride_server/config/__init__.py src/stride_server/config/models.py tests/stride_server/test_server_config_loader.py
git commit -m "feat(config): add typed server config models"
```

---

### Task 2: Source Readers and Merge Semantics

**Files:**
- Create: `src/stride_server/config/sources.py`
- Modify: `tests/stride_server/test_server_config_loader.py`

- [ ] **Step 1: Write failing tests for merge, type parsing, and env mapping**

Append these tests to `tests/stride_server/test_server_config_loader.py`:

```python
import os

from stride_server.config.sources import (
    deep_merge,
    env_source,
    parse_bool,
    parse_env_value,
    set_path,
)


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: FAIL with `ModuleNotFoundError` or missing functions from `stride_server.config.sources`.

- [ ] **Step 3: Implement source helpers**

Create `src/stride_server/config/sources.py` with these public functions and mappings:

```python
from __future__ import annotations

import os
import re
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .models import ConfigError


_ENV_MAPPING: dict[str, tuple[str, str]] = {
    "STRIDE_AUTH_PUBLIC_KEY_PEM": ("auth.public_key_pem", "str"),
    "STRIDE_AUTH_PUBLIC_KEY_PATH": ("auth.public_key_path", "str"),
    "STRIDE_AUTH_ISSUER": ("auth.issuer", "str"),
    "STRIDE_AUTH_AUDIENCE": ("auth.audience", "str"),
    "STRIDE_AUTH_ALLOW_INSECURE_WITHOUT_KEY": ("auth.allow_insecure_without_key", "bool"),
    "STRIDE_AUTH_URL": ("auth_service.base_url", "str"),
    "STRIDE_AUTH_SERVICE_TIMEOUT_SECONDS": ("auth_service.timeout_s", "float"),
    "AZURE_OPENAI_ENDPOINT": ("llm.azure_openai.endpoint", "str"),
    "AZURE_OPENAI_API_KEY": ("llm.azure_openai.api_key", "str"),
    "AZURE_OPENAI_API_VERSION": ("llm.azure_openai.api_version", "str"),
    "AZURE_OPENAI_DEPLOYMENT": ("llm.azure_openai.deployment", "str"),
    "LLM_ENABLED": ("llm.enabled", "bool"),
    "LLM_DEFAULT_MODEL": ("llm.default_model", "str"),
    "AOAI_COMMENTARY_ENABLED": ("commentary.enabled", "bool"),
    "STRIDE_INTERNAL_TOKEN": ("internal.token", "str"),
    "STRIDE_COACH_TABLE_ACCOUNT_URL": ("coach_persistence.table_account_url", "str"),
    "STRIDE_COACH_BLOB_ACCOUNT_URL": ("coach_persistence.blob_account_url", "str"),
    "STRIDE_COACH_CHECKPOINTS_TABLE_NAME": ("coach_persistence.checkpoints_table_name", "str"),
    "STRIDE_COACH_CHECKPOINT_WRITES_TABLE_NAME": ("coach_persistence.checkpoint_writes_table_name", "str"),
    "STRIDE_COACH_JOBS_TABLE_NAME": ("coach_persistence.jobs_table_name", "str"),
    "STRIDE_COACH_WEEKLY_VERSIONS_TABLE_NAME": ("coach_persistence.weekly_versions_table_name", "str"),
    "STRIDE_COACH_BLOB_CONTAINER": ("coach_persistence.blob_container", "str"),
    "STRIDE_COACH_FILE_BACKEND_DIR": ("coach_persistence.file_backend_dir", "str"),
    "STRIDE_CONTENT_BLOB_ACCOUNT_URL": ("storage.content.account_url", "str"),
    "STRIDE_CONTENT_BLOB_CONTAINER": ("storage.content.container", "str"),
    "STRIDE_CONTENT_BLOB_PREFIX": ("storage.content.prefix", "str"),
    "STRIDE_LIKES_TABLE_ACCOUNT_URL": ("storage.likes.table_account_url", "str"),
    "STRIDE_LIKES_TABLE_NAME": ("storage.likes.table_name", "str"),
    "STRIDE_STORAGE_LIKES_TABLE_NAME": ("storage.likes.table_name", "str"),
    "STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL": ("storage.master_plan.table_account_url", "str"),
    "STRIDE_MASTER_PLAN_TABLE_NAME": ("storage.master_plan.table_name", "str"),
    "STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL": ("notifications.table_account_url", "str"),
    "STRIDE_NOTIFICATIONS_DEVICES_TABLE": ("notifications.devices_table", "str"),
    "STRIDE_NOTIFICATIONS_PREFS_TABLE": ("notifications.prefs_table", "str"),
    "JPUSH_APP_KEY": ("notifications.jpush.app_key", "str"),
    "JPUSH_MASTER_SECRET": ("notifications.jpush.master_secret", "str"),
    "STRIDE_SYNC_STALE_AFTER_SECONDS": ("sync.stale_after_seconds", "int"),
    "STRIDE_AKV_ENABLED": ("akv.enabled", "bool"),
    "STRIDE_AKV_VAULT_URL": ("akv.vault_url", "str"),
    "STRIDE_AKV_SECRET_PREFIX": ("akv.secret_prefix", "str"),
}

_MIRROR_ENV_MAPPING: dict[str, list[tuple[str, str]]] = {
    "AZURE_OPENAI_ENDPOINT": [("commentary.azure_openai.endpoint", "str")],
    "AZURE_OPENAI_API_KEY": [("commentary.azure_openai.api_key", "str")],
    "AZURE_OPENAI_API_VERSION": [("commentary.azure_openai.api_version", "str")],
    "AZURE_OPENAI_DEPLOYMENT": [("commentary.azure_openai.deployment", "str")],
    "STRIDE_LIKES_TABLE_ACCOUNT_URL": [("notifications.table_account_url", "str")],
}


def deep_merge(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    merged = dict(left)
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)  # type: ignore[arg-type]
        else:
            merged[key] = value
    return merged


def set_path(target: dict[str, Any], path: str, value: Any) -> None:
    current = target
    parts = path.split(".")
    for part in parts[:-1]:
        child = current.setdefault(part, {})
        if not isinstance(child, dict):
            raise ConfigError(f"cannot set {path}: {part} is already scalar")
        current = child
    current[parts[-1]] = value


def parse_bool(value: str) -> bool:
    raw = value.strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"invalid boolean value {value!r}")


def parse_env_value(value: str, value_type: str) -> Any:
    if value_type == "str":
        return value
    if value_type == "bool":
        return parse_bool(value)
    if value_type == "int":
        return int(value)
    if value_type == "float":
        return float(value)
    raise ConfigError(f"unknown env value type {value_type!r}")


def env_source(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    data: dict[str, Any] = {}
    for name, (path, value_type) in _ENV_MAPPING.items():
        if name in env:
            set_path(data, path, parse_env_value(env[name], value_type))
        for mirror_path, mirror_type in _MIRROR_ENV_MAPPING.get(name, []):
            if name in env:
                set_path(data, mirror_path, parse_env_value(env[name], mirror_type))
    return data


def toml_file_source(path: Path) -> dict[str, Any]:
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"failed to parse {path}: {exc}") from exc
    except OSError as exc:
        raise ConfigError(f"failed to read {path}: {exc}") from exc
    return raw


def akv_secret_name(prefix: str, path: str) -> str:
    clean_prefix = prefix.strip("-")
    key = re.sub(r"[^0-9A-Za-z]+", "-", path).strip("-")
    return f"{clean_prefix}--{key}" if clean_prefix else key
```

- [ ] **Step 4: Run source tests**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: PASS for Task 1 and Task 2 tests.

- [ ] **Step 5: Commit source readers**

```bash
git add src/stride_server/config/sources.py tests/stride_server/test_server_config_loader.py
git commit -m "feat(config): add server config sources"
```

---

### Task 3: Loader, Multi-Environment Files, AKV Precedence

**Files:**
- Create: `src/stride_server/config/loader.py`
- Modify: `src/stride_server/config/__init__.py`
- Modify: `tests/stride_server/test_server_config_loader.py`

- [ ] **Step 1: Write failing loader tests**

Append these tests to `tests/stride_server/test_server_config_loader.py`:

```python
from pathlib import Path

from stride_server.config.loader import (
    clear_server_config_cache,
    load_server_config,
    resolve_config_env,
    resolve_file_layer,
)


def test_resolve_config_env_prefers_stride_config_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STRIDE_ENV", "prod")
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "local")

    assert resolve_config_env() == "local"


def test_resolve_file_layer_uses_default_base_and_optional_env_file(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    base = config_dir / "server.toml"
    prod = config_dir / "server.prod.toml"
    base.write_text("env = 'base'", encoding="utf-8")
    prod.write_text("env = 'prod'", encoding="utf-8")

    assert resolve_file_layer(config_dir=config_dir, env="prod", explicit_files=None) == [base, prod]


def test_resolve_file_layer_allows_missing_default_env_file(tmp_path: Path) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    base = config_dir / "server.toml"
    base.write_text("env = 'base'", encoding="utf-8")

    assert resolve_file_layer(config_dir=config_dir, env="local", explicit_files=None) == [base]


def test_resolve_file_layer_requires_explicit_files(tmp_path: Path) -> None:
    missing = tmp_path / "missing.toml"

    with pytest.raises(ConfigError, match="explicit config file not found"):
        resolve_file_layer(config_dir=tmp_path, env="dev", explicit_files=str(missing))


def test_load_server_config_file_akv_env_precedence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
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
    monkeypatch.setenv("STRIDE_STORAGE_LIKES_TABLE_NAME", "from-env")

    def fake_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, object]:
        assert vault_url == "https://vault.example"
        assert secret_prefix == "stride-server"
        assert "storage.likes.table_name" in manifest
        return {"storage": {"likes": {"table_name": "from-akv"}}}

    cfg = load_server_config(
        config_dir=config_dir,
        environ=os.environ,
        akv_source=fake_akv_source,
        use_cache=False,
    )

    assert cfg.storage.likes.table_name == "from-env"


def test_load_server_config_explicit_files_replace_default_layer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    default_dir = tmp_path / "config"
    default_dir.mkdir()
    (default_dir / "server.toml").write_text("[storage.likes]\ntable_name='default'", encoding="utf-8")
    explicit = tmp_path / "custom.toml"
    explicit.write_text("[storage.likes]\ntable_name='explicit'", encoding="utf-8")
    monkeypatch.setenv("STRIDE_CONFIG_FILES", str(explicit))

    cfg = load_server_config(config_dir=default_dir, environ=os.environ, use_cache=False)

    assert cfg.storage.likes.table_name == "explicit"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: FAIL with missing `stride_server.config.loader`.

- [ ] **Step 3: Implement loader orchestration**

Create `src/stride_server/config/loader.py` with these public functions:

```python
from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any

from .models import ConfigError, ServerConfig, config_from_dict
from .sources import deep_merge, env_source, toml_file_source

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_DIR = PROJECT_ROOT / "config"

AkVSource = Callable[[str, str, list[str]], dict[str, Any]]


def resolve_config_env(environ: Mapping[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    return (env.get("STRIDE_CONFIG_ENV") or env.get("STRIDE_ENV") or "default").strip() or "default"


def _split_files(raw: str) -> list[Path]:
    pieces = [p.strip() for chunk in raw.split(";") for p in chunk.split(",")]
    return [Path(p) for p in pieces if p]


def resolve_file_layer(*, config_dir: Path, env: str, explicit_files: str | None) -> list[Path]:
    if explicit_files:
        files = _split_files(explicit_files)
        for path in files:
            if not path.exists():
                raise ConfigError(f"explicit config file not found: {path}")
        return files
    base = config_dir / "server.toml"
    if not base.exists():
        raise ConfigError(f"base server config not found: {base}")
    files = [base]
    env_file = config_dir / f"server.{env}.toml"
    if env_file.exists():
        files.append(env_file)
    return files


def _known_secret_manifest() -> list[str]:
    return [
        "auth.public_key_pem",
        "auth.public_key_path",
        "auth.issuer",
        "auth.audience",
        "auth_service.base_url",
        "llm.azure_openai.endpoint",
        "llm.azure_openai.api_key",
        "llm.azure_openai.api_version",
        "llm.azure_openai.deployment",
        "commentary.azure_openai.endpoint",
        "commentary.azure_openai.api_key",
        "commentary.azure_openai.api_version",
        "commentary.azure_openai.deployment",
        "storage.content.account_url",
        "storage.content.container",
        "storage.likes.table_account_url",
        "storage.likes.table_name",
        "storage.master_plan.table_account_url",
        "storage.master_plan.table_name",
        "coach_persistence.table_account_url",
        "coach_persistence.blob_account_url",
        "notifications.table_account_url",
        "notifications.jpush.app_key",
        "notifications.jpush.master_secret",
        "internal.token",
    ]


def _default_akv_source(vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, Any]:
    from azure.core.exceptions import ResourceNotFoundError
    from azure.identity import DefaultAzureCredential
    from azure.keyvault.secrets import SecretClient

    from .sources import akv_secret_name, parse_env_value, set_path

    client = SecretClient(vault_url=vault_url, credential=DefaultAzureCredential())
    data: dict[str, Any] = {}
    for key_path in manifest:
        secret_name = akv_secret_name(secret_prefix, key_path)
        try:
            value = client.get_secret(secret_name).value
        except ResourceNotFoundError:
            continue
        if value is None:
            continue
        set_path(data, key_path, value)
    return data


def _load_uncached(
    *,
    config_dir: Path,
    environ: Mapping[str, str],
    akv_source: Callable[..., dict[str, Any]] | None,
) -> ServerConfig:
    env = resolve_config_env(environ)
    files = resolve_file_layer(
        config_dir=config_dir,
        env=env,
        explicit_files=environ.get("STRIDE_CONFIG_FILES"),
    )
    merged: dict[str, Any] = {"env": env}
    for path in files:
        merged = deep_merge(merged, toml_file_source(path))

    bootstrap = deep_merge(merged, env_source(environ))
    bootstrap_cfg = config_from_dict(bootstrap)
    if bootstrap_cfg.akv.enabled:
        source = akv_source or _default_akv_source
        akv_data = source(
            vault_url=bootstrap_cfg.akv.vault_url,
            secret_prefix=bootstrap_cfg.akv.secret_prefix,
            manifest=_known_secret_manifest(),
        )
        merged = deep_merge(merged, akv_data)

    merged = deep_merge(merged, env_source(environ))
    cfg = config_from_dict(merged)
    cfg.validate()
    return cfg


@lru_cache(maxsize=1)
def _cached_default() -> ServerConfig:
    return _load_uncached(config_dir=DEFAULT_CONFIG_DIR, environ=os.environ, akv_source=None)


def load_server_config(
    *,
    config_dir: Path | None = None,
    environ: Mapping[str, str] | None = None,
    akv_source: Callable[..., dict[str, Any]] | None = None,
    use_cache: bool = True,
) -> ServerConfig:
    if config_dir is None and environ is None and akv_source is None and use_cache:
        return _cached_default()
    return _load_uncached(
        config_dir=config_dir or DEFAULT_CONFIG_DIR,
        environ=os.environ if environ is None else environ,
        akv_source=akv_source,
    )


def clear_server_config_cache() -> None:
    _cached_default.cache_clear()


reset_server_config_cache = clear_server_config_cache
```

Also implement `config_from_dict()` in `models.py`. It should construct every dataclass from nested dicts, applying defaults from `ServerConfig.default(env=...)` and deep-merging the input over the default dataclass shape.

- [ ] **Step 4: Update package exports**

Modify `src/stride_server/config/__init__.py` so it imports from the new loader:

```python
from .loader import load_server_config, reset_server_config_cache
from .models import ConfigError, ServerConfig

__all__ = ["ConfigError", "ServerConfig", "load_server_config", "reset_server_config_cache"]
```

- [ ] **Step 5: Run loader tests**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: PASS.

- [ ] **Step 6: Commit loader**

```bash
git add src/stride_server/config/loader.py src/stride_server/config/__init__.py src/stride_server/config/models.py tests/stride_server/test_server_config_loader.py
git commit -m "feat(config): load server config from files akv and env"
```

---

### Task 4: Baseline Config Files

**Files:**
- Create: `config/server.toml`
- Create: `config/server.local.toml`
- Create: `config/server.prod.toml`
- Modify: `tests/stride_server/test_server_config_loader.py`

- [ ] **Step 1: Write failing canonical file test**

Append this test to `tests/stride_server/test_server_config_loader.py`:

```python
def test_repo_server_config_files_load(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STRIDE_CONFIG_FILES", raising=False)
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "local")

    cfg = load_server_config(use_cache=False)

    assert cfg.env == "local"
    assert cfg.storage.likes.table_name == "stridelikes"
    assert cfg.coach_persistence.file_backend_dir == "data/_coach_dev"


def test_repo_prod_config_file_loads_without_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STRIDE_CONFIG_FILES", raising=False)
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.setenv("STRIDE_AUTH_ALLOW_INSECURE_WITHOUT_KEY", "true")

    cfg = load_server_config(use_cache=False)

    assert cfg.env == "prod"
    assert cfg.auth.allow_insecure_without_key is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py::test_repo_server_config_files_load tests/stride_server/test_server_config_loader.py::test_repo_prod_config_file_loads_without_secrets -q`

Expected: FAIL because `config/server.toml` does not exist.

- [ ] **Step 3: Create shared server config file**

Create `config/server.toml`:

```toml
# STRIDE backend runtime configuration.
# Source precedence: file layer < Azure Key Vault < environment variables.

env = "default"

[akv]
enabled = false
vault_url = ""
secret_prefix = "stride-server"

[auth]
public_key_pem = ""
public_key_path = ""
issuer = "auth-service"
audience = ""
allow_insecure_without_key = false

[auth_service]
base_url = ""
timeout_s = 5.0

[llm]
enabled = false
default_model = "gpt-4.1"

[llm.azure_openai]
endpoint = ""
api_key = ""
api_version = "2024-10-21"
deployment = "gpt-4.1"
timeout_s = 60.0

[commentary]
enabled = false

[commentary.azure_openai]
endpoint = ""
api_key = ""
api_version = "2024-10-21"
deployment = "gpt-4.1"
timeout_s = 60.0

[storage.content]
account_url = ""
container = ""
prefix = "users"

[storage.likes]
table_account_url = ""
table_name = "stridelikes"

[storage.master_plan]
table_account_url = ""
table_name = "stridemasterplan"

[coach_persistence]
table_account_url = ""
blob_account_url = ""
checkpoints_table_name = "stridecoachcheckpoints"
checkpoint_writes_table_name = "stridecoachcheckpointwrites"
jobs_table_name = "stridecoachjobs"
weekly_versions_table_name = "strideweeklyversions"
blob_container = "coach-checkpoints"
file_backend_dir = "data/_coach_dev"
jobs_stale_after_seconds = 120

[notifications]
table_account_url = ""
devices_table = "stridedevices"
prefs_table = "strideprefs"

[notifications.jpush]
app_key = ""
master_secret = ""
url = "https://api.jpush.cn/v3/push"
timeout_s = 10.0
apns_production = true

[sync]
stale_after_seconds = 300

[internal]
token = ""
```

- [ ] **Step 4: Create local overrides**

Create `config/server.local.toml`:

```toml
env = "local"

[auth]
allow_insecure_without_key = true

[llm]
enabled = false

[commentary]
enabled = false

[coach_persistence]
file_backend_dir = "data/_coach_dev"
```

- [ ] **Step 5: Create production overrides**

Create `config/server.prod.toml`:

```toml
env = "prod"

[auth]
allow_insecure_without_key = false
public_key_path = "config/auth-public.pem"

[akv]
enabled = false
vault_url = ""
secret_prefix = "stride-server"

[storage.content]
prefix = "users"

[coach_persistence]
file_backend_dir = "data/_coach_dev"
```

- [ ] **Step 6: Run canonical config tests**

Run: `PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py -q`

Expected: PASS.

- [ ] **Step 7: Commit config files**

```bash
git add config/server.toml config/server.local.toml config/server.prod.toml tests/stride_server/test_server_config_loader.py
git commit -m "feat(config): add server runtime toml files"
```

---

### Task 5: FastAPI App Wiring and Auth Config

**Files:**
- Modify: `src/stride_server/app.py`
- Modify: `src/stride_server/main.py`
- Modify: `src/stride_server/deps.py`
- Modify: `src/stride_server/bearer.py`
- Test: `tests/test_bearer.py`
- Test: `tests/stride_server/test_home.py` or existing app factory tests

- [ ] **Step 1: Write failing tests for app config state and auth behavior**

Add tests near existing bearer/app tests:

```python
from stride_server.config.models import AuthConfig, ServerConfig
from stride_server.app import create_app
from stride_server.bearer import is_dev_mode, load_public_key_from_config


def test_create_app_stores_server_config(fake_source) -> None:
    cfg = ServerConfig.default(env="dev")

    app = create_app(fake_source, config=cfg)

    assert app.state.config is cfg


def test_load_public_key_from_config_prefers_inline_pem() -> None:
    cfg = AuthConfig(public_key_pem="pem-inline", public_key_path="missing.pem")

    assert load_public_key_from_config(cfg) == "pem-inline"


def test_is_dev_mode_uses_config_env() -> None:
    assert is_dev_mode(ServerConfig.default(env="dev")) is True
    assert is_dev_mode(ServerConfig.default(env="local")) is True
    assert is_dev_mode(ServerConfig.default(env="prod")) is False
```

Use the same fake source fixture or provider registry construction already used in `tests/stride_server/test_home.py`. Do not instantiate real watch clients in this test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/test_bearer.py tests/stride_server/test_home.py -q`

Expected: FAIL because `create_app` does not accept `config` and bearer helpers do not accept config.

- [ ] **Step 3: Update bearer helper API**

Modify `src/stride_server/bearer.py`:

```python
from stride_server.config.models import AuthConfig, ServerConfig
from stride_server.config import load_server_config


def is_dev_mode(config: ServerConfig | None = None) -> bool:
    cfg = config or load_server_config()
    return cfg.env in {"dev", "local", "default"}


def load_public_key_from_config(config: AuthConfig) -> str | None:
    if config.public_key_pem:
        return config.public_key_pem
    if config.public_key_path:
        path = Path(config.public_key_path)
        if path.exists():
            return path.read_text(encoding="utf-8")
    return None
```

Keep `_load_public_key()` as a compatibility wrapper:

```python
def _load_public_key() -> str | None:
    global _cached_public_key
    if _cached_public_key is not None:
        return _cached_public_key
    key = load_public_key_from_config(load_server_config().auth)
    if key is not None:
        _cached_public_key = key
    return key
```

In `require_bearer`, use `cfg = load_server_config()` and read `cfg.auth.issuer` / `cfg.auth.audience`. Preserve current fail-open behavior only when `cfg.auth.allow_insecure_without_key` is true.

- [ ] **Step 4: Wire config into app factory**

Modify `src/stride_server/app.py`:

```python
from stride_server.config import load_server_config
from stride_server.config.models import ServerConfig


def create_app(source_or_registry: DataSource | ProviderRegistry, config: ServerConfig | None = None) -> FastAPI:
    config = config or load_server_config()
    if load_public_key_from_config(config.auth) is None and not config.auth.allow_insecure_without_key:
        raise RuntimeError("STRIDE auth not configured: set auth.public_key_pem/path or allow_insecure_without_key=true for local development.")
    ...
    app.state.config = config
```

Replace the old `_load_public_key() is None and not is_dev_mode()` startup check.

- [ ] **Step 5: Add config dependency helper**

Modify `src/stride_server/deps.py`:

```python
from stride_server.config.models import ServerConfig


def get_server_config(request: Request) -> ServerConfig:
    return request.app.state.config
```

- [ ] **Step 6: Load config in composition root**

Modify `src/stride_server/main.py`:

```python
from stride_server.config import load_server_config

app = create_app(_build_registry(), config=load_server_config())
```

- [ ] **Step 7: Run auth/app tests**

Run: `PYTHONPATH=src pytest tests/test_bearer.py tests/stride_server/test_home.py -q`

Expected: PASS.

- [ ] **Step 8: Commit app wiring**

```bash
git add src/stride_server/app.py src/stride_server/main.py src/stride_server/deps.py src/stride_server/bearer.py tests/test_bearer.py tests/stride_server/test_home.py
git commit -m "feat(config): wire server config into app and auth"
```

---

### Task 6: Storage Backend Factories from Config

**Files:**
- Modify: `src/stride_server/content_store.py`
- Modify: `src/stride_server/likes_store.py`
- Modify: `src/stride_server/master_plan_store.py`
- Modify: `src/stride_server/notifications/store.py`
- Test: `tests/test_likes_store.py`
- Test: `tests/stride_server/test_master_plan_store.py`
- Test: `tests/test_teams_routes.py`

- [ ] **Step 1: Write failing tests for config-aware factories**

Add focused tests in the relevant existing test files:

```python
from stride_server.config.models import (
    ContentStorageConfig,
    LikesStorageConfig,
    MasterPlanStorageConfig,
    NotificationStorageConfig,
)


def test_likes_backend_uses_config_file_backend(monkeypatch) -> None:
    from stride_server import likes_store

    cfg = LikesStorageConfig(table_account_url="", table_name="stridelikes")

    backend = likes_store.backend_from_config(cfg)

    assert backend.__class__.__name__ == "_FileBackend"


def test_likes_backend_uses_config_azure_backend() -> None:
    from stride_server import likes_store

    cfg = LikesStorageConfig(table_account_url="https://acct.table.core.windows.net", table_name="customlikes")

    backend = likes_store.backend_from_config(cfg)

    assert backend.__class__.__name__ == "_AzureTableBackend"


def test_master_plan_store_uses_config_file_backend() -> None:
    from stride_server.master_plan_store import store_from_config

    store = store_from_config(MasterPlanStorageConfig(table_account_url="", table_name="stridemasterplan"))
    assert store.__class__.__name__ == "FileMasterPlanStore"


def test_notifications_backend_uses_config_file_backend() -> None:
    from stride_server.notifications.store import backend_from_config

    backend = backend_from_config(NotificationStorageConfig(table_account_url="", devices_table="stridedevices", prefs_table="strideprefs"))
    assert backend.__class__.__name__ == "_FileBackend"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/test_likes_store.py tests/stride_server/test_master_plan_store.py tests/test_teams_routes.py -q`

Expected: FAIL with missing `backend_from_config` / `store_from_config`.

- [ ] **Step 3: Add config-aware content storage helpers**

In `src/stride_server/content_store.py`, add functions that accept `ContentStorageConfig`:

```python
from stride_server.config import load_server_config
from stride_server.config.models import ContentStorageConfig


def _blob_prefix_from_config(config: ContentStorageConfig) -> str:
    return config.prefix.strip().strip("/")


def _blob_config_from_config(config: ContentStorageConfig) -> tuple[str, str] | None:
    account_url = config.account_url.strip()
    container = config.container.strip()
    if not account_url or not container:
        return None
    return account_url, container
```

Update public functions to accept `config: ContentStorageConfig | None = None` and call `config = config or load_server_config().storage.content` before deciding blob/file behavior. Keep old no-argument calls working.

- [ ] **Step 4: Add config-aware likes backend**

In `src/stride_server/likes_store.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import LikesStorageConfig


def backend_from_config(config: LikesStorageConfig) -> _Backend:
    if config.table_account_url:
        logger.info("likes_store: using Azure Table backend table=%s", config.table_name)
        return _AzureTableBackend(config.table_account_url, config.table_name)
    logger.info("likes_store: using JSON file backend at %s", _file_path())
    return _FileBackend()
```

Update `_get_backend()` to call `backend_from_config(load_server_config().storage.likes)`.

- [ ] **Step 5: Add config-aware master plan store**

In `src/stride_server/master_plan_store.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import MasterPlanStorageConfig


def store_from_config(config: MasterPlanStorageConfig) -> MasterPlanStore:
    if config.table_account_url:
        logger.info("master_plan_store: using Azure Table backend table=%s", config.table_name)
        return AzureTableMasterPlanStore(config.table_account_url, config.table_name)
    logger.info("master_plan_store: using JSON file backend plans=%s versions=%s", _plans_file(), _versions_file())
    return FileMasterPlanStore()
```

Update `get_master_plan_store()` to delegate to `store_from_config(load_server_config().storage.master_plan)`.

- [ ] **Step 6: Add config-aware notifications backend**

In `src/stride_server/notifications/store.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import NotificationStorageConfig


def backend_from_config(config: NotificationStorageConfig) -> _Backend:
    if config.table_account_url:
        logger.info("notifications.store: Azure Tables backend devices=%s prefs=%s", config.devices_table, config.prefs_table)
        return _AzureTableBackend(config.table_account_url, config.devices_table, config.prefs_table)
    logger.info("notifications.store: file backend at %s", _file_path())
    return _FileBackend()
```

Update `_get_backend()` to delegate to `backend_from_config(load_server_config().notifications)`.

- [ ] **Step 7: Run storage tests**

Run: `PYTHONPATH=src pytest tests/test_likes_store.py tests/stride_server/test_master_plan_store.py tests/test_teams_routes.py -q`

Expected: PASS.

- [ ] **Step 8: Commit storage migration**

```bash
git add src/stride_server/content_store.py src/stride_server/likes_store.py src/stride_server/master_plan_store.py src/stride_server/notifications/store.py tests/test_likes_store.py tests/stride_server/test_master_plan_store.py tests/test_teams_routes.py
git commit -m "feat(config): drive storage backends from server config"
```

---

### Task 7: LLM, Commentary, Auth-Service, and JPush Config

**Files:**
- Modify: `src/stride_server/llm_client.py`
- Modify: `src/stride_server/aoai_client.py`
- Modify: `src/stride_server/auth_service_client.py`
- Modify: `src/stride_server/notifications/jpush_client.py`
- Test: `tests/stride_server/test_llm_client.py`
- Test: `tests/test_teams_routes.py`

- [ ] **Step 1: Write failing config-aware client tests**

Add or extend tests:

```python
from stride_server.config.models import (
    AuthServiceConfig,
    AzureOpenAIConfig,
    CommentaryConfig,
    JPushConfig,
    LLMConfig,
)


def test_llm_enabled_from_config_without_env() -> None:
    from stride_server.llm_client import is_enabled_from_config

    cfg = LLMConfig(enabled=True, default_model="gpt-test", azure_openai=AzureOpenAIConfig(endpoint="https://aoai.example"))
    assert is_enabled_from_config(cfg) is True


def test_llm_disabled_from_config_without_endpoint() -> None:
    from stride_server.llm_client import is_enabled_from_config

    cfg = LLMConfig(enabled=False, default_model="gpt-test", azure_openai=AzureOpenAIConfig(endpoint=""))
    assert is_enabled_from_config(cfg) is False


def test_commentary_enabled_from_config() -> None:
    from stride_server.aoai_client import is_enabled_from_config, get_deployment_from_config

    cfg = CommentaryConfig(enabled=True, azure_openai=AzureOpenAIConfig(deployment="commentary-model"))
    assert is_enabled_from_config(cfg) is True
    assert get_deployment_from_config(cfg) == "commentary-model"


def test_jpush_credentials_from_config() -> None:
    from stride_server.notifications.jpush_client import credentials_from_config

    cfg = JPushConfig(app_key="app", master_secret="secret")
    assert credentials_from_config(cfg) == ("app", "secret")


def test_auth_service_base_url_from_config() -> None:
    from stride_server.auth_service_client import base_url_from_config

    assert base_url_from_config(AuthServiceConfig(base_url="https://auth.example/", timeout_s=2.0)) == "https://auth.example"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/stride_server/test_llm_client.py tests/test_teams_routes.py -q`

Expected: FAIL with missing config-aware helpers.

- [ ] **Step 3: Update LLM client**

In `src/stride_server/llm_client.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import LLMConfig


def is_enabled_from_config(config: LLMConfig) -> bool:
    return bool(config.enabled or config.azure_openai.endpoint.strip())


def default_model_from_config(config: LLMConfig) -> str:
    return config.default_model
```

Change `LLMClient.__init__` to accept `config: LLMConfig | None = None`, defaulting to `load_server_config().llm`. Use `config.azure_openai.endpoint`, `api_version`, `api_key`, `timeout_s`, and `default_model`. Keep `_is_enabled()` and `_default_model()` wrappers for old tests but make them delegate to loaded config.

- [ ] **Step 4: Update commentary AOAI client**

In `src/stride_server/aoai_client.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import CommentaryConfig


def is_enabled_from_config(config: CommentaryConfig) -> bool:
    return config.enabled


def get_deployment_from_config(config: CommentaryConfig) -> str:
    return config.azure_openai.deployment
```

Change `get_client(config: CommentaryConfig | None = None)` to default to `load_server_config().commentary` and read Azure OpenAI fields from config. Keep `is_enabled()` and `get_deployment()` wrappers delegating to loaded config.

- [ ] **Step 5: Update auth-service client**

In `src/stride_server/auth_service_client.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import AuthServiceConfig


def base_url_from_config(config: AuthServiceConfig) -> str:
    url = config.base_url.strip()
    if not url:
        raise AuthServiceUnavailable("auth_service.base_url not configured")
    return url.rstrip("/")
```

Change `_base_url()` to delegate to `base_url_from_config(load_server_config().auth_service)`. Change `_request()` timeout to use `load_server_config().auth_service.timeout_s`.

- [ ] **Step 6: Update JPush client**

In `src/stride_server/notifications/jpush_client.py`, add:

```python
from stride_server.config import load_server_config
from stride_server.config.models import JPushConfig


def credentials_from_config(config: JPushConfig) -> tuple[str, str] | None:
    app_key = config.app_key.strip()
    master_secret = config.master_secret.strip()
    if not app_key or not master_secret:
        return None
    return app_key, master_secret
```

Make `_credentials()` delegate to `credentials_from_config(load_server_config().notifications.jpush)`. In `push_to_registration_ids`, use `config.url`, `config.timeout_s`, and `config.apns_production` from loaded config.

- [ ] **Step 7: Run client tests**

Run: `PYTHONPATH=src pytest tests/stride_server/test_llm_client.py tests/test_teams_routes.py -q`

Expected: PASS.

- [ ] **Step 8: Commit client config migration**

```bash
git add src/stride_server/llm_client.py src/stride_server/aoai_client.py src/stride_server/auth_service_client.py src/stride_server/notifications/jpush_client.py tests/stride_server/test_llm_client.py tests/test_teams_routes.py
git commit -m "feat(config): drive external clients from server config"
```

---

### Task 8: Coach Persistence Config

**Files:**
- Modify: `src/stride_server/coach_adapters/persistence/azure_backend.py`
- Modify: `src/stride_server/coach_adapters/persistence/checkpointer.py`
- Modify: `src/stride_server/coach_adapters/persistence/jobs_store.py`
- Modify: `src/stride_server/coach_adapters/persistence/weekly_version_store.py`
- Modify: `src/stride_server/coach_runtime.py`
- Test: `tests/stride_server/test_job_runner.py`
- Test: `tests/stride_server/test_coach_routes.py`

- [ ] **Step 1: Write failing persistence factory tests**

Add tests near existing coach persistence tests:

```python
from stride_server.config.models import CoachPersistenceConfig


def test_jobs_store_from_config_uses_file_backend() -> None:
    from stride_server.coach_adapters.persistence.jobs_store import jobs_store_from_config

    store = jobs_store_from_config(CoachPersistenceConfig(file_backend_dir="data/_coach_dev"))

    assert store.__class__.__name__ == "FileJobsStore"


def test_weekly_version_store_from_config_uses_file_backend() -> None:
    from stride_server.coach_adapters.persistence.weekly_version_store import weekly_version_store_from_config

    store = weekly_version_store_from_config(CoachPersistenceConfig(file_backend_dir="data/_coach_dev"))

    assert store.__class__.__name__ == "FileWeeklyVersionStore"


def test_checkpointer_from_config_uses_file_store() -> None:
    from stride_server.coach_adapters.persistence.checkpointer import AzureTableCheckpointSaver

    saver = AzureTableCheckpointSaver.from_config(CoachPersistenceConfig(file_backend_dir="data/_coach_dev"))

    assert saver.store.__class__.__name__ == "FileCheckpointStore"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/stride_server/test_job_runner.py tests/stride_server/test_coach_routes.py -q`

Expected: FAIL with missing `from_config` helpers.

- [ ] **Step 3: Add Azure checkpoint store config factory**

In `src/stride_server/coach_adapters/persistence/azure_backend.py`, add:

```python
from stride_server.config.models import CoachPersistenceConfig


@classmethod
def from_config(cls, config: CoachPersistenceConfig) -> "AzureCheckpointStore":
    return cls(
        table_account_url=config.table_account_url,
        checkpoints_table_name=config.checkpoints_table_name,
        writes_table_name=config.checkpoint_writes_table_name,
        blob_account_url=config.blob_account_url,
        blob_container_name=config.blob_container,
    )
```

Attach it to `AzureCheckpointStore` as a classmethod, next to `from_env()`.

- [ ] **Step 4: Add checkpointer config factory**

In `src/stride_server/coach_adapters/persistence/checkpointer.py`, add:

```python
from stride_server.config.models import CoachPersistenceConfig


@classmethod
def from_config(cls, config: CoachPersistenceConfig, *, serde: SerializerProtocol | None = None) -> "AzureTableCheckpointSaver":
    if config.table_account_url:
        from .azure_backend import AzureCheckpointStore
        store: CheckpointStore = AzureCheckpointStore.from_config(config)
    else:
        store = FileCheckpointStore(os.path.join(config.file_backend_dir, "checkpoints"))
    return cls(store=store, serde=serde)
```

Keep `from_env()` as a wrapper:

```python
@classmethod
def from_env(cls, *, serde: SerializerProtocol | None = None) -> "AzureTableCheckpointSaver":
    from stride_server.config import load_server_config
    return cls.from_config(load_server_config().coach_persistence, serde=serde)
```

- [ ] **Step 5: Add job store config factory**

In `src/stride_server/coach_adapters/persistence/jobs_store.py`, add:

```python
from stride_server.config.models import CoachPersistenceConfig


def jobs_store_from_config(config: CoachPersistenceConfig) -> JobsStore:
    if config.table_account_url:
        return AzureJobsStore(table_account_url=config.table_account_url, table_name=config.jobs_table_name)
    return FileJobsStore(os.path.join(config.file_backend_dir, "jobs"))


def jobs_store_from_env() -> JobsStore:
    from stride_server.config import load_server_config
    return jobs_store_from_config(load_server_config().coach_persistence)
```

- [ ] **Step 6: Add weekly version store config factory**

In `src/stride_server/coach_adapters/persistence/weekly_version_store.py`, add:

```python
from stride_server.config.models import CoachPersistenceConfig


def weekly_version_store_from_config(config: CoachPersistenceConfig) -> WeeklyVersionStore:
    if config.table_account_url:
        return AzureWeeklyVersionStore(table_account_url=config.table_account_url, table_name=config.weekly_versions_table_name)
    return FileWeeklyVersionStore(os.path.join(config.file_backend_dir, "weekly_versions"))


def weekly_version_store_from_env() -> WeeklyVersionStore:
    from stride_server.config import load_server_config
    return weekly_version_store_from_config(load_server_config().coach_persistence)
```

- [ ] **Step 7: Update coach runtime checkpointer construction**

In `src/stride_server/coach_runtime.py`, change the lazy checkpointer construction:

```python
from stride_server.config import load_server_config

_CHECKPOINTER = AzureTableCheckpointSaver.from_config(load_server_config().coach_persistence)
```

- [ ] **Step 8: Run coach persistence tests**

Run: `PYTHONPATH=src pytest tests/stride_server/test_job_runner.py tests/stride_server/test_coach_routes.py -q`

Expected: PASS.

- [ ] **Step 9: Commit coach persistence migration**

```bash
git add src/stride_server/coach_adapters/persistence/azure_backend.py src/stride_server/coach_adapters/persistence/checkpointer.py src/stride_server/coach_adapters/persistence/jobs_store.py src/stride_server/coach_adapters/persistence/weekly_version_store.py src/stride_server/coach_runtime.py tests/stride_server/test_job_runner.py tests/stride_server/test_coach_routes.py
git commit -m "feat(config): drive coach persistence from server config"
```

---

### Task 9: Route-Level Runtime Config

**Files:**
- Modify: `src/stride_server/routes/plan.py`
- Modify: `src/stride_server/routes/onboarding.py`
- Test: `tests/test_plan_routes.py`
- Test: `tests/test_plan_hardening.py`
- Test: `tests/test_onboarding_routes.py`

- [ ] **Step 1: Write failing tests for internal token and sync stale config**

Add or update tests:

```python
from stride_server.config.models import InternalConfig, ServerConfig, SyncConfig


def test_internal_token_validation_uses_config() -> None:
    from stride_server.routes.plan import validate_internal_token_value

    cfg = InternalConfig(token="expected-token")

    assert validate_internal_token_value("expected-token", cfg) is None


def test_internal_token_validation_rejects_missing_config() -> None:
    from fastapi import HTTPException
    from stride_server.routes.plan import validate_internal_token_value

    with pytest.raises(HTTPException) as exc_info:
        validate_internal_token_value("any", InternalConfig(token=""))

    assert exc_info.value.status_code == 401


def test_sync_stale_after_uses_config() -> None:
    from stride_server.routes.onboarding import sync_stale_after_seconds_from_config

    assert sync_stale_after_seconds_from_config(SyncConfig(stale_after_seconds=42)) == 42
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=src pytest tests/test_plan_routes.py tests/test_plan_hardening.py tests/test_onboarding_routes.py -q`

Expected: FAIL with missing helper functions.

- [ ] **Step 3: Update internal token validation**

In `src/stride_server/routes/plan.py`, add:

```python
from stride_server.config.models import InternalConfig


def validate_internal_token_value(actual: str | None, config: InternalConfig) -> None:
    expected = config.token
    if not expected:
        raise HTTPException(status_code=401, detail="Internal token not configured on server")
    if actual is None or not secrets.compare_digest(actual, expected):
        raise HTTPException(status_code=401, detail="Invalid internal token")
```

Update the FastAPI dependency currently reading `STRIDE_INTERNAL_TOKEN` to depend on `get_server_config` and call `validate_internal_token_value(header, config.internal)`.

- [ ] **Step 4: Update sync stale threshold**

In `src/stride_server/routes/onboarding.py`, add:

```python
from stride_server.config.models import SyncConfig


def sync_stale_after_seconds_from_config(config: SyncConfig) -> int:
    return config.stale_after_seconds
```

Replace direct `os.environ.get("STRIDE_SYNC_STALE_AFTER_SECONDS", "300")` with the typed config helper through `get_server_config` where request context exists. If the current helper is module-level and used without request context, keep a compatibility wrapper that calls `load_server_config().sync`.

- [ ] **Step 5: Run route tests**

Run: `PYTHONPATH=src pytest tests/test_plan_routes.py tests/test_plan_hardening.py tests/test_onboarding_routes.py -q`

Expected: PASS.

- [ ] **Step 6: Commit route config migration**

```bash
git add src/stride_server/routes/plan.py src/stride_server/routes/onboarding.py tests/test_plan_routes.py tests/test_plan_hardening.py tests/test_onboarding_routes.py
git commit -m "feat(config): use server config in runtime routes"
```

---

### Task 10: Final Env Sweep and Verification

**Files:**
- Modify: backend files still containing direct runtime config reads after Tasks 1-9.
- Test: `tests/stride_server/test_server_config_loader.py` and the focused tests for each touched module.

- [ ] **Step 1: Run direct env-read audit**

Run:

```bash
rg -n "os\.environ|getenv\(" src/stride_server src/coach_agent src/plan_parser src/coach -g '!**/__pycache__/**'
```

Expected: Remaining hits are only inside `src/stride_server/config/`, compatibility wrappers explicitly delegating to `load_server_config()`, or out-of-scope modules (`src/coach_agent`, `src/plan_parser`, `src/coach`).

- [ ] **Step 2: Migrate any remaining in-scope env reads**

For each remaining in-scope hit in `src/stride_server` that is not in `src/stride_server/config/` and is not a compatibility wrapper, add a field to `ServerConfig`, add env mapping in `sources.py`, add TOML defaults, write a focused failing test, migrate the module to read typed config, and run the focused test.

Use this exact pattern for each field:

```python
def test_new_setting_maps_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LEGACY_ENV_NAME", "value")
    assert env_source(os.environ)["section"]["field"] == "value"
```

- [ ] **Step 3: Run loader and focused backend tests**

Run:

```bash
PYTHONPATH=src pytest tests/stride_server/test_server_config_loader.py tests/test_bearer.py tests/test_likes_routes.py tests/test_plan_routes.py tests/test_plan_hardening.py tests/test_onboarding_routes.py tests/stride_server/test_coach_routes.py -q
```

Expected: PASS.

- [ ] **Step 4: Run import boundary check**

Run:

```bash
PYTHONPATH=src lint-imports
```

Expected: PASS. If it fails because `coach.*` imports `stride_server.config`, remove that import and keep config usage in the adapter/server layer only.

- [ ] **Step 5: Run full backend tests if focused suite passes**

Run:

```bash
PYTHONPATH=src pytest tests -q
```

Expected: PASS, or only known unrelated failures. Document exact failures if any remain.

- [ ] **Step 6: Commit final sweep**

```bash
git add src config tests docs/superpowers/specs/2026-05-19-server-runtime-config-design.md docs/superpowers/plans/2026-05-19-server-runtime-config.md
git commit -m "test(config): verify server runtime configuration migration"
```
