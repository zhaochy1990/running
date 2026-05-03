"""Tests for routes/plan_variants.py — multi-variant API."""

from __future__ import annotations

import json
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
    SUPPORTED_SCHEMA_VERSION,
    WeeklyPlan,
)


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_USER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-deadbeefcafe"
WEEK = "2026-05-04_05-10(P1W2)"


# ── RSA / JWT helpers (mirror test_plan_routes.py) ─────────────────────


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
        {"sub": sub, "iss": "auth-service", "exp": now + 3600,
         "iat": now, "role": "user"},
        private_pem, algorithm="RS256",
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _db(tmp_path) -> Database:
    return Database(tmp_path / USER_UUID / "coros.db")


def _make_plan(week: str = WEEK) -> WeeklyPlan:
    return WeeklyPlan(
        week_folder=week,
        sessions=tuple([
            PlannedSession(date="2026-05-04", session_index=0,
                           kind=SessionKind.RUN, summary="easy 10k"),
            PlannedSession(date="2026-05-06", session_index=0,
                           kind=SessionKind.RUN, summary="tempo"),
            PlannedSession(date="2026-05-09", session_index=0,
                           kind=SessionKind.RUN, summary="long"),
        ]),
        nutrition=tuple([
            PlannedNutrition(date="2026-05-04", kcal_target=2400.0,
                             meals=(Meal(name="早"), Meal(name="午"))),
        ]),
    )


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    """FastAPI TestClient mounted with plan_variants.router (and weeks.router
    for the variants_summary check). Auth keys point to a fresh RSA pair;
    user data goes to a tmp directory.
    """
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
    from stride_server.routes.plan_variants import router as pv_router
    from stride_server.routes.weeks import router as weeks_router

    app = FastAPI()
    app.include_router(
        pv_router,
        dependencies=[Depends(require_bearer), Depends(verify_path_user)],
    )
    app.include_router(
        weeks_router,
        dependencies=[Depends(require_bearer), Depends(verify_path_user)],
    )
    token = _make_token(private_pem)
    other_token = _make_token(private_pem, sub=OTHER_USER_UUID)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, other_token, tmp_path


# ── Helpers used in tests ──────────────────────────────────────────────


def _post_variant(client, token, *, model_id="claude", structured=None,
                  schema_version=SUPPORTED_SCHEMA_VERSION,
                  content_md="# v",
                  generation_metadata=None,
                  folder=WEEK):
    body = {
        "schema_version": schema_version,
        "model_id": model_id,
        "content_md": content_md,
        "structured": structured,
        "generation_metadata": generation_metadata,
    }
    return client.post(
        f"/api/{USER_UUID}/plan/{folder}/variants",
        json=body, headers=_auth(token),
    )


# ── Auth boundary ──────────────────────────────────────────────────────


class TestAuth:
    def test_other_users_token_blocked(self, app_client):
        client, _, other_token, _ = app_client
        # OTHER_USER_UUID's token cannot read USER_UUID's variants.
        resp = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(other_token),
        )
        assert resp.status_code in (401, 403)

    def test_no_token_blocked(self, app_client):
        client, *_ = app_client
        resp = client.get(f"/api/{USER_UUID}/plan/{WEEK}/variants")
        assert resp.status_code in (401, 403)


# ── POST variant ───────────────────────────────────────────────────────


