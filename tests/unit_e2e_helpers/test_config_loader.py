"""Unit tests for tests/e2e/_config.py — pure logic, no network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.e2e._config import E2EConfig, ConfigError, load_config


def _write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


def test_loads_valid_config(tmp_path: Path) -> None:
    cfg_path = tmp_path / "e2e.config.local.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example",
        "auth_url": "https://auth.example",
        "client_id": "client_abc",
        "e2e_email": "e2e@example.com",
        "e2e_password": "pw",
    })
    cfg = load_config(cfg_path)
    assert isinstance(cfg, E2EConfig)
    assert cfg.prod_url == "https://prod.example"
    assert cfg.auth_url == "https://auth.example"
    assert cfg.client_id == "client_abc"
    assert cfg.e2e_email == "e2e@example.com"
    assert cfg.e2e_password == "pw"


def test_strips_trailing_slash_from_urls(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example/",
        "auth_url": "https://auth.example/",
        "client_id": "c",
        "e2e_email": "e",
        "e2e_password": "p",
    })
    cfg = load_config(cfg_path)
    assert cfg.prod_url == "https://prod.example"
    assert cfg.auth_url == "https://auth.example"


def test_missing_file_raises_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError) as exc:
        load_config(tmp_path / "does-not-exist.json")
    assert "not found" in str(exc.value).lower()


def test_missing_required_key_raises_config_error(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example",
        # missing the other four keys
    })
    with pytest.raises(ConfigError) as exc:
        load_config(cfg_path)
    msg = str(exc.value).lower()
    assert "missing" in msg
    assert "auth_url" in msg
    assert "client_id" in msg
    assert "e2e_email" in msg
    assert "e2e_password" in msg


def test_malformed_json_raises_config_error(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    cfg_path.write_text("{ this is not valid json", encoding="utf-8")
    with pytest.raises(ConfigError) as exc:
        load_config(cfg_path)
    assert "parse" in str(exc.value).lower() or "json" in str(exc.value).lower()


def test_empty_string_value_treated_as_missing(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example",
        "auth_url": "https://auth.example",
        "client_id": "",
        "e2e_email": "e",
        "e2e_password": "p",
    })
    with pytest.raises(ConfigError) as exc:
        load_config(cfg_path)
    assert "client_id" in str(exc.value)
