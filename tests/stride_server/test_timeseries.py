"""Tests for /api/{user}/activities/{id}/timeseries + include=timeseries flag."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
LABEL = "L1"


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
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
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

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path


def _seed(tmp_path, *, ts_points: int = 0):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_core.db import Database
    db = Database(user=USER_UUID)
    db._conn.execute(
        "INSERT INTO activities (label_id, name, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (LABEL, "Run", 100, "20260510", 10.0, 3000.0),
    )
    for i in range(ts_points):
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, heart_rate, adjusted_pace, "
            "altitude, cadence) VALUES (?, ?, ?, ?, ?, ?)",
            (LABEL, i, 140 + i, 300.0 + i, 10.0, 170),
        )
    db._conn.commit()
    db.close()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── new /timeseries endpoint ──────────────────────────────────────────────


def test_timeseries_default_fields_downsampled(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=600)
    resp = client.get(
        f"/api/{USER_UUID}/activities/{LABEL}/timeseries",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["label_id"] == LABEL
    assert data["point_count"] == 600
    assert set(data["series"].keys()) == {"hr", "pace", "altitude", "cadence"}
    assert len(data["series"]["hr"]) == 300  # default downsample
    assert "max-age=86400" in resp.headers["cache-control"]
    assert "immutable" in resp.headers["cache-control"]


def test_timeseries_custom_downsample_and_fields(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=100)
    resp = client.get(
        f"/api/{USER_UUID}/activities/{LABEL}/timeseries?downsample=10&fields=hr",
        headers=_auth(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert list(data["series"].keys()) == ["hr"]
    assert len(data["series"]["hr"]) == 10


def test_timeseries_unknown_field_400(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=10)
    resp = client.get(
        f"/api/{USER_UUID}/activities/{LABEL}/timeseries?fields=hr,bogus",
        headers=_auth(token),
    )
    assert resp.status_code == 400


def test_timeseries_no_data_returns_empty_series(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=0)
    resp = client.get(
        f"/api/{USER_UUID}/activities/{LABEL}/timeseries",
        headers=_auth(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["point_count"] == 0
    assert data["series"]["hr"] == []


def test_timeseries_missing_activity_404(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=0)
    resp = client.get(
        f"/api/{USER_UUID}/activities/MISSING/timeseries",
        headers=_auth(token),
    )
    assert resp.status_code == 404


# ── /activities/{id} default vs include=timeseries ────────────────────────


def test_activity_detail_default_excludes_timeseries(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=5)
    resp = client.get(f"/api/{USER_UUID}/activities/{LABEL}", headers=_auth(token))
    assert resp.status_code == 200
    assert "timeseries" not in resp.json()


def test_activity_detail_include_timeseries(app_client):
    client, token, tmp_path = app_client
    _seed(tmp_path, ts_points=5)
    resp = client.get(
        f"/api/{USER_UUID}/activities/{LABEL}?include=timeseries",
        headers=_auth(token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "timeseries" in body
    assert len(body["timeseries"]) == 5
