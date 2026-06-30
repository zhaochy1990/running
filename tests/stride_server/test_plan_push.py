"""Tests for POST /api/{user}/plan/{folder}/push (T22 — whole-week push).

Scenarios covered:
- dry_run=true: returns preview items, push_single_session NOT called
- 6 sessions all succeed: success_count=6, failed_count=0
- partial failure: success_count=4, failed_count=2
- rate-limit sleep: time.sleep called between pushes (not before first)
- folder not found → 404
- invalid folder format → 400
- user mismatch → 403
- no token → 401
"""

from __future__ import annotations

import json
import time
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.plan_spec import PlannedSession, SessionKind

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"
FOLDER = "2026-05-11_05-17"


# ── RSA key helpers ───────────────────────────────────────────────────────────


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


# ── Mock DataSource ───────────────────────────────────────────────────────────


def _make_mock_source():
    """Return a MagicMock that looks enough like a DataSource for push_week."""
    from stride_core.source import Capability, ProviderInfo

    source = MagicMock()
    source.info = ProviderInfo(
        name="mock",
        display_name="Mock",
        regions=("global",),
        capabilities=frozenset({
            Capability.PUSH_RUN_WORKOUT,
            Capability.PUSH_STRENGTH_WORKOUT,
            Capability.DELETE_WORKOUT,
        }),
    )
    source.push_run_workout.return_value = "mock-provider-id"
    source.push_strength_workout.return_value = "mock-provider-id"
    source.delete_scheduled_workout.return_value = None
    return source


# ── App fixture ───────────────────────────────────────────────────────────────


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    """FastAPI test client with bearer auth + tmp SQLite DB + mock DataSource."""
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

    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_core.registry import ProviderRegistry
    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.generate import router

    mock_source = _make_mock_source()
    registry = ProviderRegistry()
    registry.register(mock_source, default=True)

    app = FastAPI()
    app.state.registry = registry
    app.state.source = mock_source
    app.include_router(
        router,
        dependencies=[Depends(require_bearer), Depends(verify_path_user)],
    )

    # raise_server_exceptions=True so HTTPException → real HTTP status codes
    client = TestClient(app, raise_server_exceptions=True)
    token = _make_token(private_pem)
    return client, token, tmp_path, private_pem


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _push_url(folder: str = FOLDER, dry_run: bool = False) -> str:
    url = f"/api/{USER_UUID}/plan/{folder}/push"
    if dry_run:
        url += "?dry_run=true"
    return url


# ── DB seeding helper ─────────────────────────────────────────────────────────


def _seed_sessions(tmp_path, n: int = 6, kind: str = "run") -> None:
    """Insert n planned sessions (with spec_json) + a weekly_plan row."""
    import stride_core.db as core_db_mod

    core_db_mod.USER_DATA_DIR = tmp_path  # ensure correct path

    from stride_storage.sqlite.database import Database

    db = Database(user=USER_UUID)

    # weekly_plan PK is 'week' (not 'week_folder')
    db._conn.execute(
        """INSERT OR REPLACE INTO weekly_plan
           (week, content_md, structured_status, structured_source,
            generated_by, created_at, updated_at)
           VALUES (?, '', 'authored', 'authored', 'test',
                   datetime('now'), datetime('now'))""",
        (FOLDER,),
    )

    for i in range(n):
        # Use dates within the folder range (2026-05-11 to 2026-05-17)
        day = 11 + i
        date = f"2026-05-{day:02d}"
        spec = {"name": f"Session {i}", "date": date, "blocks": []}
        db._conn.execute(
            """INSERT OR REPLACE INTO planned_session
               (week_folder, date, session_index, kind, summary,
                spec_json, notes_md, total_distance_m, total_duration_s,
                scheduled_workout_id, created_at, updated_at)
               VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, NULL, NULL,
                       datetime('now'), datetime('now'))""",
            (FOLDER, date, kind, f"E {i}K 轻松跑", json.dumps(spec)),
        )
    db._conn.commit()
    db.close()