class TestPostVariant:
    def test_happy_path(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        resp = _post_variant(
            client, token, structured=plan.to_dict(), content_md="# v1",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["variant_id"] > 0
        assert body["variant_index"] == 0  # first active variant
        assert body["variant_parse_status"] == "fresh"
        assert body["sessions_count"] == 3
        assert body["nutrition_days"] == 1
        assert "superseded_variant_id" not in body  # nothing to supersede

    def test_schema_version_mismatch_returns_426(self, app_client):
        client, token, *_ = app_client
        resp = _post_variant(
            client, token, schema_version=999,
            structured=_make_plan().to_dict(),
        )
        assert resp.status_code == 426
        body = resp.json()
        assert body["detail"]["error"] == "schema_version_mismatch"
        assert body["detail"]["server_version"] == SUPPORTED_SCHEMA_VERSION

    def test_invalid_structured_returns_400(self, app_client):
        client, token, *_ = app_client
        resp = _post_variant(
            client, token,
            structured={"week_folder": WEEK, "sessions": [{"bogus": True}]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["error"] == "invalid_structured_plan"

    def test_week_folder_mismatch_returns_400(self, app_client):
        client, token, *_ = app_client
        # Plan declares a different week than the URL path.
        plan = _make_plan(week="2026-06-01_06-07")
        resp = _post_variant(
            client, token, structured=plan.to_dict(),
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"]["error"] == "structured_week_folder_mismatch"

    def test_parse_failed_accepted(self, app_client):
        client, token, *_ = app_client
        # structured=None → server stores parse_failed, still browsable
        # in GET but unselectable.
        resp = _post_variant(client, token, structured=None,
                             model_id="codex", content_md="# raw")
        assert resp.status_code == 200
        body = resp.json()
        assert body["variant_parse_status"] == "parse_failed"
        assert body["sessions_count"] == 0

    def test_append_only_supersedes_prior_same_model(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        first = _post_variant(client, token, structured=plan.to_dict(),
                              content_md="# v1").json()
        second = _post_variant(client, token, structured=plan.to_dict(),
                               content_md="# v2").json()
        assert second["variant_id"] != first["variant_id"]
        assert second["superseded_variant_id"] == first["variant_id"]

        # GET should show only the new one as active.
        listing = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        ).json()
        assert len(listing["variants"]) == 1
        assert listing["variants"][0]["variant_id"] == second["variant_id"]

    def test_oversize_md_returns_413(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        big = "x" * (64 * 1024 + 1)
        resp = _post_variant(
            client, token, structured=plan.to_dict(), content_md=big,
        )
        assert resp.status_code == 413


# ── GET variants ───────────────────────────────────────────────────────


class TestGetVariants:
    def test_empty_initial(self, app_client):
        client, token, *_ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["week_folder"] == WEEK
        assert body["selected_variant_id"] is None
        assert body["variants"] == []

    def test_active_variants_with_ratings(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        v_claude = _post_variant(client, token, structured=plan.to_dict(),
                                 model_id="claude").json()
        v_codex = _post_variant(client, token, structured=plan.to_dict(),
                                model_id="codex").json()
        # Rate the claude variant.
        client.post(
            f"/api/{USER_UUID}/plan/variants/{v_claude['variant_id']}/rate",
            json={"ratings": {"overall": 4, "structure": 5},
                  "comment": "good"},
            headers=_auth(token),
        )
        listing = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        ).json()
        assert len(listing["variants"]) == 2
        by_id = {v["variant_id"]: v for v in listing["variants"]}
        assert by_id[v_claude["variant_id"]]["ratings"] == {
            "overall": 4, "structure": 5,
        }
        assert by_id[v_claude["variant_id"]]["rating_comment"] == "good"
        assert by_id[v_codex["variant_id"]]["ratings"] == {}
        # Both are selectable (fresh + matching schema + not superseded).
        for v in listing["variants"]:
            assert v["selectable"] is True
            assert "unselectable_reason" not in v

    def test_unselectable_reasons(self, app_client):
        client, token, _other_token, tmp_path = app_client

        # parse_failed
        _post_variant(client, token, structured=None,
                      model_id="codex", content_md="# raw")
        # Direct DB write for the schema_outdated case (server-side
        # validation forbids ingesting a v999 row, but a stale row can
        # exist in DB after a server upgrade).
        db = _db(tmp_path)
        try:
            db._conn.execute(
                """INSERT INTO weekly_plan_variant
                   (week_folder, model_id, schema_version, content_md,
                    structured_json, variant_parse_status, generated_at,
                    created_at, updated_at)
                   VALUES (?,?,?,?,?,?, datetime('now'), datetime('now'), datetime('now'))""",
                (WEEK, "stale-model", 999, "# old", "{}", "fresh"),
            )
            db._conn.commit()
        finally:
            db.close()

        listing = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        ).json()
        reasons = {v["model_id"]: v.get("unselectable_reason")
                   for v in listing["variants"]}
        assert reasons["codex"] == "parse_failed"
        assert reasons["stale-model"] == "schema_outdated"

    def test_include_superseded(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        first = _post_variant(client, token, structured=plan.to_dict()).json()
        _post_variant(client, token, structured=plan.to_dict()).json()  # supersedes

        active = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        ).json()
        assert len(active["variants"]) == 1

        all_rows = client.get(
            f"/api/{USER_UUID}/plan/{WEEK}/variants?include_superseded=true",
            headers=_auth(token),
        ).json()
        assert len(all_rows["variants"]) == 2
        superseded = next(v for v in all_rows["variants"]
                          if v["variant_id"] == first["variant_id"])
        assert "superseded_at" in superseded
        # Superseded rows are selectable=false.
        assert superseded["selectable"] is False
        assert superseded["unselectable_reason"] == "superseded"


# ── Rate variant ───────────────────────────────────────────────────────


class TestRateVariant:
    def test_rate_partial_dimensions(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        resp = client.post(
            f"/api/{USER_UUID}/plan/variants/{vid}/rate",
            json={"ratings": {"overall": 3}},
            headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["ratings"] == {"overall": 3}

    def test_rate_replace_existing(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        client.post(
            f"/api/{USER_UUID}/plan/variants/{vid}/rate",
            json={"ratings": {"overall": 3}},
            headers=_auth(token),
        )
        resp = client.post(
            f"/api/{USER_UUID}/plan/variants/{vid}/rate",
            json={"ratings": {"overall": 5}, "comment": "changed mind"},
            headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["ratings"]["overall"] == 5
        assert body["rating_comment"] == "changed mind"

    def test_rate_unknown_dimension_rejected(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        resp = client.post(
            f"/api/{USER_UUID}/plan/variants/{vid}/rate",
            json={"ratings": {"unknown_dim": 4}},
            headers=_auth(token),
        )
        assert resp.status_code == 422

    def test_rate_score_out_of_range(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        resp = client.post(
            f"/api/{USER_UUID}/plan/variants/{vid}/rate",
            json={"ratings": {"overall": 6}},
            headers=_auth(token),
        )
        assert resp.status_code == 422

    def test_rate_nonexistent_variant_404(self, app_client):
        client, token, *_ = app_client
        resp = client.post(
            f"/api/{USER_UUID}/plan/variants/99999/rate",
            json={"ratings": {"overall": 4}},
            headers=_auth(token),
        )
        assert resp.status_code == 404


# ── Select variant (FALLBACK promote) ──────────────────────────────────


class TestSelect:
    def test_happy_path_no_prior_pushes(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        resp = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": vid, "force": False},
            headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["selected_variant_id"] == vid
        assert body["dropped_scheduled_workout_ids"] == []
        assert body.get("no_change") is False

    def test_idempotent_no_change(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": vid}, headers=_auth(token),
        )
        resp = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": vid}, headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["no_change"] is True

    def test_conflict_without_force(self, app_client):
        client, token, _other_token, tmp_path = app_client
        plan = _make_plan()
        v1 = _post_variant(client, token, structured=plan.to_dict(),
                           model_id="claude").json()["variant_id"]
        # First select: no prior pushes, no conflict.
        client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": v1}, headers=_auth(token),
        )
        # Simulate a push: stitch a scheduled_workout to the planned_session.
        db = _db(tmp_path)
        try:
            cur = db._conn.execute(
                """INSERT INTO scheduled_workout
                   (date, kind, name, spec_json, status, provider,
                    provider_workout_id, pushed_at, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?, datetime('now'),
                           datetime('now'), datetime('now'))""",
                ("2026-05-04", "run", "[STRIDE]", "{}", "pushed",
                 "coros", "prov-1"),
            )
            sw_id = cur.lastrowid
            db._conn.execute(
                """UPDATE planned_session
                       SET scheduled_workout_id = ?
                     WHERE week_folder = ? AND date = ? AND session_index = 0""",
                (sw_id, WEEK, "2026-05-04"),
            )
            db._conn.commit()
        finally:
            db.close()

        # New variant.
        v2 = _post_variant(client, token, structured=plan.to_dict(),
                           model_id="codex").json()["variant_id"]
        resp = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": v2, "force": False},
            headers=_auth(token),
        )
        assert resp.status_code == 409
        body = resp.json()
        assert body["detail"]["error"] == "selection_conflict"
        assert body["detail"]["already_pushed_count"] == 1

        # force=True succeeds.
        resp2 = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": v2, "force": True},
            headers=_auth(token),
        )
        assert resp2.status_code == 200
        body2 = resp2.json()
        assert body2["selected_variant_id"] == v2
        assert sw_id in body2["dropped_scheduled_workout_ids"]

    def test_schema_outdated_426(self, app_client):
        client, token, _other_token, tmp_path = app_client
        # Insert a v999 variant directly (server route forbids ingesting it,
        # but DB-level it can exist after a schema bump).
        db = _db(tmp_path)
        try:
            cur = db._conn.execute(
                """INSERT INTO weekly_plan_variant
                   (week_folder, model_id, schema_version, content_md,
                    structured_json, variant_parse_status, generated_at,
                    created_at, updated_at)
                   VALUES (?,?,?,?,?,?, datetime('now'),
                           datetime('now'), datetime('now'))""",
                (WEEK, "old-model", 999, "# v", "{}", "fresh"),
            )
            vid = cur.lastrowid
            db._conn.commit()
        finally:
            db.close()

        resp = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": vid}, headers=_auth(token),
        )
        assert resp.status_code == 426
        body = resp.json()
        assert body["detail"]["error"] == "variant_schema_outdated"

    def test_variant_not_found_404(self, app_client):
        client, token, *_ = app_client
        resp = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": 99999}, headers=_auth(token),
        )
        assert resp.status_code == 404
        body = resp.json()
        assert body["detail"]["error"] == "variant_not_found"


# ── DELETE variants ────────────────────────────────────────────────────


class TestDelete:
    def test_delete_clears_variants_and_ratings(self, app_client):
        client, token, _other_token, tmp_path = app_client
        plan = _make_plan()
        v1 = _post_variant(client, token, structured=plan.to_dict(),
                           model_id="claude").json()["variant_id"]
        client.post(
            f"/api/{USER_UUID}/plan/variants/{v1}/rate",
            json={"ratings": {"overall": 4}}, headers=_auth(token),
        )
        resp = client.delete(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        )
        assert resp.status_code == 200
        assert resp.json() == {"deleted_variants": 1}

        # Verify no orphan ratings.
        db = _db(tmp_path)
        try:
            n_rat = db._conn.execute(
                "SELECT COUNT(*) FROM weekly_plan_variant_rating",
            ).fetchone()[0]
            assert n_rat == 0
        finally:
            db.close()

    def test_delete_nullifies_selected_pointer(self, app_client):
        client, token, _other_token, tmp_path = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": vid}, headers=_auth(token),
        )
        # weekly_plan.selected_variant_id should now be vid.
        db = _db(tmp_path)
        try:
            wp_pre = db._conn.execute(
                "SELECT selected_variant_id FROM weekly_plan WHERE week=?",
                (WEEK,),
            ).fetchone()
            assert wp_pre["selected_variant_id"] == vid
        finally:
            db.close()

        resp = client.delete(
            f"/api/{USER_UUID}/plan/{WEEK}/variants",
            headers=_auth(token),
        )
        assert resp.status_code == 200

        db = _db(tmp_path)
        try:
            wp_post = db._conn.execute(
                "SELECT selected_variant_id FROM weekly_plan WHERE week=?",
                (WEEK,),
            ).fetchone()
            assert wp_post["selected_variant_id"] is None
        finally:
            db.close()


# ── weeks.py extension: variants_summary ───────────────────────────────


class TestWeeksVariantsSummary:
    def test_variants_summary_empty_initial(self, app_client):
        client, token, *_ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}",
            headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["variants_summary"] == {
            "total": 0,
            "selected_variant_id": None,
            "model_ids": [],
        }

    def test_variants_summary_lists_active_models(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        _post_variant(client, token, structured=plan.to_dict(),
                      model_id="claude")
        _post_variant(client, token, structured=plan.to_dict(),
                      model_id="codex")
        _post_variant(client, token, structured=plan.to_dict(),
                      model_id="gemini")
        resp = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}",
            headers=_auth(token),
        )
        body = resp.json()
        assert body["variants_summary"]["total"] == 3
        assert set(body["variants_summary"]["model_ids"]) == {
            "claude", "codex", "gemini",
        }

    def test_variants_summary_reflects_selection(self, app_client):
        client, token, *_ = app_client
        plan = _make_plan()
        vid = _post_variant(client, token, structured=plan.to_dict()).json()["variant_id"]
        client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": vid}, headers=_auth(token),
        )
        resp = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}",
            headers=_auth(token),
        )
        body = resp.json()
        assert body["variants_summary"]["selected_variant_id"] == vid


# ── weeks.py extension: abandoned_scheduled_workouts (Step 4 #7) ───────


class TestAbandonedScheduledWorkouts:
    """The week endpoint surfaces scheduled_workout rows whose
    abandoned_by_promote_at IS NOT NULL so the frontend can render the
    'orphan banner' over the canonical view (Step 4 design)."""

    def test_empty_when_no_orphans(self, app_client):
        client, token, *_ = app_client
        resp = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}",
            headers=_auth(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["abandoned_scheduled_workouts"] == []

    def test_lists_only_abandoned_in_window(self, app_client):
        client, token, _other_token, tmp_path = app_client
        # Seed three scheduled_workouts: 2 inside the week (one
        # abandoned, one still pushed) + 1 outside the week (abandoned
        # but should not appear). Tests the date-window filter AND the
        # IS NOT NULL filter simultaneously.
        db = _db(tmp_path)
        try:
            db._conn.execute(
                "INSERT INTO weekly_plan (week, content_md, generated_at, updated_at) "
                "VALUES (?, ?, datetime('now'), datetime('now'))",
                (WEEK, "stub"),
            )
            db._conn.execute(
                """INSERT INTO scheduled_workout
                       (date, kind, name, spec_json, status, provider,
                        provider_workout_id, pushed_at,
                        abandoned_by_promote_at,
                        created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,
                               datetime('now'), datetime('now'),
                               datetime('now'), datetime('now'))""",
                ("2026-05-06", "run", "[STRIDE] orphan A",
                 "{}", "pushed", "coros", "prov-1"),
            )
            db._conn.execute(
                """INSERT INTO scheduled_workout
                       (date, kind, name, spec_json, status, provider,
                        provider_workout_id, pushed_at,
                        abandoned_by_promote_at,
                        created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,
                               datetime('now'), NULL,
                               datetime('now'), datetime('now'))""",
                ("2026-05-08", "run", "[STRIDE] still active",
                 "{}", "pushed", "coros", "prov-2"),
            )
            db._conn.execute(
                """INSERT INTO scheduled_workout
                       (date, kind, name, spec_json, status, provider,
                        provider_workout_id, pushed_at,
                        abandoned_by_promote_at,
                        created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,
                               datetime('now'), datetime('now'),
                               datetime('now'), datetime('now'))""",
                ("2026-04-20", "run", "[STRIDE] outside window",
                 "{}", "pushed", "coros", "prov-3"),
            )
            db._conn.commit()
        finally:
            db.close()

        resp = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}",
            headers=_auth(token),
        )
        body = resp.json()
        names = [r["name"] for r in body["abandoned_scheduled_workouts"]]
        # Only the "orphan A" row matches both filters: in the week AND
        # abandoned_by_promote_at IS NOT NULL.
        assert names == ["[STRIDE] orphan A"]
        # Each row exposes the four expected keys.
        row = body["abandoned_scheduled_workouts"][0]
        assert set(row.keys()) == {
            "id", "date", "name", "abandoned_by_promote_at",
        }
        assert row["abandoned_by_promote_at"] is not None

    def test_post_select_force_populates_abandoned_list(self, app_client):
        """End-to-end: select(force=True) marks prior pushed sessions
        abandoned → next GET /weeks/{folder} surfaces them in the
        new field. This is the contract Step 4's UI banner relies on.
        """
        client, token, _other_token, tmp_path = app_client
        plan = _make_plan()
        v1 = _post_variant(client, token, structured=plan.to_dict(),
                           model_id="claude").json()["variant_id"]
        client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": v1}, headers=_auth(token),
        )
        # Stitch a scheduled_workout to a planned_session for this week.
        db = _db(tmp_path)
        try:
            cur = db._conn.execute(
                """INSERT INTO scheduled_workout
                       (date, kind, name, spec_json, status, provider,
                        provider_workout_id, pushed_at,
                        created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?, datetime('now'),
                               datetime('now'), datetime('now'))""",
                ("2026-05-04", "run", "[STRIDE] watch-pushed",
                 "{}", "pushed", "coros", "prov-X"),
            )
            sw_id = cur.lastrowid
            db._conn.execute(
                """UPDATE planned_session
                       SET scheduled_workout_id = ?
                     WHERE week_folder = ? AND date = ? AND session_index = 0""",
                (sw_id, WEEK, "2026-05-04"),
            )
            db._conn.commit()
        finally:
            db.close()

        # Pre-promote: GET shows no orphans.
        pre = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token),
        ).json()
        assert pre["abandoned_scheduled_workouts"] == []

        # Promote a new variant with force=True → marks sw_id abandoned.
        v2 = _post_variant(client, token, structured=plan.to_dict(),
                           model_id="codex").json()["variant_id"]
        sel = client.post(
            f"/api/{USER_UUID}/plan/{WEEK}/select",
            json={"variant_id": v2, "force": True},
            headers=_auth(token),
        ).json()
        assert sw_id in sel["dropped_scheduled_workout_ids"]

        # Post-promote: GET surfaces the orphan.
        post = client.get(
            f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token),
        ).json()
        rows = post["abandoned_scheduled_workouts"]
        assert len(rows) == 1
        assert rows[0]["id"] == sw_id
        assert rows[0]["abandoned_by_promote_at"] is not None
