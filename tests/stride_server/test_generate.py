"""Tests for POST /api/{user}/plan/weeks/generate.

The route delegates authoring to ``build_weekly_plan`` (LLM path); these tests
mock that boundary and focus on the route's own contract — Monday validation,
supported-week gating, 409/force conflict handling, 502 on generation failure,
response shaping, canonical-store persistence, and auth. Generation behaviour
itself is covered by ``test_weekly_plan_generator.py`` / ``test_generate_week.py``.
"""

from __future__ import annotations

import time
from datetime import date, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_core.timefmt import week_folder
from stride_server.weekly_plan_generator import (
    GeneratedWeeklyPlan,
    WeeklyPlanAlreadyExistsError,
    WeeklyPlanGenerationError,
)

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


def _seven_session_week(week_start: date, total_km: float) -> WeeklyPlan:
    """A canonical 7-day LLM-shaped plan (aspirational, spec=null)."""
    run_days = {1, 2, 3, 4, 6}
    per_m = round(total_km * 1000 / len(run_days))
    sessions = []
    for offset in range(7):
        day = (week_start + timedelta(days=offset)).isoformat()
        if offset in run_days:
            kind, dist = SessionKind.RUN, per_m
        elif offset == 5:
            kind, dist = SessionKind.STRENGTH, None
        else:
            kind, dist = SessionKind.REST, None
        sessions.append(
            PlannedSession(
                date=day,
                session_index=0,
                kind=kind,
                summary=kind.value,
                total_distance_m=dist,
            )
        )
    return WeeklyPlan(
        week_folder=week_folder(week_start),
        sessions=tuple(sessions),
        nutrition=(),
        notes_md="LLM authored notes",
    )


@pytest.fixture(autouse=True)
def _mock_generator(monkeypatch):
    """Replace the LLM authoring boundary with a deterministic 7-session plan.

    Preserves the existence semantics the route's 409/force handling depends on
    (raise ``WeeklyPlanAlreadyExistsError`` unless ``allow_existing``).
    """
    import stride_server.routes.generate as generate_route

    def _fake_build_weekly_plan(
        *, user_id, week_start, base_distance_km=None, allow_existing=False
    ):
        from stride_server.weekly_plan_store import get_weekly_plan_store

        existing = get_weekly_plan_store().get_current_plan(
            user_id, week_start.isoformat()
        )
        if existing is not None and not allow_existing:
            raise WeeklyPlanAlreadyExistsError(existing.week_folder)
        total = 40.0 if base_distance_km is None else float(base_distance_km)
        return GeneratedWeeklyPlan(
            plan=_seven_session_week(week_start, total),
            total_distance_km=round(total, 1),
        )

    monkeypatch.setattr(generate_route, "build_weekly_plan", _fake_build_weekly_plan)
    monkeypatch.setattr(generate_route, "today_shanghai", lambda: date(2026, 5, 12))


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


# ── Response shape ────────────────────────────────────────────────────────────


