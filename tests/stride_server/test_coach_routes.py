"""US-006 acceptance: ``/coach/conversations/qa/messages`` + history endpoint.

Verifies:
- POST QA returns an assistant message after running the graph
- POST QA ignores any client-supplied ``thread_id`` field
- POST QA's response thread_id matches ``user_id:qa:<shanghai today>``
- GET history returns 403 for cross-user thread_id
- GET history returns 400 for malformed thread_id
- GET history returns 200 with the conversation messages for an own thread
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from stride_server.config.models import AuthConfig, ServerConfig

USER_UUID = "11111111-2222-4aaa-89ab-123456789012"
OTHER_UUID = "22222222-2222-4aaa-89ab-123456789012"


# ---------------------------------------------------------------------------
# RSA / token helpers (cloned from test_master_plan_review.py pattern)
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# App-with-coach-router fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def coach_client(tmp_path, monkeypatch, rsa_keypair):
    """Mount only the coach router with a tmp_path-backed checkpointer and
    a deterministic FakeChatModelWithTools."""
    private_pem, public_pem = rsa_keypair

    # Bearer wiring
    import stride_server.bearer as bearer

    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    # Isolate user DB roots — the coach toolkit opens Database(user=...) on
    # any read tool call.
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    # Pre-create the user directory so the SQLite-backed adapters don't
    # complain when an unrelated read tool runs.
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)

    # Wire test checkpointer + LLM
    from stride_server import coach_runtime
    from stride_server.coach_adapters.persistence.checkpointer import AzureTableCheckpointSaver
    from stride_server.coach_adapters.persistence.file_backend import FileCheckpointStore

    coach_runtime.reset_for_tests()
    checkpointer = AzureTableCheckpointSaver(store=FileCheckpointStore(tmp_path / "ckpts"))
    coach_runtime.set_checkpointer_for_tests(checkpointer)

    # Mount the coach router behind require_bearer
    from stride_server.bearer import require_bearer
    from stride_server.routes import coach as coach_routes

    app = FastAPI()
    app.state.config = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(public_key_pem=public_pem)
    )
    app.include_router(coach_routes.router, dependencies=[Depends(require_bearer)])
    client = TestClient(app, raise_server_exceptions=True)

    yield client, private_pem, checkpointer

    coach_runtime.reset_for_tests()


def _set_canned_llm(responses: list[AIMessage]) -> None:
    """Install a fake chat model that returns the provided responses in order."""
    import sys

    if "." not in sys.path:
        sys.path.insert(0, ".")
    from tests.coach.stubs.fake_llm import FakeChatModelWithTools
    from stride_server import coach_runtime

    coach_runtime.set_generator_llm_for_tests(FakeChatModelWithTools(responses=responses))


# ---------------------------------------------------------------------------
# POST qa/messages
# ---------------------------------------------------------------------------


def test_qa_post_returns_assistant_response(coach_client):
    client, private_pem, _ = coach_client
    _set_canned_llm([AIMessage(content="你的状态看起来还不错，今天可以正常训练。")])

    resp = client.post(
        "/api/users/me/coach/conversations/qa/messages",
        json={"message": "我最近疲劳吗？"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # chat-completions content → single text part with no phase
    assert isinstance(body["parts"], list)
    assert len(body["parts"]) == 1
    part = body["parts"][0]
    assert part["kind"] == "text"
    assert part["text"].startswith("你的状态看起来")
    assert part["phase"] is None
    assert body["thread_id"].startswith(f"{USER_UUID}:qa:")
    assert body["iteration"] >= 1


def test_qa_post_responses_api_content_splits_into_parts(coach_client):
    """When the LLM is on the Responses API, AIMessage.content is a list of
    typed blocks (output_text + reasoning + function_call + …). The route
    must surface them as separate AssistantPart entries with the right
    kind/phase."""
    client, private_pem, _ = coach_client
    responses_ai_message = AIMessage(
        content=[
            {
                "type": "reasoning",
                "id": "rs_001",
                "summary": [{"type": "summary_text", "text": "用户问疲劳；先取健康数据。"}],
            },
            {
                "type": "text",
                "id": "msg_002",
                "text": "我先看一下你最近的疲劳数据。",
                "annotations": [],
                "phase": "commentary",
            },
            {
                "type": "function_call",
                "id": "call_003",
                "call_id": "call_003",
                "name": "get_health_snapshot",
                "arguments": "{}",
            },
            {
                "type": "text",
                "id": "msg_004",
                "text": "你最近 TSB 偏疲劳，建议今天降一档强度。",
                "annotations": [],
                "phase": "final_answer",
            },
        ]
    )
    _set_canned_llm([responses_ai_message])

    resp = client.post(
        "/api/users/me/coach/conversations/qa/messages",
        json={"message": "我最近疲劳吗？"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    parts = resp.json()["parts"]
    assert [p["kind"] for p in parts] == ["reasoning", "text", "tool_meta", "text"]
    assert parts[0]["text"] == "用户问疲劳；先取健康数据。"
    assert parts[1]["phase"] == "commentary"
    assert parts[2]["text"] == "调用 get_health_snapshot"
    assert parts[3]["phase"] == "final_answer"
    assert parts[3]["text"].startswith("你最近 TSB")


def test_qa_post_ignores_client_supplied_thread_id(coach_client):
    """The body model uses ``extra=ignore``; even if a client sends a
    ``thread_id`` we trust only the server-generated one."""
    client, private_pem, _ = coach_client
    _set_canned_llm([AIMessage(content="ok")])
    forged_tid = f"{OTHER_UUID}:qa:2026-05-13"

    resp = client.post(
        "/api/users/me/coach/conversations/qa/messages",
        json={"message": "hi", "thread_id": forged_tid},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Server thread_id starts with caller's UUID, NOT the forged OTHER_UUID
    assert body["thread_id"].startswith(f"{USER_UUID}:qa:")
    assert body["thread_id"] != forged_tid
    assert OTHER_UUID not in body["thread_id"]


def test_qa_post_requires_bearer(coach_client):
    client, _, _ = coach_client
    resp = client.post(
        "/api/users/me/coach/conversations/qa/messages",
        json={"message": "hi"},
    )
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET history endpoint
# ---------------------------------------------------------------------------


def test_history_cross_user_returns_403(coach_client):
    client, private_pem, _ = coach_client
    foreign_tid = f"{OTHER_UUID}:qa:2026-05-13"
    resp = client.get(
        f"/api/users/me/coach/threads/{foreign_tid}/messages",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 403, resp.text


def test_history_malformed_thread_id_returns_400(coach_client):
    client, private_pem, _ = coach_client
    for bad in ("not-a-thread-id", "only:two", f"{USER_UUID}:bogus:key"):
        resp = client.get(
            f"/api/users/me/coach/threads/{bad}/messages",
            headers=_auth(_token(private_pem)),
        )
        assert resp.status_code == 400, f"{bad!r} got {resp.status_code}"


def test_history_unknown_own_thread_returns_empty(coach_client):
    client, private_pem, _ = coach_client
    own_tid = f"{USER_UUID}:qa:2026-05-13"
    resp = client.get(
        f"/api/users/me/coach/threads/{own_tid}/messages",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user_id"] == USER_UUID
    assert body["scope"] == "qa"
    assert body["messages"] == []


def test_history_returns_messages_after_qa_post(coach_client):
    """Post one message, then GET the thread history — should include
    both user and assistant turns; assistant uses ``parts`` shape."""
    client, private_pem, _ = coach_client
    _set_canned_llm([AIMessage(content="你今天看起来精神。")])

    post = client.post(
        "/api/users/me/coach/conversations/qa/messages",
        json={"message": "我感觉怎么样？"},
        headers=_auth(_token(private_pem)),
    )
    assert post.status_code == 200, post.text
    thread_id = post.json()["thread_id"]

    resp = client.get(
        f"/api/users/me/coach/threads/{thread_id}/messages",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    roles = [m["role"] for m in body["messages"]]
    assert "user" in roles
    assert "assistant" in roles
    # User turns keep raw content; assistant turns use parts and leave content
    # empty.
    user_contents = [m["content"] for m in body["messages"] if m["role"] == "user"]
    assistant_msgs = [m for m in body["messages"] if m["role"] == "assistant"]
    assert "我感觉怎么样？" in user_contents
    assert assistant_msgs
    assistant_texts = [
        p["text"]
        for m in assistant_msgs
        for p in m["parts"]
        if p["kind"] == "text"
    ]
    assert "你今天看起来精神。" in assistant_texts


# ---------------------------------------------------------------------------
# US-007: plan-versions audit endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def coach_client_with_versions(coach_client, tmp_path, monkeypatch):
    """Wire an in-memory FileWeeklyVersionStore into the coach route module."""
    from stride_server.coach_adapters.persistence.weekly_version_store import (
        FileWeeklyVersionStore,
        WeeklyPlanVersion,
    )
    from stride_server.routes import coach as coach_routes

    store = FileWeeklyVersionStore(tmp_path / "weekly_versions")
    coach_routes.set_weekly_version_store_for_tests(store)
    yield (*coach_client, store)
    coach_routes.set_weekly_version_store_for_tests(None)


def _seed_version(store, *, user_id, folder, version_id, parent=None):
    from stride_server.coach_adapters.persistence.weekly_version_store import (
        WeeklyPlanVersion,
    )

    return store.add_version(
        WeeklyPlanVersion(
            user_id=user_id,
            folder=folder,
            version_id=version_id,
            parent_version_id=parent,
            artifact_json='{"schema":"weekly-plan/v1","sessions":[]}',
            rationale=f"seed for {version_id}",
            applied_op_ids=["op-1"],
            proposal_id=None,
            created_by="claude-sonnet-4-5",
            created_at="2026-05-13T10:00:00Z",
        )
    )


def test_plan_versions_list_reverse_chronological(coach_client_with_versions):
    client, private_pem, _, store = coach_client_with_versions
    import time as _time

    folder = "2026-05-11_05-17(P1W3)"
    _seed_version(store, user_id=USER_UUID, folder=folder, version_id="v1")
    _time.sleep(0.01)
    _seed_version(store, user_id=USER_UUID, folder=folder, version_id="v2", parent="v1")
    _time.sleep(0.01)
    _seed_version(store, user_id=USER_UUID, folder=folder, version_id="v3", parent="v2")

    resp = client.get(
        f"/api/users/me/coach/plan-versions/week/{folder}",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["folder"] == folder
    assert [v["version_id"] for v in body["versions"]] == ["v3", "v2", "v1"]
    assert body["versions"][0]["parent_version_id"] == "v2"
    assert body["versions"][1]["parent_version_id"] == "v1"
    assert body["versions"][2]["parent_version_id"] is None


def test_plan_versions_list_isolates_users(coach_client_with_versions):
    client, private_pem, _, store = coach_client_with_versions
    folder = "2026-05-11_05-17(P1W3)"
    _seed_version(store, user_id=USER_UUID, folder=folder, version_id="mine")
    _seed_version(store, user_id=OTHER_UUID, folder=folder, version_id="theirs")
    resp = client.get(
        f"/api/users/me/coach/plan-versions/week/{folder}",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert {v["version_id"] for v in body["versions"]} == {"mine"}


def test_plan_versions_detail_returns_artifact(coach_client_with_versions):
    client, private_pem, _, store = coach_client_with_versions
    folder = "2026-05-11_05-17(P1W3)"
    _seed_version(store, user_id=USER_UUID, folder=folder, version_id="v1")

    resp = client.get(
        f"/api/users/me/coach/plan-versions/week/{folder}/v1",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["folder"] == folder
    assert body["version_id"] == "v1"
    assert body["artifact"] == {"schema": "weekly-plan/v1", "sessions": []}
    assert body["applied_op_ids"] == ["op-1"]
    assert body["created_by"] == "claude-sonnet-4-5"


def test_plan_versions_detail_missing_returns_404(coach_client_with_versions):
    client, private_pem, _, _ = coach_client_with_versions
    resp = client.get(
        "/api/users/me/coach/plan-versions/week/2026-05-11_05-17(P1W3)/nope",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 404


def test_plan_versions_detail_blocks_cross_user_access(coach_client_with_versions):
    """Other user's version_id is not retrievable by this user even if the
    UUID is guessed — partition includes user_id so the lookup misses."""
    client, private_pem, _, store = coach_client_with_versions
    folder = "2026-05-11_05-17(P1W3)"
    _seed_version(store, user_id=OTHER_UUID, folder=folder, version_id="secret")
    resp = client.get(
        f"/api/users/me/coach/plan-versions/week/{folder}/secret",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 404


def test_weekly_version_store_from_config_uses_file_backend(tmp_path):
    from stride_server.coach_adapters.persistence.weekly_version_store import (
        weekly_version_store_from_config,
    )
    from stride_server.config.models import CoachPersistenceConfig

    store = weekly_version_store_from_config(
        CoachPersistenceConfig(file_backend_dir=str(tmp_path / "coach"))
    )

    assert store.__class__.__name__ == "FileWeeklyVersionStore"


def test_checkpointer_from_config_uses_file_store(tmp_path):
    from stride_server.coach_adapters.persistence.checkpointer import AzureTableCheckpointSaver
    from stride_server.config.models import CoachPersistenceConfig

    saver = AzureTableCheckpointSaver.from_config(
        CoachPersistenceConfig(file_backend_dir=str(tmp_path / "coach"))
    )

    assert saver.store.__class__.__name__ == "FileCheckpointStore"
