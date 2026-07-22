"""Tests for persisted notification read state routes."""

from __future__ import annotations

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"
INTERNAL_TOKEN = "test-internal-token-12345678"


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
        "STRIDE_INTERNAL_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)
    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)

    from stride_core import db as core_db_mod
    from stride_server.notifications import store as nstore
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    nstore.reset_backend_cache()

    from stride_server.bearer import require_bearer
    from stride_server.routes.notifications import internal_router, router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])
    app.include_router(internal_router)

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


def test_internal_notification_upsert_requires_internal_token(app_client):
    client, _private_pem = app_client

    response = client.post(
        "/internal/notifications",
        json={
            "user_id": USER_A,
            "notification_id": "sync:onboarding",
            "title": "正在同步数据",
            "body": "正在同步健康数据",
        },
    )

    assert response.status_code == 401


def test_internal_notification_upsert_rechecks_fence_inside_writer_lock(
    app_client, monkeypatch,
):
    client, _private_pem = app_client
    import stride_server.routes.notifications as route_mod
    import stride_server.sqlite_writer as writer

    writer.reset_for_tests()
    checks: list[str] = []

    def reject_deleting_user(user_id: str) -> None:
        checks.append(user_id)
        with writer.try_user_sqlite_writer(user_id) as acquired:
            assert acquired is False
        raise HTTPException(status_code=410, detail="deleted")

    def fail_upsert(*_args, **_kwargs):
        raise AssertionError("fenced user must be rejected before notification write")

    monkeypatch.setattr(
        route_mod,
        "reject_deleting_user",
        reject_deleting_user,
        raising=False,
    )
    monkeypatch.setattr(route_mod.nstore, "upsert_notification", fail_upsert)

    response = client.post(
        "/internal/notifications",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            "user_id": USER_A,
            "notification_id": "sync:onboarding",
            "title": "正在同步数据",
            "body": "正在同步健康数据",
        },
    )

    assert response.status_code == 410
    assert checks == [USER_A]


def test_file_notifications_backend_deletes_all_user_data(app_client):
    _client, _private_pem = app_client
    from stride_server.notifications import store as nstore

    for user_id in (USER_A, USER_B):
        nstore.upsert_device(
            user_id,
            f"registration_{user_id[:8]}",
            platform="android",
            app_version="1.0",
        )
        nstore.update_prefs(user_id, plan_reminder_enabled=False)
        nstore.mark_notification_read(user_id, "legacy-message")
        nstore.upsert_notification(
            user_id,
            "sync:onboarding",
            title="同步",
            body="处理中",
        )

    assert nstore.delete_user(USER_A) == 4
    assert nstore.list_device_ids(USER_A) == []
    assert nstore.get_prefs(USER_A)["updated_at"] is None
    assert nstore.get_read_notification_ids(USER_A) == []
    assert nstore.list_notifications(USER_A) == []

    assert len(nstore.list_device_ids(USER_B)) == 1
    assert nstore.get_prefs(USER_B)["updated_at"] is not None
    assert nstore.get_read_notification_ids(USER_B) == ["legacy-message"]
    assert len(nstore.list_notifications(USER_B)) == 1


def test_azure_notifications_backend_deletes_both_user_partitions():
    from stride_storage.azure.notifications_backend import (
        AzureTableNotificationsBackend,
    )

    class FakeTable:
        def __init__(self, rows):
            self.rows = [dict(row) for row in rows]

        def query_entities(self, _query, *, parameters):
            return [
                dict(row)
                for row in self.rows
                if row["PartitionKey"] == parameters["pk"]
            ]

        def delete_entity(self, *, partition_key, row_key):
            self.rows = [
                row
                for row in self.rows
                if not (
                    row["PartitionKey"] == partition_key
                    and row["RowKey"] == row_key
                )
            ]

    devices = FakeTable([
        {"PartitionKey": USER_A, "RowKey": "device-a1"},
        {"PartitionKey": USER_A, "RowKey": "device-a2"},
        {"PartitionKey": USER_B, "RowKey": "device-b"},
    ])
    prefs = FakeTable([
        {"PartitionKey": USER_A, "RowKey": "prefs"},
        {"PartitionKey": USER_A, "RowKey": "notification-read-state"},
        {"PartitionKey": USER_A, "RowKey": "notification:sync"},
        {"PartitionKey": USER_B, "RowKey": "prefs"},
    ])
    backend = AzureTableNotificationsBackend.__new__(
        AzureTableNotificationsBackend
    )
    backend._devices_conn = SimpleNamespace(table=lambda: devices)
    backend._prefs_conn = SimpleNamespace(table=lambda: prefs)

    assert backend.delete_user(USER_A) == 5
    assert {row["PartitionKey"] for row in devices.rows} == {USER_B}
    assert {row["PartitionKey"] for row in prefs.rows} == {USER_B}


