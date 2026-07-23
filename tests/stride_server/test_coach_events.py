"""Trusted coach events — applied/abandoned receipts recorded on the thread and
surfaced as role="event" history rows (never faked SystemMessages)."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from coach.contracts import CoachEvent, TargetRef
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
def client_with_saver(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    import stride_server.bearer as bearer

    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    from stride_server.bearer import require_bearer
    from stride_server.routes import coach as coach_routes
    import stride_server.coach_runtime as coach_runtime

    saver = InMemorySaver()
    # One shared in-memory checkpointer for the recorder and the history read.
    monkeypatch.setattr(coach_routes, "get_checkpointer", lambda: saver)
    monkeypatch.setattr(coach_runtime, "get_checkpointer", lambda: saver)

    app = FastAPI()
    app.state.config = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(public_key_pem=public_pem),
    )
    app.include_router(coach_routes.router, dependencies=[Depends(require_bearer)])
    return TestClient(app, raise_server_exceptions=True), private_pem, coach_routes, saver


def test_abandon_records_event_on_the_requested_session(client_with_saver):
    client, private_pem, _routes, _saver = client_with_saver
    resp = client.post(
        "/api/users/me/coach/proposals/abandon",
        json={
            "session_id": "session-alt",
            "target": {"kind": "week", "folder": "2026-07-13_07-19"},
            "summary": "先不改了",
        },
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recorded"] is True

    hist = client.get(
        "/api/users/me/coach/sessions/session-alt/messages",
        headers=_auth(_token(private_pem)),
    )
    assert hist.status_code == 200, hist.text
    events = [m for m in hist.json()["messages"] if m["role"] == "event"]
    assert len(events) == 1
    assert events[0]["event_type"] == "proposal_abandoned"
    assert events[0]["status"] == "abandoned"
    assert events[0]["summary"] == "先不改了"

    default_hist = client.get(
        "/api/users/me/coach/sessions/web-default/messages",
        headers=_auth(_token(private_pem)),
    )
    assert default_hist.status_code == 200, default_hist.text
    assert [m for m in default_hist.json()["messages"] if m["role"] == "event"] == []


def test_abandon_rejects_oversized_summary(client_with_saver):
    client, private_pem, _routes, _saver = client_with_saver
    response = client.post(
        "/api/users/me/coach/proposals/abandon",
        json={"session_id": "web-default", "summary": "x" * 513},
        headers=_auth(_token(private_pem)),
    )
    assert response.status_code == 422


def test_recorder_appends_events_in_order(client_with_saver):
    client, private_pem, _routes, saver = client_with_saver
    from stride_server.coach_adapters.orchestrator import record_coach_event

    for i in range(3):
        record_coach_event(
            user_id=USER_UUID,
            event=CoachEvent(
                type="weekly_plan_applied", status="applied",
                created_at=f"2026-07-18T0{i}:00:00Z", summary=f"apply {i}",
                target=TargetRef(kind="week", folder="2026-07-13_07-19"),
            ),
        )

    hist = client.get(
        "/api/users/me/coach/sessions/web-default/messages",
        headers=_auth(_token(private_pem)),
    )
    events = [m for m in hist.json()["messages"] if m["role"] == "event"]
    assert [e["summary"] for e in events] == ["apply 0", "apply 1", "apply 2"]
