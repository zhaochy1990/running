"""Tests for persisted notification read state routes."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"


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


def _token(private_pem: str, sub: str = USER_A) -> str:
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
    for key in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
        "STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL",
        "STRIDE_LIKES_TABLE_ACCOUNT_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    from stride_core import db as core_db_mod
    from stride_server.notifications import store as nstore
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    nstore.reset_backend_cache()

    from stride_server.bearer import require_bearer
    from stride_server.routes.notifications import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    yield TestClient(app, raise_server_exceptions=False), private_pem

    nstore.reset_backend_cache()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_notification_read_state_persists_per_user(app_client):
    client, private_pem = app_client
    token_a = _token(private_pem, USER_A)
    token_b = _token(private_pem, USER_B)

    first = client.get("/api/users/me/notifications/read-state", headers=_auth(token_a))
    assert first.status_code == 200
    assert first.json() == {"read_ids": []}

    marked = client.post(
        "/api/users/me/notifications/2026-04-30-custom-domain/read",
        headers=_auth(token_a),
    )
    assert marked.status_code == 200
    assert marked.json()["read_ids"] == ["2026-04-30-custom-domain"]

    again = client.get("/api/users/me/notifications/read-state", headers=_auth(token_a))
    assert again.status_code == 200
    assert again.json()["read_ids"] == ["2026-04-30-custom-domain"]

    other_user = client.get("/api/users/me/notifications/read-state", headers=_auth(token_b))
    assert other_user.status_code == 200
    assert other_user.json() == {"read_ids": []}


def test_notification_read_state_rejects_invalid_notification_id(app_client):
    client, private_pem = app_client
    token = _token(private_pem, USER_A)

    response = client.post(
        "/api/users/me/notifications/not%20valid/read",
        headers=_auth(token),
    )

    assert response.status_code == 422


def test_notifications_inbox_lists_user_scoped_items_and_read_state(app_client):
    client, private_pem = app_client
    token_a = _token(private_pem, USER_A)
    token_b = _token(private_pem, USER_B)

    from stride_server.notifications import store as nstore

    nstore.upsert_notification(
        USER_A,
        "sync:onboarding",
        kind="sync",
        status="running",
        severity="info",
        title="正在同步数据",
        body="正在同步健康数据，马上就好",
        progress_pct=0,
        source_type="sync",
        source_id="health_only",
    )
    nstore.upsert_notification(
        USER_B,
        "sync:onboarding",
        kind="sync",
        status="done",
        severity="success",
        title="数据同步完成",
        body="初始化完成",
        progress_pct=100,
    )

    response = client.get("/api/users/me/notifications", headers=_auth(token_a))

    assert response.status_code == 200
    body = response.json()
    assert body["read_ids"] == []
    assert [item["id"] for item in body["notifications"]] == ["sync:onboarding"]
    item = body["notifications"][0]
    assert item["status"] == "running"
    assert item["progress_pct"] == 0
    assert item["read"] is False

    other = client.get("/api/users/me/notifications", headers=_auth(token_b))
    assert other.status_code == 200
    assert other.json()["notifications"][0]["status"] == "done"


def test_updated_dynamic_notification_becomes_unread_again(app_client):
    client, private_pem = app_client
    token = _token(private_pem, USER_A)

    from stride_server.notifications import store as nstore

    nstore.upsert_notification(
        USER_A,
        "master-plan:job-1",
        kind="master_plan_generation",
        status="running",
        severity="info",
        title="训练计划正在生成",
        body="正在读取历史训练数据",
        progress_pct=10,
    )

    marked = client.post(
        "/api/users/me/notifications/master-plan:job-1/read",
        headers=_auth(token),
    )
    assert marked.status_code == 200
    assert marked.json()["read_ids"] == ["master-plan:job-1"]

    nstore.upsert_notification(
        USER_A,
        "master-plan:job-1",
        kind="master_plan_generation",
        status="done",
        severity="success",
        title="训练计划已生成",
        body="你的训练总纲已经生成好了，可以进入训练计划页审核。",
        progress_pct=100,
    )

    read_state = client.get(
        "/api/users/me/notifications/read-state",
        headers=_auth(token),
    )
    assert read_state.status_code == 200
    assert read_state.json() == {"read_ids": []}

    inbox = client.get("/api/users/me/notifications", headers=_auth(token)).json()
    assert inbox["notifications"][0]["read"] is False
    assert inbox["notifications"][0]["status"] == "done"