def test_internal_notification_upsert_persists_generic_item(app_client):
    client, private_pem = app_client
    token = _token(private_pem, USER_A)

    response = client.post(
        "/internal/notifications",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            "user_id": USER_A,
            "notification_id": "sync:onboarding",
            "severity": "info",
            "title": "正在同步数据",
            "body": "正在同步健康数据，马上就好",
            "action_url": "/plan",
            "progress_pct": 0,
            "metadata": {"type": "sync", "state": "running", "mode": "health_only"},
        },
    )

    assert response.status_code == 200
    item = response.json()["notification"]
    assert item["id"] == "sync:onboarding"
    assert item["metadata"] == {"type": "sync", "state": "running", "mode": "health_only"}
    assert item["progress_pct"] == 0
    assert item["read"] is False
    assert item["read_at"] is None
    assert "status" not in item
    assert "kind" not in item
    assert "source_type" not in item
    assert "source_id" not in item

    from stride_server.notifications import store as nstore

    stored = nstore.list_notifications(USER_A)
    assert [notification["id"] for notification in stored] == ["sync:onboarding"]
    assert nstore.list_notifications(USER_B) == []

    marked = client.post(
        "/api/users/me/notifications/sync:onboarding/read",
        headers=_auth(token),
    )
    assert marked.status_code == 200
    assert marked.json()["read_ids"] == ["sync:onboarding"]

    updated = client.post(
        "/internal/notifications",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        json={
            "user_id": USER_A,
            "notification_id": "sync:onboarding",
            "severity": "success",
            "title": "数据同步完成",
            "body": "初始化完成",
            "action_url": "/plan",
            "progress_pct": 100,
            "metadata": {"type": "sync", "state": "done", "mode": "health_only"},
        },
    )
    assert updated.status_code == 200
    assert updated.json()["notification"]["read"] is False

    read_state = client.get(
        "/api/users/me/notifications/read-state",
        headers=_auth(token),
    )
    assert read_state.status_code == 200
    assert read_state.json() == {"read_ids": []}


def test_notifications_inbox_lists_user_scoped_items(app_client):
    client, private_pem = app_client
    token_a = _token(private_pem, USER_A)
    token_b = _token(private_pem, USER_B)

    from stride_server.notifications import store as nstore

    nstore.upsert_notification(
        USER_A,
        "sync:onboarding",
        severity="info",
        title="正在同步数据",
        body="正在同步健康数据，马上就好",
        progress_pct=0,
        metadata={"type": "sync", "state": "running", "mode": "health_only"},
    )
    nstore.upsert_notification(
        USER_B,
        "sync:onboarding",
        severity="success",
        title="数据同步完成",
        body="初始化完成",
        progress_pct=100,
        metadata={"type": "sync", "state": "done"},
    )

    response = client.get("/api/users/me/notifications", headers=_auth(token_a))

    assert response.status_code == 200
    body = response.json()
    assert body["read_ids"] == []
    assert [item["id"] for item in body["notifications"]] == ["sync:onboarding"]
    item = body["notifications"][0]
    assert "status" not in item
    assert "kind" not in item
    assert "source_type" not in item
    assert "source_id" not in item
    assert item["metadata"] == {"type": "sync", "state": "running", "mode": "health_only"}
    assert item["progress_pct"] == 0
    assert item["read"] is False
    assert item["read_at"] is None

    other = client.get("/api/users/me/notifications", headers=_auth(token_b))
    assert other.status_code == 200
    assert other.json()["notifications"][0]["metadata"]["state"] == "done"


def test_updated_dynamic_notification_becomes_unread_again_in_store(app_client):
    client, private_pem = app_client
    token = _token(private_pem, USER_A)

    from stride_server.notifications import store as nstore

    nstore.upsert_notification(
        USER_A,
        "master-plan:job-1",
        severity="info",
        title="训练计划正在生成",
        body="正在读取历史训练数据",
        progress_pct=10,
        metadata={"type": "master_plan_generation", "state": "running"},
    )

    marked = client.post(
        "/api/users/me/notifications/master-plan:job-1/read",
        headers=_auth(token),
    )
    assert marked.status_code == 200
    assert marked.json()["read_ids"] == ["master-plan:job-1"]
    read_inbox = nstore.list_notifications(USER_A)
    assert read_inbox[0]["read"] is True
    assert read_inbox[0]["read_at"] is not None

    nstore.upsert_notification(
        USER_A,
        "master-plan:job-1",
        severity="success",
        title="训练计划已生成",
        body="你的训练总纲已经生成好了，可以进入训练计划页审核。",
        progress_pct=100,
        metadata={"type": "master_plan_generation", "state": "done"},
    )

    read_state = client.get(
        "/api/users/me/notifications/read-state",
        headers=_auth(token),
    )
    assert read_state.status_code == 200
    assert read_state.json() == {"read_ids": []}

    inbox = nstore.list_notifications(USER_A)
    assert inbox[0]["read"] is False
    assert inbox[0]["metadata"]["state"] == "done"
