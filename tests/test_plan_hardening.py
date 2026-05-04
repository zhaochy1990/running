"""Tests for the team-verify Round-1 hardening fixes.

Coverage matrix (one or more tests per fix):

- Fix #1 — timing-safe internal-token compare via secrets.compare_digest
- Fix #2 — re-push transaction order: superseded UPDATE deferred until after
  successful new push; if new push 502s the old row's status is unchanged
- Fix #3 — apply_weekly_plan rolls back on mid-call exception (no partial rows)
- Fix #4 — LLM input size cap on /plan/reparse and /internal/plan/reparse
- Fix #5 — _parse_structured rejects WeeklyPlan whose session dates fall
  outside the parent week's date range
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
        src = inspect.getsource(plan_mod.require_internal_token)
        assert "compare_digest" in src
        assert " == " not in src or "compare_digest" in src

    def test_correct_token_passes(self, tmp_path, monkeypatch, rsa_keypair):
        client, _, _ = _build_app(tmp_path, monkeypatch, rsa_keypair)
        db = _db(tmp_path)
        try:
            db.upsert_weekly_plan(WEEK, "# md", generated_by="t")
        finally:
            db.close()
        # Stub run_agent + apply_weekly_plan so the route returns 200 fast.
        import stride_server.routes.plan as plan_mod
        from stride_server.coach_agent.agent import AgentResult
        wp = WeeklyPlan(
            week_folder=WEEK,
            sessions=(PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.REST, summary="rest",
            ),),
            nutrition=(),
        )
        monkeypatch.setattr(
            plan_mod, "run_agent",
            lambda *a, **kw: AgentResult(
                content="", model="t", context_summary={}, sync={},
                structured=wp, parse_error=None,
            ),
        )
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text

    def test_wrong_token_still_401(self, tmp_path, monkeypatch, rsa_keypair):
        client, _, _ = _build_app(tmp_path, monkeypatch, rsa_keypair)
        # Same length to avoid fast-path differences
        wrong = "x" * len(INTERNAL_TOKEN)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": wrong},
        )
        assert resp.status_code == 401

    def test_empty_token_still_401(self, tmp_path, monkeypatch, rsa_keypair):
        client, _, _ = _build_app(tmp_path, monkeypatch, rsa_keypair)
        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": ""},
        )
        assert resp.status_code == 401


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
            # planned_session FK still points at the original row.
            ps = db.get_planned_session_by_date_index("2026-04-22", 0)
            assert ps["scheduled_workout_id"] == first_sw_id
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
# Fix #3 — apply_weekly_plan rollback on mid-call exception
# ─────────────────────────────────────────────────────────────────────────────


class TestApplyWeeklyPlanRollback:
    def test_mid_call_exception_rolls_back_all_writes(self, tmp_path, monkeypatch):
        """Inject an exception into upsert_planned_nutrition and verify NO
        partial rows landed in any of the three tables."""
        import stride_core.db as core_db
        monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
        from stride_server.coach_agent import agent as agent_mod
        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-model")

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
        original_upsert = core_db.Database.upsert_planned_nutrition

        def boom(self, *args, **kwargs):
            # Run the original DELETE+INSERT then raise to simulate a mid-call
            # transient failure (e.g. disk full, schema mismatch).
            original_upsert(self, *args, **kwargs)
            raise RuntimeError("simulated mid-call failure")

        monkeypatch.setattr(
            core_db.Database, "upsert_planned_nutrition", boom,
        )

        with pytest.raises(RuntimeError, match="simulated"):
            agent_mod.apply_weekly_plan(
                USER_UUID, WEEK, "# Plan markdown",
                generated_by="claude-opus-4-7",
                structured=wp, structured_source="fresh",
            )

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


# ─────────────────────────────────────────────────────────────────────────────
# Fix #4 — LLM input size cap (64 KiB)
# ─────────────────────────────────────────────────────────────────────────────


class TestPlanMarkdownSizeCap:
    def _seed_oversized(self, tmp_path) -> None:
        db = _db(tmp_path)
        try:
            big = "x" * (65 * 1024)  # > 64 KiB
            db.upsert_weekly_plan(WEEK, big, generated_by="t")
        finally:
            db.close()

    def test_public_reparse_400_when_too_big(self, tmp_path, monkeypatch, rsa_keypair):
        client, token, _ = _build_app(tmp_path, monkeypatch, rsa_keypair)
        self._seed_oversized(tmp_path)
        # Stub run_agent so we know the route would have called it (and we
        # can fail loudly if the size cap is bypassed).
        import stride_server.routes.plan as plan_mod
        called = {"flag": False}

        def boom(*a, **kw):
            called["flag"] = True
            raise RuntimeError("should not be called")
        monkeypatch.setattr(plan_mod, "run_agent", boom)

        resp = client.post(
            f"/api/{USER_UUID}/plan/reparse?folder={WEEK}",
            headers=_auth(token),
        )
        assert resp.status_code == 400
        assert "byte limit" in resp.json()["detail"]
        assert called["flag"] is False

    def test_internal_reparse_400_when_too_big(self, tmp_path, monkeypatch, rsa_keypair):
        client, _, _ = _build_app(tmp_path, monkeypatch, rsa_keypair)
        self._seed_oversized(tmp_path)
        import stride_server.routes.plan as plan_mod
        called = {"flag": False}

        def boom(*a, **kw):
            called["flag"] = True
            raise RuntimeError("should not be called")
        monkeypatch.setattr(plan_mod, "run_agent", boom)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 400
        assert "byte limit" in resp.json()["detail"]
        assert called["flag"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Fix #5 — session-date-within-week validation
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionDateValidation:
    def test_parser_rejects_out_of_week_session(self):
        """Direct test on _parse_structured: a session dated outside the
        parent week's range yields parse_error."""
        from stride_server.coach_agent.agent import _parse_structured
        plan = {
            "schema": "weekly-plan/v1",
            "week_folder": WEEK,
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-05-15",  # outside 2026-04-20..04-26
                    "session_index": 0,
                    "kind": "rest",
                    "summary": "rest",
                    "spec": None,
                    "notes_md": None,
                    "total_distance_m": None,
                    "total_duration_s": None,
                    "scheduled_workout_id": None,
                }
            ],
            "nutrition": [],
            "notes_md": None,
        }
        raw = f"```json\n{json.dumps(plan)}\n```"
        result, err = _parse_structured(raw, folder=WEEK)
        assert result is None
        assert err is not None
        assert "outside week" in err
        assert "2026-05-15" in err

    def test_parser_accepts_in_range_session(self):
        from stride_server.coach_agent.agent import _parse_structured
        plan = {
            "schema": "weekly-plan/v1",
            "week_folder": WEEK,
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-04-22",  # within range
                    "session_index": 0,
                    "kind": "rest",
                    "summary": "rest",
                    "spec": None,
                    "notes_md": None,
                    "total_distance_m": None,
                    "total_duration_s": None,
                    "scheduled_workout_id": None,
                }
            ],
            "nutrition": [],
            "notes_md": None,
        }
        raw = f"```json\n{json.dumps(plan)}\n```"
        result, err = _parse_structured(raw, folder=WEEK)
        assert err is None
        assert result is not None
        assert len(result.sessions) == 1

    def test_run_agent_marks_parse_failed_on_out_of_week(self, monkeypatch):
        """End-to-end through run_agent(task='parse_plan') — when the LLM
        returns a session dated outside the week, structured is None and
        parse_error is set; downstream apply_weekly_plan would mark
        structured_status='parse_failed'."""
        from stride_server.coach_agent import agent as agent_mod

        plan = {
            "schema": "weekly-plan/v1",
            "week_folder": WEEK,
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2027-01-01",  # very far outside
                    "session_index": 0,
                    "kind": "rest",
                    "summary": "rest",
                    "spec": None,
                    "notes_md": None,
                    "total_distance_m": None,
                    "total_duration_s": None,
                    "scheduled_workout_id": None,
                }
            ],
            "nutrition": [],
            "notes_md": None,
        }

        class FakeModel:
            def invoke(self, messages):
                class _R: pass
                r = _R()
                r.content = f"```json\n{json.dumps(plan)}\n```"
                return r

        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "stub")
        result = agent_mod.run_agent(
            USER_UUID, task="parse_plan", user_message="reparse",
            folder=WEEK, md_text="# md", chat_model=FakeModel(),
            sync_before=False,
        )
        assert result.structured is None
        assert result.parse_error is not None
        assert "outside week" in result.parse_error

    def test_invalid_folder_skips_date_check(self):
        """Defensive: when folder is unparseable we don't reject the plan
        on date grounds (parse_week_dates returns None → skip the guard)."""
        from stride_server.coach_agent.agent import _parse_structured
        plan = {
            "schema": "weekly-plan/v1",
            "week_folder": "garbage",
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-04-22", "session_index": 0,
                    "kind": "rest", "summary": "rest", "spec": None,
                    "notes_md": None, "total_distance_m": None,
                    "total_duration_s": None, "scheduled_workout_id": None,
                }
            ],
            "nutrition": [], "notes_md": None,
        }
        raw = f"```json\n{json.dumps(plan)}\n```"
        result, err = _parse_structured(raw, folder="not-a-week")
        assert err is None
        assert result is not None
