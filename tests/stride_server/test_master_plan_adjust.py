"""Tests for T42 — adjust-chat endpoints for ACTIVE master plans.

Covers:
  POST /api/users/me/master-plan/{plan_id}/adjust/messages
  POST /api/users/me/master-plan/{plan_id}/adjust/apply
  GET  /api/users/me/master-plan/{plan_id}/versions
  GET  /api/users/me/master-plan/{plan_id}/versions/{version}
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from coach.contracts import SpecialistResult

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanVersion,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
)
from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOp, MasterPlanDiffOpKind
from stride_server.master_plan_store import FileMasterPlanStore, reset_master_plan_store_cache
import stride_server.master_plan_apply as apply_mod
import stride_server.routes.master_plan as mp_mod

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _make_plan(
    user_id: str = USER_UUID,
    status: MasterPlanStatus = MasterPlanStatus.ACTIVE,
    start_date: str = "2026-05-12",
    end_date: str = "2026-10-26",
) -> MasterPlan:
    phase_id = str(uuid4())
    ms_id = str(uuid4())
    phase = Phase(
        id=phase_id,
        name="基础期",
        start_date=start_date,
        end_date="2026-07-06",
        focus="有氧基础",
        weekly_distance_km_low=40.0,
        weekly_distance_km_high=50.0,
        key_session_types=["长距离", "有氧"],
        milestone_ids=[ms_id],
    )
    build_phase = Phase(
        id=str(uuid4()),
        name="专项期",
        start_date="2026-07-07",
        end_date=end_date,
        focus="马拉松专项",
        weekly_distance_km_low=45.0,
        weekly_distance_km_high=60.0,
        key_session_types=["阈值", "马拉松配速"],
        milestone_ids=[],
    )
    milestone = Milestone(
        id=ms_id,
        type=MilestoneType.TEST_RUN,
        date="2026-07-05",
        phase_id=phase_id,
        target="30K 测试跑 4'55/km",
        completed_actual=None,
    )
    now = datetime.now(timezone.utc).isoformat()
    goal_id = str(uuid4())
    return MasterPlan(
        plan_id=str(uuid4()),
        user_id=user_id,
        status=status,
        goal=MasterPlanGoal(goal_id=goal_id, target_time="", race_date=end_date),
        start_date=start_date,
        end_date=end_date,
        phases=[phase, build_phase],
        milestones=[milestone],
        training_principles=["渐进原则", "充足休息"],
        generated_by="gpt-4.1",
        version=1,
        created_at=now,
        updated_at=now,
    )


def _old_race_date(plan: MasterPlan) -> dict[str, str]:
    milestone = next(item for item in plan.milestones if item.type == MilestoneType.RACE)
    return {
        "race_date": plan.goal.race_date,
        "plan_end_date": plan.end_date,
        "milestone_date": milestone.date,
    }


def _old_race_time(plan: MasterPlan) -> dict[str, str]:
    milestone = next(item for item in plan.milestones if item.type == MilestoneType.RACE)
    return {
        "target_time": plan.goal.target_time,
        "milestone_target": milestone.target,
    }


def _make_race_plan(
    user_id: str = USER_UUID,
    status: MasterPlanStatus = MasterPlanStatus.ACTIVE,
) -> MasterPlan:
    build = Phase(
        id="build",
        name="专项期",
        phase_type=PhaseType.BUILD,
        start_date="2026-08-01",
        end_date="2026-10-31",
        focus="专项",
        weekly_distance_km_low=60.0,
        weekly_distance_km_high=80.0,
        key_session_types=["long_run"],
        milestone_ids=[],
    )
    taper = Phase(
        id="taper",
        name="调整期",
        phase_type=PhaseType.TAPER,
        start_date="2026-11-01",
        end_date="2026-11-15",
        focus="减量",
        weekly_distance_km_low=30.0,
        weekly_distance_km_high=45.0,
        key_session_types=["race"],
        milestone_ids=["race"],
    )
    race = Milestone(
        id="race",
        type=MilestoneType.RACE,
        date="2026-11-15",
        phase_id=taper.id,
        target="全马 3:15:00",
    )
    return MasterPlan(
        plan_id=str(uuid4()),
        user_id=user_id,
        status=status,
        goal=MasterPlanGoal(
            goal_id="g1",
            target_time="3:15:00",
            race_date="2026-11-15",
        ),
        start_date="2026-08-01",
        end_date="2026-11-15",
        phases=[build, taper],
        milestones=[race],
        training_principles=["保留 taper"],
        generated_by="test",
        version=1,
        created_at="2026-07-01T00:00:00Z",
        updated_at="2026-07-01T00:00:00Z",
    )


# ---------------------------------------------------------------------------
# RSA fixtures and token helpers (mirrors test_master_plan_review.py)
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
    for key in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    import stride_core.db as core_db_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)

    reset_master_plan_store_cache()
    monkeypatch.setenv("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL", "")

    from stride_server.bearer import require_bearer
    from stride_server.routes.master_plan import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    yield client, _token(private_pem), tmp_path, private_pem

    reset_master_plan_store_cache()


def _get_store() -> FileMasterPlanStore:
    from stride_server.master_plan_store import get_master_plan_store
    return get_master_plan_store()


# ===========================================================================
# Shared apply lock tests
# ===========================================================================


def test_master_plan_apply_lock_fails_fast_and_cleans_registry():
    entered = threading.Event()
    release = threading.Event()

    def hold_lock():
        with apply_mod.master_plan_apply_lock(USER_UUID, "plan-lock"):
            entered.set()
            release.wait(timeout=2)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    assert entered.wait(timeout=1)

    started = time.monotonic()
    with pytest.raises(HTTPException) as caught:
        with apply_mod.master_plan_apply_lock(USER_UUID, "plan-lock"):
            pytest.fail("concurrent apply must not enter critical section")
    elapsed = time.monotonic() - started

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "master_plan_apply_in_progress"
    assert elapsed < 0.2
    assert (USER_UUID, "plan-lock") in apply_mod._PLAN_LOCKS

    release.set()
    holder.join(timeout=2)
    assert not holder.is_alive()
    assert (USER_UUID, "plan-lock") not in apply_mod._PLAN_LOCKS

    with apply_mod.master_plan_apply_lock(USER_UUID, "plan-lock"):
        assert (USER_UUID, "plan-lock") in apply_mod._PLAN_LOCKS
    assert (USER_UUID, "plan-lock") not in apply_mod._PLAN_LOCKS


def test_master_plan_apply_lock_allows_different_plans_concurrently():
    with apply_mod.master_plan_apply_lock(USER_UUID, "plan-a"):
        with apply_mod.master_plan_apply_lock(USER_UUID, "plan-b"):
            assert (USER_UUID, "plan-a") in apply_mod._PLAN_LOCKS
            assert (USER_UUID, "plan-b") in apply_mod._PLAN_LOCKS
    assert (USER_UUID, "plan-a") not in apply_mod._PLAN_LOCKS
    assert (USER_UUID, "plan-b") not in apply_mod._PLAN_LOCKS


# ===========================================================================
# T42 — adjust/messages tests
# ===========================================================================


class TestAdjustMessages:

    def test_active_plan_returns_diff(self, app_client):
        """Reasonable specialist proposal is returned and kept for legacy apply."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[MasterPlanDiffOp(
                id=str(uuid4()),
                op=MasterPlanDiffOpKind.SHIFT_PHASE_BOUNDARY,
                phase_id=phase_id,
                old_value={"end_date": "2026-07-06", "following_phase_id": plan.phases[1].id, "following_start_date": "2026-07-07"},
                new_value={"end_date": "2026-07-20", "following_phase_id": plan.phases[1].id, "following_start_date": "2026-07-21"},
                spec_patch={"end_date": "2026-07-20", "following_phase_id": plan.phases[1].id, "following_start_date": "2026-07-21"},
            )],
            ai_explanation="数据支持把基础期延长两周",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        def fake_factory(**kwargs):
            kwargs["state_observer"]({
                "master_adjustment_request": "把基础期延长两周",
                "master_adjustment_assessment": {
                    "adjustment_request": "把基础期延长两周",
                    "verdict": "reasonable",
                    "rationale": "当前负荷与目标窗口支持延长。",
                }
            })
            return lambda task: SpecialistResult(
                status="completed",
                reply_fragment="数据支持把基础期延长两周",
                proposals=[diff],
            )

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把基础期延长两周", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["stage"] == "proposal"
        assert data["assessment"]["verdict"] == "reasonable"
        assert isinstance(data["ai_response"], str)
        assert data["diff"] is not None
        assert len(data["diff"]["ops"]) == 1
        assert data["diff"]["ops"][0]["op"] == "shift_phase_boundary"

    def test_draft_plan_returns_409(self, app_client):
        """DRAFT plan → 409 (use review-chat instead)."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
            json={"message": "把基础期延长两周", "history": []},
            headers=_auth(token),
        )

        assert resp.status_code == 409, resp.text

    def test_plan_not_found_returns_404(self, app_client):
        """Non-existent plan_id → 404."""
        client, token, tmp_path, _ = app_client

        resp = client.post(
            "/api/users/me/master-plan/nonexistent-id/adjust/messages",
            json={"message": "把基础期延长两周", "history": []},
            headers=_auth(token),
        )

        assert resp.status_code == 404, resp.text

    def test_llm_unavailable_returns_503(self, app_client):
        """LLMUnavailable → 503."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        def fail_factory(**kwargs):
            return lambda task: (_ for _ in ()).throw(RuntimeError("no config"))

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fail_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把基础期延长两周", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 503, resp.text

    def test_vague_direction_unknown_plan_returns_404_before_clarification(self, app_client):
        client, token, tmp_path, _ = app_client

        with patch.object(mp_mod, "make_season_plan_runner") as make_runner:
            resp = client.post(
                "/api/users/me/master-plan/missing/adjust/messages",
                json={"message": "我想调整整体训练计划", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 404, resp.text
        make_runner.assert_not_called()

    def test_vague_direction_draft_plan_returns_409_before_clarification(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(plan)

        with patch.object(mp_mod, "make_season_plan_runner") as make_runner:
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "我想调整整体训练计划", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 409, resp.text
        make_runner.assert_not_called()

    def test_vague_direction_clarifies_without_plan_data_or_llm(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with (
            patch.object(mp_mod, "make_season_plan_runner") as make_runner,
            patch.object(mp_mod, "get_generator_llm") as get_llm,
        ):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "我想调整整体训练计划", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "clarification"
        assert resp.json()["diff"] is None
        assert "具体怎么调整" in resp.json()["clarification"]
        make_runner.assert_not_called()
        get_llm.assert_not_called()

    def test_missing_phase_clarifies_without_plan_data_or_llm(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with (
            patch.object(mp_mod, "make_season_plan_runner") as make_runner,
            patch.object(mp_mod, "get_generator_llm") as get_llm,
        ):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把周跑量降到 45 公里", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "clarification"
        assert "哪个阶段" in resp.json()["clarification"]
        make_runner.assert_not_called()
        get_llm.assert_not_called()

    def test_phase_only_followup_restores_original_request(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        captured = {}

        def fake_factory(**kwargs):
            def run(task):
                captured["task"] = task
                kwargs["state_observer"]({
                    "master_adjustment_request": (
                        "专项期：训练重点改成上坡力量与跑姿经济性"
                    ),
                    "master_adjustment_assessment": {
                        "adjustment_request": "专项期：训练重点改成上坡力量与跑姿经济性",
                        "verdict": "unreasonable",
                        "rationale": "当前阶段不适合加入该重点。",
                    }
                })
                return SpecialistResult(
                    status="completed",
                    reply_fragment="当前阶段不适合加入该重点。",
                )
            return run

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={
                    "message": "专项期",
                    "history": [
                        {"role": "user", "content": "训练重点改成上坡力量与跑姿经济性"},
                        {
                            "role": "assistant",
                            "content": "你希望调整哪个阶段？确认阶段后我再加载数据评估。",
                        },
                    ],
                },
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "assessment"
        assert captured["task"].objective == "专项期"
        assert captured["task"].conversation_window[-2].content.startswith("训练重点")

    def test_unreasonable_assessment_never_returns_diff(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        unsafe_diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[MasterPlanDiffOp(
                id=str(uuid4()),
                op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
                phase_id=plan.phases[0].id,
                old_value={"weekly_distance_km_high": 50},
                new_value={"weekly_distance_km_high": 150},
                spec_patch={"weekly_distance_km_high": 150},
            )],
            ai_explanation="不应泄漏的方案",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        def fake_factory(**kwargs):
            kwargs["state_observer"]({
                "master_adjustment_request": "把基础期周跑量加到 140–150 公里",
                "master_adjustment_assessment": {
                    "adjustment_request": "把基础期周跑量加到 140–150 公里",
                    "verdict": "unreasonable",
                    "rationale": "远高于近期负荷，受伤风险过高。",
                }
            })
            return lambda task: SpecialistResult(
                status="completed",
                reply_fragment="远高于近期负荷，受伤风险过高。",
                proposals=[unsafe_diff],
            )

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把基础期周跑量加到 140–150 公里", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "assessment"
        assert resp.json()["assessment"]["verdict"] == "unreasonable"
        assert resp.json()["diff"] is None

    def test_stale_reasonable_assessment_never_returns_diff(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        stale_diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[MasterPlanDiffOp(
                id=str(uuid4()),
                op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
                phase_id=plan.phases[0].id,
                old_value={"weekly_distance_km_high": 50},
                new_value={"weekly_distance_km_high": 60},
                spec_patch={"weekly_distance_km_high": 60},
            )],
            ai_explanation="不应泄漏的旧请求方案",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        def fake_factory(**kwargs):
            kwargs["state_observer"]({
                "master_adjustment_request": "把基础期周跑量加到 55–60 公里",
                "master_adjustment_assessment": {
                    "adjustment_request": "把基础期延长两周",
                    "verdict": "reasonable",
                    "rationale": "这是上一条请求的评估。",
                },
            })
            return lambda task: SpecialistResult(
                status="completed",
                reply_fragment="旧请求评估不应授权新方案。",
                proposals=[stale_diff],
            )

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把基础期周跑量加到 55–60 公里", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "assessment"
        assert resp.json()["assessment"] is None
        assert resp.json()["diff"] is None

    def test_increase_request_never_returns_or_caches_a_reduction_diff(
        self, app_client
    ):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        wrong_diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[MasterPlanDiffOp(
                id=str(uuid4()),
                op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
                phase_id=plan.phases[0].id,
                old_value={
                    "weekly_distance_km_low": 50,
                    "weekly_distance_km_high": 65,
                },
                new_value={
                    "weekly_distance_km_low": 45,
                    "weekly_distance_km_high": 58.5,
                },
                spec_patch={
                    "weekly_distance_km_low": 45,
                    "weekly_distance_km_high": 58.5,
                },
            )],
            ai_explanation="不应泄漏的减量方案",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        request = "把基础期周跑量增加到 55–70 公里"

        def fake_factory(**kwargs):
            kwargs["state_observer"]({
                "master_adjustment_request": request,
                "master_adjustment_assessment": {
                    "adjustment_request": request,
                    "verdict": "reasonable",
                    "rationale": "测试中的错误 runner 声称合理。",
                },
            })
            return lambda task: SpecialistResult(
                status="completed",
                reply_fragment="错误的减量方案。",
                proposals=[wrong_diff],
            )

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": request, "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "assessment"
        assert resp.json()["diff"] is None

    def test_percentage_request_never_returns_or_caches_wrong_magnitude(
        self, app_client
    ):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        wrong_diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[MasterPlanDiffOp(
                id=str(uuid4()),
                op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
                phase_id=plan.phases[0].id,
                old_value={
                    "weekly_distance_km_low": 40,
                    "weekly_distance_km_high": 50,
                },
                new_value={
                    "weekly_distance_km_low": 45,
                    "weekly_distance_km_high": 56,
                },
                spec_patch={
                    "weekly_distance_km_low": 45,
                    "weekly_distance_km_high": 56,
                },
            )],
            ai_explanation="方向向上但不是精确 10%",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        request = "把基础期跑量提高 10%"

        def fake_factory(**kwargs):
            kwargs["state_observer"]({
                "master_adjustment_request": request,
                "master_adjustment_assessment": {
                    "adjustment_request": request,
                    "verdict": "reasonable",
                    "rationale": "测试中的错误 runner 声称合理。",
                },
            })
            return lambda task: SpecialistResult(
                status="completed",
                reply_fragment="错误幅度方案。",
                proposals=[wrong_diff],
            )

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": request, "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["stage"] == "assessment"
        assert resp.json()["diff"] is None


# ===========================================================================
# T42 — adjust/apply tests
# ===========================================================================


class TestAdjustApply:

    def _post_messages_and_get_diff(
        self, client, token, plan, phase_id: str
    ) -> tuple[dict, str]:
        """Helper: call /adjust/messages, return (diff body, op_id)."""
        diff = MasterPlanDiff(
            diff_id=str(uuid4()), plan_id=plan.plan_id,
            ops=[MasterPlanDiffOp(
                id=str(uuid4()), op=MasterPlanDiffOpKind.SHIFT_PHASE_BOUNDARY,
                phase_id=phase_id, old_value={"end_date": "2026-07-06", "following_phase_id": plan.phases[1].id, "following_start_date": "2026-07-07"},
                new_value={"end_date": "2026-07-20", "following_phase_id": plan.phases[1].id, "following_start_date": "2026-07-21"},
                spec_patch={"end_date": "2026-07-20", "following_phase_id": plan.phases[1].id, "following_start_date": "2026-07-21"},
            )],
            ai_explanation="已延长基础期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        def fake_factory(**kwargs):
            kwargs["state_observer"]({
                "master_adjustment_request": "把基础期延长两周",
                "master_adjustment_assessment": {
                    "adjustment_request": "把基础期延长两周",
                    "verdict": "reasonable",
                    "rationale": "合理",
                }
            })
            return lambda task: SpecialistResult(
                status="completed", reply_fragment="已延长基础期", proposals=[diff]
            )

        with patch.object(mp_mod, "make_season_plan_runner", side_effect=fake_factory):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把基础期延长两周", "history": []},
                headers=_auth(token),
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["diff"], data["diff"]["ops"][0]["id"]

    def test_apply_bumps_version_and_returns_affected_weeks(self, app_client):
        """Apply accepted op → version bumped, affected_weeks computed."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff_body, op_id = self._post_messages_and_get_diff(client, token, plan, phase_id)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff_body,
                "accepted_op_ids": [op_id],
                "change_reason": "比赛推迟，需要更多基础",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["plan_id"] == plan.plan_id
        assert data["applied"] == 1
        assert data["version"] == 2  # bumped from 1 → 2
        assert isinstance(data["affected_weeks"], list)

        # Verify store: version bumped
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.version == 2
        assert updated.phases[0].end_date == "2026-07-20"
        assert updated.phases[1].start_date == "2026-07-21"

    def test_apply_writes_version_snapshot(self, app_client):
        """apply → MasterPlanVersion snapshot stored in store."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff_body, op_id = self._post_messages_and_get_diff(client, token, plan, phase_id)

        client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff_body,
                "accepted_op_ids": [op_id],
                "change_reason": "变更原因",
            },
            headers=_auth(token),
        )

        versions = store.list_versions(plan.plan_id)
        assert len(versions) == 1
        assert versions[0].change_reason == "变更原因"
        # snapshot should be valid JSON
        snap = json.loads(versions[0].snapshot_json)
        assert snap["plan_id"] == plan.plan_id

    def test_apply_draft_plan_returns_409(self, app_client):
        """adjust/apply on DRAFT plan → 409."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={"diff_id": "any", "accepted_op_ids": [], "change_reason": ""},
            headers=_auth(token),
        )
        assert resp.status_code == 409, resp.text

    def test_apply_missing_diff_body_returns_400(self, app_client):
        """Stateless apply requires the typed diff body."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={"accepted_op_ids": [], "change_reason": ""},
            headers=_auth(token),
        )
        assert resp.status_code == 400, resp.text

    def test_affected_weeks_calculation(self, app_client):
        """affected_weeks covers the weeks overlapping the changed phase date range."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        # Inject diff directly with a resize_phase spec_patch from 2026-07-06 to 2026-07-20
        # Phase originally ends 2026-07-06; patching to 2026-07-20
        phase_id = plan.phases[0].id
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.RESIZE_PHASE,
            phase_id=phase_id,
            milestone_id=None,
            old_value={"end_date": "2026-07-06"},
            new_value={"end_date": "2026-07-20"},
            spec_patch={"end_date": "2026-07-20"},
            accepted=None,
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="延长基础期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "延长",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        affected = resp.json()["affected_weeks"]
        # Should include at least some weeks — the phase spans 2026-05-12 to 2026-07-27
        assert isinstance(affected, list)
        assert len(affected) > 0
        # All entries should have folder and reason keys
        for aw in affected:
            assert "folder" in aw
            assert "reason" in aw

    def test_apply_drops_rejected_duplicate_and_unknown_op_ids(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="op1",
            op=MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
            phase_id=plan.phases[0].id,
            old_value={"focus": plan.phases[0].focus},
            new_value={"focus": "不应应用"},
            spec_patch={"focus": "不应应用"},
            accepted=False,
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="rejected",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": ["op1", "op1", "unknown"],
                "change_reason": "ignored",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 0
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.version == plan.version
        assert updated.phases[0].focus == plan.phases[0].focus

    def test_apply_rejects_duplicate_diff_op_ids(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[
                MasterPlanDiffOp(
                    id="duplicate",
                    op=MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
                    phase_id=plan.phases[0].id,
                    spec_patch={"focus": "first"},
                ),
                MasterPlanDiffOp(
                    id="duplicate",
                    op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
                    phase_id=plan.phases[0].id,
                    spec_patch={"weekly_distance_km_high": 55},
                ),
            ],
            ai_explanation="duplicate ids",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": ["duplicate"],
                "change_reason": "invalid",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 400, resp.text
        assert "必须唯一" in resp.json()["detail"]
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.version == plan.version

    def test_apply_validates_only_selected_ops_for_taper_safety(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        base = _make_plan()
        taper = base.phases[0].model_copy(
            update={
                "id": "taper",
                "name": "调整期",
                "start_date": "2026-10-13",
                "end_date": "2026-10-26",
                "milestone_ids": [],
            }
        )
        plan = base.model_copy(update={"phases": [base.phases[0], taper]})
        store.save_plan(plan)
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[
                MasterPlanDiffOp(
                    id="remove-base",
                    op=MasterPlanDiffOpKind.REMOVE_PHASE,
                    phase_id=base.phases[0].id,
                    old_value={"name": base.phases[0].name},
                ),
                MasterPlanDiffOp(
                    id="remove-taper",
                    op=MasterPlanDiffOpKind.REMOVE_PHASE,
                    phase_id="taper",
                    old_value={"name": taper.name},
                ),
                MasterPlanDiffOp(
                    id="remove-ms",
                    op=MasterPlanDiffOpKind.REMOVE_MILESTONE,
                    milestone_id=base.milestones[0].id,
                    old_value={"date": base.milestones[0].date},
                ),
            ],
            ai_explanation="清空重排",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": ["remove-taper"],
                "change_reason": "should fail",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 400, resp.text
        assert "不能删除" in resp.json()["detail"]

    def test_apply_400_when_gate_raises_on_malformed_diff(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="op1",
            op=MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
            phase_id=plan.phases[0].id,
            old_value={
                "weekly_distance_km_low": plan.phases[0].weekly_distance_km_low,
                "weekly_distance_km_high": plan.phases[0].weekly_distance_km_high,
            },
            spec_patch={"weekly_distance_km_low": 55},
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="bad",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        with patch.object(mp_mod, "validate_master_diff", side_effect=TypeError("bad coercion")):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
                json={
                    "diff": diff.model_dump(),
                    "accepted_op_ids": ["op1"],
                    "change_reason": "",
                },
                headers=_auth(token),
            )

        assert resp.status_code == 400, resp.text
        assert "非法" in resp.json()["detail"]

    def test_apply_400_on_apply_data_error(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="op1",
            op=MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
            phase_id=plan.phases[0].id,
            old_value={"focus": plan.phases[0].focus},
            spec_patch={"focus": "x"},
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="bad apply",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        with patch.object(mp_mod, "apply_master_plan_diff", side_effect=TypeError("bad data")):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
                json={
                    "diff": diff.model_dump(),
                    "accepted_op_ids": ["op1"],
                    "change_reason": "",
                },
                headers=_auth(token),
            )

        assert resp.status_code == 400, resp.text

    def test_apply_preserves_infra_errors_as_500(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="op1",
            op=MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
            phase_id=plan.phases[0].id,
            old_value={"focus": plan.phases[0].focus},
            spec_patch={"focus": "x"},
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="infra",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        with patch.object(mp_mod, "apply_master_plan_diff", side_effect=RuntimeError("storage down")):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
                json={
                    "diff": diff.model_dump(),
                    "accepted_op_ids": ["op1"],
                    "change_reason": "",
                },
                headers=_auth(token),
            )

        assert resp.status_code == 500

    def test_apply_reschedules_training_goal_and_plan(self, app_client, monkeypatch):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="move-race",
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id="race",
            old_value=_old_race_date(plan),
            spec_patch={
                "race_date": "2026-11-29",
                "plan_end_date": "2026-11-29",
                "milestone_date": "2026-11-29",
                "phase_updates": [
                    {"phase_id": "build", "end_date": "2026-11-14"},
                    {
                        "phase_id": "taper",
                        "start_date": "2026-11-15",
                        "end_date": "2026-11-29",
                    },
                ],
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="比赛延期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        writes: list[dict] = []
        monkeypatch.setattr(
            mp_mod,
            "read_json",
            lambda _path: ({
                "current": {
                    "goal_id": "g1",
                    "race_date": "2026-11-15",
                    "target_finish_time": "3:15:00",
                    "type": "race",
                    "race_distance": "FM",
                },
                "history": [],
            }, "file"),
        )
        monkeypatch.setattr(
            mp_mod, "write_json", lambda _path, data: writes.append(data) or "file"
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "比赛推迟",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert writes[0]["current"]["race_date"] == "2026-11-29"
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.goal.race_date == "2026-11-29"
        assert updated.end_date == "2026-11-29"

    def test_apply_updates_target_time_in_training_goal_and_plan(self, app_client, monkeypatch):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="change-target-time",
            op=MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME,
            milestone_id="race",
            old_value=_old_race_time(plan),
            spec_patch={
                "target_time": "3:10:00",
                "milestone_target": "全马 3:10:00",
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="目标成绩调整",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        writes: list[dict] = []
        monkeypatch.setattr(
            mp_mod,
            "read_json",
            lambda _path: ({
                "current": {
                    "goal_id": "g1",
                    "race_date": "2026-11-15",
                    "target_finish_time": "3:15:00",
                    "type": "race",
                    "race_distance": "FM",
                },
                "history": [],
            }, "file"),
        )
        monkeypatch.setattr(
            mp_mod, "write_json", lambda _path, data: writes.append(data) or "file"
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "目标调整",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert writes[0]["current"]["target_finish_time"] == "3:10:00"
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.goal.target_time == "3:10:00"
        assert updated.milestones[0].target == "全马 3:10:00"

    def test_apply_rejects_race_move_when_training_goal_is_stale(self, app_client, monkeypatch):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="move-race",
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id="race",
            old_value=_old_race_date(plan),
            spec_patch={
                "race_date": "2026-11-29",
                "plan_end_date": "2026-11-29",
                "milestone_date": "2026-11-29",
                "phase_updates": [
                    {"phase_id": "build", "end_date": "2026-11-14"},
                    {
                        "phase_id": "taper",
                        "start_date": "2026-11-15",
                        "end_date": "2026-11-29",
                    },
                ],
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="比赛延期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        monkeypatch.setattr(
            mp_mod,
            "read_json",
            lambda _path: ({
                "current": {
                    "goal_id": "other",
                    "race_date": "2026-11-15",
                    "target_finish_time": "3:15:00",
                    "type": "race",
                    "race_distance": "FM",
                }
            }, "file"),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "比赛推迟",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 409, resp.text
        assert "不一致" in resp.json()["detail"]

    def test_apply_rejects_race_move_when_target_time_is_stale(
        self, app_client, monkeypatch
    ):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="move-race",
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id="race",
            old_value=_old_race_date(plan),
            spec_patch={
                "race_date": "2026-11-29",
                "plan_end_date": "2026-11-29",
                "milestone_date": "2026-11-29",
                "phase_updates": [
                    {"phase_id": "build", "end_date": "2026-11-14"},
                    {
                        "phase_id": "taper",
                        "start_date": "2026-11-15",
                        "end_date": "2026-11-29",
                    },
                ],
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="比赛延期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        monkeypatch.setattr(
            mp_mod,
            "read_json",
            lambda _path: ({
                "current": {
                    "goal_id": "g1",
                    "race_date": "2026-11-15",
                    "target_finish_time": "3:20:00",
                    "type": "race",
                    "race_distance": "FM",
                }
            }, "file"),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "比赛推迟",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 409, resp.text
        assert "不一致" in resp.json()["detail"]

    def test_apply_rolls_back_training_goal_when_plan_apply_fails(self, app_client, monkeypatch):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="move-race",
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id="race",
            old_value=_old_race_date(plan),
            spec_patch={
                "race_date": "2026-11-29",
                "plan_end_date": "2026-11-29",
                "milestone_date": "2026-11-29",
                "phase_updates": [
                    {"phase_id": "build", "end_date": "2026-11-14"},
                    {
                        "phase_id": "taper",
                        "start_date": "2026-11-15",
                        "end_date": "2026-11-29",
                    },
                ],
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="比赛延期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        original = {
            "current": {
                "goal_id": "g1",
                "race_date": "2026-11-15",
                "target_finish_time": "3:15:00",
                "type": "race",
                "race_distance": "FM",
            },
            "history": [],
        }
        writes: list[dict] = []
        monkeypatch.setattr(mp_mod, "read_json", lambda _path: (original, "file"))
        monkeypatch.setattr(
            mp_mod, "write_json", lambda _path, data: writes.append(data) or "file"
        )
        monkeypatch.setattr(
            mp_mod,
            "apply_master_plan_diff",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "比赛推迟",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 400, resp.text
        assert writes[0]["current"]["race_date"] == "2026-11-29"
        assert writes[1] == original

    def test_apply_reports_inconsistency_when_training_goal_rollback_fails(
        self, app_client, monkeypatch
    ):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="move-race",
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id="race",
            old_value=_old_race_date(plan),
            spec_patch={
                "race_date": "2026-11-29",
                "plan_end_date": "2026-11-29",
                "milestone_date": "2026-11-29",
                "phase_updates": [
                    {"phase_id": "build", "end_date": "2026-11-14"},
                    {
                        "phase_id": "taper",
                        "start_date": "2026-11-15",
                        "end_date": "2026-11-29",
                    },
                ],
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="比赛延期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        original = {
            "current": {
                "goal_id": "g1",
                "race_date": "2026-11-15",
                "target_finish_time": "3:15:00",
                "type": "race",
                "race_distance": "FM",
            },
            "history": [],
        }
        writes: list[dict] = []

        def fail_rollback(_path, data):
            writes.append(data)
            if data == original:
                raise RuntimeError("content store unavailable")
            return "file"

        monkeypatch.setattr(mp_mod, "read_json", lambda _path: (original, "file"))
        monkeypatch.setattr(mp_mod, "write_json", fail_rollback)
        monkeypatch.setattr(
            mp_mod,
            "apply_master_plan_diff",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "比赛推迟",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 503, resp.text
        assert resp.json()["detail"]["code"] == "master_plan_goal_inconsistent"
        assert writes[0]["current"]["race_date"] == "2026-11-29"
        assert writes[1:] == [original, original]

    def test_apply_treats_committed_then_raised_plan_save_as_success(
        self, app_client, monkeypatch
    ):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="focus",
            op=MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
            phase_id=plan.phases[0].id,
            old_value={"focus": plan.phases[0].focus},
            spec_patch={"focus": "已提交"},
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="更新重点",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        original_save = store.save_plan

        def commit_then_raise(updated):
            original_save(updated)
            raise RuntimeError("response lost")

        monkeypatch.setattr(store, "save_plan", commit_then_raise)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "commit ambiguity",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 1
        assert resp.json()["version"] == plan.version + 1

    def test_apply_compensates_committed_then_raised_goal_write(
        self, app_client, monkeypatch
    ):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_race_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id="move-race",
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id="race",
            old_value=_old_race_date(plan),
            spec_patch={
                "race_date": "2026-11-29",
                "plan_end_date": "2026-11-29",
                "milestone_date": "2026-11-29",
                "phase_updates": [
                    {"phase_id": "build", "end_date": "2026-11-14"},
                    {
                        "phase_id": "taper",
                        "start_date": "2026-11-15",
                        "end_date": "2026-11-29",
                    },
                ],
            },
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan.plan_id,
            ops=[op],
            ai_explanation="比赛延期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        state = {
            "current": {
                "goal_id": "g1",
                "race_date": "2026-11-15",
                "target_finish_time": "3:15:00",
                "type": "race",
                "race_distance": "FM",
            },
            "history": [],
        }
        original = json.loads(json.dumps(state))
        calls = 0

        def read_goal(_path):
            return json.loads(json.dumps(state)), "file"

        def commit_then_raise_once(_path, data):
            nonlocal calls, state
            calls += 1
            state = json.loads(json.dumps(data))
            if calls == 1:
                raise RuntimeError("response lost")
            return "file"

        monkeypatch.setattr(mp_mod, "read_json", read_goal)
        monkeypatch.setattr(mp_mod, "write_json", commit_then_raise_once)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff": diff.model_dump(),
                "accepted_op_ids": [op.id],
                "change_reason": "goal ambiguity",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 503, resp.text
        assert state == original
        persisted = store.get_plan(USER_UUID, plan.plan_id)
        assert persisted is not None
        assert persisted.version == plan.version


# ===========================================================================
# T42 — versions list tests
# ===========================================================================


class TestVersionsList:

    def test_empty_versions_list(self, app_client):
        """Plan with no versions → empty list."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        resp = client.get(
            f"/api/users/me/master-plan/{plan.plan_id}/versions",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["plan_id"] == plan.plan_id
        assert data["versions"] == []

    def test_versions_sorted_desc(self, app_client):
        """Multiple versions → sorted by version desc."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        now = datetime.now(timezone.utc).isoformat()
        for ver in [1, 2, 3]:
            v = MasterPlanVersion(
                version_id=str(uuid4()),
                plan_id=plan.plan_id,
                version=ver,
                changed_at=now,
                change_reason=f"变更 {ver}",
                change_summary=f"摘要 {ver}",
                snapshot_json=plan.model_dump_json(),
            )
            store.save_version(v)

        resp = client.get(
            f"/api/users/me/master-plan/{plan.plan_id}/versions",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        versions = resp.json()["versions"]
        assert len(versions) == 3
        # Verify descending order
        assert versions[0]["version"] == 3
        assert versions[1]["version"] == 2
        assert versions[2]["version"] == 1

    def test_versions_list_unknown_plan_returns_404(self, app_client):
        """Unknown plan_id → 404."""
        client, token, tmp_path, _ = app_client

        resp = client.get(
            "/api/users/me/master-plan/nonexistent-plan/versions",
            headers=_auth(token),
        )
        assert resp.status_code == 404, resp.text

    def test_versions_contains_required_fields(self, app_client):
        """Version entries have expected fields."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        now = datetime.now(timezone.utc).isoformat()
        v = MasterPlanVersion(
            version_id=str(uuid4()),
            plan_id=plan.plan_id,
            version=1,
            changed_at=now,
            change_reason="初始确认",
            change_summary="生成并确认总纲",
            snapshot_json=plan.model_dump_json(),
        )
        store.save_version(v)

        resp = client.get(
            f"/api/users/me/master-plan/{plan.plan_id}/versions",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        ver = resp.json()["versions"][0]
        assert "version_id" in ver
        assert "version" in ver
        assert "changed_at" in ver
        assert "change_reason" in ver
        assert "change_summary" in ver


# ===========================================================================
# T42 — get specific version snapshot tests
# ===========================================================================


class TestGetVersionSnapshot:

    def test_get_specific_version_returns_snapshot(self, app_client):
        """GET versions/{version} → full MasterPlan snapshot."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        now = datetime.now(timezone.utc).isoformat()
        v = MasterPlanVersion(
            version_id=str(uuid4()),
            plan_id=plan.plan_id,
            version=1,
            changed_at=now,
            change_reason="初始确认",
            change_summary="生成并确认总纲",
            snapshot_json=plan.model_dump_json(),
        )
        store.save_version(v)

        resp = client.get(
            f"/api/users/me/master-plan/{plan.plan_id}/versions/1",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["plan_id"] == plan.plan_id
        assert "phases" in data
        assert "milestones" in data

    def test_get_nonexistent_version_returns_404(self, app_client):
        """Unknown version number → 404."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        resp = client.get(
            f"/api/users/me/master-plan/{plan.plan_id}/versions/99",
            headers=_auth(token),
        )
        assert resp.status_code == 404, resp.text
