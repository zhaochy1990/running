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


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/plan/{folder}/apply
# ---------------------------------------------------------------------------

_APPLY_FOLDER = "2026-06-22_06-28(W8)"


def _apply_body(folder: str = _APPLY_FOLDER, op_ids=("op1",)) -> dict:
    return {
        "diff": {
            "diff_id": "d1",
            "folder": folder,
            "ops": [
                {
                    "id": "op1",
                    "op": "move_session",
                    "date": "2026-06-24",
                    "session_index": 0,
                    "old_value": None,
                    "new_value": {"date": "2026-06-25", "session_index": 0},
                    "spec_patch": {"new_date": "2026-06-25", "new_session_index": 0},
                    "accepted": None,
                }
            ],
            "ai_explanation": "把周三挪到周四",
            "created_at": "2026-06-28T00:00:00Z",
        },
        "accepted_op_ids": list(op_ids),
    }


def _stub_apply(coach_routes, monkeypatch) -> dict:
    """Isolate the apply route from storage; capture its single save."""
    captured: dict[str, object] = {}
    from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan

    class _Store:
        def get_plan(self, user_id, folder):
            return WeeklyPlan(
                week_folder=folder,
                sessions=(PlannedSession(
                    date="2026-06-24", session_index=0,
                    kind=SessionKind.RUN, summary="run",
                ),),
            )

    monkeypatch.setattr(coach_routes, "get_weekly_plan_store", lambda: _Store())

    real_apply = coach_routes.apply_diff_to_weekly_plan

    def _fake_apply(plan, diff, accepted_op_ids):
        captured.update(folder=diff.folder, diff=diff, accepted=list(accepted_op_ids))
        return real_apply(plan, diff, accepted_op_ids)

    monkeypatch.setattr(coach_routes, "apply_diff_to_weekly_plan", _fake_apply)

    def _fake_save(user_id, plan, *, expected_folder=None, generated_by=None):
        captured.update(
            projection_user=user_id,
            projection_folder=expected_folder,
            projection_generated_by=generated_by,
            saved_plan=plan,
        )

    monkeypatch.setattr(coach_routes, "save_weekly_plan", _fake_save)
    return captured


