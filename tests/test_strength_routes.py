"""Tests for routes/strength.py — per-week strength training tab data."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.db import Database
from stride_core.plan_spec import (
    PlannedSession,
    SessionKind,
)
from stride_core.workout_spec import (
    NormalizedStrengthWorkout,
    StrengthExerciseSpec,
    StrengthTargetKind,
)


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
WEEK = "2026-05-04_05-10(P1W1)"


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


def _seed_strength(db: Database, week: str) -> None:
    db.upsert_weekly_plan(week, "# Plan", generated_by="test-model")
    db.set_weekly_plan_structured_status(week, status="fresh", parsed_from_md_hash="x")
    spec = NormalizedStrengthWorkout(
        name="[STRIDE] 力量基线",
        date="2026-05-04",
        exercises=(
            # T1231 — verdict=go in review_notes.json → image_url present
            StrengthExerciseSpec(
                canonical_id="wall_sit",
                display_name="靠墙静蹲",
                sets=2, target_kind=StrengthTargetKind.TIME_S, target_value=60,
                rest_seconds=30, provider_id="T1231",
            ),
            # T1174 — verdict=hold → image_url None (text-only)
            StrengthExerciseSpec(
                canonical_id="ski_jump",
                display_name="滑雪跨步",
                sets=2, target_kind=StrengthTargetKind.REPS, target_value=10,
                rest_seconds=30, provider_id="T1174",
            ),
            # canonical_id alias path: single_leg_wall_sit → SL_WALLSIT (verdict=go)
            StrengthExerciseSpec(
                canonical_id="single_leg_wall_sit",
                display_name="单腁靠墙静蹲（左/右）",
                sets=2, target_kind=StrengthTargetKind.TIME_S, target_value=60,
                rest_seconds=30, provider_id=None,
            ),
            # No match at all (provider_id+canonical_id miss) → text-only,
            # everything library-derived comes back null/empty.
            StrengthExerciseSpec(
                canonical_id="completely_unknown",
                display_name="未知动作",
                sets=1, target_kind=StrengthTargetKind.REPS, target_value=8,
                rest_seconds=30, provider_id="TZZZZ",
            ),
        ),
    )
    sessions = [
        PlannedSession(
            date="2026-05-04", session_index=0,
            kind=SessionKind.STRENGTH, summary="[STRIDE] 力量基线",
            spec=spec,
        ),
        # A run session — must be filtered out of the strength response.
        PlannedSession(
            date="2026-05-05", session_index=0,
            kind=SessionKind.REST, summary="rest",
        ),
    ]
    db.upsert_planned_sessions(week, sessions)


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

    import stride_core.db as core_db
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.strength import router as strength_router

    app = FastAPI()
    app.include_router(
        strength_router,
        dependencies=[Depends(require_bearer), Depends(verify_path_user)],
    )

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_strength_tab_joins_library_data(app_client):
    client, token, tmp_path = app_client
    db = Database(user=USER_UUID)
    _seed_strength(db, WEEK)

    res = client.get(f"/api/{USER_UUID}/weeks/{WEEK}/strength", headers=_auth(token))
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["folder"] == WEEK
    assert len(data["sessions"]) == 1, "REST session must be filtered out"

    sess = data["sessions"][0]
    assert sess["date"] == "2026-05-04"
    assert sess["session_index"] == 0
    assert sess["summary"] == "[STRIDE] 力量基线"

    exs = sess["exercises"]
    assert len(exs) == 4

    # 1. T1231 — go verdict → image_url present, descriptions populated
    e1 = exs[0]
    assert e1["code"] == "T1231"
    assert e1["image_url"] == "/strength_illustrations/output/T1231/v1.png"
    assert e1["name_zh"] == "靠墙静蹲"
    assert len(e1["key_points"]) >= 2
    assert len(e1["muscle_focus"]) >= 1

    # 2. T1174 — hold verdict → text-only (image_url None) but descriptions present
    e2 = exs[1]
    assert e2["code"] == "T1174"
    assert e2["image_url"] is None, "hold verdict → image must not surface"
    assert len(e2["key_points"]) >= 1, "descriptions still come through"

    # 3. canonical_id alias → SL_WALLSIT
    e3 = exs[2]
    assert e3["code"] == "SL_WALLSIT"
    assert e3["image_url"] == "/strength_illustrations/output/SL_WALLSIT/v1.png"

    # 4. No match → null code + empty arrays, but display_name preserved
    e4 = exs[3]
    assert e4["code"] is None
    assert e4["image_url"] is None
    assert e4["key_points"] == []
    assert e4["muscle_focus"] == []
    assert e4["common_mistakes"] == []
    assert e4["display_name"] == "未知动作"


def test_strength_tab_invalid_folder(app_client):
    client, token, _ = app_client
    res = client.get(
        f"/api/{USER_UUID}/weeks/not-a-week/strength",
        headers=_auth(token),
    )
    assert res.status_code == 400


def test_strength_tab_no_strength_returns_empty(app_client):
    client, token, _ = app_client
    db = Database(user=USER_UUID)
    db.upsert_weekly_plan(WEEK, "# Plan", generated_by="test-model")
    db.set_weekly_plan_structured_status(WEEK, status="fresh", parsed_from_md_hash="x")
    db.upsert_planned_sessions(WEEK, [
        PlannedSession(
            date="2026-05-05", session_index=0,
            kind=SessionKind.REST, summary="rest",
        ),
    ])

    res = client.get(f"/api/{USER_UUID}/weeks/{WEEK}/strength", headers=_auth(token))
    assert res.status_code == 200
    assert res.json() == {"folder": WEEK, "sessions": []}


def test_strength_tab_requires_bearer(app_client):
    client, _token, _ = app_client
    res = client.get(f"/api/{USER_UUID}/weeks/{WEEK}/strength")
    assert res.status_code == 401


def test_strength_library_lookup_basic():
    """Direct lookup test — independent of HTTP layer."""
    from stride_server.strength_library import lookup

    e = lookup(provider_id="T1061")  # bodyweight squat — go
    assert e is not None
    assert e.code == "T1061"
    assert e.image_url is not None
    assert "股四头肌" in e.muscle_focus

    # T1273 is borderline_go → image not surfaced
    e = lookup(provider_id="T1273")
    assert e is not None
    assert e.image_url is None

    # Unknown
    assert lookup(provider_id="TZZZZ") is None
    assert lookup(canonical_id="not_a_real_alias") is None
