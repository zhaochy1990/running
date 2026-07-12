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

    def begin_delete_secret(self, name: str) -> None:
        if name not in self.secrets:
            raise ResourceNotFoundError(name)
        del self.secrets[name]


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


# ── prod: watch creds are KV-only, never file fallback ─────────────────────

_USER = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


def test_prod_without_keyvault_url_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.delenv("STRIDE_COROS_KEYVAULT_URL", raising=False)
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)
    # Even if a stale local file exists, prod must refuse to read it.
    (tmp_path / _USER).mkdir(parents=True)
    (tmp_path / _USER / "config.json").write_text(json.dumps({"access_token": "leaked"}))

    import pytest
    with pytest.raises(RuntimeError, match="required in prod"):
        Credentials.load(user=_USER)


def test_prod_with_keyvault_missing_secret_returns_empty(monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    # A missing KV secret in prod is a legitimate "not logged in", not an error.
    assert Credentials.load(user=_USER) == Credentials()


def test_prod_never_backfills_from_file(tmp_path, monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_BACKFILL_FROM_FILE", "true")  # ignored in prod
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)
    (tmp_path / _USER).mkdir(parents=True)
    (tmp_path / _USER / "config.json").write_text(json.dumps({"access_token": "file-token"}))

    # Backfill is disabled in prod → empty creds + KV NOT populated from file.
    assert Credentials.load(user=_USER) == Credentials()
    assert fake_client.secrets == {}


def test_non_prod_without_keyvault_reads_file(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIDE_CONFIG_ENV", raising=False)
    monkeypatch.delenv("STRIDE_ENV", raising=False)
    monkeypatch.delenv("STRIDE_COROS_KEYVAULT_URL", raising=False)
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)

    creds = Credentials(email="r@e.com", pwd_hash="h", access_token="t")
    creds.save(user="alice")
    # Non-prod file-backend behavior is unchanged.
    assert Credentials.load(user="alice") == creds



def test_keyvault_secret_name_sanitizes_non_keyvault_chars(monkeypatch):
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_SECRET_PREFIX", "coros_config")

    assert auth_mod._keyvault_secret_name("__cli_test") == "coros-config-cli-test"


def test_delete_removes_keyvault_secret(monkeypatch):
    fake_client = FakeSecretClient()
    user = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    fake_client.secrets[f"coros-config-{user}"] = json.dumps({
        "email": "runner@example.com",
        "pwd_hash": "hash",
        "access_token": "token",
        "region": "cn",
        "user_id": "coros-user",
    })
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    Credentials.delete(user=user)

    assert f"coros-config-{user}" not in fake_client.secrets


def test_delete_local_file_preserves_provider(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIDE_COROS_KEYVAULT_URL", raising=False)
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)
    user = "alice"
    config_path = tmp_path / user / "config.json"
    config_path.parent.mkdir(parents=True)
    config_path.write_text(json.dumps({
        "provider": "coros",
        "email": "runner@example.com",
        "pwd_hash": "hash",
        "access_token": "token",
        "region": "cn",
        "user_id": "coros-user",
    }), encoding="utf-8")

    Credentials.delete(user=user)

    assert json.loads(config_path.read_text(encoding="utf-8")) == {"provider": "coros"}


def test_delete_idempotent_when_secret_missing(monkeypatch):
    fake_client = FakeSecretClient()
    monkeypatch.setenv("STRIDE_COROS_KEYVAULT_URL", "https://stride-kv.vault.azure.net/")
    monkeypatch.setattr(auth_mod, "_keyvault_secret_client", lambda _url: fake_client)

    Credentials.delete(user="a1b2c3d4-e5f6-4aaa-89ab-123456789012")
