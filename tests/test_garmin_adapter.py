"""Tests for garmin_sync.adapter — DataSource contract + token persistence."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from garmin_sync.adapter import GarminDataSource
from garmin_sync.auth import GarminCredentials, _auth_path
from stride_core.source import (
    Capability,
    DataSource,
    LoginCredentials,
    LoginResult,
    ProviderInfo,
)


class TestGarminProviderInfo:
    def test_satisfies_data_source_protocol(self):
        src = GarminDataSource()
        assert isinstance(src, DataSource)

    def test_info_metadata(self):
        src = GarminDataSource()
        info: ProviderInfo = src.info
        assert info.name == "garmin"
        assert info.display_name == "佳明"
        assert "cn" in info.regions
        assert "global" in info.regions

    def test_capabilities(self):
        # Phase 3 added HRV detail; Phase 4 wires push_run_workout.
        # Strength push + exercise catalog still deferred.
        src = GarminDataSource()
        assert Capability.SYNC_HRV_DETAIL in src.info.capabilities
        assert Capability.PUSH_RUN_WORKOUT in src.info.capabilities
        assert Capability.PUSH_STRENGTH_WORKOUT not in src.info.capabilities
        assert Capability.EXERCISE_CATALOG not in src.info.capabilities


class TestIsLoggedIn:
    def test_no_creds_means_not_logged_in(self, tmp_path: Path, monkeypatch):
        from stride_core import db as db_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
        src = GarminDataSource()
        assert src.is_logged_in("never_seen_user") is False

    def test_creds_with_token_dump(self, tmp_path: Path, monkeypatch):
        from stride_core import db as db_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
        # Fake a stored creds file
        path = tmp_path / "u" / "garmin_auth.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({
            "email": "x@y.com", "region": "cn", "tokens_dump": "{...some json...}",
        }), encoding="utf-8")

        src = GarminDataSource()
        assert src.is_logged_in("u") is True


class TestLogoutWipesTokens:
    def test_logout_removes_auth_file(self, tmp_path: Path, monkeypatch):
        from stride_core import db as db_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
        path = tmp_path / "u" / "garmin_auth.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({
            "email": "x@y.com", "region": "cn", "tokens_dump": "blob",
        }), encoding="utf-8")

        src = GarminDataSource()
        assert path.exists()
        src.logout("u")
        assert not path.exists()

    def test_logout_when_no_creds_is_noop(self, tmp_path: Path, monkeypatch):
        from stride_core import db as db_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
        # Should not raise
        GarminDataSource().logout("never_seen")


class TestLoginFailure:
    def test_login_failure_returns_unsuccessful_result(self, tmp_path: Path, monkeypatch):
        """Network/auth failures map to LoginResult(success=False) with a
        message — not an exception. The route layer collapses to 400 if
        success is False or any exception bubbles."""
        from stride_core import db as db_mod
        from garmin_sync import client as garmin_client_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)

        def boom(*args, **kwargs):
            from garmin_sync.client import GarminAuthError
            raise GarminAuthError("Garmin login failed: rate limited")

        monkeypatch.setattr(garmin_client_mod.GarminClient, "login", classmethod(boom))

        src = GarminDataSource()
        result = src.login("u", LoginCredentials(email="x@y.com", password="bad"))
        assert isinstance(result, LoginResult)
        assert result.success is False
        assert "rate limited" in (result.message or "")


class TestLoginSuccessPersists:
    def test_login_writes_tokens_and_provider_tag(self, tmp_path: Path, monkeypatch):
        """On success, the adapter must:
          1. Save Garmin tokens to data/{user}/garmin_auth.json
          2. Stamp `provider='garmin'` in data/{user}/config.json
             (so registry.for_user dispatches back here on subsequent calls)
        """
        from stride_core import db as db_mod
        from garmin_sync import client as garmin_client_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)

        # Build a fake authenticated GarminClient
        class _FakeGarth:
            username = "12345"
            profile = {"profileId": 555, "fullName": "Test User"}
            def dumps(self):
                return '{"oauth1": "...", "oauth2": "..."}'

        class _FakeGarminClient:
            def __init__(self):
                self.garth = _FakeGarth()
                self.profile = self.garth.profile

        def fake_login(cls, email, password, region="cn"):
            return _FakeGarminClient()

        monkeypatch.setattr(
            garmin_client_mod.GarminClient, "login", classmethod(fake_login)
        )

        src = GarminDataSource()
        result = src.login(
            "u",
            LoginCredentials(email="real@user.com", password="pw", region="cn"),
        )
        assert result.success is True
        assert result.user_id == "555"
        assert result.region == "cn"

        # Tokens persisted
        auth_file = _auth_path("u", base_dir=tmp_path)
        assert auth_file.exists()
        auth_data = json.loads(auth_file.read_text(encoding="utf-8"))
        assert auth_data["email"] == "real@user.com"
        assert auth_data["region"] == "cn"
        assert auth_data["tokens_dump"]

        # Provider tag stamped in config.json
        config_file = tmp_path / "u" / "config.json"
        assert config_file.exists()
        config = json.loads(config_file.read_text(encoding="utf-8"))
        assert config["provider"] == "garmin"


class TestGarminCredentialsRoundtrip:
    def test_save_then_load(self, tmp_path: Path):
        creds = GarminCredentials(
            email="x@y.com", region="cn", tokens_dump='{"oauth": "blob"}'
        )
        creds.save("alice", base_dir=tmp_path)

        loaded = GarminCredentials.load("alice", base_dir=tmp_path)
        assert loaded.email == "x@y.com"
        assert loaded.region == "cn"
        assert loaded.tokens_dump == '{"oauth": "blob"}'
        assert loaded.is_logged_in is True

    def test_load_missing_returns_empty(self, tmp_path: Path):
        creds = GarminCredentials.load("nobody", base_dir=tmp_path)
        assert creds.email == ""
        assert creds.is_logged_in is False

    def test_load_malformed_returns_empty(self, tmp_path: Path):
        path = tmp_path / "u" / "garmin_auth.json"
        path.parent.mkdir(parents=True)
        path.write_text("not json", encoding="utf-8")

        creds = GarminCredentials.load("u", base_dir=tmp_path)
        assert creds.is_logged_in is False
