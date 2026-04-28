"""Tests for /api/users/me/profile endpoints."""

from __future__ import annotations

import json
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"

VALID_PROFILE_BODY = {
    "display_name": "Test User",
    "dob": "1990-05-15",
    "sex": "male",
    "height_cm": 175.0,
    "weight_kg": 68.0,
    "target_race": "上海马拉松 2026",
    "target_distance": "FM",
    "target_race_date": "2026-10-18",
    "target_time": "2:50:00",
}


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
    """TestClient with bearer configured and USER_DATA_DIR pointing to tmp_path."""
    private_pem, public_pem = rsa_keypair

    # Patch bearer module
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)
    # Re-load key after env change
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)

    # Patch USER_DATA_DIR in profile routes
    import stride_server.routes.profile as profile_mod
    monkeypatch.setattr(profile_mod, "USER_DATA_DIR", tmp_path)

    from fastapi import FastAPI, Depends
    from stride_server.bearer import require_bearer
    from stride_server.routes.profile import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token


def test_get_profile_no_files_returns_defaults(app_client):
    client, token = app_client
    resp = client.get("/api/users/me/profile", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == USER_UUID
    assert data["display_name"] is None
    assert data["profile"] == {}
    onboarding = data["onboarding"]
    assert onboarding["coros_ready"] is False
    assert onboarding["profile_ready"] is False
    assert onboarding["completed_at"] is None
    assert onboarding["sync_state"] is None


def test_post_valid_profile_writes_file(app_client, tmp_path):
    client, token = app_client
    resp = client.post(
        "/api/users/me/profile",
        json=VALID_PROFILE_BODY,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    profile_file = tmp_path / USER_UUID / "profile.json"
    assert profile_file.exists()
    saved = json.loads(profile_file.read_text())
    assert saved["display_name"] == "Test User"
    assert saved["target_race"] == "上海马拉松 2026"
    assert saved["target_distance"] == "FM"


def test_post_profile_sets_profile_ready(app_client, tmp_path):
    client, token = app_client
    client.post(
        "/api/users/me/profile",
        json=VALID_PROFILE_BODY,
        headers={"Authorization": f"Bearer {token}"},
    )
    onboarding_file = tmp_path / USER_UUID / "onboarding.json"
    assert onboarding_file.exists()
    onboarding = json.loads(onboarding_file.read_text())
    assert onboarding["profile_ready"] is True


def test_get_profile_after_post_returns_saved_data(app_client):
    client, token = app_client
    client.post(
        "/api/users/me/profile",
        json=VALID_PROFILE_BODY,
        headers={"Authorization": f"Bearer {token}"},
    )
    resp = client.get("/api/users/me/profile", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "Test User"
    assert data["profile"]["target_race"] == "上海马拉松 2026"
    assert data["profile"]["target_distance"] == "FM"
    assert data["onboarding"]["profile_ready"] is True


def test_post_missing_required_field_returns_422(app_client):
    client, token = app_client
    body = {k: v for k, v in VALID_PROFILE_BODY.items() if k != "display_name"}
    resp = client.post(
        "/api/users/me/profile",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_post_invalid_sex_returns_422(app_client):
    client, token = app_client
    body = {**VALID_PROFILE_BODY, "sex": "unknown"}
    resp = client.post(
        "/api/users/me/profile",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_post_invalid_target_distance_returns_422(app_client):
    client, token = app_client
    body = {**VALID_PROFILE_BODY, "target_distance": "ultramarathon"}
    resp = client.post(
        "/api/users/me/profile",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_post_target_race_accepts_free_text(app_client, tmp_path):
    """target_race is free-text (race name); only target_distance is constrained."""
    client, token = app_client
    body = {**VALID_PROFILE_BODY, "target_race": "Boston Marathon 2027"}
    resp = client.post(
        "/api/users/me/profile",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200

    saved = json.loads((tmp_path / USER_UUID / "profile.json").read_text())
    assert saved["target_race"] == "Boston Marathon 2027"
    assert saved["target_distance"] == "FM"


def test_post_empty_target_race_returns_422(app_client):
    """Empty target_race must be rejected (min_length=1)."""
    client, token = app_client
    body = {**VALID_PROFILE_BODY, "target_race": ""}
    resp = client.post(
        "/api/users/me/profile",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_get_profile_no_auth_returns_401(app_client):
    client, _ = app_client
    resp = client.get("/api/users/me/profile")
    assert resp.status_code == 401


def test_post_profile_no_auth_returns_401(app_client):
    client, _ = app_client
    resp = client.post("/api/users/me/profile", json=VALID_PROFILE_BODY)
    assert resp.status_code == 401


def test_post_profile_optional_fields_accepted(app_client):
    client, token = app_client
    body = {
        **VALID_PROFILE_BODY,
        "pbs": {"5K": "19:30", "HM": "1:24:00"},
        "weekly_mileage_km": 60.0,
        "constraints": "left knee tendinitis",
    }
    resp = client.post(
        "/api/users/me/profile",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200

    resp2 = client.get("/api/users/me/profile", headers={"Authorization": f"Bearer {token}"})
    data = resp2.json()
    assert data["profile"]["pbs"] == {"5K": "19:30", "HM": "1:24:00"}
    assert data["profile"]["weekly_mileage_km"] == 60.0
    assert data["profile"]["constraints"] == "left knee tendinitis"


# ---------------------------------------------------------------------------
# PATCH /api/users/me/profile — partial profile edits
# ---------------------------------------------------------------------------


def test_patch_profile_partial_change_preserves_other_fields(app_client, tmp_path):
    """PATCH with only display_name preserves all other onboarding fields."""
    client, token = app_client
    # Seed via POST first.
    client.post(
        "/api/users/me/profile",
        json=VALID_PROFILE_BODY,
        headers={"Authorization": f"Bearer {token}"},
    )

    resp = client.patch(
        "/api/users/me/profile",
        json={"display_name": "新名字"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["display_name"] == "新名字"

    saved = json.loads((tmp_path / USER_UUID / "profile.json").read_text())
    assert saved["display_name"] == "新名字"
    # Other fields untouched.
    assert saved["target_race"] == VALID_PROFILE_BODY["target_race"]
    assert saved["target_distance"] == VALID_PROFILE_BODY["target_distance"]
    assert saved["height_cm"] == VALID_PROFILE_BODY["height_cm"]


def test_patch_profile_empty_display_name_returns_422(app_client):
    """display_name with empty string violates min_length=1."""
    client, token = app_client
    resp = client.patch(
        "/api/users/me/profile",
        json={"display_name": ""},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_patch_profile_creates_when_missing(app_client, tmp_path):
    """PATCH succeeds even when profile.json doesn't exist yet."""
    client, token = app_client
    resp = client.patch(
        "/api/users/me/profile",
        json={"display_name": "First"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    saved = json.loads((tmp_path / USER_UUID / "profile.json").read_text())
    assert saved == {"display_name": "First"}


def test_patch_profile_no_auth_returns_401(app_client):
    client, _ = app_client
    resp = client.patch("/api/users/me/profile", json={"display_name": "X"})
    assert resp.status_code == 401


def test_patch_profile_empty_body_is_noop(app_client, tmp_path):
    """Empty PATCH body shouldn't error or wipe existing data."""
    client, token = app_client
    client.post(
        "/api/users/me/profile",
        json=VALID_PROFILE_BODY,
        headers={"Authorization": f"Bearer {token}"},
    )

    resp = client.patch(
        "/api/users/me/profile",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    saved = json.loads((tmp_path / USER_UUID / "profile.json").read_text())
    assert saved["display_name"] == VALID_PROFILE_BODY["display_name"]
    assert saved["target_race"] == VALID_PROFILE_BODY["target_race"]


def test_patch_profile_invalid_target_distance_returns_422(app_client):
    client, token = app_client
    resp = client.patch(
        "/api/users/me/profile",
        json={"target_distance": "ULTRA"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_patch_profile_partial_pbs_replaces_only_pbs(app_client, tmp_path):
    client, token = app_client
    client.post(
        "/api/users/me/profile",
        json={**VALID_PROFILE_BODY, "pbs": {"5K": "20:00"}},
        headers={"Authorization": f"Bearer {token}"},
    )
    resp = client.patch(
        "/api/users/me/profile",
        json={"pbs": {"5K": "19:00", "HM": "1:25:00"}},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    saved = json.loads((tmp_path / USER_UUID / "profile.json").read_text())
    assert saved["pbs"] == {"5K": "19:00", "HM": "1:25:00"}
    # other fields preserved
    assert saved["target_race"] == VALID_PROFILE_BODY["target_race"]
