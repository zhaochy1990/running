"""Tests for routes/plan.py — public plan endpoints + internal webhook."""

from __future__ import annotations

import json
import os
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.db import Database
from stride_core.plan_spec import (
    Meal,
    PlannedNutrition,
    PlannedSession,
    SessionKind,
    WeeklyPlan,
)
from stride_core.source import (
    BaseDataSource,
    Capability,
    ProviderInfo,
)
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
)


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
WEEK = "2026-04-20_04-26(W0)"
INTERNAL_TOKEN = "test-internal-token-very-secret"


# ─────────────────────────────────────────────────────────────────────────────
# Fakes & helpers
# ─────────────────────────────────────────────────────────────────────────────


class FakeRunSource(BaseDataSource):
    """Adapter stub with optional PUSH_RUN_WORKOUT + DELETE_WORKOUT."""

    def __init__(self, *, push: bool = True, delete: bool = True, fail_push: bool = False):
        caps = set()
        if push:
            caps.add(Capability.PUSH_RUN_WORKOUT)
        if delete:
            caps.add(Capability.DELETE_WORKOUT)
        self._caps = frozenset(caps)
        self._fail_push = fail_push
        self.delete_calls: list[tuple[str, str]] = []
        self.push_calls: list[NormalizedRunWorkout] = []
        self.name = "fake"

    @property
    def info(self) -> ProviderInfo:
        return ProviderInfo(
            name="fake", display_name="Fake",
            regions=("global",), capabilities=self._caps,
        )

    def is_logged_in(self, user):
        return True

    def push_run_workout(self, user, workout):
        self.push_calls.append(workout)
        if self._fail_push:
            raise RuntimeError("upstream rejected")
        return f"provider-id-{len(self.push_calls)}"

    def delete_scheduled_workout(self, user, date):
        self.delete_calls.append((user, date))
        return True


@pytest.fixture
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return (
        private.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode(),
        private.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode(),
    )


def _make_token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


def _easy_run(date: str = "2026-04-22") -> NormalizedRunWorkout:
    return NormalizedRunWorkout(
        name="[STRIDE] Easy 10K",
        date=date,
        blocks=(
            WorkoutBlock(
                steps=(WorkoutStep(
                    step_kind=StepKind.WORK,
                    duration=Duration.of_distance_km(10),
                    target=Target.pace_range_s_km(360, 330),
                ),),
                repeat=1,
            ),
        ),
    )


def _seed_plan(db: Database, week_folder: str, *, structured_status: str = "fresh", with_run: bool = True) -> int | None:
    """Seed a weekly_plan markdown row + structured layer. Return the id of
    the run session if one was created, else None."""
    db.upsert_weekly_plan(week_folder, "# Plan", generated_by="test-model")
    db.set_weekly_plan_structured_status(week_folder, status=structured_status, parsed_from_md_hash="abc")
    sessions: list[PlannedSession] = [
        PlannedSession(date="2026-04-21", session_index=0,
                       kind=SessionKind.REST, summary="rest"),
    ]
    if with_run:
        sessions.append(
            PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.RUN, summary="Easy 10K",
                spec=_easy_run("2026-04-22"),
            )
        )
    nutrition = [
        PlannedNutrition(
            date="2026-04-22", kcal_target=2400,
            meals=(Meal(name="早餐", kcal=600),),
        ),
    ]
    ids = db.upsert_planned_sessions(week_folder, sessions)
    db.upsert_planned_nutrition(week_folder, nutrition)
    if not with_run:
        return None
    # Find the run session id (always the last one in our seed)
    return ids[-1]


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for k in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
              "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)
    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)

    import stride_core.db as core_db
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.plan import internal_router, router as plan_router

    fake_source = FakeRunSource()

    app = FastAPI()
    # Mirror app.py wiring: /api/* under bearer + path-user, /internal/* unguarded
    # (relies on per-route Depends(require_internal_token)).
    app.include_router(plan_router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])
    app.include_router(internal_router)
    # The push route resolves the source via get_source_for_user → app.state.registry.
    from stride_core.registry import ProviderRegistry
    reg = ProviderRegistry()
    reg.register(fake_source, default=True)
    app.state.source = fake_source
    app.state.registry = reg

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path, fake_source, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _db(tmp_path) -> Database:
    return Database(tmp_path / USER_UUID / "coros.db")


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/{user}/plan/days
# ─────────────────────────────────────────────────────────────────────────────


