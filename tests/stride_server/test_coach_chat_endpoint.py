"""S1h — POST /api/users/me/coach/chat HTTP contract.

Isolates the route from the LLM/DB by monkeypatching ``run_coach_turn`` to a
fake TurnResponse. The orchestration logic itself is covered by the core graph
tests; here we verify auth, request/response shape, and session threading.
"""

from __future__ import annotations

import time
from datetime import date

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from coach.contracts import ProposalCard, TargetRef, TurnResponse
from stride_core.master_plan_diff import MasterPlanDiff
from stride_core.plan_diff import PlanDiff
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal
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


def test_chat_surfaces_multiple_master_plan_choices(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    choices = [
        MasterPlanDiff(
            diff_id="conservative",
            plan_id="plan-1",
            ops=[],
            ai_explanation="方案 A（温和减量）",
            created_at="t",
        ),
        MasterPlanDiff(
            diff_id="aggressive",
            plan_id="plan-1",
            ops=[],
            ai_explanation="方案 B（明显减量）",
            created_at="t",
        ),
    ]

    def _fake_turn(**_kw) -> TurnResponse:
        return TurnResponse(
            reply="请选择一个调整方向",
            proposals=[
                ProposalCard(
                    specialist_id="season_plan",
                    proposal=choice,
                    summary=choice.ai_explanation,
                )
                for choice in choices
            ],
            active_target=TargetRef(kind="master", plan_id="plan-1"),
        )

    monkeypatch.setattr(coach_routes, "run_coach_turn", _fake_turn)
    resp = client.post(
        "/api/users/me/coach/chat",
        json={"session_id": "s-alternatives", "message": "给我两个方向"},
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [card["proposal"]["diff_id"] for card in body["proposals"]] == [
        "conservative",
        "aggressive",
    ]
    assert [card["summary"] for card in body["proposals"]] == [
        "方案 A（温和减量）",
        "方案 B（明显减量）",
    ]


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


def _create_body(folder: str = _APPLY_FOLDER) -> dict:
    plan = WeeklyPlan(
        week_folder=folder,
        sessions=(
                PlannedSession(
                    date=folder[:10],
                session_index=0,
                kind=SessionKind.REST,
                summary="休息日",
            ),
        ),
        notes_md="创建提案中的完整周级说明",
    )
    proposal = WeeklyPlanCreateProposal(
        proposal_id="create-1",
        folder=folder,
        plan=plan.to_dict(),
        total_distance_km=40,
        ai_explanation="创建本周计划",
        created_at="2026-06-22T00:00:00Z",
    )
    return {"proposal": proposal.model_dump()}


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


def test_apply_creates_week_from_full_proposal(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    captured: dict[str, object] = {}
    monkeypatch.setattr(coach_routes, "today_shanghai", lambda: date(2026, 6, 24))

    def _create(user_id, plan, *, expected_folder=None, generated_by=None):
        captured.update(
            user_id=user_id,
            plan=plan,
            folder=expected_folder,
            generated_by=generated_by,
        )
        return True

    monkeypatch.setattr(coach_routes, "create_weekly_plan", _create)
    resp = client.post(
        f"/api/users/me/coach/plan/{_APPLY_FOLDER}/apply",
        json=_create_body(),
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["created"] is True
    assert captured["generated_by"] == "coach-generation"
    assert captured["plan"].notes_md == "创建提案中的完整周级说明"


def test_apply_create_is_conflict_safe(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    monkeypatch.setattr(coach_routes, "today_shanghai", lambda: date(2026, 6, 24))
    monkeypatch.setattr(coach_routes, "create_weekly_plan", lambda *a, **k: False)

    resp = client.post(
        f"/api/users/me/coach/plan/{_APPLY_FOLDER}/apply",
        json=_create_body(),
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 409


def test_apply_rejects_create_proposal_folder_mismatch(chat_client):
    client, private_pem, _coach_routes = chat_client
    resp = client.post(
        "/api/users/me/coach/plan/2026-06-15_06-21/apply",
        json=_create_body(),
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 400


def test_apply_rejects_forged_far_future_create(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    monkeypatch.setattr(coach_routes, "today_shanghai", lambda: date(2026, 6, 24))
    captured = {"called": False}
    monkeypatch.setattr(
        coach_routes,
        "create_weekly_plan",
        lambda *a, **k: captured.update(called=True) or True,
    )
    far_folder = "2026-07-06_07-12"

    resp = client.post(
        f"/api/users/me/coach/plan/{far_folder}/apply",
        json=_create_body(far_folder),
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 400
    assert captured["called"] is False


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


def _race_plan(status_value="active"):
    from stride_core.master_plan import (
        MasterPlan, MasterPlanGoal, MasterPlanStatus, Milestone, MilestoneType,
        Phase, PhaseType,
    )
    build = Phase(
        id="build", name="专项期", phase_type=PhaseType.BUILD,
        start_date="2026-08-01", end_date="2026-10-31", focus="专项",
        weekly_distance_km_low=60, weekly_distance_km_high=80,
        key_session_types=["long_run"], milestone_ids=[],
    )
    taper = Phase(
        id="taper", name="调整期", phase_type=PhaseType.TAPER,
        start_date="2026-11-01", end_date="2026-11-15", focus="减量",
        weekly_distance_km_low=30, weekly_distance_km_high=45,
        key_session_types=["race"], milestone_ids=["race"],
    )
    race = Milestone(
        id="race", type=MilestoneType.RACE, date="2026-11-15",
        phase_id=taper.id, target="全马",
    )
    return MasterPlan(
        plan_id=_PLAN_ID, user_id=USER_UUID, status=MasterPlanStatus(status_value),
        goal=MasterPlanGoal(goal_id="g1", target_time="3:15:00", race_date="2026-11-15"),
        start_date="2026-08-01", end_date="2026-11-15", phases=[build, taper],
        milestones=[race], training_principles=["保留 taper"], generated_by="test",
        version=3, created_at="2026-07-01T00:00:00Z",
        updated_at="2026-07-01T00:00:00Z",
    )


def _race_reschedule_body():
    return {
        "diff": {
            "diff_id": "race-move", "plan_id": _PLAN_ID,
            "ops": [{
                "id": "move-race", "op": "reschedule_target_race",
                "milestone_id": "race",
                "old_value": {
                    "race_date": "2026-11-15",
                    "plan_end_date": "2026-11-15",
                    "milestone_date": "2026-11-15",
                },
                "spec_patch": {
                    "race_date": "2026-11-29",
                    "plan_end_date": "2026-11-29",
                    "milestone_date": "2026-11-29",
                    "phase_updates": [
                        {"phase_id": "build", "end_date": "2026-11-14"},
                        {"phase_id": "taper", "start_date": "2026-11-15", "end_date": "2026-11-29"},
                    ],
                },
            }],
            "ai_explanation": "比赛延期", "created_at": "2026-07-16T00:00:00Z",
        },
        "accepted_op_ids": ["move-race"],
    }


def _target_race_time_body():
    return {
        "diff": {
            "diff_id": "target-time", "plan_id": _PLAN_ID,
            "ops": [{
                "id": "change-target-time", "op": "update_target_race_time",
                "milestone_id": "race",
                "old_value": {
                    "target_time": "3:15:00",
                    "milestone_target": "全马",
                },
                "spec_patch": {
                    "target_time": "3:10:00",
                    "milestone_target": "全马；目标完赛时间 3:10:00",
                },
            }],
            "ai_explanation": "目标成绩调整",
            "created_at": "2026-07-16T00:00:00Z",
        },
        "accepted_op_ids": ["change-target-time"],
    }


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


def test_master_apply_drops_rejected_and_duplicate_op_ids(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    captured = _stub_master(
        coach_routes, monkeypatch, plan=_master_plan()
    )
    body = _master_diff_body(op_ids=("op1", "op1"))
    body["diff"]["ops"][0]["accepted"] = False

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=body, headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] == 0
    assert captured["accepted"] == []


def test_master_apply_reschedules_training_goal_and_plan(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan()
    saved: dict[str, object] = {"plan": plan}

    class _Store:
        def get_plan(self, user_id, plan_id):
            return saved["plan"]

        def save_plan(self, updated):
            saved["plan"] = updated

        def save_version(self, version):
            saved["version"] = version

    monkeypatch.setattr(coach_routes, "get_master_plan_store", lambda: _Store())
    writes: list[dict] = []
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "target_finish_time": "3:15:00",
            "type": "race", "race_distance": "FM",
        }, "history": []}, "file"),
    )
    monkeypatch.setattr(
        coach_routes, "write_json", lambda _path, data: writes.append(data) or "file"
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_race_reschedule_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    assert len(writes) == 1
    assert writes[0]["current"]["race_date"] == "2026-11-29"
    updated = saved["plan"]
    assert updated.goal.race_date == "2026-11-29"
    assert updated.end_date == "2026-11-29"
    assert updated.milestones[0].date == "2026-11-29"
    assert updated.phases[-1].end_date == "2026-11-29"


def test_master_apply_updates_target_time_in_training_goal_and_plan(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan()
    saved: dict[str, object] = {"plan": plan}

    class _Store:
        def get_plan(self, user_id, plan_id):
            return saved["plan"]

        def save_plan(self, updated):
            saved["plan"] = updated

        def save_version(self, version):
            saved["version"] = version

    monkeypatch.setattr(coach_routes, "get_master_plan_store", lambda: _Store())
    writes: list[dict] = []
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "target_finish_time": "3:15:00",
            "type": "race", "race_distance": "FM",
        }, "history": []}, "file"),
    )
    monkeypatch.setattr(
        coach_routes, "write_json", lambda _path, data: writes.append(data) or "file"
    )
    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_target_race_time_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    affected = resp.json()["affected_weeks"]
    assert affected
    assert affected[-1]["folder"] == "2026-11-09_11-15"
    assert writes[0]["current"]["target_finish_time"] == "3:10:00"
    updated = saved["plan"]
    assert updated.goal.target_time == "3:10:00"
    assert updated.milestones[0].target == "全马；目标完赛时间 3:10:00"


def test_master_apply_accepts_equivalent_leading_zero_target_time(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan().model_copy(update={
        "goal": _race_plan().goal.model_copy(update={"target_time": "03:15:00"})
    })
    saved: dict[str, object] = {"plan": plan}

    class _Store:
        def get_plan(self, user_id, plan_id):
            return saved["plan"]

        def save_plan(self, updated):
            saved["plan"] = updated

        def save_version(self, version):
            saved["version"] = version

    monkeypatch.setattr(coach_routes, "get_master_plan_store", lambda: _Store())
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "target_finish_time": "3:15:00",
            "type": "race", "race_distance": "FM",
        }}, "file"),
    )
    monkeypatch.setattr(coach_routes, "write_json", lambda *_args: "file")

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_target_race_time_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    assert saved["plan"].goal.target_time == "3:10:00"


def test_master_apply_rejects_duplicate_diff_op_ids(chat_client, monkeypatch):
    client, private_pem, coach_routes = chat_client
    captured = _stub_master(coach_routes, monkeypatch, plan=_master_plan())
    body = _master_diff_body()
    duplicate = dict(body["diff"]["ops"][0])
    duplicate["op"] = "replace_phase_focus"
    duplicate["spec_patch"] = {"focus": "duplicate"}
    body["diff"]["ops"].append(duplicate)

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=body,
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 400
    assert "必须唯一" in resp.json()["detail"]
    assert "accepted" not in captured


def test_master_apply_rejects_target_time_when_training_goal_is_stale(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_race_plan())
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "target_finish_time": "3:20:00", "type": "race",
        }}, "file"),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_target_race_time_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 409
    assert "不一致" in resp.json()["detail"]


