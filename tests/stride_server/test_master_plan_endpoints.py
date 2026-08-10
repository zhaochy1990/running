"""Tests for POST /api/users/me/master-plan/generate and
GET /api/users/me/master-plan/jobs/{job_id} (T12)."""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_server.job_runner import _reset_jobs_for_tests

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"

# A minimal valid training goal (matches TrainingGoal model requirements)
VALID_GOAL: dict[str, Any] = {
    "goal_id": "g1b2c3d4-e5f6-4aaa-89ab-123456789012",
    "type": "health",
    "weekly_training_days": 4,
    "available_time_slots": ["morning"],
    "strength_willingness": "yes",
    "created_at": "2026-05-12T10:00:00+00:00",
    "updated_at": "2026-05-12T10:00:00+00:00",
}

VALID_GOAL_STORE = {"current": VALID_GOAL, "history": []}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


def _token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def reset_jobs():
    """Clear job store before and after each test."""
    _reset_jobs_for_tests()
    yield
    _reset_jobs_for_tests()


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
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)

    # Point content_store file reads to tmp_path. The read/write primitives
    # now live in stride_storage.content.store (exposed as cs_mod._store);
    # patch _file_path there so the facade's delegated calls pick it up.
    import stride_server.content_store as cs_mod
    monkeypatch.setattr(cs_mod._store, "_file_path", lambda rel: tmp_path / rel)

    from stride_server.bearer import require_bearer
    from stride_server.routes.master_plan import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _write_goal(tmp_path, user_id: str = USER_UUID, goal_store: dict | None = None) -> None:
    """Write a training_goal.json for the given user under tmp_path."""
    import json
    user_dir = tmp_path / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / "training_goal.json").write_text(
        json.dumps(goal_store or VALID_GOAL_STORE), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Stub run_generate_job so tests don't actually sleep 2s
# ---------------------------------------------------------------------------

def _stub_noop(job_id, user_id, goal, profile):
    """Do nothing — job stays QUEUED in tests (fast)."""
    pass


# ---------------------------------------------------------------------------
# Test 1: POST generate with valid goal → 201 with job_id
# ---------------------------------------------------------------------------


def test_generate_with_goal_returns_201(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    _write_goal(tmp_path)

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    resp = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert "job_id" in data
    assert data["status"] == "queued"
    assert "eta_seconds" in data


# ---------------------------------------------------------------------------
# Test 2: POST generate without training goal → 422
# ---------------------------------------------------------------------------


def test_generate_without_goal_returns_422(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    # Do NOT write goal — content_store returns None

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    resp = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert resp.status_code == 422, resp.text
    assert "训练目标未设置" in resp.text


# ---------------------------------------------------------------------------
# Test 3: POST generate with nonexistent goal_id → 404
# ---------------------------------------------------------------------------


def test_generate_with_nonexistent_goal_id_returns_404(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    _write_goal(tmp_path)  # goal exists but with different goal_id

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    resp = client.post(
        "/api/users/me/master-plan/generate",
        json={"goal_id": "nonexistent-goal-id-0000-000000000000"},
        headers=_auth(token),
    )
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# Test 4: POST generate when running job exists → 200 with existing job_id (idempotent)
# ---------------------------------------------------------------------------


def test_generate_idempotent_when_running_job_exists(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    _write_goal(tmp_path)

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    # First request — creates job
    resp1 = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert resp1.status_code == 201, resp1.text
    job_id_1 = resp1.json()["job_id"]

    # Second request — should return existing job (200, not 201)
    resp2 = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert resp2.status_code == 200, resp2.text
    data2 = resp2.json()
    assert data2["job_id"] == job_id_1
    assert data2["status"] in ("queued", "running")


# ---------------------------------------------------------------------------
# Test 5: GET jobs/{job_id} → 200 with stage_label and elapsed_seconds
# ---------------------------------------------------------------------------


def test_get_job_status_returns_200(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    _write_goal(tmp_path)

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    # Create a job first
    create_resp = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert create_resp.status_code == 201
    job_id = create_resp.json()["job_id"]

    # Poll status
    resp = client.get(
        f"/api/users/me/master-plan/jobs/{job_id}",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["job_id"] == job_id
    assert data["status"] in ("queued", "running", "done")
    assert "stage_label" in data
    assert "elapsed_seconds" in data
    assert isinstance(data["elapsed_seconds"], int)
    assert data["elapsed_seconds"] >= 0
    assert "created_at" in data
    # created_at must be ISO 8601
    from datetime import datetime
    datetime.fromisoformat(data["created_at"])  # should not raise


# ---------------------------------------------------------------------------
# Test 6: GET jobs/{unknown} → 404
# ---------------------------------------------------------------------------


def test_get_job_unknown_returns_404(app_client):
    client, token, _, _ = app_client

    resp = client.get(
        "/api/users/me/master-plan/jobs/nonexistent-job-id",
        headers=_auth(token),
    )
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# Test 7: GET jobs/{other_user_job} → 403
# ---------------------------------------------------------------------------


def test_get_job_other_user_returns_403(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, private_pem = app_client
    _write_goal(tmp_path)

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    # USER_UUID creates a job
    create_resp = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert create_resp.status_code == 201
    job_id = create_resp.json()["job_id"]

    # OTHER_UUID tries to poll it
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.get(
        f"/api/users/me/master-plan/jobs/{job_id}",
        headers=_auth(other_token),
    )
    assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Test 8: stage_label is empty when stage is None (QUEUED)
# ---------------------------------------------------------------------------


def test_get_job_stage_label_empty_when_no_stage(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    _write_goal(tmp_path)

    import stride_server.routes.master_plan as mp_mod
    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", _stub_noop)

    create_resp = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    job_id = create_resp.json()["job_id"]

    resp = client.get(
        f"/api/users/me/master-plan/jobs/{job_id}",
        headers=_auth(token),
    )
    data = resp.json()
    # Job was just created with stage=None (QUEUED), stub did nothing
    if data["stage"] is None:
        assert data["stage_label"] == ""


# ---------------------------------------------------------------------------
# Test 9: raw_output only exposed when status=FAILED
# ---------------------------------------------------------------------------


def test_raw_output_only_on_failure(app_client, tmp_path, monkeypatch):
    client, token, tmp_path, _ = app_client
    _write_goal(tmp_path)

    import stride_server.job_runner as jr_mod
    import stride_server.routes.master_plan as mp_mod

    def stub_fail(job_id, user_id, goal, profile):
        jr_mod.update_job(
            job_id,
            status=jr_mod.JobStatus.FAILED,
            error="parse error",
            raw_output="some raw llm text",
            progress=85,
        )

    monkeypatch.setattr(mp_mod.master_plan_generator, "run_generate_job", stub_fail)

    create_resp = client.post(
        "/api/users/me/master-plan/generate",
        json={},
        headers=_auth(token),
    )
    assert create_resp.status_code == 201
    job_id = create_resp.json()["job_id"]

    # Wait briefly for the thread to complete
    time.sleep(0.2)

    resp = client.get(
        f"/api/users/me/master-plan/jobs/{job_id}",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "failed"
    assert data["raw_output"] == "some raw llm text"
    assert data["error"] == "parse error"