class TestPlanDays:
    def test_returns_seeded_sessions(self, app_client):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        resp = client.get(
            f"/api/{USER_UUID}/plan/days?from=2026-04-20&to=2026-04-26",
            headers=_auth(token),
        )
        assert resp.status_code == 200
        data = resp.json()
        # 7 day slots returned, contiguous
        assert len(data["days"]) == 7
        assert data["days"][0]["date"] == "2026-04-20"
        # The seeded run lives on 2026-04-22
        run_day = next(d for d in data["days"] if d["date"] == "2026-04-22")
        kinds = [s["kind"] for s in run_day["sessions"]]
        assert "run" in kinds
        run_session = next(s for s in run_day["sessions"] if s["kind"] == "run")
        assert run_session["pushable"] is True
        assert run_session["spec"] is not None

    def test_invalid_date_400(self, app_client):
        client, token, _, _, _ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/plan/days?from=oops&to=2026-04-26",
            headers=_auth(token),
        )
        assert resp.status_code == 400

    def test_range_too_large_400(self, app_client):
        client, token, _, _, _ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/plan/days?from=2026-01-01&to=2026-12-31",
            headers=_auth(token),
        )
        assert resp.status_code == 400

    def test_inverted_range_400(self, app_client):
        client, token, _, _, _ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/plan/days?from=2026-04-26&to=2026-04-20",
            headers=_auth(token),
        )
        assert resp.status_code == 400

    def test_unauthenticated_401(self, app_client):
        client, _, _, _, _ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/plan/days?from=2026-04-20&to=2026-04-26",
        )
        assert resp.status_code == 401

    def test_other_user_403(self, app_client, rsa_keypair):
        client, _own, _, _, _ = app_client
        private_pem, _ = rsa_keypair
        other_token = _make_token(private_pem, sub="b1b2c3d4-e5f6-4aaa-89ab-999999999999")
        resp = client.get(
            f"/api/{USER_UUID}/plan/days?from=2026-04-20&to=2026-04-26",
            headers=_auth(other_token),
        )
        assert resp.status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/{user}/plan/today
# ─────────────────────────────────────────────────────────────────────────────


