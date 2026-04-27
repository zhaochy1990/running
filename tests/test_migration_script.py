"""Tests for scripts/migrate_friendly_to_uuid.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Make the scripts/ directory importable for tests.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from migrate_friendly_to_uuid import (  # noqa: E402
    _resolve_admin_token,
    _validate_auth_url,
    is_uuid4,
    load_slug_aliases,
    migrate,
)


VALID_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
VALID_UUID2 = "b2c3d4e5-f6a7-4bbb-9abc-234567890123"


def _setup_slug_dir(data_dir: Path, slug: str, email: str = "user@example.com") -> Path:
    d = data_dir / slug
    d.mkdir(parents=True)
    (d / "config.json").write_text(json.dumps({"email": email}))
    (d / "coros.db").write_text("")  # sentinel file
    return d


def test_is_uuid4_valid():
    assert is_uuid4(VALID_UUID)


def test_is_uuid4_invalid():
    assert not is_uuid4("zhaochaoyi")
    assert not is_uuid4("not-a-uuid")


def test_dry_run_makes_no_fs_changes(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi")

    migrated = migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=True,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    # dry-run reports 1 planned dir but makes no filesystem changes
    assert migrated == 1
    assert (tmp_path / "zhaochaoyi").exists()
    assert not (tmp_path / VALID_UUID).exists()
    assert not (tmp_path / ".slug_aliases.json").exists()


def test_migrate_renames_dir_and_writes_alias(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi", email="user@example.com")

    migrated = migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    assert migrated == 1
    assert not (tmp_path / "zhaochaoyi").exists()
    assert (tmp_path / VALID_UUID).exists()
    assert (tmp_path / VALID_UUID / "coros.db").exists()

    aliases = load_slug_aliases(tmp_path)
    assert aliases["zhaochaoyi"] == VALID_UUID


def test_migrate_sets_display_name_from_slug(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi")

    migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    profile = json.loads((tmp_path / VALID_UUID / "profile.json").read_text())
    assert profile["display_name"] == "zhaochaoyi"


def test_migrate_preserves_existing_display_name(tmp_path):
    d = _setup_slug_dir(tmp_path, "zhaochaoyi")
    (d / "profile.json").write_text(json.dumps({"display_name": "Chaoyi Zhao"}))

    migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    profile = json.loads((tmp_path / VALID_UUID / "profile.json").read_text())
    assert profile["display_name"] == "Chaoyi Zhao"


def test_migrate_skips_existing_uuid_dirs(tmp_path):
    uuid_dir = tmp_path / VALID_UUID
    uuid_dir.mkdir()
    (uuid_dir / "coros.db").write_text("")

    migrated = migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={},
    )

    assert migrated == 0
    assert (tmp_path / VALID_UUID).exists()


def test_migrate_idempotent_after_first_run(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi")

    # First run
    migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    # Second run — slug dir gone, UUID dir already exists, should be no-op
    migrated = migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    assert migrated == 0


def test_migrate_multiple_users(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi")
    _setup_slug_dir(tmp_path, "dehua")

    migrated = migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID, "dehua": VALID_UUID2},
    )

    assert migrated == 2
    assert (tmp_path / VALID_UUID).exists()
    assert (tmp_path / VALID_UUID2).exists()
    aliases = load_slug_aliases(tmp_path)
    assert aliases["zhaochaoyi"] == VALID_UUID
    assert aliases["dehua"] == VALID_UUID2


def test_migrate_uses_api_lookup_when_no_explicit_mapping(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi", email="user@example.com")

    def _fake_resolve(auth_url, admin_token, email):
        if email == "user@example.com":
            return VALID_UUID
        return None

    with patch("migrate_friendly_to_uuid.resolve_uuid_via_api", side_effect=_fake_resolve):
        migrated = migrate(
            auth_url="https://auth.example.com",
            admin_token="admin-token",
            data_dir=tmp_path,
            dry_run=False,
            explicit_mapping={},
        )

    assert migrated == 1
    assert (tmp_path / VALID_UUID).exists()


def test_migrate_skips_slug_when_api_lookup_fails(tmp_path):
    _setup_slug_dir(tmp_path, "zhaochaoyi", email="user@example.com")

    with patch(
        "migrate_friendly_to_uuid.resolve_uuid_via_api",
        side_effect=Exception("network error"),
    ):
        migrated = migrate(
            auth_url="https://auth.example.com",
            admin_token="admin-token",
            data_dir=tmp_path,
            dry_run=False,
            explicit_mapping={},
        )

    assert migrated == 0
    assert (tmp_path / "zhaochaoyi").exists()


def test_migrate_skips_dot_dirs(tmp_path):
    (tmp_path / ".hidden").mkdir()
    _setup_slug_dir(tmp_path, "zhaochaoyi")

    migrated = migrate(
        auth_url=None,
        admin_token=None,
        data_dir=tmp_path,
        dry_run=False,
        explicit_mapping={"zhaochaoyi": VALID_UUID},
    )

    assert migrated == 1
    assert (tmp_path / ".hidden").exists()


# --- Admin-token / auth-url hardening tests (D3, D4) ---

def test_resolve_admin_token_from_env(monkeypatch):
    monkeypatch.setenv("STRIDE_ADMIN_TOKEN_TEST", "tkn-from-env")
    assert _resolve_admin_token("STRIDE_ADMIN_TOKEN_TEST") == "tkn-from-env"


def test_resolve_admin_token_falls_back_to_getpass(monkeypatch):
    monkeypatch.delenv("MISSING_TOKEN_VAR", raising=False)
    with patch("migrate_friendly_to_uuid.getpass.getpass", return_value="prompted"):
        assert _resolve_admin_token("MISSING_TOKEN_VAR") == "prompted"


def test_resolve_admin_token_returns_none_on_eof(monkeypatch):
    monkeypatch.delenv("MISSING_TOKEN_VAR", raising=False)
    with patch("migrate_friendly_to_uuid.getpass.getpass", side_effect=EOFError):
        assert _resolve_admin_token("MISSING_TOKEN_VAR") is None


def test_validate_auth_url_https_passes():
    _validate_auth_url("https://auth.example.com", allow_insecure=False)


def test_validate_auth_url_http_without_flag_aborts():
    with pytest.raises(SystemExit):
        _validate_auth_url("http://auth.example.com", allow_insecure=False)


def test_validate_auth_url_http_with_flag_passes():
    _validate_auth_url("http://auth.example.com", allow_insecure=True)


def test_validate_auth_url_none_passes():
    _validate_auth_url(None, allow_insecure=False)


def test_validate_auth_url_other_scheme_aborts():
    with pytest.raises(SystemExit):
        _validate_auth_url("file:///etc/passwd", allow_insecure=True)
