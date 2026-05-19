from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import fields, is_dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

from .models import ConfigError, ServerConfig
from .sources import deep_merge, env_source, parse_bool, set_path, toml_file_source


PROJECT_ROOT = Path(__file__).resolve().parents[3]

AkVSource = Callable[..., dict[str, Any]]


def resolve_config_env(environ: Mapping[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    return (env.get("STRIDE_CONFIG_ENV") or env.get("STRIDE_ENV") or "default").strip() or "default"


def _split_files(raw: str, *, project_root: Path) -> list[Path]:
    pieces = [piece.strip() for chunk in raw.split(";") for piece in chunk.split(",")]
    paths: list[Path] = []
    for piece in pieces:
        if not piece:
            continue
        path = Path(piece)
        paths.append(path if path.is_absolute() else project_root / path)
    return paths


def resolve_file_layer(
    env: str,
    project_root: Path | None = None,
    environ: Mapping[str, str] | None = None,
    *,
    config_dir: Path | None = None,
    explicit_files: str | None = None,
) -> list[Path]:
    root = PROJECT_ROOT if project_root is None else project_root
    config_root = config_dir if config_dir is not None else root / "config"
    env_map = os.environ if environ is None else environ
    has_explicit_files = explicit_files is not None or "STRIDE_CONFIG_FILES" in env_map
    raw_explicit_files = explicit_files if explicit_files is not None else env_map.get("STRIDE_CONFIG_FILES", "")

    if has_explicit_files:
        files = _split_files(raw_explicit_files, project_root=root)
        if not files:
            raise ConfigError("STRIDE_CONFIG_FILES did not contain any config files")
        for path in files:
            if not path.exists():
                raise ConfigError(f"explicit config file not found: {path}")
        return files

    base = config_root / "server.toml"
    if not base.exists():
        raise ConfigError(f"base server config not found: {base}")

    files = [base]
    env_file = config_root / f"server.{env}.toml"
    if env_file.exists():
        files.append(env_file)
    return files


def _known_secret_manifest() -> list[str]:
    return [
        "auth.public_key_pem",
        "auth.public_key_path",
        "auth.issuer",
        "auth.audience",
        "auth.allow_insecure_without_key",
        "auth_service.base_url",
        "auth_service.timeout_s",
        "llm.enabled",
        "llm.default_model",
        "llm.azure_openai.endpoint",
        "llm.azure_openai.api_key",
        "llm.azure_openai.api_version",
        "llm.azure_openai.deployment",
        "llm.azure_openai.timeout_s",
        "commentary.enabled",
        "commentary.azure_openai.endpoint",
        "commentary.azure_openai.api_key",
        "commentary.azure_openai.api_version",
        "commentary.azure_openai.deployment",
        "commentary.azure_openai.timeout_s",
        "storage.content.account_url",
        "storage.content.container",
        "storage.content.prefix",
        "storage.likes.table_account_url",
        "storage.likes.table_name",
        "storage.master_plan.table_account_url",
        "storage.master_plan.table_name",
        "coach_persistence.table_account_url",
        "coach_persistence.blob_account_url",
        "coach_persistence.checkpoints_table_name",
        "coach_persistence.checkpoint_writes_table_name",
        "coach_persistence.jobs_table_name",
        "coach_persistence.weekly_versions_table_name",
        "coach_persistence.blob_container",
        "coach_persistence.file_backend_dir",
        "coach_persistence.jobs_stale_after_seconds",
        "notifications.table_account_url",
        "notifications.devices_table",
        "notifications.prefs_table",
        "notifications.jpush.app_key",
        "notifications.jpush.master_secret",
        "notifications.jpush.url",
        "notifications.jpush.timeout_s",
        "notifications.jpush.apns_production",
        "sync.stale_after_seconds",
        "internal.token",
        "plan.prefer_authored_json",
    ]


def _default_akv_source(*, vault_url: str, secret_prefix: str, manifest: list[str]) -> dict[str, Any]:
    try:
        from azure.core.exceptions import ResourceNotFoundError
        from azure.identity import DefaultAzureCredential
        from azure.keyvault.secrets import SecretClient
    except ImportError as exc:
        raise ConfigError("Azure Key Vault support requires azure-identity and azure-keyvault-secrets") from exc

    from .sources import akv_secret_name

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


def _coerce_scalar(path: str, current: object, value: object) -> object:
    if isinstance(current, bool):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            try:
                return parse_bool(value)
            except ValueError as exc:
                raise ConfigError(f"{path} must be a boolean") from exc
        raise ConfigError(f"{path} must be a boolean")
    if isinstance(current, int) and not isinstance(current, bool):
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError as exc:
                raise ConfigError(f"{path} must be an integer") from exc
        raise ConfigError(f"{path} must be an integer")
    if isinstance(current, float):
        if isinstance(value, int | float) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError as exc:
                raise ConfigError(f"{path} must be a number") from exc
        raise ConfigError(f"{path} must be a number")
    if isinstance(current, str):
        if isinstance(value, str):
            return value
        raise ConfigError(f"{path} must be a string")
    return value


def _apply_dataclass_updates(instance: object, updates: Mapping[str, Any], *, path: str) -> object:
    field_names = {field.name for field in fields(instance)}
    replacements: dict[str, object] = {}

    for key, value in updates.items():
        key_path = f"{path}.{key}" if path else key
        if key not in field_names:
            raise ConfigError(f"unknown config key: {key_path}")
        current = getattr(instance, key)
        if is_dataclass(current):
            if not isinstance(value, Mapping):
                raise ConfigError(f"{key_path} must be a table")
            replacements[key] = _apply_dataclass_updates(current, value, path=key_path)
        else:
            replacements[key] = _coerce_scalar(key_path, current, value)

    return replace(instance, **replacements)


def _config_from_dict(data: Mapping[str, Any]) -> ServerConfig:
    raw_env = data.get("env", "default")
    if not isinstance(raw_env, str):
        raise ConfigError("env must be a string")
    default_config = ServerConfig.default(env=raw_env)
    return _apply_dataclass_updates(default_config, data, path="")  # type: ignore[return-value]


def _load_uncached(
    *,
    project_root: Path,
    environ: Mapping[str, str],
    akv_source: AkVSource | None,
    config_dir: Path | None = None,
) -> ServerConfig:
    env = resolve_config_env(environ)
    files = resolve_file_layer(env, project_root=project_root, environ=environ, config_dir=config_dir)
    merged: dict[str, Any] = {"env": env}
    for path in files:
        merged = deep_merge(merged, toml_file_source(path))

    env_data = env_source(environ)
    bootstrap_cfg = _config_from_dict(deep_merge(merged, env_data))
    if bootstrap_cfg.akv.enabled:
        if not bootstrap_cfg.akv.vault_url:
            raise ConfigError("akv.vault_url is required when akv.enabled is true")
        source = akv_source or _default_akv_source
        akv_data = source(
            vault_url=bootstrap_cfg.akv.vault_url,
            secret_prefix=bootstrap_cfg.akv.secret_prefix,
            manifest=_known_secret_manifest(),
        )
        merged = deep_merge(merged, akv_data)

    merged = deep_merge(merged, env_data)
    cfg = _config_from_dict(merged)
    cfg.validate()
    return cfg


@lru_cache(maxsize=1)
def _cached_default() -> ServerConfig:
    return _load_uncached(project_root=PROJECT_ROOT, environ=os.environ, akv_source=None)


def load_server_config(
    *,
    project_root: Path | None = None,
    environ: Mapping[str, str] | None = None,
    akv_source: AkVSource | None = None,
    use_cache: bool = True,
    config_dir: Path | None = None,
) -> ServerConfig:
    if project_root is None and environ is None and akv_source is None and config_dir is None and use_cache:
        return _cached_default()
    return _load_uncached(
        project_root=PROJECT_ROOT if project_root is None else project_root,
        environ=os.environ if environ is None else environ,
        akv_source=akv_source,
        config_dir=config_dir,
    )


def clear_server_config_cache() -> None:
    _cached_default.cache_clear()


reset_server_config_cache = clear_server_config_cache
