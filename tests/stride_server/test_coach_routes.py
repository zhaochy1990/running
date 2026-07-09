"""Coach history endpoints + removed legacy qa/messages route.

Verifies:
- the old POST QA route is no longer exposed
- GET history returns 403 for cross-user thread_id
- GET history returns 400 for malformed thread_id
- GET history returns 200 with conversation messages for own qa/coach threads
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

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
    """Mount only the coach router with a tmp_path-backed checkpointer."""
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


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}


def _metadata(step: int = 0) -> dict:
    return {"source": "input", "step": step, "writes": {}, "parents": {}}


def _seed_history(checkpointer, thread_id: str, history: list[object]) -> None:
    checkpoint = {
        "v": 1,
        "id": "seed-history",
        "ts": "2026-05-13T10:00:00Z",
        "channel_values": {"history": history},
        "channel_versions": {"history": "1"},
        "versions_seen": {},
        "updated_channels": ["history"],
    }
    checkpointer.put(_config(thread_id), checkpoint, _metadata(), {"history": "1"})


# ---------------------------------------------------------------------------
# Removed legacy POST qa/messages
# ---------------------------------------------------------------------------


def test_legacy_qa_post_route_is_removed(coach_client):
    client, private_pem, _ = coach_client
    resp = client.post(
        "/api/users/me/coach/conversations/" + "qa/messages",
        json={"message": "hi"},
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 404, resp.text


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


def test_history_returns_seeded_qa_messages(coach_client):
    """History still supports old qa thread ids for already-persisted audit data."""
    client, private_pem, checkpointer = coach_client
    thread_id = f"{USER_UUID}:qa:2026-05-13"
    _seed_history(
        checkpointer,
        thread_id,
        [
            SystemMessage(content="internal prompt"),
            HumanMessage(content="我感觉怎么样？"),
            AIMessage(content="你今天看起来精神。"),
            ToolMessage(content="{}", tool_call_id="call-1", name="get_health_snapshot"),
        ],
    )

    resp = client.get(
        f"/api/users/me/coach/threads/{thread_id}/messages",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope"] == "qa"
    assert body["key"] == "2026-05-13"
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["user", "assistant", "tool"]
    # User turns keep raw content; assistant turns use parts and leave content
    # empty. System messages are skipped.
    assert body["messages"][0]["content"] == "我感觉怎么样？"
    assert body["messages"][1]["content"] == ""
    assert body["messages"][1]["parts"][0]["text"] == "你今天看起来精神。"
    assert body["messages"][2]["content"] == "{}"
    assert body["messages"][2]["name"] == "get_health_snapshot"
    assert body["messages"][2]["tool_call_id"] == "call-1"


def test_history_supports_orchestrator_coach_thread(coach_client):
    client, private_pem, checkpointer = coach_client
    thread_id = f"{USER_UUID}:coach:qa-2026-05-13"
    _seed_history(
        checkpointer,
        thread_id,
        [
            HumanMessage(content="我最近状态怎么样？"),
            AIMessage(content="状态问答由 orchestrator session 保存。"),
        ],
    )

    resp = client.get(
        f"/api/users/me/coach/threads/{thread_id}/messages",
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope"] == "coach"
    assert body["key"] == "qa-2026-05-13"
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]
    assert body["messages"][1]["parts"][0]["text"] == "状态问答由 orchestrator session 保存。"


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
