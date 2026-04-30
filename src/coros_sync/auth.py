"""Credential and token management for COROS API."""

from __future__ import annotations

import hashlib
import json
import os
import re
from functools import lru_cache
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from platformdirs import user_config_dir

CONFIG_DIR = Path(user_config_dir("coros-sync"))
CONFIG_FILE = CONFIG_DIR / "config.json"

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
USER_DATA_DIR = PROJECT_ROOT / "data"
KEYVAULT_URL_ENV = "STRIDE_COROS_KEYVAULT_URL"
KEYVAULT_SECRET_PREFIX_ENV = "STRIDE_COROS_KEYVAULT_SECRET_PREFIX"
KEYVAULT_BACKFILL_ENV = "STRIDE_COROS_KEYVAULT_BACKFILL_FROM_FILE"
DEFAULT_KEYVAULT_SECRET_PREFIX = "coros-config"
_SAFE_SECRET_CHARS_RE = re.compile(r"[^0-9A-Za-z-]+")


def _config_path(user: str | None) -> Path:
    if user:
        return USER_DATA_DIR / user / "config.json"
    return CONFIG_FILE


def _keyvault_url(user: str | None) -> str | None:
    if not user:
        return None
    url = os.environ.get(KEYVAULT_URL_ENV, "").strip()
    return url or None


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _safe_secret_part(value: str) -> str:
    safe = _SAFE_SECRET_CHARS_RE.sub("-", value.strip()).strip("-")
    return safe or "default"


def _keyvault_secret_name(user: str) -> str:
    prefix = _safe_secret_part(
        os.environ.get(KEYVAULT_SECRET_PREFIX_ENV, DEFAULT_KEYVAULT_SECRET_PREFIX)
    )
    return f"{prefix}-{_safe_secret_part(user)}"


@lru_cache(maxsize=4)
def _keyvault_secret_client(vault_url: str) -> Any:
    from azure.identity import DefaultAzureCredential
    from azure.keyvault.secrets import SecretClient

    return SecretClient(vault_url=vault_url, credential=DefaultAzureCredential())


def _is_keyvault_not_found(exc: Exception) -> bool:
    return exc.__class__.__name__ == "ResourceNotFoundError"


def _load_keyvault_config(user: str, vault_url: str) -> dict[str, Any] | None:
    try:
        secret = _keyvault_secret_client(vault_url).get_secret(_keyvault_secret_name(user))
    except Exception as exc:
        if _is_keyvault_not_found(exc):
            return None
        raise
    if not secret.value:
        return None
    data = json.loads(secret.value)
    if not isinstance(data, dict):
        raise ValueError("COROS Key Vault secret must contain a JSON object")
    return data


def _save_keyvault_config(user: str, vault_url: str, data: dict[str, Any]) -> None:
    _keyvault_secret_client(vault_url).set_secret(
        _keyvault_secret_name(user),
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
    )


def _load_file_config(user: str | None) -> dict[str, Any] | None:
    path = _config_path(user)
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("COROS config file must contain a JSON object")
    return data


@dataclass
class Credentials:
    email: str = ""
    pwd_hash: str = ""
    access_token: str = ""
    region: str = "global"
    user_id: str = ""

    def save(self, user: str | None = None) -> None:
        vault_url = _keyvault_url(user)
        if vault_url and user:
            _save_keyvault_config(user, vault_url, asdict(self))
            return

        path = _config_path(user)
        path.parent.mkdir(parents=True, exist_ok=True)

        # Preserve any non-Credentials fields already in the file (notably
        # `provider`, written by stride_core.registry.write_user_provider).
        # Without this, re-login (which calls .save() again) would silently
        # wipe the provider tag and `for_user()` would lose track of which
        # adapter this user is bound to.
        existing: dict[str, Any] = {}
        if path.exists():
            try:
                loaded = json.loads(path.read_text())
                if isinstance(loaded, dict):
                    existing = loaded
            except (OSError, json.JSONDecodeError):
                pass

        merged = {**existing, **asdict(self)}
        path.write_text(json.dumps(merged, indent=2, ensure_ascii=False))

    @classmethod
    def load(cls, user: str | None = None) -> Credentials:
        vault_url = _keyvault_url(user)
        if vault_url and user:
            data = _load_keyvault_config(user, vault_url)
            if data is None:
                if _truthy_env(KEYVAULT_BACKFILL_ENV):
                    data = _load_file_config(user)
                    if data is not None:
                        _save_keyvault_config(user, vault_url, data)
                if data is None:
                    return cls()
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

        data = _load_file_config(user)
        if data is None:
            return cls()
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    @property
    def is_logged_in(self) -> bool:
        return bool(self.access_token and self.email)


def hash_password(password: str) -> str:
    return hashlib.md5(password.encode()).hexdigest()
