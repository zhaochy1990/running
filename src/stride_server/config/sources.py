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
    "STRIDE_LIKES_TABLE_ACCOUNT_URL": [("notifications.table_account_url", "str")],
}

_EMPTY_AS_UNSET_ENV_NAMES: set[str] = set()
_LEGACY_FALSY_ENV_VALUES = {"false", "0", "no", "off", "disabled"}


def deep_merge(left: Mapping[str, Any], right: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(left)
    for key, value in right.items():
        current = merged.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged[key] = deep_merge(current, value)
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


def parse_legacy_truthy_default_true(value: str) -> bool | None:
    raw = value.strip().lower()
    if not raw:
        return None
    return raw not in _LEGACY_FALSY_ENV_VALUES


def env_source(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    data: dict[str, Any] = {}
    for name, (path, value_type) in _ENV_MAPPING.items():
        if name in env and not (name in _EMPTY_AS_UNSET_ENV_NAMES and env[name].strip() == ""):
            set_path(data, path, parse_env_value(env[name], value_type))
        for mirror_path, mirror_type in _MIRROR_ENV_MAPPING.get(name, []):
            if name in env and not (name in _EMPTY_AS_UNSET_ENV_NAMES and env[name].strip() == ""):
                set_path(data, mirror_path, parse_env_value(env[name], mirror_type))
    if "STRIDE_PLAN_JSON_PRIORITY" in env:
        value = parse_legacy_truthy_default_true(env["STRIDE_PLAN_JSON_PRIORITY"])
        if value is not None:
            set_path(data, "plan.prefer_authored_json", value)
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
