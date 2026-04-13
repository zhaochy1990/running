"""Credential and token management for COROS API."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from platformdirs import user_config_dir

CONFIG_DIR = Path(user_config_dir("coros-sync"))
CONFIG_FILE = CONFIG_DIR / "config.json"

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
USER_DATA_DIR = PROJECT_ROOT / "data"


def _config_path(user: str | None) -> Path:
    if user:
        return USER_DATA_DIR / user / "config.json"
    return CONFIG_FILE


@dataclass
class Credentials:
    email: str = ""
    pwd_hash: str = ""
    access_token: str = ""
    region: str = "global"
    user_id: str = ""

    def save(self, user: str | None = None) -> None:
        path = _config_path(user)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls, user: str | None = None) -> Credentials:
        path = _config_path(user)
        if not path.exists():
            return cls()
        data = json.loads(path.read_text())
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    @property
    def is_logged_in(self) -> bool:
        return bool(self.access_token and self.email)


def hash_password(password: str) -> str:
    return hashlib.md5(password.encode()).hexdigest()