# ── Tests: dry_run ────────────────────────────────────────────────────────────


class TestDryRun:
    """dry_run=true: preview items returned, push NOT called."""

    def test_returns_200(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=6)
        client, token, _, _ = app_client
        resp = client.post(_push_url(dry_run=True), headers=_auth(token))
        assert resp.status_code == 200, resp.text

    def test_success_count_zero(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=6)
        client, token, _, _ = app_client
        data = client.post(_push_url(dry_run=True), headers=_auth(token)).json()
        assert data["success_count"] == 0
        assert data["failed_count"] == 0
        assert data["dry_run"] is True

    def test_results_count_matches_total(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=4)
        client, token, _, _ = app_client
        data = client.post(_push_url(dry_run=True), headers=_auth(token)).json()
        assert data["total"] == 4
        assert len(data["results"]) == 4

    def test_push_single_session_not_called(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=3)
        client, token, _, _ = app_client
        with patch("stride_server.routes.generate.push_single_session") as mock_push:
            resp = client.post(_push_url(dry_run=True), headers=_auth(token))
        assert resp.status_code == 200, resp.text
        mock_push.assert_not_called()

    def test_result_items_have_null_success(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=2)
        client, token, _, _ = app_client
        data = client.post(_push_url(dry_run=True), headers=_auth(token)).json()
        for item in data["results"]:
            assert item["success"] is None


# ── Tests: all success ────────────────────────────────────────────────────────


class TestAllSuccess:
    """All 6 sessions pushed successfully."""

    def _ok_push(self, user, date, session_index, source, db, plan_store):
        return {
            "session_id": 1,
            "date": date,
            "session_index": session_index,
            "kind": "run",
            "summary": "E 轻松跑",
            "success": True,
            "scheduled_workout_id": 99,
            "provider_workout_id": "PW99",
            "error": None,
        }

    def test_success_count_6(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=6)
        client, token, _, _ = app_client
        with patch("stride_server.routes.generate.push_single_session",
                   side_effect=self._ok_push):
            resp = client.post(_push_url(), headers=_auth(token))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success_count"] == 6
        assert data["failed_count"] == 0
        assert len(data["results"]) == 6

    def test_ok_true(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=2)
        client, token, _, _ = app_client
        with patch("stride_server.routes.generate.push_single_session",
                   side_effect=self._ok_push):
            data = client.post(_push_url(), headers=_auth(token)).json()
        assert data["ok"] is True

    def test_folder_echoed(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=2)
        client, token, _, _ = app_client
        with patch("stride_server.routes.generate.push_single_session",
                   side_effect=self._ok_push):
            data = client.post(_push_url(), headers=_auth(token)).json()
        assert data["folder"] == FOLDER


# ── Tests: partial failure ────────────────────────────────────────────────────


class TestPartialFailure:
    """4 succeed, 2 fail — endpoint still returns 200 with mixed results."""

    def _make_mixed_push(self, fail_indices: set):
        call_count = {"n": 0}

        def _push(user, date, session_index, source, db, plan_store):
            idx = call_count["n"]
            call_count["n"] += 1
            if idx in fail_indices:
                return {
                    "session_id": idx + 1,
                    "date": date,
                    "session_index": session_index,
                    "kind": "run",
                    "summary": "fail",
                    "success": False,
                    "scheduled_workout_id": None,
                    "provider_workout_id": None,
                    "error": "COROS rate limit",
                }
            return {
                "session_id": idx + 1,
                "date": date,
                "session_index": session_index,
                "kind": "run",
                "summary": "ok",
                "success": True,
                "scheduled_workout_id": 100 + idx,
                "provider_workout_id": None,
                "error": None,
            }

        return _push

    def test_partial_counts(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=6)
        mixed = self._make_mixed_push(fail_indices={1, 3})
        with patch("stride_server.routes.generate.push_single_session", side_effect=mixed):
            client, token, _, _ = app_client
            resp = client.post(_push_url(), headers=_auth(token))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success_count"] == 4
        assert data["failed_count"] == 2

    def test_failed_items_have_error(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=4)
        mixed = self._make_mixed_push(fail_indices={0, 2})
        with patch("stride_server.routes.generate.push_single_session", side_effect=mixed):
            client, token, _, _ = app_client
            data = client.post(_push_url(), headers=_auth(token)).json()
        failed = [r for r in data["results"] if not r["success"]]
        assert len(failed) == 2
        for f in failed:
            assert f["error"] is not None

    def test_status_200_despite_failure(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=3)
        # All fail
        mixed = self._make_mixed_push(fail_indices={0, 1, 2})
        with patch("stride_server.routes.generate.push_single_session", side_effect=mixed):
            client, token, _, _ = app_client
            resp = client.post(_push_url(), headers=_auth(token))
        assert resp.status_code == 200


