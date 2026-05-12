"""Tests for POST /api/{user}/plan/weeks/generate."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"

# A known Monday for testing
MONDAY = "2026-05-11"
# A known non-Monday (Tuesday)
TUESDAY = "2026-05-12"


# ── Fixtures ─────────────────────────────────────────────────────────────────


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

    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    # Create user directory so Database() can open the SQLite file
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.generate import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    token = _make_token(private_pem)
    return client, token, tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _post(client, token, body: dict, force: bool = False) -> object:
    url = f"/api/{USER_UUID}/plan/weeks/generate"
    if force:
        url += "?force=true"
    return client.post(url, json=body, headers=_auth(token))


# ── Tests ────────────────────────────────────────────────────────────────────


class TestNewUserDefaultKm:
    """Fresh user with no prior data → default 40 km, 7 sessions."""

    def test_status_200(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        assert resp.status_code == 200, resp.text

    def test_default_40km(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        data = resp.json()
        assert data["total_distance_km"] == 40.0

    def test_7_sessions(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        data = resp.json()
        assert data["sessions_count"] == 7

    def test_folder_format(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        data = resp.json()
        assert data["folder"] == "2026-05-11_05-17"

    def test_session_dates_span_week(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        data = resp.json()
        dates = [s["date"] for s in data["sessions"]]
        assert dates[0] == "2026-05-11"
        assert dates[-1] == "2026-05-17"

    def test_monday_is_rest(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        data = resp.json()
        monday_session = data["sessions"][0]
        assert monday_session["kind"] == "rest"

    def test_saturday_is_strength(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        data = resp.json()
        saturday_session = data["sessions"][5]
        assert saturday_session["kind"] == "strength"

    def test_source_echoed(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY, "source": "manual"})
        assert resp.json()["source"] == "manual"

    def test_sessions_persisted_in_db(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, token, _, _ = app_client
        _post(client, token, {"week_start": MONDAY})
        from stride_core.db import Database
        db = Database(user=USER_UUID)
        rows = db.query(
            "SELECT * FROM planned_session WHERE week_folder = ?",
            ("2026-05-11_05-17",),
        )
        db.close()
        assert len(rows) == 7


class TestProgressionFromLastWeek:
    """When last week has sessions, progression rules apply."""

    def _seed_last_week(self, tmp_path, monkeypatch, completed_km: float = 40.0):
        """Insert planned sessions + activities for the week of 2026-05-04."""
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        from stride_core.db import Database
        from stride_core.plan_spec import PlannedSession, SessionKind

        db = Database(user=USER_UUID)
        prev_folder = "2026-05-04_05-10"

        # Insert 6 run planned sessions for prev week
        sessions = []
        for i, day_str in enumerate(
            ["2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-10"]
        ):
            sessions.append(
                PlannedSession(
                    date=day_str,
                    session_index=0,
                    kind=SessionKind.RUN,
                    summary=f"E run day {i}",
                    total_distance_m=8000.0,
                )
            )
        db.upsert_planned_sessions(prev_folder, sessions)

        # Insert activities matching those dates (simulating completion).
        # activities.date is UTC ISO 8601 in prod (see stride_core/timefmt.py);
        # pick 08:00 UTC so the row is unambiguously inside the Shanghai day
        # named by `day_str` (16:00 Shanghai).
        for i, day_str in enumerate(
            ["2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-10"]
        ):
            day_iso = f"{day_str}T08:00:00+00:00"
            dist = (completed_km * 1000) / 5  # evenly split across 5 activities
            db._conn.execute(
                "INSERT OR REPLACE INTO activities "
                "(label_id, name, sport_type, date, distance_m, duration_s) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (f"A{i}", f"Run {i}", 100, day_iso, dist, dist * 0.3),
            )
        db._conn.commit()
        db.close()

    def test_good_week_increases_5pct(self, app_client, tmp_path, monkeypatch):
        """100% completion + low RPE → +5% distance."""
        import stride_core.db as core_db_mod
        import stride_server.deps as deps_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
        self._seed_last_week(tmp_path, monkeypatch, completed_km=40.0)

        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # 40km × 1.05 = 42km; round to nearest 0.5 → 42.0
        assert data["total_distance_km"] == pytest.approx(42.0, abs=0.5)

    def test_poor_completion_reduces_10pct(self, app_client, tmp_path, monkeypatch):
        """<60% completion → -10% distance."""
        import stride_core.db as core_db_mod
        import stride_server.deps as deps_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

        from stride_core.db import Database
        from stride_core.plan_spec import PlannedSession, SessionKind

        db = Database(user=USER_UUID)
        prev_folder = "2026-05-04_05-10"

        # 5 planned sessions but only 2 activities (40% completion)
        sessions = [
            PlannedSession(
                date=f"2026-05-0{5 + i}",
                session_index=0,
                kind=SessionKind.RUN,
                summary=f"E run {i}",
                total_distance_m=8000.0,
            )
            for i in range(5)
        ]
        db.upsert_planned_sessions(prev_folder, sessions)

        # Only 2 activities completed (40% of 5)
        for i in range(2):
            day_str = f"2026-05-0{5 + i}"
            day_compact = day_str.replace("-", "")
            db._conn.execute(
                "INSERT OR REPLACE INTO activities "
                "(label_id, name, sport_type, date, distance_m, duration_s) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (f"B{i}", f"Run {i}", 100, day_compact, 8000.0, 2400.0),
            )
        db._conn.commit()
        db.close()

        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # planned total = 5 × 8km = 40km; actual = 2 × 8km = 16km
        # completion 2/5 = 40% < 60% → use planned base 40km × 0.9 = 36km
        assert data["total_distance_km"] == pytest.approx(36.0, abs=0.5)


class TestValidation:
    """Input validation edge cases."""

    def test_non_monday_returns_400(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": TUESDAY})
        assert resp.status_code == 400
        assert "Monday" in resp.json()["detail"]

    def test_invalid_date_returns_400(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": "not-a-date"})
        assert resp.status_code == 400

    def test_explicit_base_distance_used(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY, "base_distance_km": 55.0})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_distance_km"] == pytest.approx(55.0, abs=0.5)


class TestConflictHandling:
    """Week already exists conflict + force override."""

    def test_existing_week_returns_409(self, app_client):
        client, token, _, _ = app_client
        # First call creates the week
        r1 = _post(client, token, {"week_start": MONDAY})
        assert r1.status_code == 200

        # Second call should 409
        r2 = _post(client, token, {"week_start": MONDAY})
        assert r2.status_code == 409
        detail = r2.json()["detail"]
        assert "week_already_exists" in str(detail)

    def test_force_overwrites_existing(self, app_client):
        client, token, _, _ = app_client
        # First call
        r1 = _post(client, token, {"week_start": MONDAY})
        assert r1.status_code == 200

        # Force overwrite
        r2 = _post(client, token, {"week_start": MONDAY}, force=True)
        assert r2.status_code == 200
        assert r2.json()["folder"] == "2026-05-11_05-17"

    def test_force_replaces_sessions_in_db(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, token, _, _ = app_client
        # Generate twice with force
        _post(client, token, {"week_start": MONDAY})
        _post(client, token, {"week_start": MONDAY}, force=True)

        from stride_core.db import Database
        db = Database(user=USER_UUID)
        rows = db.query(
            "SELECT * FROM planned_session WHERE week_folder = ?",
            ("2026-05-11_05-17",),
        )
        db.close()
        # Should still be exactly 7 (not doubled)
        assert len(rows) == 7


class TestAuthEnforcement:
    """Bearer + path-user checks."""

    def test_no_token_returns_401(self, app_client):
        client, _, _, _ = app_client
        resp = client.post(
            f"/api/{USER_UUID}/plan/weeks/generate",
            json={"week_start": MONDAY},
        )
        assert resp.status_code == 401

    def test_user_mismatch_returns_403(self, app_client):
        client, _, tmp_path, private_pem = app_client
        other_token = _make_token(private_pem, sub=OTHER_UUID)
        resp = client.post(
            f"/api/{USER_UUID}/plan/weeks/generate",
            json={"week_start": MONDAY},
            headers=_auth(other_token),
        )
        assert resp.status_code == 403
