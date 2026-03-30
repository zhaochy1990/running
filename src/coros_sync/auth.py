"""Credential and token management for COROS API."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from platformdirs import user_config_dir

CONFIG_DIR = Path(user_config_dir("coros-sync"))
CONFIG_FILE = CONFIG_DIR / "config.json"


@dataclass
class Credentials:
    email: str = ""
    pwd_hash: str = ""
    access_token: str = ""
    region: str = "global"
    user_id: str = ""

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls) -> Credentials:
        if not CONFIG_FILE.exists():
            return cls()
        data = json.loads(CONFIG_FILE.read_text())
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    @property
    def is_logged_in(self) -> bool:
        return bool(self.access_token and self.email)


def hash_password(password: str) -> str:
    return hashlib.md5(password.encode()).hexdigest()