class TestPlanToday:
    def test_returns_today_payload(self, app_client, monkeypatch):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        # Pin "today" to 2026-04-22 so the seeded run is on the day
        import stride_server.routes.plan as plan_mod
        monkeypatch.setattr(plan_mod, "_shanghai_today_iso", lambda: "2026-04-22")
        resp = client.get(f"/api/{USER_UUID}/plan/today", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["date"] == "2026-04-22"
        assert len(data["sessions"]) == 1  # only the run session is on 4/22
        assert data["nutrition"]["kcal_target"] == 2400
        # planned_vs_actual carries the planned + (no actual yet) shape
        assert isinstance(data["planned_vs_actual"], list)
        assert len(data["planned_vs_actual"]) == 1
        entry = data["planned_vs_actual"][0]
        assert entry["planned"]["kind"] == "run"
        assert entry["actual"] is None  # no synced activity for the day


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/{user}/plan/sessions/{date}/{idx}/push
# ─────────────────────────────────────────────────────────────────────────────


class TestPushSession:
    def test_happy_path(self, app_client):
        client, token, tmp_path, fake, _ = app_client
        db = _db(tmp_path)
        try:
            ps_id = _seed_plan(db, WEEK)
        finally:
            db.close()
        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["planned_session_id"] == ps_id
        assert body["scheduled_workout_id"]
        assert body["provider"] == "fake"
        assert body["provider_workout_id"] == "provider-id-1"
        assert len(fake.push_calls) == 1
        assert len(fake.delete_calls) == 0

        # FK on planned_session was filled in.
        db = _db(tmp_path)
        try:
            row = db.get_planned_session(ps_id)
            assert row["scheduled_workout_id"] == body["scheduled_workout_id"]
            sw = db.get_scheduled_workout(body["scheduled_workout_id"])
            assert sw["status"] == "pushed"
            assert sw["provider"] == "fake"
        finally:
            db.close()

    def test_404_when_session_missing(self, app_client):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-12-31/0/push",
            headers=_auth(token),
        )
        assert resp.status_code == 404

    def test_409_when_structured_status_backfilled(self, app_client):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK, structured_status="backfilled")
        finally:
            db.close()
        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert resp.status_code == 409
        body = resp.json()
        assert body["detail"]["structured_status"] == "backfilled"

    def test_409_when_structured_status_parse_failed(self, app_client):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK, structured_status="parse_failed")
        finally:
            db.close()
        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert resp.status_code == 409

    def test_400_when_kind_not_run(self, app_client):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-21/0/push",  # rest day
            headers=_auth(token),
        )
        assert resp.status_code == 400
        assert "kind=run" in resp.json()["detail"]

    def test_400_when_provider_lacks_capability(self, tmp_path, monkeypatch, rsa_keypair):
        # Build an app with a no-push fake source. Mirrors app_client fixture.
        private_pem, public_pem = rsa_keypair
        import stride_server.bearer as bearer
        monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
        monkeypatch.setattr(bearer, "_warned_open", False)
        for k in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                  "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)
        monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)

        import stride_core.db as core_db
        import stride_server.deps as deps_mod
        monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
        monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
        (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)

        from stride_server.bearer import require_bearer, verify_path_user
        from stride_server.routes.plan import internal_router, router as plan_router
        from stride_core.registry import ProviderRegistry

        no_push = FakeRunSource(push=False, delete=False)
        app = FastAPI()
        app.include_router(plan_router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])
        app.include_router(internal_router)
        reg = ProviderRegistry()
        reg.register(no_push, default=True)
        app.state.source = no_push
        app.state.registry = reg

        token = _make_token(private_pem)
        client = TestClient(app, raise_server_exceptions=False)

        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()

        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert resp.status_code == 400
        assert "does not support pushing" in resp.json()["detail"]

    def test_502_when_upstream_rejects(self, tmp_path, monkeypatch, rsa_keypair):
        private_pem, public_pem = rsa_keypair
        import stride_server.bearer as bearer
        monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
        monkeypatch.setattr(bearer, "_warned_open", False)
        for k in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                  "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)
        monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
        import stride_core.db as core_db
        import stride_server.deps as deps_mod
        monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
        monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
        (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)
        from stride_server.bearer import require_bearer, verify_path_user
        from stride_server.routes.plan import internal_router, router as plan_router
        from stride_core.registry import ProviderRegistry
        bad = FakeRunSource(push=True, fail_push=True)
        app = FastAPI()
        app.include_router(plan_router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])
        app.include_router(internal_router)
        reg = ProviderRegistry()
        reg.register(bad, default=True)
        app.state.source = bad
        app.state.registry = reg
        token = _make_token(private_pem)
        client = TestClient(app, raise_server_exceptions=False)
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        resp = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert resp.status_code == 502

    def test_repush_marks_old_superseded_and_calls_delete(self, app_client):
        client, token, tmp_path, fake, _ = app_client
        db = _db(tmp_path)
        try:
            ps_id = _seed_plan(db, WEEK)
        finally:
            db.close()
        # First push
        first = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert first.status_code == 200
        first_sw_id = first.json()["scheduled_workout_id"]
        # Second push (re-push)
        second = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert second.status_code == 200
        second_sw_id = second.json()["scheduled_workout_id"]
        assert second_sw_id != first_sw_id
        assert len(fake.delete_calls) == 1
        assert fake.delete_calls[0] == (USER_UUID, "2026-04-22")
        # DB state: old row superseded, new row pushed
        db = _db(tmp_path)
        try:
            old = db.get_scheduled_workout(first_sw_id)
            new = db.get_scheduled_workout(second_sw_id)
            assert old["status"] == "superseded"
            assert new["status"] == "pushed"
        finally:
            db.close()


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/{user}/plan/reparse
# ─────────────────────────────────────────────────────────────────────────────


