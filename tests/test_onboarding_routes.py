"""Tests for /api/users/me/coros/login, /onboarding/complete, /sync-status."""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from stride_server.config.models import AuthConfig, ServerConfig, SyncConfig

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


def test_sync_stale_after_uses_config() -> None:
    from stride_server.routes.onboarding import sync_stale_after_seconds_from_config

    assert sync_stale_after_seconds_from_config(SyncConfig(stale_after_seconds=42)) == 42


def test_sync_stale_after_fallback_config_is_uncached(monkeypatch: pytest.MonkeyPatch) -> None:
    from stride_server.config import clear_server_config_cache, load_server_config
    from stride_server.routes.onboarding import _sync_stale_after_seconds

    monkeypatch.delenv("STRIDE_SYNC_STALE_AFTER_SECONDS", raising=False)
    clear_server_config_cache()
    load_server_config()

    monkeypatch.setenv("STRIDE_SYNC_STALE_AFTER_SECONDS", "999")

    assert _sync_stale_after_seconds() == 999.0
    clear_server_config_cache()


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

    import stride_server.jobs.account_deletion as account_deletion
    import stride_server.routes.onboarding as ob_mod
    from stride_core import db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(account_deletion, "is_deleting", lambda _uuid: False)

    def fake_start_pipeline(uuid: str) -> str:
        state = ob_mod._read_onboarding(uuid)
        now = ob_mod._utcnow_iso()
        state.update({
            "onboarding_pipeline_run_id": "run-1",
            "sync_state": "running",
            "completed_at": None,
            "sync_progress": {
                "phase": "queued",
                "message": "正在同步健康数据，马上就好",
                "percent": 0,
                "started_at": now,
                "updated_at": now,
            },
            "full_sync_state": "running",
            "full_sync_progress": {
                "phase": "queued",
                "message": "健康同步后将继续同步历史训练数据",
                "percent": 0,
                "started_at": now,
                "updated_at": now,
            },
        })
        state.pop("error", None)
        state.pop("failed_at", None)
        state.pop("full_sync_error", None)
        state.pop("full_sync_failed_at", None)
        ob_mod._write_onboarding(uuid, state)
        return "run-1"

    monkeypatch.setattr(ob_mod, "_start_onboarding_pipeline", fake_start_pipeline)
    monkeypatch.delenv("STRIDE_CONTENT_BLOB_ACCOUNT_URL", raising=False)
    monkeypatch.delenv("STRIDE_CONTENT_BLOB_CONTAINER", raising=False)

    # Minimal DataSource mock used as both `app.state.source` (back-compat
    # for /onboarding/complete which still goes through Depends(get_source))
    # and as the 'coros' adapter in the registry (used by /coros/login).
    mock_source = MagicMock()
    mock_source.sync_user.return_value = MagicMock(activities=5, health=7)
    # The login route uses registry.get('coros') and then calls .login();
    # tests that patch CorosClient.login at the deeper layer expect a real
    # CorosDataSource on the registry. Build that.
    from coros_sync.adapter import CorosDataSource
    from stride_core.registry import ProviderRegistry

    registry = ProviderRegistry()
    registry.register(CorosDataSource(), default=True)

    from stride_server.bearer import require_bearer

    app = FastAPI()
    app.state.config = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(public_key_pem=public_pem)
    )

    # Inject mock source + real registry via app state (mirrors real app factory)
    app.state.source = mock_source
    app.state.registry = registry
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


def test_coros_login_rejected_when_account_deleting(app_env, monkeypatch):
    """A fenced user (account deletion in progress) is refused watch-login with
    410 Gone, and the COROS client is never called (no pipeline / credentials)."""
    client, token, _, _ = app_env

    import stride_server.jobs.account_deletion as coord
    monkeypatch.setattr(coord, "is_deleting", lambda uuid: True)

    login = MagicMock()
    with patch("coros_sync.client.CorosClient.login", login):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "secret"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 410
    login.assert_not_called()


def test_coros_login_returns_503_when_deletion_fence_is_unavailable(
    app_env, monkeypatch,
):
    """Unknown deletion state must fail closed before credentials are written."""
    client, token, _, _ = app_env

    import stride_server.jobs.account_deletion as coord

    def unavailable(_uuid):
        raise RuntimeError("pipeline store unavailable")

    monkeypatch.setattr(coord, "is_deleting", unavailable)
    login = MagicMock()
    with patch("coros_sync.client.CorosClient.login", login):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "secret"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 503
    login.assert_not_called()