def test_master_apply_rejects_target_time_for_different_race_distance(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_race_plan())
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "target_finish_time": "3:15:00",
            "type": "race", "race_distance": "HM",
        }}, "file"),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_target_race_time_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 409
    assert "不一致" in resp.json()["detail"]


def test_master_apply_rolls_back_target_time_when_plan_apply_fails(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan()
    _stub_master(coach_routes, monkeypatch, plan=plan)
    original = {"current": {
        "goal_id": "g1", "race_date": "2026-11-15",
        "target_finish_time": "3:15:00",
        "type": "race", "race_distance": "FM",
    }, "history": []}
    writes: list[dict] = []
    monkeypatch.setattr(coach_routes, "read_json", lambda _path: (original, "file"))
    monkeypatch.setattr(
        coach_routes, "write_json", lambda _path, data: writes.append(data) or "file"
    )
    monkeypatch.setattr(
        coach_routes, "apply_master_plan_diff",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_target_race_time_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 400
    assert writes[0]["current"]["target_finish_time"] == "3:10:00"
    assert writes[1] == original


def test_master_apply_rejects_race_move_when_training_goal_is_stale(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_race_plan())
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "other-goal", "race_date": "2026-11-15",
            "type": "race",
        }}, "file"),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_race_reschedule_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 409
    assert "不一致" in resp.json()["detail"]


