"""Per-user Garmin token persistence.

Two backends (mirrors ``src/coros_sync/auth.py`` so prod can keep all watch
tokens in one Key Vault):

  - **File** (default for local dev): tokens at ``data/{user}/garmin_auth.json``.
  - **Azure Key Vault** (prod): when ``STRIDE_GARMIN_KEYVAULT_URL`` is set,
    credentials live as a single JSON blob in the configured Key Vault.
    Secret name: ``{STRIDE_GARMIN_KEYVAULT_SECRET_PREFIX or 'garmin-config'}-{user}``.

Set ``STRIDE_GARMIN_KEYVAULT_BACKFILL_FROM_FILE=1`` once after enabling AKV to
copy any pre-existing local files into the vault on first read. Subsequent
saves overwrite the vault secret only — the local file is left untouched for
diagnostics.

`garth.Client.dumps()` / `loads()` give us a portable JSON-blob representation
of the OAuth1 + OAuth2 tokens (plus user agent + region domain). We store it
as ``tokens_dump`` alongside ``email`` and ``region`` for diagnostics. The
``provider`` tag itself stays in ``config.json`` (written by
``stride_core.registry.write_user_provider``).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

KEYVAULT_URL_ENV = "STRIDE_GARMIN_KEYVAULT_URL"
KEYVAULT_SECRET_PREFIX_ENV = "STRIDE_GARMIN_KEYVAULT_SECRET_PREFIX"
KEYVAULT_BACKFILL_ENV = "STRIDE_GARMIN_KEYVAULT_BACKFILL_FROM_FILE"
DEFAULT_KEYVAULT_SECRET_PREFIX = "garmin-config"
_SAFE_SECRET_CHARS_RE = re.compile(r"[^0-9A-Za-z-]+")


def _auth_path(user: str, base_dir: Path | None = None) -> Path:
    if base_dir is not None:
        return base_dir / user / "garmin_auth.json"
    # Lazy import so test monkey-patches of `stride_core.db.USER_DATA_DIR`
    # are picked up at call time rather than at module import time.
    from stride_core.db import USER_DATA_DIR
    return USER_DATA_DIR / user / "garmin_auth.json"


def _keyvault_url() -> str | None:
    url = os.environ.get(KEYVAULT_URL_ENV, "").strip()
    return url or None


def _is_prod() -> bool:
    """True when running in the prod environment.

    Read straight from the environment (same pattern as the KV env vars) so this
    low-level auth module stays free of any ``stride_server`` import. In prod we
    refuse to read Garmin credentials from the local file backend — creds live in
    Key Vault, and a missing KV URL is a deploy misconfiguration that must fail
    loudly rather than silently returning empty ("not logged in") credentials.
    """
    env = (os.environ.get("STRIDE_CONFIG_ENV") or os.environ.get("STRIDE_ENV") or "").strip().lower()
    return env == "prod"


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


def _keyvault_secret_client(vault_url: str) -> Any:
    # Delegates to the shared (cached) Key Vault client in stride_storage so
    # all COROS/Garmin/server secret access uses one credential. Kept as a
    # module-level function because tests monkeypatch it.
    from stride_storage.keyvault import get_secret_client

    return get_secret_client(vault_url)


def _is_keyvault_not_found(exc: Exception) -> bool:
    return exc.__class__.__name__ == "ResourceNotFoundError"


def _load_keyvault_creds(user: str, vault_url: str) -> dict[str, Any] | None:
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
        raise ValueError("Garmin Key Vault secret must contain a JSON object")
    return data


def _save_keyvault_creds(user: str, vault_url: str, data: dict[str, Any]) -> None:
    _keyvault_secret_client(vault_url).set_secret(
        _keyvault_secret_name(user),
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
    )


def _delete_keyvault_creds(user: str, vault_url: str) -> None:
    try:
        # `begin_delete_secret` kicks off soft-delete; we don't wait on the poller.
        _keyvault_secret_client(vault_url).begin_delete_secret(
            _keyvault_secret_name(user)
        )
    except Exception as exc:
        if _is_keyvault_not_found(exc):
            return
        raise


def _load_file_creds(user: str, base_dir: Path | None = None) -> dict[str, Any] | None:
    path = _auth_path(user, base_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


@dataclass
class GarminCredentials:
    """Stored Garmin authentication state for a single user."""

    email: str = ""
    region: str = "cn"            # 'cn' | 'global'
    tokens_dump: str = ""         # garth.Client.dumps() output (JSON string)

    @property
    def is_logged_in(self) -> bool:
        return bool(self.tokens_dump and self.email)

    def save(self, user: str, *, base_dir: Path | None = None) -> None:
        vault_url = _keyvault_url()
        if vault_url:
            _save_keyvault_creds(user, vault_url, asdict(self))
            return
        path = _auth_path(user, base_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, user: str, *, base_dir: Path | None = None) -> GarminCredentials:
        vault_url = _keyvault_url()
        prod = _is_prod()

        if prod and not vault_url:
            # Misconfiguration: prod must serve watch creds from Key Vault. Fail
            # loudly instead of silently falling back to the local file backend.
            raise RuntimeError(
                f"{KEYVAULT_URL_ENV} is required in prod; refusing to read Garmin "
                "credentials from the local file backend"
            )

        if vault_url:
            data = _load_keyvault_creds(user, vault_url)
            # In prod the file backend is off-limits, so never backfill from file
            # there; a missing KV secret is a legitimate "not logged in".
            if data is None and not prod and _truthy_env(KEYVAULT_BACKFILL_ENV):
                data = _load_file_creds(user, base_dir)
                if data is not None:
                    _save_keyvault_creds(user, vault_url, data)
            if data is None:
                return cls()
            return cls._from_dict(data)

        data = _load_file_creds(user, base_dir)
        if data is None:
            return cls()
        return cls._from_dict(data)

    @classmethod
    def delete(cls, user: str, *, base_dir: Path | None = None) -> None:
        """Wipe the user's stored Garmin credentials from whichever backend is active."""
        vault_url = _keyvault_url()
        if vault_url:
            _delete_keyvault_creds(user, vault_url)
            return
        path = _auth_path(user, base_dir)
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> GarminCredentials:
        return cls(
            email=str(data.get("email", "")),
            region=str(data.get("region", "cn")),
            tokens_dump=str(data.get("tokens_dump", "")),
        )

    @classmethod
    def from_garth_client(cls, email: str, region: str, garth_client: Any) -> GarminCredentials:
        """Build creds from a freshly logged-in garth.Client."""
        return cls(
            email=email,
            region=region,
            tokens_dump=garth_client.dumps(),
        )


def domain_for_region(region: str) -> str:
    """Map our compact region code to garth's `domain` parameter."""
    return "garmin.cn" if region == "cn" else "garmin.com"
