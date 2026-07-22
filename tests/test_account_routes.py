"""Tests for self-service account deletion."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.source import BaseDataSource, ProviderInfo

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


class _DummySource(BaseDataSource):
    def __init__(self) -> None:
        self.logout_calls: list[str] = []

    @property
    def info(self) -> ProviderInfo:
        return ProviderInfo(
            name="coros",
            display_name="COROS",
            regions=("cn",),
            capabilities=frozenset(),
        )

    def is_logged_in(self, user: str) -> bool:
        return True

    def logout(self, user: str) -> None:
        self.logout_calls.append(user)


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

    import stride_server.routes.account as account_mod
    monkeypatch.setattr(account_mod, "USER_DATA_DIR", tmp_path)

    from stride_core.registry import ProviderRegistry

    source = _DummySource()
    registry = ProviderRegistry()
    registry.register(source, default=True)

    from stride_server.bearer import require_bearer
    from stride_server.deps import get_registry
    from stride_server.routes.account import router

    app = FastAPI()
    app.state.registry = registry
    app.dependency_overrides[get_registry] = lambda: registry
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path, source


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class _FakeCoordinator:
    """In-memory stand-in for the account-deletion coordinator.

    Lets tests drive the fence / cancel / running-job seams without touching the
    real dev job stores under ``data/_jobs_dev``. ``running_seq`` is a list of
    return values for successive ``running_jobs`` calls (drives the drain loop).
    """

    def __init__(self, running_seq=None):
        self.fenced: set[str] = set()
        self.cancel_calls: list[str] = []
        self._running_seq = list(running_seq or [[]])

    def mark_deleting(self, user_id):
        self.fenced.add(user_id)

    def is_deleting(self, user_id):
        return user_id in self.fenced

    def cancel_active_pipeline_runs(self, user_id):
        self.cancel_calls.append(user_id)
        return 0

    def cancel_queued_jobs(self, user_id):
        return 0

    def running_jobs(self, user_id):
        if len(self._running_seq) > 1:
            return self._running_seq.pop(0)
        return self._running_seq[0]


@pytest.fixture
def fake_coordinator(monkeypatch):
    """Patch the route's account_deletion seam with an in-memory fake."""
    import stride_server.routes.account as account_mod
    import stride_server.sqlite_writer as writer

    writer.reset_for_tests()
    coord = _FakeCoordinator()
    monkeypatch.setattr(account_mod, "account_deletion", coord)
    monkeypatch.setattr(account_mod, "_JOB_DRAIN_INTERVAL_S", 0)
    monkeypatch.setattr(account_mod.content_store, "delete_prefix", lambda _user: 0)
    monkeypatch.setattr(
        account_mod.notification_store,
        "delete_user",
        lambda _user: 0,
        raising=False,
    )
    return coord


def test_delete_account_deletes_local_data_after_auth_delete(app_client, monkeypatch, fake_coordinator):
    client, token, tmp_path, source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "profile.json").write_text("{}")
    (user_dir / "coros.db").write_text("sqlite")
    seen: dict = {}

    async def fake_delete_my_account(bearer):
        seen["bearer"] = bearer

    import stride_server.auth_service_client as ac
    import stride_server.routes.account as account_mod
    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)

    class _WeeklyStore:
        def delete_user(self, user_id):
            seen["weekly_deleted"] = user_id
            return 1

    monkeypatch.setattr(account_mod, "get_weekly_plan_store", lambda: _WeeklyStore())
    monkeypatch.setattr(
        account_mod.notification_store,
        "delete_user",
        lambda user_id: seen.setdefault("notifications_deleted", user_id) and 4,
        raising=False,
    )
    monkeypatch.setattr(
        account_mod.content_store,
        "delete_prefix",
        lambda user_id: seen.setdefault("blob_deleted", user_id) and 2,
    )

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    assert not user_dir.exists()
    assert seen["bearer"] == token
    assert source.logout_calls == [USER_UUID]
    assert seen["weekly_deleted"] == USER_UUID
    assert seen["notifications_deleted"] == USER_UUID
    assert seen["blob_deleted"] == USER_UUID


def test_delete_account_keeps_local_data_when_auth_service_blocks(app_client, monkeypatch):
    client, token, tmp_path, source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "profile.json").write_text("{}")

    import stride_server.auth_service_client as ac

    async def fake_delete_my_account(_bearer):
        raise ac.AuthServiceError(409, "user owns teams")

    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 409
    assert user_dir.exists()
    assert source.logout_calls == []


def test_delete_account_finishes_local_cleanup_when_auth_account_is_already_gone(app_client, monkeypatch, fake_coordinator):
    client, token, tmp_path, source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "profile.json").write_text("{}")

    import stride_server.auth_service_client as ac

    async def fake_delete_my_account(_bearer):
        raise ac.AuthServiceError(401, "unauthorized")

    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    assert not user_dir.exists()
    assert source.logout_calls == [USER_UUID]