def test_coros_login_rechecks_fence_after_acquiring_writer_lock(
    app_env, monkeypatch,
):
    """A fence landing after the first check still blocks credential writes."""
    client, token, _, _ = app_env

    import stride_server.jobs.account_deletion as coord

    checks = iter((False, True))
    monkeypatch.setattr(coord, "is_deleting", lambda _uuid: next(checks))
    login = MagicMock()
    with patch("coros_sync.client.CorosClient.login", login):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "secret"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 410
    login.assert_not_called()


def test_coros_login_stops_when_fence_lands_during_provider_login(
    app_env, monkeypatch,
):
    """A deletion that starts during provider auth wins before onboarding writes."""
    client, token, tmp_path, _ = app_env

    import stride_server.jobs.account_deletion as coord

    checks = iter((False, False, True))
    monkeypatch.setattr(coord, "is_deleting", lambda _uuid: next(checks))
    mock_creds = MagicMock(region="global", user_id="coros-12345")
    with patch("coros_sync.client.CorosClient.login", return_value=mock_creds):
        resp = client.post(
            "/api/users/me/coros/login",
            json={"email": "user@example.com", "password": "secret"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 410
    assert not (tmp_path / USER_UUID / "onboarding.json").exists()


def test_garmin_login_rejected_when_account_deleting(app_env, monkeypatch):
    """Mirror of the COROS guard for the Garmin login route."""
    client, token, _, _ = app_env

    import stride_server.jobs.account_deletion as coord
    monkeypatch.setattr(coord, "is_deleting", lambda uuid: True)

    resp = client.post(
        "/api/users/me/garmin/login",
        json={"email": "user@example.com", "password": "secret", "region": "cn"},
        headers={"Authorization": f"Bearer {token}"},
    )

    # 410 fence rejection, or 500 if garmin adapter isn't registered — either
    # way it must NOT be a 200 success. The fence check runs before adapter
    # lookup, so 410 is expected here.
    assert resp.status_code == 410


# --- onboarding/complete ---


def test_complete_rejected_when_account_deleting(app_env, monkeypatch):
    """A stale JWT cannot enqueue sync or recreate onboarding state after delete."""
    client, token, tmp_path, mock_source = app_env

    import stride_server.jobs.account_deletion as coord

    monkeypatch.setattr(coord, "is_deleting", lambda _uuid: True)
    resp = client.post(
        "/api/users/me/onboarding/complete",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 410
    mock_source.sync_user.assert_not_called()
    assert not (tmp_path / USER_UUID).exists()


def test_full_sync_rejected_when_account_deleting(app_env, monkeypatch):
    """A stale JWT cannot enqueue a full sync after account deletion."""
    client, token, tmp_path, mock_source = app_env

    import stride_server.jobs.account_deletion as coord

    monkeypatch.setattr(coord, "is_deleting", lambda _uuid: True)
    resp = client.post(
        "/api/users/me/full-sync",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 410
    mock_source.sync_user.assert_not_called()
    assert not (tmp_path / USER_UUID).exists()


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


def test_complete_without_profile_ready_still_succeeds(app_env):
    """profile_ready is no longer required — onboarding only needs coros_ready.

    Race goals are collected later in the training plan setup page.
    """
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
    assert resp.status_code == 200
    assert resp.json()["state"] == "running"


def test_complete_with_both_flags_returns_running(app_env):
    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": None,
    })

    resp = client.post(
        "/api/users/me/onboarding/complete",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["state"] == "running"
    assert data["progress"]["phase"] == "queued"
    assert data["progress"]["percent"] == 0

    onboarding_file = tmp_path / USER_UUID / "onboarding.json"
    onboarding = json.loads(onboarding_file.read_text())
    assert onboarding["sync_state"] == "running"
    assert onboarding["sync_progress"]["phase"] == "queued"
    assert onboarding["completed_at"] is None
    # The API process only starts the worker pipeline; it never writes SQLite.
    app_env[3].sync_user.assert_not_called()


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


def test_sync_status_projects_completed_health_job_to_content_store(
    app_env, monkeypatch,
):
    import stride_server.jobs as jobs_module
    from stride_server.routes import onboarding as ob_mod
    from stride_storage.interfaces.jobs import (
        JobRecord,
        JobStatus,
        PipelineRunRecord,
    )

    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "onboarding_pipeline_run_id": "run-1",
        "sync_state": "running",
    })
    run = PipelineRunRecord(
        run_id="run-1",
        partition_key=USER_UUID,
        pipeline_name="onboarding",
        status=JobStatus.RUNNING,
        current_step="full_sync",
        steps_json=json.dumps([
            {"name": "health_sync", "status": "done", "job_id": "health-1"},
            {"name": "full_sync", "status": "queued", "job_id": "full-1"},
        ]),
        updated_at="2026-07-22T00:00:00Z",
    )
    jobs = {
        "health-1": JobRecord(
            job_id="health-1",
            partition_key=USER_UUID,
            job_type="onboarding_health_sync",
            status=JobStatus.DONE,
            result_json=json.dumps({"activities": 0, "health": 7}),
            completed_at="2026-07-22T00:00:01Z",
        ),
        "full-1": JobRecord(
            job_id="full-1",
            partition_key=USER_UUID,
            job_type="onboarding_full_sync",
            status=JobStatus.QUEUED,
            heartbeat_at="2026-07-22T00:00:02Z",
        ),
    }
    monkeypatch.setattr(
        ob_mod,
        "_pipeline_run_store",
        lambda: SimpleNamespace(get=lambda _user, _run: run),
    )
    fake_client = SimpleNamespace(get=lambda _user, job_id: jobs.get(job_id))
    monkeypatch.setattr(jobs_module, "get_job_client", lambda: fake_client)

    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    assert resp.json()["state"] == "done"
    assert resp.json()["progress"]["synced_health"] == 7
    stored = json.loads((tmp_path / USER_UUID / "onboarding.json").read_text())
    assert stored["completed_at"] == "2026-07-22T00:00:01Z"


def test_sync_status_does_not_recreate_content_after_account_delete(
    app_env, monkeypatch,
):
    """A status request admitted before DELETE must not write after cleanup."""
    import stride_server.jobs as jobs_module
    import stride_server.jobs.account_deletion as account_deletion
    import stride_server.sqlite_writer as writer
    from stride_server.routes import onboarding as ob_mod
    from stride_storage.interfaces.jobs import (
        JobRecord,
        JobStatus,
        PipelineRunRecord,
    )

    client, token, tmp_path, _ = app_env
    user_dir = tmp_path / USER_UUID
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "onboarding_pipeline_run_id": "run-1",
        "sync_state": "running",
    })
    run = PipelineRunRecord(
        run_id="run-1",
        partition_key=USER_UUID,
        pipeline_name="onboarding",
        status=JobStatus.RUNNING,
        current_step="full_sync",
        steps_json=json.dumps([
            {"name": "health_sync", "status": "done", "job_id": "health-1"},
            {"name": "full_sync", "status": "queued", "job_id": "full-1"},
        ]),
        updated_at="2026-07-22T00:00:00Z",
    )
    jobs = {
        "health-1": JobRecord(
            job_id="health-1",
            partition_key=USER_UUID,
            job_type="onboarding_health_sync",
            status=JobStatus.DONE,
            result_json=json.dumps({"activities": 0, "health": 7}),
            completed_at="2026-07-22T00:00:01Z",
        ),
        "full-1": JobRecord(
            job_id="full-1",
            partition_key=USER_UUID,
            job_type="onboarding_full_sync",
            status=JobStatus.QUEUED,
        ),
    }
    monkeypatch.setattr(
        ob_mod,
        "_pipeline_run_store",
        lambda: SimpleNamespace(get=lambda _user, _run: run),
    )
    monkeypatch.setattr(
        jobs_module,
        "get_job_client",
        lambda: SimpleNamespace(get=lambda _user, job_id: jobs.get(job_id)),
    )

    read_complete = threading.Event()
    resume_status = threading.Event()
    real_read = ob_mod._read_onboarding

    def pause_after_read(uuid: str):
        onboarding = real_read(uuid)
        read_complete.set()
        assert resume_status.wait(timeout=5)
        return onboarding

    monkeypatch.setattr(ob_mod, "_read_onboarding", pause_after_read)
    writer.reset_for_tests()
    response: dict[str, object] = {}

    def poll_status() -> None:
        response["value"] = client.get(
            "/api/users/me/sync-status",
            headers={"Authorization": f"Bearer {token}"},
        )

    thread = threading.Thread(target=poll_status)
    thread.start()
    assert read_complete.wait(timeout=5)

    monkeypatch.setattr(account_deletion, "is_deleting", lambda _uuid: True)
    with writer.acquire_writer_for_delete(USER_UUID, timeout_s=1) as acquired:
        assert acquired is True
        shutil.rmtree(user_dir)

    resume_status.set()
    thread.join(timeout=5)
    assert not thread.is_alive()

    resp = response["value"]
    assert getattr(resp, "status_code") == 410
    assert not user_dir.exists()


