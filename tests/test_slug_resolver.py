"""Tests for _resolve_profile in coros_sync.cli."""

from __future__ import annotations

import json

import pytest


def _resolver(profile, data_dir=None):
    from coros_sync.cli import _resolve_profile
    return _resolve_profile(profile, data_dir=data_dir)


def test_none_passthrough():
    assert _resolver(None) is None


def test_uuid_passthrough():
    uuid = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    assert _resolver(uuid) == uuid


def test_alias_hit(tmp_path):
    uuid = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    aliases = {"zhaochaoyi": uuid}
    (tmp_path / ".slug_aliases.json").write_text(json.dumps(aliases))
    assert _resolver("zhaochaoyi", data_dir=tmp_path) == uuid


def test_alias_miss_falls_back_to_slug(tmp_path):
    aliases = {"someone_else": "a1b2c3d4-e5f6-4aaa-89ab-123456789012"}
    (tmp_path / ".slug_aliases.json").write_text(json.dumps(aliases))
    assert _resolver("zhaochaoyi", data_dir=tmp_path) == "zhaochaoyi"


def test_no_aliases_file_falls_back(tmp_path):
    # No .slug_aliases.json in tmp_path
    assert _resolver("zhaochaoyi", data_dir=tmp_path) == "zhaochaoyi"


def test_corrupted_aliases_file_falls_back(tmp_path):
    (tmp_path / ".slug_aliases.json").write_text("not-json{{")
    assert _resolver("zhaochaoyi", data_dir=tmp_path) == "zhaochaoyi"


def test_uuid_variant_uppercase_passthrough():
    uuid = "A1B2C3D4-E5F6-4AAA-89AB-123456789012"
    assert _resolver(uuid) == uuid