def test_master_apply_rejects_race_move_for_non_race_training_goal(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    _stub_master(coach_routes, monkeypatch, plan=_race_plan())
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "type": "health",
        }}, "file"),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_race_reschedule_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 409
    assert "不是比赛目标" in resp.json()["detail"]


def test_master_apply_rolls_back_training_goal_when_plan_apply_fails(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan()
    _stub_master(coach_routes, monkeypatch, plan=plan)
    original = {"current": {
        "goal_id": "g1", "race_date": "2026-11-15",
        "target_finish_time": "3:15:00",
        "type": "race", "race_distance": "FM",
    }, "history": []}
    writes: list[dict] = []
    monkeypatch.setattr(coach_routes, "read_json", lambda _path: (original, "file"))
    monkeypatch.setattr(
        coach_routes, "write_json", lambda _path, data: writes.append(data) or "file"
    )
    monkeypatch.setattr(
        coach_routes, "apply_master_plan_diff",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_race_reschedule_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 400
    assert len(writes) == 2
    assert writes[0]["current"]["race_date"] == "2026-11-29"
    assert writes[1] == original


def test_master_apply_reports_inconsistency_when_training_goal_rollback_fails(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan()
    _stub_master(coach_routes, monkeypatch, plan=plan)
    original = {"current": {
        "goal_id": "g1", "race_date": "2026-11-15",
        "target_finish_time": "3:15:00",
        "type": "race", "race_distance": "FM",
    }, "history": []}
    writes: list[dict] = []

    def fail_rollback(_path, data):
        writes.append(data)
        if data == original:
            raise RuntimeError("content store unavailable")
        return "file"

    monkeypatch.setattr(coach_routes, "read_json", lambda _path: (original, "file"))
    monkeypatch.setattr(coach_routes, "write_json", fail_rollback)
    monkeypatch.setattr(
        coach_routes,
        "apply_master_plan_diff",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
    )

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_race_reschedule_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "master_plan_goal_inconsistent"
    assert writes[0]["current"]["race_date"] == "2026-11-29"
    assert writes[1:] == [original, original]


def test_race_reschedule_affected_weeks_include_extended_build_window(
    chat_client, monkeypatch
):
    _client, _private_pem, coach_routes = chat_client
    from stride_core.master_plan_diff import MasterPlanDiff

    diff = MasterPlanDiff.model_validate(_race_reschedule_body()["diff"])

    from stride_server.routes.master_plan import _compute_affected_weeks

    weeks = _compute_affected_weeks(diff.ops, _race_plan())
    folders = [item["folder"] for item in weeks]

    assert "2026-10-26_11-01" in folders
    assert "2026-11-02_11-08" in folders
    assert "2026-11-09_11-15" in folders
    assert "2026-11-23_11-29" in folders


def test_target_race_time_affected_weeks_start_from_as_of(
    chat_client,
):
    from stride_core.master_plan_diff import MasterPlanDiff
    from stride_server.routes.master_plan import _compute_affected_weeks

    diff = MasterPlanDiff.model_validate(_target_race_time_body()["diff"])

    weeks = _compute_affected_weeks(
        diff.ops, _race_plan(), as_of=date(2026, 7, 16)
    )

    assert weeks[0]["folder"] == "2026-07-13_07-19"
    assert weeks[-1]["folder"] == "2026-11-09_11-15"


def test_coach_race_reschedule_apply_returns_affected_weeks(
    chat_client, monkeypatch
):
    client, private_pem, coach_routes = chat_client
    plan = _race_plan()
    saved: dict[str, object] = {"plan": plan}

    class _Store:
        def get_plan(self, user_id, plan_id):
            return saved["plan"]

        def save_plan(self, updated):
            saved["plan"] = updated

        def save_version(self, version):
            pass

    monkeypatch.setattr(coach_routes, "get_master_plan_store", lambda: _Store())
    monkeypatch.setattr(
        coach_routes,
        "read_json",
        lambda _path: ({"current": {
            "goal_id": "g1", "race_date": "2026-11-15",
            "target_finish_time": "3:15:00",
            "type": "race", "race_distance": "FM",
        }}, "file"),
    )
    monkeypatch.setattr(coach_routes, "write_json", lambda *_args: "file")

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=_race_reschedule_body(), headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 200, resp.text
    folders = [item["folder"] for item in resp.json()["affected_weeks"]]
    assert "2026-10-26_11-01" in folders
    assert "2026-11-23_11-29" in folders


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


def test_master_apply_validates_only_selected_ops_for_taper_safety(
    chat_client, monkeypatch
):
    """Unselected regeneration ops cannot make a selected taper deletion safe."""
    client, private_pem, coach_routes = chat_client
    plan = _master_plan()
    taper = plan.phases[0].model_copy(
        update={
            "id": "taper",
            "name": "调整期",
            "start_date": "2026-11-02",
            "end_date": "2026-11-15",
            "milestone_ids": [],
        }
    )
    plan = plan.model_copy(update={"phases": [plan.phases[0], taper]})
    _stub_master(coach_routes, monkeypatch, plan=plan)
    body = {
        "diff": {
            "diff_id": "regenerate",
            "plan_id": _PLAN_ID,
            "ops": [
                {
                    "id": "remove-base", "op": "remove_phase", "phase_id": "phase-1",
                    "old_value": {"name": plan.phases[0].name},
                },
                {
                    "id": "remove-taper", "op": "remove_phase", "phase_id": "taper",
                    "old_value": {"name": taper.name},
                },
                {
                    "id": "remove-ms", "op": "remove_milestone", "milestone_id": "ms-1",
                    "old_value": {"date": plan.milestones[0].date},
                },
            ],
            "ai_explanation": "清空重排",
            "created_at": "2026-07-15T00:00:00Z",
        },
        "accepted_op_ids": ["remove-taper"],
    }

    resp = client.post(
        f"/api/users/me/coach/master-plan/{_PLAN_ID}/apply",
        json=body,
        headers=_auth(_token(private_pem)),
    )

    assert resp.status_code == 400
    assert "不能删除" in resp.json()["detail"]


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