class TestResponseShape:
    def test_status_200(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY})
        assert resp.status_code == 200, resp.text

    def test_folder_and_sessions(self, app_client):
        client, token, _, _ = app_client
        data = _post(client, token, {"week_start": MONDAY}).json()
        assert data["folder"] == "2026-05-11_05-17"
        assert data["sessions_count"] == 7

    def test_session_dates_span_week(self, app_client):
        client, token, _, _ = app_client
        data = _post(client, token, {"week_start": MONDAY}).json()
        dates = [s["date"] for s in data["sessions"]]
        assert dates[0] == "2026-05-11"
        assert dates[-1] == "2026-05-17"

    def test_source_echoed(self, app_client):
        client, token, _, _ = app_client
        resp = _post(client, token, {"week_start": MONDAY, "source": "manual"})
        assert resp.json()["source"] == "manual"

    def test_sessions_persisted_only_in_canonical_store(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, token, _, _ = app_client
        _post(client, token, {"week_start": MONDAY})
        from stride_storage.sqlite.database import Database
        db = Database(user=USER_UUID)
        rows = db.query(
            "SELECT * FROM planned_session WHERE week_folder = ?",
            ("2026-05-11_05-17",),
        )
        db.close()
        assert rows == []
        from stride_server.weekly_plan_store import get_weekly_plan_store
        plan = get_weekly_plan_store().get_plan(USER_UUID, "2026-05-11_05-17")
        assert plan is not None
        assert len(plan.sessions) == 7


# ── Validation ────────────────────────────────────────────────────────────────


class TestValidation:
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
        assert resp.json()["total_distance_km"] == pytest.approx(55.0, abs=0.5)


# ── Generation failure ────────────────────────────────────────────────────────


def test_generation_failure_returns_502(app_client, monkeypatch):
    import stride_server.routes.generate as generate_route

    def _boom(**_kwargs):
        raise WeeklyPlanGenerationError("no rule-valid week after retries")

    monkeypatch.setattr(generate_route, "build_weekly_plan", _boom)
    client, token, _, _ = app_client
    resp = _post(client, token, {"week_start": MONDAY})
    assert resp.status_code == 502
    assert "weekly_plan_generation_failed" in str(resp.json()["detail"])


# ── Conflict handling ─────────────────────────────────────────────────────────


class TestConflictHandling:
    def test_existing_week_returns_409(self, app_client):
        client, token, _, _ = app_client
        assert _post(client, token, {"week_start": MONDAY}).status_code == 200
        r2 = _post(client, token, {"week_start": MONDAY})
        assert r2.status_code == 409
        assert "week_already_exists" in str(r2.json()["detail"])

    def test_labeled_folder_for_same_dates_returns_409(self, app_client):
        client, token, _, _ = app_client
        from stride_server.weekly_plan_store import get_weekly_plan_store

        get_weekly_plan_store().save_plan(
            USER_UUID,
            WeeklyPlan(
                week_folder="2026-05-11_05-17(P1W2)",
                sessions=(PlannedSession(
                    date=MONDAY, session_index=0, kind=SessionKind.REST,
                    summary="rest",
                ),),
            ),
        )
        resp = _post(client, token, {"week_start": MONDAY})
        assert resp.status_code == 409
        assert resp.json()["detail"]["folder"] == "2026-05-11_05-17(P1W2)"

    def test_force_overwrites_existing(self, app_client):
        client, token, _, _ = app_client
        assert _post(client, token, {"week_start": MONDAY}).status_code == 200
        r2 = _post(client, token, {"week_start": MONDAY}, force=True)
        assert r2.status_code == 200
        assert r2.json()["folder"] == "2026-05-11_05-17"

    def test_force_replaces_sessions_only_in_canonical_store(self, app_client, tmp_path, monkeypatch):
        import stride_core.db as core_db_mod
        monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
        client, token, _, _ = app_client
        _post(client, token, {"week_start": MONDAY})
        _post(client, token, {"week_start": MONDAY}, force=True)

        from stride_storage.sqlite.database import Database
        db = Database(user=USER_UUID)
        rows = db.query(
            "SELECT * FROM planned_session WHERE week_folder = ?",
            ("2026-05-11_05-17",),
        )
        db.close()
        assert rows == []
        from stride_server.weekly_plan_store import get_weekly_plan_store
        plan = get_weekly_plan_store().get_plan(USER_UUID, "2026-05-11_05-17")
        assert plan is not None
        assert len(plan.sessions) == 7


def test_rejects_week_after_next(app_client):
    client, token, _, _ = app_client
    resp = _post(client, token, {"week_start": "2026-05-25"})
    assert resp.status_code == 400
    assert "current and next" in resp.json()["detail"]


# ── Auth ──────────────────────────────────────────────────────────────────────


class TestAuthEnforcement:
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
