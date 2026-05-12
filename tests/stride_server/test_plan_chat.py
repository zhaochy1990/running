"""Tests for POST /api/{user}/plan/{folder}/chat/messages and /apply (T31)."""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"
FOLDER = "2026-05-04_05-10(W1)"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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

    # Ensure user dir exists so Database() can open.
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.plan_chat import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _seed_sessions(tmp_path):
    """Seed planned sessions for FOLDER so the route doesn't return 404."""
    from stride_core.db import Database
    db = Database(user=USER_UUID)
    db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, total_distance_m)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (FOLDER, "2026-05-05", 0, "run", "E 10K 有氧", 10000),
    )
    db._conn.commit()
    db.close()


# ---------------------------------------------------------------------------
# Fake LLM helpers
# ---------------------------------------------------------------------------

_VALID_LLM_JSON = """{
  "ai_response": "好的，已为你将周三调整为休息日",
  "ops": [
    {
      "op": "replace_kind",
      "date": "2026-05-07",
      "session_index": 0,
      "old_value": {"summary": "E 8K"},
      "new_value": {"summary": "休息"},
      "spec_patch": {"kind": "rest", "summary": "休息"}
    }
  ]
}"""

_NON_JSON_RESPONSE = "好的，你的计划看起来很合理，不需要修改。"


def _make_fake_llm(response: str):
    """Return a FakeLLMClient class whose chat_sync returns the given string."""
    class FakeLLMClient:
        def __init__(self):
            pass

        def chat_sync(self, system, messages, max_tokens=2048):
            return response

    return FakeLLMClient


# ---------------------------------------------------------------------------
# Test 1: valid JSON → /messages 200, diff.ops non-empty
# ---------------------------------------------------------------------------


def test_messages_valid_json_returns_diff(app_client, tmp_path, monkeypatch):
    """mock LLMClient.chat_sync returns valid JSON → /messages 200, diff.ops non-empty."""
    client, token, tmp_path, _ = app_client
    _seed_sessions(tmp_path)

    import stride_server.routes.plan_chat as plan_chat_mod
    monkeypatch.setattr(plan_chat_mod, "LLMClient", _make_fake_llm(_VALID_LLM_JSON))

    resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/messages",
        json={"message": "将周三改为休息日"},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "ai_response" in data
    assert data["ai_response"] == "好的，已为你将周三调整为休息日"
    assert data["diff"] is not None
    assert len(data["diff"]["ops"]) == 1
    assert data["diff"]["ops"][0]["op"] == "replace_kind"
    assert data["diff"]["diff_id"]  # uuid string


# ---------------------------------------------------------------------------
# Test 2: LLMUnavailable → 503
# ---------------------------------------------------------------------------


def test_messages_llm_unavailable_returns_503(app_client, tmp_path, monkeypatch):
    """mock LLMClient raises LLMUnavailable → /messages 503."""
    client, token, tmp_path, _ = app_client
    _seed_sessions(tmp_path)

    from stride_server.llm_client import LLMUnavailable

    class FakeUnavailableClient:
        def __init__(self):
            raise LLMUnavailable("no credentials")

    import stride_server.routes.plan_chat as plan_chat_mod
    monkeypatch.setattr(plan_chat_mod, "LLMClient", FakeUnavailableClient)

    resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/messages",
        json={"message": "调整计划"},
        headers=_auth(token),
    )
    assert resp.status_code == 503, resp.text


# ---------------------------------------------------------------------------
# Test 3: non-JSON LLM response → ai_response pass-through, diff = null
# ---------------------------------------------------------------------------


def test_messages_non_json_response_graceful_fallback(app_client, tmp_path, monkeypatch):
    """mock LLMClient returns non-JSON → ai_response透传, diff = null."""
    client, token, tmp_path, _ = app_client
    _seed_sessions(tmp_path)

    import stride_server.routes.plan_chat as plan_chat_mod
    monkeypatch.setattr(plan_chat_mod, "LLMClient", _make_fake_llm(_NON_JSON_RESPONSE))

    resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/messages",
        json={"message": "计划还好吗"},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ai_response"] == _NON_JSON_RESPONSE
    assert data["diff"] is None


