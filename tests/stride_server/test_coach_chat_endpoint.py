"""S1h — POST /api/users/me/coach/chat HTTP contract.

Isolates the route from the LLM/DB by monkeypatching ``run_coach_turn`` to a
fake TurnResponse. The orchestration logic itself is covered by the core graph
tests; here we verify auth, request/response shape, and session threading.
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from coach.contracts import ProposalCard, TargetRef, TurnResponse
from stride_core.plan_diff import PlanDiff
from stride_server.config.models import AuthConfig, ServerConfig

USER_UUID = "11111111-2222-4aaa-89ab-123456789012"


@pytest.fixture
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        private.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
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


@pytest.fixture
def chat_client(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    import stride_server.bearer as bearer

    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    from stride_server.bearer import require_bearer
    from stride_server.routes import coach as coach_routes

    app = FastAPI()
    app.state.config = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(public_key_pem=public_pem)
    )
    app.include_router(coach_routes.router, dependencies=[Depends(require_bearer)])
    client = TestClient(app, raise_server_exceptions=True)
    return client, private_pem, coach_routes


def test_chat_returns_reply_and_session_thread(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client

    captured: dict[str, object] = {}

    def _fake_turn(*, user_id: str, session_id: str, message: str) -> TurnResponse:
        captured.update(user_id=user_id, session_id=session_id, message=message)
        return TurnResponse(
            reply="你最近负荷偏高，注意恢复。",
            active_target=TargetRef(kind="week", folder="2026-W26"),
        )

    monkeypatch.setattr(coach_routes, "run_coach_turn", _fake_turn)

    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "sess-1", "message": "我状态如何"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reply"].startswith("你最近负荷偏高")
    assert body["session_id"] == "sess-1"
    assert body["thread_id"] == f"{USER_UUID}:coach:sess-1"
    assert body["clarification"] is None
    assert body["active_target"]["folder"] == "2026-W26"
    assert body["proposals"] == []
    # The handler forwarded the authenticated user + session to the driver.
    assert captured == {"user_id": USER_UUID, "session_id": "sess-1", "message": "我状态如何"}


def test_chat_surfaces_proposal_cards(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client

    diff = PlanDiff(diff_id="d1", folder="2026-W26", ops=[], ai_explanation="x", created_at="t")

    def _fake_turn(**_kw) -> TurnResponse:
        return TurnResponse(
            reply="已为你准备调整方案",
            proposals=[ProposalCard(specialist_id="weekly_plan", proposal=diff, summary="改周三")],
        )

    monkeypatch.setattr(coach_routes, "run_coach_turn", _fake_turn)
    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "s2", "message": "把周三改轻松跑"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    proposals = resp.json()["proposals"]
    assert len(proposals) == 1
    assert proposals[0]["specialist_id"] == "weekly_plan"
    assert proposals[0]["proposal"]["folder"] == "2026-W26"


def test_chat_clarify_turn_has_no_proposals(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client

    def _fake_turn(**_kw) -> TurnResponse:
        return TurnResponse(reply="你想了解还是调整？", clarification="你想了解还是调整？")

    monkeypatch.setattr(coach_routes, "run_coach_turn", _fake_turn)
    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "s3", "message": "嗯"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["clarification"] == "你想了解还是调整？"
    assert body["proposals"] == []


def test_chat_rejects_colon_in_session_id(chat_client, monkeypatch):
    """session_id with ':' would let a client forge a cross-user thread id."""
    client, private_pem, coach_routes = chat_client
    called = {"n": 0}

    def _fake_turn(**_kw):
        called["n"] += 1
        return TurnResponse(reply="x")

    monkeypatch.setattr(coach_routes, "run_coach_turn", _fake_turn)
    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "x:qa:2026-06-26", "message": "hi"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 422  # validator rejects before the driver runs
    assert called["n"] == 0


def test_chat_requires_auth(chat_client):
    client, _private_pem, _ = chat_client
    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "s1", "message": "hi"},
    )
    assert resp.status_code in (401, 403)


def test_chat_rejects_empty_message(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    monkeypatch.setattr(coach_routes, "run_coach_turn", lambda **_kw: TurnResponse(reply="x"))
    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "s1", "message": ""},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 422  # pydantic min_length
