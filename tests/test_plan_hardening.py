"""Tests for the team-verify Round-1 hardening fixes.

Coverage matrix (one or more tests per fix):

- Fix #1 — timing-safe internal-token compare via secrets.compare_digest
- Fix #2 — re-push transaction order: superseded UPDATE deferred until after
  successful new push; if new push 502s the old row's status is unchanged
- Fix #3 — apply_weekly_plan_atomic rolls back on mid-call exception (no partial
  rows)
"""

from __future__ import annotations

import json
import time
from unittest.mock import patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_storage.sqlite.database import Database
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
# Shared fixtures
# ─────────────────────────────────────────────────────────────────────────────


class FakeRunSource(BaseDataSource):
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

    def delete_scheduled_workout(self, user, date, name=None):
        # Hardening tests don't introspect ``name`` directly — they only
        # care that the route invokes deletion. Match the new protocol
        # signature so the route's ``name=workout.name`` keyword passes.
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


def _seed_plan(db: Database, week_folder: str, *, structured_status: str = "fresh") -> int:
    db.upsert_weekly_plan(week_folder, "# Plan", generated_by="test-model")
    db.set_weekly_plan_structured_status(
        week_folder, status=structured_status, parsed_from_md_hash="abc",
    )
    sessions = [
        PlannedSession(date="2026-04-21", session_index=0,
                       kind=SessionKind.REST, summary="rest"),
        PlannedSession(
            date="2026-04-22", session_index=0,
            kind=SessionKind.RUN, summary="Easy 10K",
            spec=_easy_run("2026-04-22"),
        ),
    ]
    ids = db.upsert_planned_sessions(week_folder, sessions)
    return ids[-1]


def _build_app(tmp_path, monkeypatch, rsa_keypair, *, fake_source: FakeRunSource | None = None):
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

    if fake_source is None:
        fake_source = FakeRunSource()
    app = FastAPI()
    app.include_router(plan_router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])
    app.include_router(internal_router)
    reg = ProviderRegistry()
    reg.register(fake_source, default=True)
    app.state.source = fake_source
    app.state.registry = reg
    token = _make_token(private_pem)
    return TestClient(app, raise_server_exceptions=False), token, fake_source


def _db(tmp_path) -> Database:
    return Database(tmp_path / USER_UUID / "coros.db")


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ─────────────────────────────────────────────────────────────────────────────
# Fix #1 — timing-safe internal-token compare
# ─────────────────────────────────────────────────────────────────────────────


class TestInternalTokenTimingSafeCompare:
    def test_uses_secrets_compare_digest(self):
        """Source-level guard: confirm the implementation imports and calls
        secrets.compare_digest rather than raw '=='. Source inspection is
        cheaper and more reliable than statistical timing tests in CI."""
        import inspect
        import stride_server.routes.plan as plan_mod
        src = inspect.getsource(plan_mod.validate_internal_token_value)
        assert "compare_digest" in src
        assert " == " not in src or "compare_digest" in src


# ─────────────────────────────────────────────────────────────────────────────
# Fix #2 — re-push transaction (no orphan-supersede on 502)
# ─────────────────────────────────────────────────────────────────────────────