class TestReparsePlan:
    def test_reparse_success(self, app_client, monkeypatch):
        client, token, tmp_path, _, _ = app_client
        db = _db(tmp_path)
        try:
            db.upsert_weekly_plan(WEEK, "# Plan markdown", generated_by="test")
            db.set_weekly_plan_structured_status(WEEK, status="parse_failed")
        finally:
            db.close()

        # Stub run_agent so the reparse route doesn't hit a real LLM.
        from stride_server.coach_agent.agent import AgentResult
        wp = WeeklyPlan(
            week_folder=WEEK,
            sessions=(PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.REST, summary="rest",
            ),),
            nutrition=(),
        )
        import stride_server.routes.plan as plan_mod
        monkeypatch.setattr(
            plan_mod, "run_agent",
            lambda *a, **kw: AgentResult(
                content="", model="test", context_summary={}, sync={},
                structured=wp, parse_error=None,
            ),
        )

        resp = client.post(
            f"/api/{USER_UUID}/plan/reparse?folder={WEEK}",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["structured_status"] == "fresh"

    def test_reparse_404_when_no_plan(self, app_client):
        client, token, _, _, _ = app_client
        resp = client.post(
            f"/api/{USER_UUID}/plan/reparse?folder={WEEK}",
            headers=_auth(token),
        )
        assert resp.status_code == 404

    def test_reparse_400_when_folder_invalid(self, app_client):
        client, token, _, _, _ = app_client
        resp = client.post(
            f"/api/{USER_UUID}/plan/reparse?folder=not-a-week",
            headers=_auth(token),
        )
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# Internal webhook
# ─────────────────────────────────────────────────────────────────────────────


class TestInternalReparse:
    def _seed_md(self, tmp_path):
        db = _db(tmp_path)
        try:
            db.upsert_weekly_plan(WEEK, "# md", generated_by="test")
        finally:
            db.close()

    def _stub_agent(self, monkeypatch, *, structured=True):
        from stride_server.coach_agent.agent import AgentResult
        wp = WeeklyPlan(
            week_folder=WEEK,
            sessions=(PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.REST, summary="rest",
            ),),
            nutrition=(),
        ) if structured else None
        import stride_server.routes.plan as plan_mod
        monkeypatch.setattr(
            plan_mod, "run_agent",
            lambda *a, **kw: AgentResult(
                content="", model="test", context_summary={}, sync={},
                structured=wp, parse_error=None if structured else "fail",
            ),
        )

    def test_missing_token_401(self, app_client):
        client, _, tmp_path, _, _ = app_client
        self._seed_md(tmp_path)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
        )
        assert resp.status_code == 401

    def test_wrong_token_401(self, app_client):
        client, _, tmp_path, _, _ = app_client
        self._seed_md(tmp_path)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": "WRONG"},
        )
        assert resp.status_code == 401

    def test_correct_token_triggers_reparse(self, app_client, monkeypatch):
        client, _, tmp_path, _, _ = app_client
        self._seed_md(tmp_path)
        self._stub_agent(monkeypatch, structured=True)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["user"] == USER_UUID
        assert body["folder"] == WEEK
        assert body["structured_status"] == "fresh"

    def test_internal_route_does_not_require_bearer(self, app_client, monkeypatch):
        """Internal route should ignore Authorization headers entirely — only the
        X-Internal-Token gates it. We verify by sending a Bearer that would fail
        normal verification AND no internal token: 401 from internal-token dep
        rather than 401 from bearer.
        """
        client, _, tmp_path, _, _ = app_client
        self._seed_md(tmp_path)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"Authorization": "Bearer total-junk"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid internal token"

    def test_token_unset_on_server_401(self, app_client, monkeypatch):
        client, _, tmp_path, _, _ = app_client
        self._seed_md(tmp_path)
        monkeypatch.delenv("STRIDE_INTERNAL_TOKEN", raising=False)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": "anything"},
        )
        assert resp.status_code == 401

    def test_404_when_plan_row_missing(self, app_client, monkeypatch):
        client, _, _, _, _ = app_client
        self._stub_agent(monkeypatch, structured=True)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 404

    def test_noop_when_hash_matches(self, app_client, monkeypatch):
        """Atomicity guard — same md sha256 + status='fresh' should skip the
        LLM call and return noop:True."""
        client, _, tmp_path, _, _ = app_client
        # Seed plan + walk it to fresh first
        self._seed_md(tmp_path)
        self._stub_agent(monkeypatch, structured=True)
        first = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert first.status_code == 200
        assert first.json()["noop"] is False

        # Re-stub run_agent to fail loudly if called again — second call should not invoke it.
        import stride_server.routes.plan as plan_mod
        sentinel = {"called": False}

        def _boom(*a, **kw):
            sentinel["called"] = True
            raise RuntimeError("should not be called when hash matches")
        monkeypatch.setattr(plan_mod, "run_agent", _boom)

        second = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert second.status_code == 200, second.text
        body = second.json()
        assert body["noop"] is True
        assert body["structured_status"] == "fresh"
        assert sentinel["called"] is False


