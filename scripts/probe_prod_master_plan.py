"""Read-only probe: confirm a prod user's master-plan / goal / legacy-plan state.

Reads email/password from repo-root .credentials.local, logs in against the
prod auth backend, then GETs three endpoints to classify why /plan shows no
change. Prints NO secrets/tokens. Safe: all requests are GET except login.
"""
from __future__ import annotations

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

AUTH_BASE = "https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io"
APP_BASE = "https://stride-running.cn"


def _read_creds() -> tuple[str, str]:
    # .credentials.local lives at repo root (one level up from this worktree's scripts/)
    candidates = [
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
            # decode sub from JWT (no verify — just read payload)
            import base64
            payload_b64 = token.split(".")[1] + "=="
            sub = json.loads(base64.urlsafe_b64decode(payload_b64)).get("sub")
            print(f"login OK (client_id={client_id!r}) sub={sub}")
            break
        print(f"login attempt client_id={client_id!r} -> {status}")
    else:
        raise SystemExit("login failed for all client_id variants")

    mp_status, _ = _get(f"{app_base}/api/users/me/master-plan/current", token)
    goal_status, _ = _get(f"{app_base}/api/users/me/training-goal", token)
    tp_status, tp = _get(f"{app_base}/api/{sub}/training-plan", token)
    has_legacy = bool(isinstance(tp, dict) and tp.get("content"))

    print("--- prod state for this account ---")
    print(f"GET master-plan/current : {mp_status}  ({'has ACTIVE plan' if mp_status==200 else 'no active plan' if mp_status==404 else 'unexpected'})")
    print(f"GET training-goal       : {goal_status}  ({'has goal' if goal_status==200 else 'no goal' if goal_status==404 else 'unexpected'})")
    print(f"GET training-plan       : {tp_status}  (legacy markdown content present: {has_legacy})")
    print("--- diagnosis ---")
    if mp_status == 404 and has_legacy:
        print("CONFIRMED: no master plan + has legacy plan.md -> frontend renders legacy branch, no entry to new flow. Migration needed.")
    elif mp_status == 200:
        print("User already has an ACTIVE master plan -> /plan should show new SeasonOverview. Root cause is elsewhere.")
    else:
        print("State does not match the assumed root cause; inspect manually.")


if __name__ == "__main__":
    main()
