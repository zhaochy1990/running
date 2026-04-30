"""Per-user Garmin token persistence.

`garth.Client.dumps()` / `loads()` give us a portable JSON-blob representation
of the OAuth1 + OAuth2 tokens (plus user agent + region domain). We store
the dump string at `data/{user}/garmin_auth.json` alongside an `email` and
`region` for diagnostics. The `provider` tag itself stays in `config.json`
(written by `stride_core.registry.write_user_provider`).

Why a separate file: COROS's `config.json` has email + pwd_hash + access
token in plain text — Garmin's tokens are more involved (refresh tokens,
user agents). Keeping them in their own file isolates the format from
adapter-specific quirks.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

def _auth_path(user: str, base_dir: Path | None = None) -> Path:
    if base_dir is not None:
        return base_dir / user / "garmin_auth.json"
    # Lazy import so test monkey-patches of `stride_core.db.USER_DATA_DIR`
    # are picked up at call time rather than at module import time.
    from stride_core.db import USER_DATA_DIR
    return USER_DATA_DIR / user / "garmin_auth.json"


@dataclass
class GarminCredentials:
    """Stored Garmin authentication state for a single user."""

    email: str = ""
    region: str = "cn"            # 'cn' | 'global'
    tokens_dump: str = ""         # garth.Client.dumps() output (JSON string)

    @property
    def is_logged_in(self) -> bool:
        return bool(self.tokens_dump and self.email)

    def save(self, user: str, *, base_dir: Path | None = None) -> None:
        path = _auth_path(user, base_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "email": self.email,
                    "region": self.region,
                    "tokens_dump": self.tokens_dump,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, user: str, *, base_dir: Path | None = None) -> GarminCredentials:
        path = _auth_path(user, base_dir)
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls()
        if not isinstance(data, dict):
            return cls()
        return cls(
            email=str(data.get("email", "")),
            region=str(data.get("region", "cn")),
            tokens_dump=str(data.get("tokens_dump", "")),
        )

    @classmethod
    def from_garth_client(cls, email: str, region: str, garth_client: Any) -> GarminCredentials:
        """Build creds from a freshly logged-in garth.Client."""
        return cls(
            email=email,
            region=region,
            tokens_dump=garth_client.dumps(),
        )


def domain_for_region(region: str) -> str:
    """Map our compact region code to garth's `domain` parameter."""
    return "garmin.cn" if region == "cn" else "garmin.com"