def test_apply_lands_accepted_ops(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    captured = _stub_apply(coach_routes, monkeypatch)

    resp = client.post(
        f"/api/users/me/coach/plan/{_APPLY_FOLDER}/apply",
        json=_apply_body(),
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["applied"] == 1
    assert body["folder"] == _APPLY_FOLDER
    assert captured["accepted"] == ["op1"]
    assert captured["folder"] == _APPLY_FOLDER
    assert captured["projection_folder"] == _APPLY_FOLDER
    assert captured["saved_plan"].sessions[0].date == "2026-06-25"


def test_apply_drops_unknown_op_ids(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    captured = _stub_apply(coach_routes, monkeypatch)

    body = _apply_body(op_ids=("op1", "ghost"))
    resp = client.post(
        f"/api/users/me/coach/plan/{_APPLY_FOLDER}/apply",
        json=body,
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] == 1
    assert captured["accepted"] == ["op1"]  # 'ghost' isn't in diff.ops


def test_apply_rejects_folder_mismatch(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    _stub_apply(coach_routes, monkeypatch)

    resp = client.post(
        "/api/users/me/coach/plan/2026-06-15_06-21(W7)/apply",
        json=_apply_body(folder=_APPLY_FOLDER),  # diff.folder != path folder
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 400


def test_apply_requires_auth(chat_client):
    client, _private_pem, _ = chat_client
    resp = client.post(
        f"/api/users/me/coach/plan/{_APPLY_FOLDER}/apply",
        json=_apply_body(),
    )
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# POST /api/users/me/coach/master-plan/{plan_id}/apply  (season diff)
# ---------------------------------------------------------------------------

_PLAN_ID = "plan-xyz"


def _master_plan(status_value="active"):
    from stride_core.master_plan import (
        MasterPlan, MasterPlanGoal, MasterPlanStatus, Milestone, MilestoneType, Phase,
    )
    _status = MasterPlanStatus(status_value)
    return MasterPlan(
        plan_id=_PLAN_ID, user_id=USER_UUID, status=_status,
        goal=MasterPlanGoal(goal_id="g1", target_time="", race_date="2026-11-15"),
        start_date="2026-06-01", end_date="2026-11-15",
        phases=[Phase(id="phase-1", name="基础期", start_date="2026-06-01",
                      end_date="2026-07-31", focus="有氧", weekly_distance_km_low=50.0,
                      weekly_distance_km_high=65.0, key_session_types=["有氧"],
                      milestone_ids=["ms-1"])],
        milestones=[Milestone(id="ms-1", type=MilestoneType.LONG_RUN, date="2026-07-20",
                              phase_id="phase-1", target="30K")],
        training_principles=["x"], generated_by="gpt-4.1", version=3,
        created_at="2026-05-01T00:00:00Z", updated_at="2026-05-01T00:00:00Z",
    )


def _master_diff_body(*, plan_id=_PLAN_ID, end_date="2026-08-15", op_ids=("op1",)):
    return {
        "diff": {
            "diff_id": "md1",
            "plan_id": plan_id,
            "ops": [{
                "id": "op1", "op": "resize_phase", "phase_id": "phase-1",
                "old_value": {"end_date": "2026-07-31"},
                "new_value": {"end_date": end_date},
                "spec_patch": {"end_date": end_date}, "accepted": None,
            }],
            "ai_explanation": "延长基础期", "created_at": "2026-06-28T00:00:00Z",
        },
        "accepted_op_ids": list(op_ids),
    }


def _stub_master(coach_routes, monkeypatch, *, plan):
    captured: dict[str, object] = {}

    class _Store:
        def get_plan(self, user_id, plan_id):
            return plan

    monkeypatch.setattr(coach_routes, "get_master_plan_store", lambda: _Store())

    def _fake_apply(bridge, plan_id, diff, accepted_op_ids, change_reason):
        captured.update(plan_id=plan_id, accepted=list(accepted_op_ids), reason=change_reason)
        return plan.model_copy(update={"version": plan.version + 1})

    monkeypatch.setattr(coach_routes, "apply_master_plan_diff", _fake_apply)
    return captured


def test_master_apply_lands_accepted_ops(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    captured = _stub_master(coach_routes, monkeypatch, plan=_master_plan())

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_master_diff_body(),
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["applied"] == 1
    assert body["plan_id"] == _PLAN_ID
    assert body["version"] == 4  # bumped from 3
    assert captured["accepted"] == ["op1"]


def test_master_apply_rejects_plan_id_mismatch(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_master_plan())
    resp = client.post(
        "/api/users/me/coach/master-plan/other-plan/apply",
        json=_master_diff_body(plan_id=_PLAN_ID),
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 400


def test_master_apply_rejects_invalid_diff_via_gate(chat_client, monkeypatch):
    """A diff that inverts a phase is refused by the validation gate (400)."""
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_master_plan())
    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_master_diff_body(end_date="2026-05-15"),  # before phase start
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 400
    assert "结构非法" in resp.json()["detail"]


def test_master_apply_404_when_plan_missing(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=None)
    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_master_diff_body(),
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 404


def test_master_apply_409_when_not_active(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_master_plan(status_value="draft"))
    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_master_diff_body(),
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 409


def test_master_apply_requires_auth(chat_client):
    client, _private_pem, _ = chat_client
    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_master_diff_body(),
    )
    assert resp.status_code in (401, 403)


def test_master_apply_400_on_apply_data_error(chat_client, monkeypatch):
    """A malformed spec_patch that slips past the gate raises inside apply
    (bad type / enum / missing key) — the endpoint backstop returns 400, not 500."""
    client, private_pem, coach_routes = chat_client

    class _Store:
        def get_plan(self, user_id, plan_id):
            return _master_plan()

    monkeypatch.setattr(coach_routes, "get_master_plan_store", lambda: _Store())

    def _boom(*_a, **_k):
        raise TypeError("float() argument must be a string or a number, not 'NoneType'")

    monkeypatch.setattr(coach_routes, "apply_master_plan_diff", _boom)
    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_master_diff_body(),  # valid per gate; apply raises a data error
        headers=_auth(_token(private_pem)),
    )
    assert resp.status_code == 400