def test_delete_account_retries_rmtree_then_succeeds(app_client, monkeypatch, fake_coordinator):
    """A transient OSError from rmtree (SMB delayed-close) is ridden out."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")

    import stride_server.auth_service_client as ac
    import stride_server.routes.account as account_mod

    async def fake_delete_my_account(_bearer):
        return None

    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)
    monkeypatch.setattr(account_mod, "_RMTREE_BACKOFF_S", 0)

    real_rmtree = account_mod.shutil.rmtree
    calls = {"n": 0}

    def flaky_rmtree(path):
        calls["n"] += 1
        if calls["n"] < 3:
            raise OSError("device or resource busy")
        real_rmtree(path)

    monkeypatch.setattr(account_mod.shutil, "rmtree", flaky_rmtree)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    assert calls["n"] == 3
    assert not user_dir.exists()


def test_delete_account_returns_500_when_rmtree_keeps_failing(app_client, monkeypatch, fake_coordinator):
    """A persistent rmtree failure surfaces as 500 (no silent residue)."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")

    import stride_server.auth_service_client as ac
    import stride_server.routes.account as account_mod

    async def fake_delete_my_account(_bearer):
        return None

    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)
    monkeypatch.setattr(account_mod, "_RMTREE_BACKOFF_S", 0)

    def always_busy(_path):
        raise OSError("device or resource busy")

    monkeypatch.setattr(account_mod.shutil, "rmtree", always_busy)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 500
    assert user_dir.exists()


def test_delete_account_no_auth_returns_401(app_client):
    client, _, _, _ = app_client
    resp = client.delete("/api/users/me")
    assert resp.status_code == 401


def _ok_auth(monkeypatch):
    import stride_server.auth_service_client as ac

    async def ok(_bearer):
        return None

    monkeypatch.setattr(ac, "delete_my_account", ok)


def test_delete_account_fences_and_cancels_before_deleting(app_client, monkeypatch, fake_coordinator):
    """The durable fence is set and in-flight work cancelled before rmtree; the
    fence is NOT cleared by a successful delete."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    assert not user_dir.exists()
    assert fake_coordinator.is_deleting(USER_UUID)  # fence kept after delete
    assert fake_coordinator.cancel_calls == [USER_UUID]


def test_delete_account_waits_for_running_job_then_deletes(app_client, monkeypatch, fake_coordinator):
    """Directory survives while a job is RUNNING; once drained, delete proceeds."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    # Running for the first two polls, then drained.
    seen_dir_states: list[bool] = []
    orig_running = fake_coordinator.running_jobs

    def running_then_drain(user_id):
        seen_dir_states.append(user_dir.exists())
        if len(seen_dir_states) < 3:
            return ["job-1"]
        return []

    monkeypatch.setattr(fake_coordinator, "running_jobs", running_then_drain)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    # The directory still existed on every poll while the job was RUNNING.
    assert all(seen_dir_states[:2])
    assert not user_dir.exists()


def test_delete_account_returns_503_when_job_never_drains(app_client, monkeypatch, fake_coordinator):
    """If a RUNNING job never drains, the request 503s and the dir survives."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    import stride_server.routes.account as account_mod
    monkeypatch.setattr(account_mod, "_JOB_DRAIN_ATTEMPTS", 2)
    monkeypatch.setattr(fake_coordinator, "running_jobs", lambda u: ["stuck-job"])

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 503
    assert user_dir.exists()  # never deleted


def test_delete_account_returns_503_when_writer_lock_busy(app_client, monkeypatch, fake_coordinator):
    """A held writer lock (in-process sync) → 503, directory intact."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    import stride_server.routes.account as account_mod
    import stride_server.sqlite_writer as writer
    monkeypatch.setattr(account_mod, "_WRITER_LOCK_TIMEOUT_S", 0.05)

    # Hold the writer lock on a background thread for the whole request.
    import threading
    holding = threading.Event()
    release = threading.Event()

    def holder():
        with writer.hold_writer(USER_UUID):
            holding.set()
            release.wait(timeout=5)

    t = threading.Thread(target=holder)
    t.start()
    holding.wait(timeout=5)
    try:
        resp = client.delete("/api/users/me", headers=_auth(token))
    finally:
        release.set()
        t.join(timeout=5)

    assert resp.status_code == 503
    assert user_dir.exists()


def test_delete_account_returns_503_when_notification_cleanup_fails(
    app_client, monkeypatch, fake_coordinator,
):
    """Notification partition cleanup failure keeps local data for retry."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    import stride_server.routes.account as account_mod

    def fail_notification_cleanup(_user_id):
        raise RuntimeError("notification storage unavailable")

    monkeypatch.setattr(
        account_mod.notification_store,
        "delete_user",
        fail_notification_cleanup,
        raising=False,
    )

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 503
    assert user_dir.exists()
    assert fake_coordinator.is_deleting(USER_UUID)


def test_delete_account_returns_503_when_blob_cleanup_fails(
    app_client, monkeypatch, fake_coordinator,
):
    """Blob cleanup failure keeps local data intact for an idempotent retry."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    import stride_server.routes.account as account_mod

    def fail_blob_cleanup(_user_id):
        raise RuntimeError("blob storage unavailable")

    monkeypatch.setattr(
        account_mod.content_store,
        "delete_prefix",
        fail_blob_cleanup,
    )

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 503
    assert user_dir.exists()
    assert fake_coordinator.is_deleting(USER_UUID)


def test_delete_account_returns_503_when_coordination_store_fails(app_client, monkeypatch, fake_coordinator):
    """A coordination-store outage aborts the delete (503) without rmtree."""
    client, token, tmp_path, _source = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "coros.db").write_text("sqlite")
    _ok_auth(monkeypatch)

    def boom(user_id):
        raise RuntimeError("table storage down")

    monkeypatch.setattr(fake_coordinator, "mark_deleting", boom)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 503
    assert user_dir.exists()


def test_delete_account_rejects_invalid_subject_before_auth_delete(app_client, rsa_keypair, monkeypatch):
    client, _, _, _ = app_client
    private_pem, _ = rsa_keypair
    token = _make_token(private_pem, sub="not-a-uuid")

    import stride_server.auth_service_client as ac

    delete_my_account = AsyncMock()
    monkeypatch.setattr(ac, "delete_my_account", delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 400
    delete_my_account.assert_not_called()
