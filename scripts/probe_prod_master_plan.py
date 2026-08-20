"""Read-only probe for the unified production current season-plan contract.

Reads credentials from repo-root .credentials.local, logs in, and inspects only
status plus content_version. It never prints credentials, tokens, user identity,
or plan content. All requests are GET except login.
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

AUTH_BASE = "https://124.221.38.59"
APP_BASE = "https://stride-running.cn"


def _main_checkout_root() -> Path | None:
    try:
        common_dir = subprocess.check_output(
            ["git", "-C", str(Path(__file__).resolve().parents[1]), "rev-parse", "--git-common-dir"],
            text=True,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    common_path = Path(common_dir)
    if not common_path.is_absolute():
        common_path = Path(__file__).resolve().parents[1] / common_path
    return common_path.resolve().parent


def _read_creds() -> tuple[str, str]:
    checkout_root = _main_checkout_root()
    candidates = [
        *((checkout_root / ".credentials.local",) if checkout_root else ()),
        Path(__file__).resolve().parents[1] / ".credentials.local",
        Path("C:/Users/zhaochaoyi/workspace/running/.credentials.local"),
    ]
    for p in candidates:
        if p.exists():
            email = password = None
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("email"):
                    email = line.split("=", 1)[-1].strip().strip('"').strip("'")
                elif line.startswith("password"):
                    password = line.split("=", 1)[-1].strip().strip('"').strip("'")
            if email and password:
                return email, password
    raise SystemExit("could not read email/password from .credentials.local")


def _post(url: str, body: dict, headers: dict) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}


def _get(url: str, token: str) -> tuple[int, object]:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}, method="GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None


def _current_plan_summary(status: int, payload: object) -> str:
    if status == 404:
        return "no active season plan"
    if status != 200:
        return "unexpected response"
    if not isinstance(payload, dict):
        return "malformed response"
    content_version = payload.get("content_version")
    if content_version == 1:
        return "active Markdown season plan (content_version=1)"
    if content_version == 2:
        return "active structured season plan (content_version=2)"
    return "malformed response"


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-base", default=APP_BASE,
                    help="app API base (default prod; pass http://127.0.0.1:8000 for local backend)")
    args = ap.parse_args()
    app_base = args.app_base.rstrip("/")

    email, password = _read_creds()
    # Try login with X-Client-Id variants; many backends ignore it.
    for client_id in ("app_62978bf2803346878a2e4805",):
        headers = {"Content-Type": "application/json"}
        if client_id:
            headers["X-Client-Id"] = client_id
        status, data = _post(
            f"{AUTH_BASE}/api/auth/login",
            {"email": email, "password": password},
            headers,
        )
        if status == 200 and isinstance(data, dict) and data.get("access_token"):
            token = data["access_token"]
            print("login OK")
            break
        print(f"login attempt failed: HTTP {status}")
    else:
        raise SystemExit("login failed for all client_id variants")

    mp_status, mp = _get(f"{app_base}/api/users/me/master-plan/current", token)

    print("--- current season-plan contract ---")
    print(f"GET master-plan/current : {mp_status}  ({_current_plan_summary(mp_status, mp)})")


if __name__ == "__main__":
    main()
