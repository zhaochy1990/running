"""Tests for /api/{user}/activities list pagination and filters."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


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


def _token(private_pem: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": USER_UUID, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
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
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.activities import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    return TestClient(app, raise_server_exceptions=False), _token(private_pem), tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _seed_activities(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_storage.sqlite.database import Database
    db = Database(user=USER_UUID)
    rows = [
        ("run10", "10K Run", 100, "Run", "2026-05-10T00:00:00+00:00", 10.0, 3000.0),
        ("run5", "5K Run", 100, "Run", "2026-05-09T00:00:00+00:00", 5.0, 1600.0),
        ("strength", "Strength", 402, "Strength Training", "2026-05-08T00:00:00+00:00", 0.0, 2400.0),
        ("bike", "Bike", 200, "Bike", "2026-05-07T00:00:00+00:00", 30.0, 3600.0),
    ]
    db._conn.executemany(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date, distance_m, duration_s)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    db._conn.commit()
    db.close()


def test_activity_list_filters_run_category_and_min_distance_on_server(app_client):
    client, token, tmp_path = app_client
    _seed_activities(tmp_path)

    resp = client.get(
        f"/api/{USER_UUID}/activities?sport_category=run&min_distance_km=10&limit=12&offset=0",
        headers=_auth(token),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert [activity["label_id"] for activity in body["activities"]] == ["run10"]


def test_activity_list_total_is_not_limited_by_current_page(app_client):
    client, token, tmp_path = app_client
    _seed_activities(tmp_path)

    resp = client.get(
        f"/api/{USER_UUID}/activities?limit=2&offset=2",
        headers=_auth(token),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 4
    assert body["offset"] == 2
    assert body["limit"] == 2
    assert len(body["activities"]) == 2

