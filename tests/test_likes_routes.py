"""Tests for the /api/teams/{team_id}/activities/{user_id}/{label_id}/likes routes.

The auth-service ``list_members`` call is monkeypatched. The likes_store is
the file-backed backend pointed at tmp_path. Each test seeds the activity
existence by writing a tiny coros.db.
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"
USER_C_OUTSIDE = "c1b2c3d4-e5f6-4aaa-89ab-333333333333"
LABEL = "act-label-001"


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


def _make_token(private_pem: str, sub: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


def _seed_activity(user_data_dir, user_id: str, label_id: str) -> None:
    from stride_core.db import Database
    user_dir = user_data_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    db = Database(user_dir / "coros.db")
    db._conn.execute(
        """INSERT OR REPLACE INTO activities
            (label_id, name, sport_type, sport_name, date, distance_m,
             duration_s, avg_pace_s_km, avg_hr, max_hr, training_load,
             vo2max, train_type)
            VALUES (?, 'Run', 100, 'Run', '2026-05-04T10:00:00+00:00',
                    10.0, 3000, 300, 150, 170, 100, 50, 'easy')""",
        (label_id,),
    )
    db._conn.commit()
    db.close()


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
    monkeypatch.delenv("STRIDE_LIKES_TABLE_ACCOUNT_URL", raising=False)

    # Point USER_DATA_DIR at tmp_path so likes_store.file backend writes there.
    import stride_core.db as core_db
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)

    import stride_server.likes_store as ls
    ls.reset_backend_cache()

    from stride_server.bearer import require_bearer
    from stride_server.routes.likes import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token_a = _make_token(private_pem, USER_A)
    token_outsider = _make_token(private_pem, USER_C_OUTSIDE)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token_a, token_outsider, tmp_path, ls


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _stub_members(monkeypatch, members: list[dict]):
    async def fake_list_members(_bearer, _team_id):
        return members
    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)


def test_post_then_idempotent_then_delete(app_client, monkeypatch):
    client, token_a, _, tmp_path, _ls = app_client
    _seed_activity(tmp_path, USER_B, LABEL)
    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "member"},
        {"user_id": USER_B, "name": "Bob", "role": "owner"},
    ])

    # First like
    resp = client.post(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"liked": True, "count": 1, "you_liked": True}

    # Same caller again — idempotent, count stays 1
    resp = client.post(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.json() == {"liked": True, "count": 1, "you_liked": True}

    # Unlike
    resp = client.delete(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.json() == {"liked": False, "count": 0, "you_liked": False}


def test_get_lists_likers(app_client, monkeypatch):
    client, token_a, _, tmp_path, _ls = app_client
    _seed_activity(tmp_path, USER_B, LABEL)
    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "member"},
        {"user_id": USER_B, "name": "Bob", "role": "owner"},
    ])

    client.post(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    resp = client.get(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["you_liked"] is True
    assert len(data["likers"]) == 1
    liker = data["likers"][0]
    assert liker["user_id"] == USER_A
    assert liker["display_name"] == "Alice"


def test_post_outside_caller_403(app_client, monkeypatch):
    client, _token_a, token_outsider, tmp_path, _ls = app_client
    _seed_activity(tmp_path, USER_B, LABEL)
    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "member"},
        {"user_id": USER_B, "name": "Bob", "role": "owner"},
    ])

    resp = client.post(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_outsider),
    )
    assert resp.status_code == 403


def test_post_target_not_in_team_404(app_client, monkeypatch):
    client, token_a, _, tmp_path, _ls = app_client
    _seed_activity(tmp_path, USER_B, LABEL)
    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "owner"},
        # USER_B not in team
    ])

    resp = client.post(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 404


def test_likes_isolated_per_team(app_client, monkeypatch):
    """A like made in team A must not surface when GETting from team B."""
    client, token_a, _, tmp_path, _ls = app_client
    _seed_activity(tmp_path, USER_B, LABEL)
    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "member"},
        {"user_id": USER_B, "name": "Bob", "role": "owner"},
    ])

    # Like in team A
    client.post(
        f"/api/teams/teamA/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    # GET in team B should see zero
    resp = client.get(
        f"/api/teams/teamB/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


def test_post_invalid_user_id_422(app_client, monkeypatch):
    client, token_a, _, _, _ls = app_client
    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])
    resp = client.post(
        f"/api/teams/t1/activities/not-a-uuid/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 422


def test_post_invalid_label_id_422(app_client, monkeypatch):
    client, token_a, _, _, _ls = app_client
    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])
    # path traversal attempt
    resp = client.post(
        f"/api/teams/t1/activities/{USER_A}/has%20space/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 422


def test_post_succeeds_without_local_db(app_client, monkeypatch):
    """We intentionally don't verify the activity exists in the owner's DB —
    the activity_id is opaque to the like store. Liking a stale label is
    harmless because feed enrichment only surfaces likes for activities
    currently in the feed."""
    client, token_a, _, _tmp_path, _ls = app_client
    # No DB seeded for USER_B
    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "member"},
        {"user_id": USER_B, "name": "Bob", "role": "owner"},
    ])

    resp = client.post(
        f"/api/teams/t1/activities/{USER_B}/{LABEL}/likes",
        headers=_auth(token_a),
    )
    assert resp.status_code == 200
    assert resp.json()["liked"] is True
