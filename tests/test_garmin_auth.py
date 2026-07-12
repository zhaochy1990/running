"""Garmin token persistence — file backend + Azure Key Vault backend.

Mirrors ``tests/test_coros_auth.py`` so both adapters get the same coverage
shape (file by default, AKV when configured, backfill on first read, secret
name sanitization, delete via active backend).
"""

from __future__ import annotations

import json

from garmin_sync import auth as auth_mod
from garmin_sync.auth import GarminCredentials


class ResourceNotFoundError(Exception):
    pass


class FakeSecret:
    def __init__(self, value: str | None) -> None:
        self.value = value


class FakeSecretClient:
    def __init__(self) -> None:
        self.secrets: dict[str, str] = {}

    def get_secret(self, name: str) -> FakeSecret:
        if name not in self.secrets:
            raise ResourceNotFoundError(name)
        return FakeSecret(self.secrets[name])

    def set_secret(self, name: str, value: str) -> None:
        self.secrets[name] = value

    def begin_delete_secret(self, name: str) -> None:
        if name not in self.secrets:
            raise ResourceNotFoundError(name)
        del self.secrets[name]


def _patch_user_data_dir(monkeypatch, tmp_path):
    """garmin auth uses a lazy import; patch the source module."""
    import stride_core.db as db_mod
    monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)


def test_credentials_use_file_backend_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIDE_GARMIN_KEYVAULT_URL", raising=False)
    _patch_user_data_dir(monkeypatch, tmp_path)

    creds = GarminCredentials(
        email="runner@example.com",
        region="cn",
        tokens_dump='{"refresh_token":"abc"}',
    )
    creds.save(user="alice")

    auth_path = tmp_path / "alice" / "garmin_auth.json"
    assert auth_path.exists()
    assert GarminCredentials.load(user="alice") == creds


def test_credentials_use_keyvault_when_configured(tmp_path, monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    _patch_user_data_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    user = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    creds = GarminCredentials(
        email="runner@example.com",
        region="global",
        tokens_dump='{"refresh_token":"abc"}',
    )
    creds.save(user=user)

    # No file written when AKV is the active backend.
    assert not (tmp_path / user / "garmin_auth.json").exists()
    secret_name = f"garmin-config-{user}"
    assert json.loads(fake_client.secrets[secret_name])["tokens_dump"] == '{"refresh_token":"abc"}'
    assert GarminCredentials.load(user=user) == creds


def test_credentials_keyvault_missing_secret_returns_empty(monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.delenv("STRIDE_GARMIN_KEYVAULT_BACKFILL_FROM_FILE", raising=False)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    creds = GarminCredentials.load(user="a1b2c3d4-e5f6-4aaa-89ab-123456789012")
    assert creds == GarminCredentials()


# ── prod: watch creds are KV-only, never file fallback ─────────────────────

_USER = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


def test_prod_without_keyvault_url_raises(tmp_path, monkeypatch):
    import pytest
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.delenv("STRIDE_GARMIN_KEYVAULT_URL", raising=False)
    _patch_user_data_dir(monkeypatch, tmp_path)
    (tmp_path / _USER).mkdir(parents=True)
    (tmp_path / _USER / "garmin_auth.json").write_text(json.dumps({"tokens_dump": "leaked"}))

    with pytest.raises(RuntimeError, match="required in prod"):
        GarminCredentials.load(user=_USER)


def test_prod_with_keyvault_missing_secret_returns_empty(monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    assert GarminCredentials.load(user=_USER) == GarminCredentials()


def test_prod_never_backfills_from_file(tmp_path, monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_BACKFILL_FROM_FILE", "true")  # ignored in prod
    _patch_user_data_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)
    (tmp_path / _USER).mkdir(parents=True)
    (tmp_path / _USER / "garmin_auth.json").write_text(json.dumps({"tokens_dump": "file"}))

    assert GarminCredentials.load(user=_USER) == GarminCredentials()
    assert fake_client.secrets == {}


def test_non_prod_without_keyvault_reads_file(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIDE_CONFIG_ENV", raising=False)
    monkeypatch.delenv("STRIDE_ENV", raising=False)
    monkeypatch.delenv("STRIDE_GARMIN_KEYVAULT_URL", raising=False)
    _patch_user_data_dir(monkeypatch, tmp_path)

    creds = GarminCredentials(email="r@e.com", region="cn", tokens_dump='{"refresh_token":"abc"}')
    creds.save(user="alice")
    assert GarminCredentials.load(user="alice") == creds



def test_credentials_can_backfill_keyvault_from_file(tmp_path, monkeypatch):
    fake_client = FakeSecretClient()
    user = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_BACKFILL_FROM_FILE", "true")
    _patch_user_data_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    user_dir = tmp_path / user
    user_dir.mkdir(parents=True)
    (user_dir / "garmin_auth.json").write_text(
        json.dumps({
            "email": "runner@example.com",
            "region": "cn",
            "tokens_dump": '{"refresh_token":"abc"}',
        }),
        encoding="utf-8",
    )

    loaded = GarminCredentials.load(user=user)
    assert loaded.is_logged_in
    assert loaded.email == "runner@example.com"
    # Backfill happened on first read.
    assert f"garmin-config-{user}" in fake_client.secrets


def test_delete_removes_keyvault_secret(monkeypatch):
    fake_client = FakeSecretClient()
    user = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    fake_client.secrets[f"garmin-config-{user}"] = json.dumps({
        "email": "x@x.com", "region": "cn", "tokens_dump": "y",
    })
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    GarminCredentials.delete(user=user)
    assert f"garmin-config-{user}" not in fake_client.secrets


def test_delete_removes_local_file_when_no_keyvault(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIDE_GARMIN_KEYVAULT_URL", raising=False)
    _patch_user_data_dir(monkeypatch, tmp_path)

    creds = GarminCredentials(email="x@x.com", region="cn", tokens_dump="y")
    creds.save(user="alice")
    auth_path = tmp_path / "alice" / "garmin_auth.json"
    assert auth_path.exists()

    GarminCredentials.delete(user="alice")
    assert not auth_path.exists()


def test_delete_idempotent_when_secret_missing(monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    # Should not raise even though there's no secret to delete.
    GarminCredentials.delete(user="a1b2c3d4-e5f6-4aaa-89ab-123456789012")


def test_keyvault_secret_name_sanitizes_non_keyvault_chars(monkeypatch):
    monkeypatch.setenv("STRIDE_GARMIN_KEYVAULT_SECRET_PREFIX", "garmin_config")

    assert auth_mod._keyvault_secret_name("__cli_test") == "garmin-config-cli-test"
