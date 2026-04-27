"""Tests for /api/users/me/coros/login, /onboarding/complete, /sync-status."""

from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Depends
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


def _make_token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


@pytest.fixture
def app_env(tmp_path, monkeypatch, rsa_keypair):
    """Set up a FastAPI test app with the onboarding router and mocked data dir."""
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)

    import stride_server.routes.onboarding as ob_mod
    monkeypatch.setattr(ob_mod, "USER_DATA_DIR", tmp_path)

    # Minimal DataSource mock
    mock_source = MagicMock()
    mock_source.sync_user.return_value = MagicMock(activities=5, health=7)

    from stride_server.bearer import require_bearer

    app = FastAPI()

    # Inject mock source via app state (mirrors real app factory)
    app.state.source = mock_source
    app.include_router(ob_mod.router, dependencies=[Depends(require_bearer)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path, mock_source


# --- COROS login ---

def test_coros_login_success(app_env):
    client, token, tmp_path, _ = app_env

    mock_creds = MagicMock()
    mock_creds.region = "global"
    mock_creds.user_id = "coros-12345"

    with patch("coros_sync.client.CorosClient.login", return_value=mock_creds):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "secret"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["region"] == "global"
    assert data["user_id"] == "coros-12345"

    onboarding_file = tmp_path / USER_UUID / "onboarding.json"
    assert onboarding_file.exists()
    onboarding = json.loads(onboarding_file.read_text())
    assert onboarding["coros_ready"] is True


def test_coros_login_failure_returns_400(app_env, caplog):
    client, token, _, _ = app_env

    from coros_sync.client import CorosAuthError

    with patch(
        "coros_sync.client.CorosClient.login",
        side_effect=CorosAuthError("Login failed"),
    ):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "wrongpass"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 400
    detail = resp.json().get("detail", "")
    # Password must not appear in the response
    assert "wrongpass" not in detail
    # Password must not appear in logs
    assert "wrongpass" not in caplog.text


def test_coros_login_network_error_returns_400(app_env):
    client, token, _, _ = app_env

    import httpx

    with patch(
        "coros_sync.client.CorosClient.login",
        side_effect=httpx.ConnectError("network down"),
    ):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "secret"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 400


def test_coros_login_no_auth_returns_401(app_env):
    client, _, _, _ = app_env
    resp = client.post(
        "/api/users/me/coros/login",
        json={"email": "user@example.com", "password": "secret"},
    )
    assert resp.status_code == 401


# --- onboarding/complete ---

def _set_onboarding(tmp_path, data: dict) -> None:
    p = tmp_path / USER_UUID / "onboarding.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data))


def test_complete_without_coros_ready_returns_400(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": False,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": None,
    })
    resp = client.post(
        "/api/users/me/onboarding/complete",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    assert "coros_ready" in resp.json()["detail"]


def test_complete_without_profile_ready_returns_400(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
    })
    resp = client.post(
        "/api/users/me/onboarding/complete",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    assert "profile_ready" in resp.json()["detail"]


def test_complete_with_both_flags_returns_running(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": None,
    })

    with patch("stride_server.routes.onboarding._run_background_sync"):
        resp = client.post(
            "/api/users/me/onboarding/complete",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 200
    assert resp.json()["state"] == "running"

    onboarding_file = tmp_path / USER_UUID / "onboarding.json"
    onboarding = json.loads(onboarding_file.read_text())
    assert onboarding["sync_state"] == "running"
    # completed_at is set ONLY after the background sync finishes successfully.
    assert onboarding["completed_at"] is None


def test_complete_already_complete_returns_already_complete(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": "2026-04-27T10:00:00+00:00",
        "sync_state": "done",
    })
    resp = client.post(
        "/api/users/me/onboarding/complete",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "already-complete"


def test_complete_background_sync_updates_state_to_done(app_env):
    """The background function updates onboarding.json to 'done' after sync."""
    client, token, tmp_path, mock_source = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": None,
    })

    import stride_server.routes.onboarding as ob_mod

    with patch.object(ob_mod, "USER_DATA_DIR", tmp_path):
        # Run background sync directly (synchronously) to verify state transitions
        ob_mod._run_background_sync(USER_UUID, mock_source)

    onboarding = json.loads((tmp_path / USER_UUID / "onboarding.json").read_text())
    assert onboarding["sync_state"] == "done"
    # completed_at is only stamped after a SUCCESSFUL sync.
    assert onboarding["completed_at"] is not None
    mock_source.sync_user.assert_called_once_with(USER_UUID, full=False)


