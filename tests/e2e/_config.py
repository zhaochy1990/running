"""Load and validate tests/e2e/e2e.config.local.json. Pure I/O — no network."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


class ConfigError(RuntimeError):
    """Raised when the e2e config file is missing, malformed, or incomplete."""


@dataclass(frozen=True)
class E2EConfig:
    prod_url: str
    auth_url: str
    client_id: str
    e2e_email: str
    e2e_password: str


_REQUIRED = ("prod_url", "auth_url", "client_id", "e2e_email", "e2e_password")


def load_config(path: Path) -> E2EConfig:
    if not path.exists():
        raise ConfigError(
            f"e2e config not found at {path}; "
            f"copy tests/e2e/e2e.config.example.json to "
            f"tests/e2e/e2e.config.local.json and fill in credentials"
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"failed to parse {path} as JSON: {e}") from e
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain a JSON object, got {type(raw).__name__}")

    missing = [k for k in _REQUIRED if not isinstance(raw.get(k), str) or not raw.get(k).strip()]
    if missing:
        raise ConfigError(
            f"e2e config {path} is missing or empty for required keys: {', '.join(missing)}"
        )

    return E2EConfig(
        prod_url=raw["prod_url"].rstrip("/"),
        auth_url=raw["auth_url"].rstrip("/"),
        client_id=raw["client_id"],
        e2e_email=raw["e2e_email"],
        e2e_password=raw["e2e_password"],
    )