def test_full_sync_status_projects_completed_pipeline_to_content_store(
    app_env, monkeypatch,
):
    import stride_server.jobs as jobs_module
    from stride_server.routes import onboarding as ob_mod
    from stride_storage.interfaces.jobs import JobRecord, JobStatus, PipelineRunRecord

    client, token, tmp_path, _ = app_env
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "onboarding_pipeline_run_id": "run-1",
        "full_sync_state": "running",
    })
    run = PipelineRunRecord(
        run_id="run-1",
        partition_key=USER_UUID,
        pipeline_name="onboarding",
        status=JobStatus.DONE,
        current_step=None,
        steps_json=json.dumps([
            {"name": "health_sync", "status": "done", "job_id": "health-1"},
            {"name": "full_sync", "status": "done", "job_id": "full-1"},
            {"name": "calibration", "status": "done", "job_id": "cal-1"},
            {"name": "backfill", "status": "done", "job_id": "backfill-1"},
        ]),
        updated_at="2026-07-22T00:10:00Z",
        completed_at="2026-07-22T00:10:00Z",
    )
    jobs = {
        "health-1": JobRecord(
            job_id="health-1",
            partition_key=USER_UUID,
            job_type="onboarding_health_sync",
            status=JobStatus.DONE,
            result_json=json.dumps({"activities": 0, "health": 7}),
            completed_at="2026-07-22T00:00:01Z",
        ),
        "full-1": JobRecord(
            job_id="full-1",
            partition_key=USER_UUID,
            job_type="onboarding_full_sync",
            status=JobStatus.DONE,
            result_json=json.dumps({"activities": 24, "health": 7}),
            completed_at="2026-07-22T00:08:00Z",
        ),
    }
    monkeypatch.setattr(
        ob_mod,
        "_pipeline_run_store",
        lambda: SimpleNamespace(get=lambda _user, _run: run),
    )
    monkeypatch.setattr(
        jobs_module,
        "get_job_client",
        lambda: SimpleNamespace(get=lambda _user, job_id: jobs.get(job_id)),
    )

    resp = client.get(
        "/api/users/me/full-sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    assert resp.json()["state"] == "done"
    assert resp.json()["progress"]["synced_activities"] == 24
    stored = json.loads((tmp_path / USER_UUID / "onboarding.json").read_text())
    assert stored["full_sync_completed_at"] == "2026-07-22T00:10:00Z"


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


def test_sync_status_marks_stale_running_sync_as_error(app_env, monkeypatch):
    client, token, tmp_path, _ = app_env
    monkeypatch.setenv("STRIDE_SYNC_STALE_AFTER_SECONDS", "60")
    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": "running",
        "sync_progress": {
            "phase": "activity_details",
            "message": "正在同步训练详情：2024-10-10 健身 (474/962)",
            "percent": 52,
            "current": 474,
            "total": 962,
            "updated_at": "2026-01-01T00:00:00+00:00",
        },
    })

    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["state"] == "error"
    assert data["error"] == "同步任务已停止，请点击重试"
    assert data["progress"]["phase"] == "error"
    assert data["progress"]["failed_phase"] == "activity_details"
    assert data["progress"]["current"] == 474
    assert data["progress"]["total"] == 962

    onboarding = json.loads((tmp_path / USER_UUID / "onboarding.json").read_text())
    assert onboarding["sync_state"] == "error"
    assert onboarding["completed_at"] is None
    assert onboarding["failed_at"] is not None


def test_sync_status_keeps_recent_running_sync_running(app_env, monkeypatch):
    client, token, tmp_path, _ = app_env
    monkeypatch.setenv("STRIDE_SYNC_STALE_AFTER_SECONDS", "300")

    import stride_server.routes.onboarding as ob_mod

    _set_onboarding(tmp_path, {
        "coros_ready": True,
        "profile_ready": True,
        "completed_at": None,
        "sync_state": "running",
        "sync_progress": {
            "phase": "activity_details",
            "message": "正在同步训练详情",
            "percent": 52,
            "updated_at": ob_mod._utcnow_iso(),
        },
    })

    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["state"] == "running"
    assert data["progress"]["phase"] == "activity_details"


def test_sync_status_no_files_returns_none_state(app_env):
    client, token, _, _ = app_env
    resp = client.get(
        "/api/users/me/sync-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["state"] is None