# ── Tests: rate limiting ──────────────────────────────────────────────────────


class TestRateLimit:
    """time.sleep called (n-1) times for n sessions."""

    def _ok_push(self, user, date, session_index, source, db, plan_store):
        return {"session_id": 1, "date": date, "session_index": session_index,
                "kind": "run", "summary": "x", "success": True,
                "scheduled_workout_id": 1, "provider_workout_id": None, "error": None}

    def test_sleep_called_between_pushes(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=3)
        client, token, _, _ = app_client
        with patch("stride_server.routes.generate.push_single_session",
                   side_effect=self._ok_push), \
             patch("stride_server.routes.generate.time") as mock_time:
            mock_time.sleep = MagicMock()
            resp = client.post(_push_url(), headers=_auth(token))
        assert resp.status_code == 200, resp.text
        # For 3 sessions: sleep called 2 times (between session 0→1 and 1→2)
        assert mock_time.sleep.call_count == 2

    def test_no_sleep_for_single_session(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        _seed_sessions(tmp_path, n=1)
        client, token, _, _ = app_client
        with patch("stride_server.routes.generate.push_single_session",
                   side_effect=self._ok_push), \
             patch("stride_server.routes.generate.time") as mock_time:
            mock_time.sleep = MagicMock()
            resp = client.post(_push_url(), headers=_auth(token))
        assert resp.status_code == 200, resp.text
        # Only 1 session → zero sleeps
        assert mock_time.sleep.call_count == 0


# ── Tests: 404 / 400 ─────────────────────────────────────────────────────────


class TestNotFound:
    """Folder with no sessions returns 404; invalid folder format returns 400."""

    def test_empty_folder_404(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, token, _, _ = app_client
        # No sessions seeded — Starlette converts HTTPException to a response;
        # raise_server_exceptions=True only re-raises *unhandled* exceptions, not HTTP errors.
        resp = client.post(_push_url(folder=FOLDER), headers=_auth(token))
        assert resp.status_code == 404

    def test_invalid_folder_400(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, token, _, _ = app_client
        resp = client.post(
            f"/api/{USER_UUID}/plan/not-a-folder/push",
            headers=_auth(token),
        )
        assert resp.status_code == 400


# ── Tests: auth enforcement ───────────────────────────────────────────────────


class TestAuthEnforcement:
    """Bearer + path-user enforcement — these work with raise_server_exceptions=True
    because auth errors are handled by FastAPI's exception handlers (not unhandled)."""

    def test_no_token_returns_401(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, _, _, _ = app_client
        resp = client.post(_push_url())
        assert resp.status_code == 401

    def test_user_mismatch_returns_403(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, _, _, private_pem = app_client
        other_token = _make_token(private_pem, sub=OTHER_UUID)
        resp = client.post(
            f"/api/{USER_UUID}/plan/{FOLDER}/push",
            headers=_auth(other_token),
        )
        assert resp.status_code == 403
