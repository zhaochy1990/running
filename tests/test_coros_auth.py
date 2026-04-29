from __future__ import annotations

import json

from coros_sync import auth as auth_mod
from coros_sync.auth import Credentials


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


def test_credentials_use_file_backend_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIDE_COROS_KEYVAULT_URL", raising=False)
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)

    creds = Credentials(
        email="runner@example.com",
        pwd_hash="hash",
        access_token="token",
        region="cn",
        user_id="coros-user",
    )
    creds.save(user="alice")

    config_path = tmp_path / "alice" / "config.json"
    assert config_path.exists()
    assert Credentials.load(user="alice") == creds


def test_credentials_use_keyvault_when_configured(tmp_path, monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    creds = Credentials(
        email="runner@example.com",
        pwd_hash="hash",
        access_token="token",
        region="eu",
        user_id="coros-user",
    )
    creds.save(user="a1b2c3d4-e5f6-4aaa-89ab-123456789012")

    assert not (tmp_path / "a1b2c3d4-e5f6-4aaa-89ab-123456789012" / "config.json").exists()
    secret_name = "coros-config-a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    assert json.loads(fake_client.secrets[secret_name])["access_token"] == "token"
    assert Credentials.load(user="a1b2c3d4-e5f6-4aaa-89ab-123456789012") == creds


def test_credentials_keyvault_missing_secret_returns_empty(monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.delenv("STRIDE_COROS_KEYVAULT_BACKFILL_FROM_FILE", raising=False)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    creds = Credentials.load(user="a1b2c3d4-e5f6-4aaa-89ab-123456789012")

    assert creds == Credentials()


def test_credentials_can_backfill_keyvault_from_file(tmp_path, monkeypatch):
    fake_client = FakeSecretClient()
    user = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_BACKFILL_FROM_FILE", "true")
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    creds = Credentials(email="runner@example.com", pwd_hash="hash", access_token="token")
    config_path = tmp_path / user / "config.json"
    config_path.parent.mkdir(parents=True)
    config_path.write_text(json.dumps({
        "email": creds.email,
        "pwd_hash": creds.pwd_hash,
        "access_token": creds.access_token,
    }))

    assert Credentials.load(user=user).is_logged_in is True
    assert "coros-config-a1b2c3d4-e5f6-4aaa-89ab-123456789012" in fake_client.secrets


def test_keyvault_secret_name_sanitizes_non_keyvault_chars(monkeypatch):
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_SECRET_PREFIX", "coros_config")

    assert auth_mod._keyvault_secret_name("__cli_test") == "coros-config-cli-test"