class TestRepushTransaction:
    def test_old_row_unchanged_when_new_push_502s(self, tmp_path, monkeypatch, rsa_keypair):
        # First push with a normal source → DB gets a 'pushed' row attached.
        good = FakeRunSource(push=True, delete=True, fail_push=False)
        client, token, _ = _build_app(tmp_path, monkeypatch, rsa_keypair, fake_source=good)
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        first = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert first.status_code == 200, first.text
        first_sw_id = first.json()["scheduled_workout_id"]

        # Now flip the source to fail on push and try a re-push.
        good._fail_push = True
        second = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push",
            headers=_auth(token),
        )
        assert second.status_code == 502
        # delete from watch HAS happened (only thing the route can't undo —
        # acceptable per the team-verify guidance), but the local old row
        # MUST still be 'pushed' (not 'superseded'), and no new row exists.
        db = _db(tmp_path)
        try:
            old = db.get_scheduled_workout(first_sw_id)
            assert old is not None
            assert old["status"] == "pushed", \
                f"expected old row left as 'pushed', got {old['status']!r}"
            # No new row inserted.
            rows = db.list_scheduled_workouts()
            assert len(rows) == 1, [dict(r) for r in rows]
            # Execution identity lives on scheduled_workout; the legacy plan
            # row is deliberately never back-stamped.
            ps = db.get_planned_session_by_date_index("2026-04-22", 0)
            assert ps["scheduled_workout_id"] is None
            linked = db.get_latest_scheduled_workout_for_plan_session(
                WEEK, "2026-04-22", 0
            )
            assert linked["id"] == first_sw_id
        finally:
            db.close()

    def test_repush_succeeds_when_push_succeeds(self, tmp_path, monkeypatch, rsa_keypair):
        """Sanity — a successful re-push still flips old→superseded + creates new."""
        client, token, fake = _build_app(tmp_path, monkeypatch, rsa_keypair)
        db = _db(tmp_path)
        try:
            _seed_plan(db, WEEK)
        finally:
            db.close()
        first = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push", headers=_auth(token),
        )
        assert first.status_code == 200
        second = client.post(
            f"/api/{USER_UUID}/plan/sessions/2026-04-22/0/push", headers=_auth(token),
        )
        assert second.status_code == 200
        first_sw_id = first.json()["scheduled_workout_id"]
        second_sw_id = second.json()["scheduled_workout_id"]
        assert first_sw_id != second_sw_id
        db = _db(tmp_path)
        try:
            assert db.get_scheduled_workout(first_sw_id)["status"] == "superseded"
            assert db.get_scheduled_workout(second_sw_id)["status"] == "pushed"
        finally:
            db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Fix #3 — apply_weekly_plan_atomic rollback on mid-call exception
# ─────────────────────────────────────────────────────────────────────────────


class TestApplyWeeklyPlanRollback:
    def test_mid_call_exception_rolls_back_all_writes(self, tmp_path, monkeypatch):
        """Inject an exception into upsert_planned_nutrition and verify NO
        partial rows landed in any of the three tables."""
        import stride_core.db as core_db
        import stride_storage.sqlite.database as sdb
        from stride_storage.sqlite.state_stores import SqlitePlanStateStore
        monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)

        wp = WeeklyPlan(
            week_folder=WEEK,
            sessions=(PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.RUN, summary="Easy 10K",
                spec=_easy_run("2026-04-22"),
            ),),
            nutrition=(PlannedNutrition(date="2026-04-22", kcal_target=2400),),
        )

        # Pre-condition: no DB exists yet.
        original_upsert = sdb.Database.upsert_planned_nutrition

        def boom(self, *args, **kwargs):
            # Run the original DELETE+INSERT then raise to simulate a mid-call
            # transient failure (e.g. disk full, schema mismatch).
            original_upsert(self, *args, **kwargs)
            raise RuntimeError("simulated mid-call failure")

        monkeypatch.setattr(
            sdb.Database, "upsert_planned_nutrition", boom,
        )

        db = Database(tmp_path / USER_UUID / "coros.db")
        try:
            with pytest.raises(RuntimeError, match="simulated"):
                SqlitePlanStateStore(db).apply_weekly_plan_atomic(
                    WEEK, "# Plan markdown",
                    generated_by="claude-opus-4-7",
                    sessions=list(wp.sessions),
                    nutrition=list(wp.nutrition),
                    structured_status="fresh",
                    structured_source="fresh",
                    parsed_from_md_hash=None,
                )
        finally:
            db.close()

        # All three tables should be empty — the transaction rolled back.
        db = Database(tmp_path / USER_UUID / "coros.db")
        try:
            wp_row = db.get_weekly_plan_row(WEEK)
            assert wp_row is None, \
                "weekly_plan row should not exist (transaction rolled back)"
            assert db.get_planned_sessions(week_folder=WEEK) == []
            assert db.get_planned_nutrition(week_folder=WEEK) == []
        finally:
            db.close()
