"""GET /api/users/me/coach/sessions/{session_id}/messages — JWT-derived thread,
debug-user gating, stable message ids."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

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


class _FakeCheckpointer:
    def __init__(self, history, extra_channels=None):
        self._history = history
        self._extra = extra_channels or {}

    def get_tuple(self, config):
        channel_values = {"history": self._history, **self._extra}

        class _Tup:
            checkpoint = {
                "ts": "2026-07-18T00:00:00Z",
                "channel_values": channel_values,
            }

        return _Tup() if self._history is not None else None


def _client(monkeypatch, rsa_keypair, *, history, debug_users=(), extra_channels=None):
    private_pem, public_pem = rsa_keypair
    import stride_server.bearer as bearer

    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    from stride_server.bearer import require_bearer
    from stride_server.routes import coach as coach_routes

    monkeypatch.setattr(
        coach_routes, "get_checkpointer",
        lambda: _FakeCheckpointer(history, extra_channels),
    )
    # Debug-user gating is config-driven; inject via the route's accessor so this
    # test doesn't depend on the (separately-owned) PlanConfig field name.
    monkeypatch.setattr(coach_routes, "_debug_users", lambda _cfg: tuple(debug_users))

    app = FastAPI()
    app.state.config = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(public_key_pem=public_pem),
    )
    app.include_router(coach_routes.router, dependencies=[Depends(require_bearer)])
    return TestClient(app, raise_server_exceptions=True), private_pem


_HISTORY = [
    HumanMessage(content="我状态如何"),
    AIMessage(
        content=[
            {"type": "reasoning", "summary": [{"text": "内部推理"}]},
            {"type": "function_call", "name": "read_status"},
            {"type": "text", "text": "你状态不错"},
        ]
    ),
    ToolMessage(content="tool output", name="read_status", tool_call_id="call-1"),
]


def test_session_messages_normal_user_hides_reasoning_and_tools(monkeypatch, rsa_keypair):
    client, private_pem = _client(monkeypatch, rsa_keypair, history=_HISTORY)
    resp = client.get(
        "/api/users/me/coach/sessions/s1/messages", headers=_auth(_token(private_pem))
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["debug"] is False
    assert body["thread_id"] == f"{USER_UUID}:coach:s1"
    roles = [m["role"] for m in body["messages"]]
    assert "tool" not in roles
    kinds = [p["kind"] for m in body["messages"] for p in m["parts"]]
    assert "reasoning" not in kinds
    assert "tool_meta" not in kinds
    assert "text" in kinds
    # Stable ids present on every row.
    assert all(m["message_id"] for m in body["messages"])


def test_session_messages_debug_user_sees_reasoning_and_tools(monkeypatch, rsa_keypair):
    client, private_pem = _client(
        monkeypatch, rsa_keypair, history=_HISTORY, debug_users=(USER_UUID,)
    )
    resp = client.get(
        "/api/users/me/coach/sessions/s1/messages", headers=_auth(_token(private_pem))
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["debug"] is True
    roles = [m["role"] for m in body["messages"]]
    assert "tool" in roles
    kinds = [p["kind"] for m in body["messages"] for p in m["parts"]]
    assert "reasoning" in kinds
    assert "tool_meta" in kinds


def test_session_messages_empty_when_no_checkpoint(monkeypatch, rsa_keypair):
    client, private_pem = _client(monkeypatch, rsa_keypair, history=None)
    resp = client.get(
        "/api/users/me/coach/sessions/s1/messages", headers=_auth(_token(private_pem))
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["messages"] == []


def test_session_messages_requires_auth(monkeypatch, rsa_keypair):
    client, _private_pem = _client(monkeypatch, rsa_keypair, history=_HISTORY)
    resp = client.get("/api/users/me/coach/sessions/s1/messages")
    assert resp.status_code in (401, 403)


def test_session_messages_turn_id_and_receipt_created_at(monkeypatch, rsa_keypair):
    """user + assistant of one turn share turn_id; assistant created_at comes
    from the turn receipt (first-run ts), and stable ids don't duplicate."""
    thread = f"{USER_UUID}:coach:s1"
    history = [
        HumanMessage(content="我状态如何", id="t-1:u"),
        AIMessage(content="你状态不错", id="t-1:a"),
    ]
    receipts = [
        {"client_turn_id": "t-1", "fingerprint": "fp", "turn_response": {},
         "message_id": "t-1:a", "created_at": "2026-07-18T09:30:00Z"},
    ]
    client, private_pem = _client(
        monkeypatch, rsa_keypair, history=history,
        extra_channels={"turn_receipts": receipts},
    )
    resp = client.get(
        "/api/users/me/coach/sessions/s1/messages", headers=_auth(_token(private_pem))
    )
    assert resp.status_code == 200, resp.text
    msgs = resp.json()["messages"]
    user_msg = next(m for m in msgs if m["role"] == "user")
    asst_msg = next(m for m in msgs if m["role"] == "assistant")
    assert user_msg["turn_id"] == "t-1"
    assert asst_msg["turn_id"] == "t-1"
    assert asst_msg["message_id"] == "t-1:a"
    # created_at comes from the receipt (not the checkpoint ts).
    assert asst_msg["created_at"] == "2026-07-18T09:30:00Z"
    assert user_msg["created_at"] == "2026-07-18T09:30:00Z"
    # Exactly one user + one assistant row (stable ids => no dup on replay).
    assert len(msgs) == 2