# ─────────────────────────────────────────────────────────────────────────────
# /api/{user}/weeks/{folder} additive `structured` field
# ─────────────────────────────────────────────────────────────────────────────


class TestWeeksRouteStructuredField:
    @pytest.fixture
    def weeks_app(self, tmp_path, monkeypatch, rsa_keypair):
        private_pem, public_pem = rsa_keypair
        import stride_server.bearer as bearer
        monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
        monkeypatch.setattr(bearer, "_warned_open", False)
        for k in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                  "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)
        import stride_core.db as core_db
        import stride_server.deps as deps_mod
        monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
        monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
        (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)
        from stride_server.bearer import require_bearer, verify_path_user
        from stride_server.routes.weeks import router
        app = FastAPI()
        app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])
        token = _make_token(private_pem)
        client = TestClient(app, raise_server_exceptions=False)
        return client, token, tmp_path

    def test_get_week_includes_structured(self, weeks_app):
        client, token, tmp_path = weeks_app
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
        assert resp.status_code == 200
        body = resp.json()
        assert "structured" in body
        s = body["structured"]
        assert s["structured_status"] == "fresh"
        assert isinstance(s["sessions"], list)
        assert isinstance(s["nutrition"], list)
        kinds = {x["kind"] for x in s["sessions"]}
        assert "run" in kinds
        assert "rest" in kinds
        assert s["nutrition"][0]["kcal_target"] == 2400

    def test_get_week_structured_empty_when_no_plan_row(self, weeks_app):
        client, token, tmp_path = weeks_app
        # No DB rows seeded; just create a plan.md so the file fallback path runs.
        plan_md = tmp_path / USER_UUID / "logs" / WEEK / "plan.md"
        plan_md.write_text("# md only", encoding="utf-8")
        resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
        assert resp.status_code == 200
        body = resp.json()
        s = body["structured"]
        # No structured_status (we never wrote a weekly_plan DB row)
        assert s["structured_status"] is None
        assert s["sessions"] == []
        assert s["nutrition"] == []