def test_complete_background_sync_sets_error_on_failure(app_env):
    client, token, tmp_path, mock_source = app_env
    mock_source.sync_user.side_effect = RuntimeError("connection refused")
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": "running",
    })

    import stride_server.routes.onboarding as ob_mod

    with patch.object(ob_mod, "USER_DATA_DIR", tmp_path):
        ob_mod._run_background_sync(USER_UUID, mock_source)

    onboarding = json.loads((tmp_path / USER_UUID / "onboarding.json").read_text())
    assert onboarding["sync_state"] == "error"
    assert "connection refused" in onboarding["error"]
    # completed_at MUST stay null on error so re-POST is allowed.
    assert onboarding["completed_at"] is None
    assert onboarding["failed_at"] is not None


def test_repost_after_error_returns_running_not_already_complete(app_env):
    """Re-POST /onboarding/complete after a prior errored sync must retry,
    not short-circuit to 'already-complete'."""
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,           # error path keeps this null
        "sync_state": "error",
        "error": "connection refused",
        "failed_at": "2026-04-27T09:00:00+00:00",
    })

    with patch("stride_server.routes.onboarding._run_background_sync"):
        resp = client.post(
            "/api/users/me/onboarding/complete",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 200
    assert resp.json()["state"] == "running"

    onboarding = json.loads((tmp_path / USER_UUID / "onboarding.json").read_text())
    assert onboarding["sync_state"] == "running"
    assert onboarding["completed_at"] is None
    # Stale error/failed_at should be cleared on retry.
    assert "error" not in onboarding
    assert "failed_at" not in onboarding


def test_no_real_data_dir_leaked_on_background_sync(app_env, monkeypatch):
    """Regression: _run_background_sync must use the monkey-patched USER_DATA_DIR
    when generating the starter status (i.e., must pass data_root=...)."""
    client, token, tmp_path, mock_source = app_env

    import stride_server.routes.onboarding as ob_mod
    from stride_core import db as core_db_mod

    # Sentinel: track whether anything writes under the real (non-tmp) USER_DATA_DIR.
    real_dir = core_db_mod.USER_DATA_DIR
    leaked_dir = real_dir / USER_UUID
    leaked_pre = leaked_dir.exists()

    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": None,
    })

    with patch.object(ob_mod, "USER_DATA_DIR", tmp_path):
        ob_mod._run_background_sync(USER_UUID, mock_source)

    # tmp_path got the write; the real on-disk directory must NOT have been
    # newly created by the sync path.
    assert (tmp_path / USER_UUID / "onboarding.json").exists()
    if not leaked_pre:
        assert not leaked_dir.exists(), (
            f"_run_background_sync leaked into real data dir: {leaked_dir}"
        )


# --- sync-status ---

def test_sync_status_returns_state(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": "2026-04-27T10:00:00+00:00",
        "sync_state": "done",
    })
    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "done"


def test_sync_status_returns_error_when_present(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": "2026-04-27T10:00:00+00:00",
        "sync_state": "error",
        "error": "connection refused",
    })
    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["state"] == "error"
    assert data["error"] == "connection refused"


def test_sync_status_no_files_returns_none_state(app_env):
    client, token, _, _ = app_env
    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["state"] is None
