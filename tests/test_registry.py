"""Tests for ProviderRegistry + per-user provider resolution."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from stride_core.registry import (
    DEFAULT_PROVIDER,
    ProviderRegistry,
    UnknownProvider,
    read_user_provider,
    write_user_provider,
)
from stride_core.source import (
    BaseDataSource,
    Capability,
    LoginCredentials,
    LoginResult,
    ProviderInfo,
    SyncResult,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────────────────


class _FakeSource(BaseDataSource):
    """Minimal DataSource for registry tests — just needs `info`."""

    def __init__(self, name: str, *, regions: tuple[str, ...] = ("global",)) -> None:
        self.name = name
        self._info = ProviderInfo(
            name=name,
            display_name=name.title(),
            regions=regions,
            capabilities=frozenset(),
        )

    @property
    def info(self) -> ProviderInfo:
        return self._info

    def is_logged_in(self, user: str) -> bool:
        return False

    def login(self, user: str, creds: LoginCredentials) -> LoginResult:
        return LoginResult(success=False)

    def sync_user(self, user: str, *, full: bool = False, progress=None) -> SyncResult:
        return SyncResult(activities=0, health=0)

    def resync_activity(self, user: str, label_id: str) -> bool:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# ProviderRegistry behavior
# ─────────────────────────────────────────────────────────────────────────────


class TestProviderRegistry:
    def test_register_and_get(self):
        reg = ProviderRegistry()
        coros = _FakeSource("coros")
        reg.register(coros)
        assert reg.get("coros") is coros

    def test_get_unknown_raises(self):
        reg = ProviderRegistry()
        with pytest.raises(UnknownProvider) as exc_info:
            reg.get("garmin")
        assert exc_info.value.name == "garmin"
        assert "garmin" in str(exc_info.value)

    def test_register_duplicate_rejected(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        with pytest.raises(ValueError, match="already registered"):
            reg.register(_FakeSource("coros"))

    def test_first_registered_becomes_default(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        reg.register(_FakeSource("garmin"))
        assert reg.default_name() == "coros"

    def test_explicit_default_overrides_first(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        reg.register(_FakeSource("garmin"), default=True)
        assert reg.default_name() == "garmin"

    def test_contains(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        assert "coros" in reg
        assert "garmin" not in reg

    def test_len(self):
        reg = ProviderRegistry()
        assert len(reg) == 0
        reg.register(_FakeSource("coros"))
        reg.register(_FakeSource("garmin"))
        assert len(reg) == 2

    def test_names_iter(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        reg.register(_FakeSource("garmin"))
        assert sorted(reg.names()) == ["coros", "garmin"]

    def test_all_infos(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        reg.register(_FakeSource("garmin", regions=("global", "cn")))
        infos = reg.all_infos()
        assert len(infos) == 2
        names = {i.name for i in infos}
        assert names == {"coros", "garmin"}

    def test_default_name_when_empty(self):
        assert ProviderRegistry().default_name() is None


# ─────────────────────────────────────────────────────────────────────────────
# read_user_provider — robust to missing/malformed config
# ─────────────────────────────────────────────────────────────────────────────


class TestReadUserProvider:
    def test_missing_config_returns_default(self, tmp_path: Path):
        assert read_user_provider("user1", base_dir=tmp_path) == DEFAULT_PROVIDER

    def test_missing_config_returns_explicit_default(self, tmp_path: Path):
        assert read_user_provider("user1", default="garmin", base_dir=tmp_path) == "garmin"

    def test_legacy_config_without_provider_field_returns_default(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({
            "email": "x@y.com", "pwd_hash": "abc", "access_token": "t",
        }), encoding="utf-8")
        assert read_user_provider("user1", base_dir=tmp_path) == DEFAULT_PROVIDER

    def test_config_with_provider_field(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({
            "provider": "garmin", "email": "x@y.com",
        }), encoding="utf-8")
        assert read_user_provider("user1", base_dir=tmp_path) == "garmin"

    def test_malformed_json_returns_default(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text("not json {{{", encoding="utf-8")
        assert read_user_provider("user1", base_dir=tmp_path) == DEFAULT_PROVIDER

    def test_non_dict_json_returns_default(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")
        assert read_user_provider("user1", base_dir=tmp_path) == DEFAULT_PROVIDER

    def test_provider_field_empty_string_returns_default(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({"provider": ""}), encoding="utf-8")
        assert read_user_provider("user1", base_dir=tmp_path) == DEFAULT_PROVIDER

    def test_provider_field_null_returns_default(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({"provider": None}), encoding="utf-8")
        assert read_user_provider("user1", base_dir=tmp_path) == DEFAULT_PROVIDER


# ─────────────────────────────────────────────────────────────────────────────
# write_user_provider — preserves other fields, creates if missing
# ─────────────────────────────────────────────────────────────────────────────


class TestWriteUserProvider:
    def test_creates_file_if_missing(self, tmp_path: Path):
        write_user_provider("user1", "coros", base_dir=tmp_path)
        cfg = tmp_path / "user1" / "config.json"
        assert cfg.exists()
        data = json.loads(cfg.read_text(encoding="utf-8"))
        assert data == {"provider": "coros"}

    def test_preserves_existing_fields(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({
            "email": "x@y.com",
            "pwd_hash": "abc",
            "access_token": "t",
        }), encoding="utf-8")

        write_user_provider("user1", "garmin", base_dir=tmp_path)

        data = json.loads(cfg.read_text(encoding="utf-8"))
        assert data["provider"] == "garmin"
        assert data["email"] == "x@y.com"
        assert data["pwd_hash"] == "abc"
        assert data["access_token"] == "t"

    def test_overwrites_existing_provider(self, tmp_path: Path):
        write_user_provider("user1", "coros", base_dir=tmp_path)
        write_user_provider("user1", "garmin", base_dir=tmp_path)
        assert read_user_provider("user1", base_dir=tmp_path) == "garmin"

    def test_handles_malformed_existing_file(self, tmp_path: Path):
        cfg = tmp_path / "user1" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text("garbage{{", encoding="utf-8")
        # Should not raise — falls back to fresh dict.
        write_user_provider("user1", "coros", base_dir=tmp_path)
        data = json.loads(cfg.read_text(encoding="utf-8"))
        assert data == {"provider": "coros"}


# ─────────────────────────────────────────────────────────────────────────────
# Registry.for_user — the real dispatch path
# ─────────────────────────────────────────────────────────────────────────────


class TestForUserDispatch:
    @pytest.fixture(autouse=True)
    def _patch_user_data_dir(self, tmp_path: Path, monkeypatch):
        """Redirect read_user_provider's USER_DATA_DIR to tmp_path."""
        # registry._user_config_path imports USER_DATA_DIR lazily from db; patch there.
        from stride_core import db as db_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
        self.tmp_path = tmp_path

    def test_user_with_no_config_gets_default(self):
        reg = ProviderRegistry()
        coros = _FakeSource("coros")
        reg.register(coros)
        assert reg.for_user("brand_new_user") is coros

    def test_user_with_explicit_garmin_dispatches_to_garmin(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))
        garmin = _FakeSource("garmin")
        reg.register(garmin)

        cfg = self.tmp_path / "garmin_user" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({"provider": "garmin"}), encoding="utf-8")

        assert reg.for_user("garmin_user") is garmin

    def test_user_with_unsupported_provider_raises(self):
        reg = ProviderRegistry()
        reg.register(_FakeSource("coros"))

        cfg = self.tmp_path / "polar_user" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({"provider": "polar"}), encoding="utf-8")

        with pytest.raises(UnknownProvider) as exc_info:
            reg.for_user("polar_user")
        assert exc_info.value.name == "polar"

    def test_legacy_user_without_provider_field_gets_default(self):
        reg = ProviderRegistry()
        coros = _FakeSource("coros")
        reg.register(coros)
        reg.register(_FakeSource("garmin"))

        cfg = self.tmp_path / "legacy" / "config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(json.dumps({"email": "old@user.com"}), encoding="utf-8")

        assert reg.for_user("legacy") is coros