# ---------------------------------------------------------------------------
# Test 4: /apply diff_id 不存在 → 404
# ---------------------------------------------------------------------------


def test_apply_unknown_diff_id_returns_404(app_client, tmp_path):
    """Apply with unknown diff_id → 404."""
    client, token, tmp_path, _ = app_client
    _seed_sessions(tmp_path)

    resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/apply",
        json={"diff_id": "nonexistent-diff-id", "accepted_op_ids": []},
        headers=_auth(token),
    )
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# Test 5: /apply 部分 accepted_op_ids → apply_diff called with correct ids
# ---------------------------------------------------------------------------


def test_apply_partial_ops_calls_apply_diff(app_client, tmp_path, monkeypatch):
    """Store a pending diff, then /apply with a subset of op_ids → apply_diff invoked."""
    client, token, tmp_path, _ = app_client
    _seed_sessions(tmp_path)

    import stride_server.routes.plan_chat as plan_chat_mod
    monkeypatch.setattr(plan_chat_mod, "LLMClient", _make_fake_llm(_VALID_LLM_JSON))

    # First call /messages to get a diff stored in-memory
    msg_resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/messages",
        json={"message": "改计划"},
        headers=_auth(token),
    )
    assert msg_resp.status_code == 200, msg_resp.text
    diff = msg_resp.json()["diff"]
    assert diff is not None
    diff_id = diff["diff_id"]
    op_id = diff["ops"][0]["id"]

    # Patch apply_diff to capture the call
    called_with = {}

    def fake_apply_diff(plan_store, folder, plan_diff, accepted_op_ids):
        called_with["folder"] = folder
        called_with["accepted_op_ids"] = accepted_op_ids

    monkeypatch.setattr(plan_chat_mod, "apply_diff", fake_apply_diff)

    apply_resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/apply",
        json={"diff_id": diff_id, "accepted_op_ids": [op_id]},
        headers=_auth(token),
    )
    assert apply_resp.status_code == 200, apply_resp.text
    data = apply_resp.json()
    assert data["applied"] == 1
    assert data["folder"] == FOLDER
    assert called_with["accepted_op_ids"] == [op_id]


# ---------------------------------------------------------------------------
# Test 6: folder 不存在 → 404
# ---------------------------------------------------------------------------


def test_messages_folder_not_found_returns_404(app_client, tmp_path, monkeypatch):
    """folder with no planned sessions → /messages 404."""
    client, token, tmp_path, _ = app_client

    # Do NOT seed sessions — folder effectively doesn't exist
    import stride_server.routes.plan_chat as plan_chat_mod
    monkeypatch.setattr(plan_chat_mod, "LLMClient", _make_fake_llm(_VALID_LLM_JSON))

    resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/messages",
        json={"message": "调整计划"},
        headers=_auth(token),
    )
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# Test 7: user mismatch → 403
# ---------------------------------------------------------------------------


def test_messages_user_mismatch_returns_403(app_client, tmp_path, monkeypatch):
    """Path user != JWT sub → /messages 403."""
    client, token, tmp_path, private_pem = app_client
    _seed_sessions(tmp_path)

    import stride_server.routes.plan_chat as plan_chat_mod
    monkeypatch.setattr(plan_chat_mod, "LLMClient", _make_fake_llm(_VALID_LLM_JSON))

    # Token belongs to OTHER_UUID but path uses USER_UUID
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.post(
        f"/api/{USER_UUID}/plan/{FOLDER}/chat/messages",
        json={"message": "调整计划"},
        headers=_auth(other_token),
    )
    assert resp.status_code == 403, resp.text
