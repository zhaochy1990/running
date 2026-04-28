"""Tests for /api/{user}/weeks/{folder} feedback DB-precedence + PUT endpoint."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
WEEK = "2026-04-20_04-26(W0)"


@pytest.fixture
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _make_token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    # Point USER_DATA_DIR at tmp_path so DB writes / reads + logs_dir resolution
    # both target the per-test sandbox. Patch BOTH the original (stride_core.db
    # — used by Database(user=...)) and the re-export in stride_server.deps
    # (used by get_logs_dir).
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    # Pre-create logs dir + a feedback.md so the file fallback can be exercised.
    (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.weeks import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# GET — DB precedence over feedback.md
# ---------------------------------------------------------------------------


def test_get_week_feedback_falls_back_to_file(app_client):
    client, token, tmp_path = app_client
    feedback_md = tmp_path / USER_UUID / "logs" / WEEK / "feedback.md"
    feedback_md.write_text("# Week 0\n\nplain markdown notes", encoding="utf-8")

    resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["feedback_source"] == "file"
    assert "plain markdown notes" in data["feedback"]


def test_get_week_feedback_db_overrides_file(app_client):
    """When weekly_feedback row exists, it wins over feedback.md and over
    auto-merged sport_notes."""
    client, token, tmp_path = app_client

    # Seed both file and DB; DB should win.
    feedback_md = tmp_path / USER_UUID / "logs" / WEEK / "feedback.md"
    feedback_md.write_text("FROM FILE", encoding="utf-8")

    from stride_core.db import Database
    db = Database(tmp_path / USER_UUID / "coros.db")
    db.upsert_weekly_feedback(WEEK, "FROM DB EDIT", generated_by="user")
    db.close()

    resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["feedback_source"] == "db"
    assert data["feedback"] == "FROM DB EDIT"
    assert "FROM FILE" not in (data.get("feedback") or "")
    assert data["feedback_generated_by"] == "user"


# ---------------------------------------------------------------------------
# PUT — write + own-only
# ---------------------------------------------------------------------------


def test_put_feedback_writes_db_row(app_client):
    client, token, tmp_path = app_client

    resp = client.put(
        f"/api/{USER_UUID}/weeks/{WEEK}/feedback",
        json={"content": "**bold week**", "generated_by": "user"},
        headers=_auth(token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["feedback_source"] == "db"

    # GET should now see the DB row.
    get_resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    assert get_resp.status_code == 200
    assert get_resp.json()["feedback"] == "**bold week**"
    assert get_resp.json()["feedback_source"] == "db"


def test_put_feedback_validates_content(app_client):
    client, token, _ = app_client
    resp = client.put(
        f"/api/{USER_UUID}/weeks/{WEEK}/feedback",
        json={"content": 123},  # not a string
        headers=_auth(token),
    )
    assert resp.status_code == 422


def test_put_feedback_rejects_bad_folder(app_client):
    client, token, _ = app_client
    resp = client.put(
        f"/api/{USER_UUID}/weeks/not-a-week/feedback",
        json={"content": "hi"},
        headers=_auth(token),
    )
    assert resp.status_code == 400


def test_put_feedback_other_user_forbidden(app_client, rsa_keypair):
    """A token whose sub != path user should get 403 from verify_path_user."""
    client, _own_token, _ = app_client
    private_pem, _public_pem = rsa_keypair
    other_token = _make_token(private_pem, sub="b1b2c3d4-e5f6-4aaa-89ab-999999999999")

    resp = client.put(
        f"/api/{USER_UUID}/weeks/{WEEK}/feedback",
        json={"content": "hijack"},
        headers=_auth(other_token),
    )
    assert resp.status_code == 403


def test_put_feedback_overwrites_previous(app_client):
    """Repeated PUTs replace the prior content (no append)."""
    client, token, _ = app_client

    client.put(f"/api/{USER_UUID}/weeks/{WEEK}/feedback",
               json={"content": "draft 1"}, headers=_auth(token))
    client.put(f"/api/{USER_UUID}/weeks/{WEEK}/feedback",
               json={"content": "draft 2 final"}, headers=_auth(token))

    get_resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    assert get_resp.json()["feedback"] == "draft 2 final"
