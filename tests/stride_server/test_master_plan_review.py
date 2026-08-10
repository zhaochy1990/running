"""Tests for T21 (review-chat), T22 (confirm), T23 (current) endpoints.

Covers:
  POST /api/users/me/master-plan/{plan_id}/review/messages
  POST /api/users/me/master-plan/{plan_id}/review/apply
  POST /api/users/me/master-plan/{plan_id}/confirm
  GET  /api/users/me/master-plan/current
  GET  /api/users/me/master-plan/{plan_id}
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone, timedelta
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.master_plan import (
    KeySession,
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanWeek,
    Milestone,
    MilestoneType,
    Phase,
    TrainingLoadProjection,
)
from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOp, MasterPlanDiffOpKind
from stride_core.models import ActivityDetail
from stride_core.timefmt import today_shanghai
from stride_server.master_plan_store import FileMasterPlanStore, reset_master_plan_store_cache
import stride_server.routes.master_plan as mp_mod
from stride_storage.sqlite.database import Database

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"


# ---------------------------------------------------------------------------
# Helpers to build test fixtures
# ---------------------------------------------------------------------------


def _make_plan(
    user_id: str = USER_UUID,
    status: MasterPlanStatus = MasterPlanStatus.DRAFT,
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
        phases=[phase],
        milestones=[milestone],
        training_principles=["渐进原则", "充足休息"],
        generated_by="gpt-4.1",
        version=1,
        created_at=now,
        updated_at=now,
    )


def _make_diff(plan_id: str) -> MasterPlanDiff:
    op = MasterPlanDiffOp(
        id=str(uuid4()),
        op=MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id=str(uuid4()),
        milestone_id=None,
        old_value={"end_date": "2026-07-06"},
        new_value={"end_date": "2026-07-20"},
        spec_patch={"end_date": "2026-07-20"},
        accepted=None,
    )
    return MasterPlanDiff(
        diff_id=str(uuid4()),
        plan_id=plan_id,
        ops=[op],
        ai_explanation="延长基础期两周",
        created_at=datetime.now(timezone.utc).isoformat(),
    )


def _activity(
    label_id: str,
    *,
    date: str,
    distance_km: float,
    duration_s: float,
    pace_s_km: int,
    avg_hr: int,
    sport_type: int = 100,
    sport_name: str = "Run",
) -> ActivityDetail:
    return ActivityDetail(
        label_id=label_id,
        name="Test Run",
        sport_type=sport_type,
        sport_name=sport_name,
        date=date,
        distance_m=distance_km * 1000.0,
        duration_s=duration_s,
        avg_pace_s_km=pace_s_km,
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=None,
        avg_hr=avg_hr,
        max_hr=170,
        avg_cadence=180,
        max_cadence=190,
        avg_power=None,
        max_power=None,
        avg_step_len_cm=None,
        ascent_m=0,
        descent_m=0,
        calories_kcal=300,
        aerobic_effect=None,
        anaerobic_effect=None,
        training_load=None,
        vo2max=None,
        performance=None,
        train_type="Aerobic Endurance",
        temperature=None,
        humidity=None,
        feels_like=None,
        wind_speed=None,
        laps=[],
        zones=[],
        timeseries=[],
    )


# ---------------------------------------------------------------------------
# RSA fixtures and token helpers
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


# ---------------------------------------------------------------------------
# App client fixture with isolated FileMasterPlanStore
# ---------------------------------------------------------------------------


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

    # Isolate file store to tmp_path
    import stride_core.db as core_db_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(mp_mod, "get_db", lambda user: Database(user=user))

    # Reset the lru_cache so we get a fresh store using tmp_path
    reset_master_plan_store_cache()
    monkeypatch.setenv("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL", "")  # force file backend


    from stride_server.bearer import require_bearer
    from stride_server.routes.master_plan import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    yield client, _token(private_pem), tmp_path, private_pem

    # Cleanup
    reset_master_plan_store_cache()


def _get_store(monkeypatch=None) -> FileMasterPlanStore:
    """Get the current store instance (after fixture setup)."""
    from stride_server.master_plan_store import get_master_plan_store
    return get_master_plan_store()


# ===========================================================================
# T21 review/messages tests
# ===========================================================================


class TestReviewMessages:

    def test_valid_llm_response_returns_diff(self, app_client, monkeypatch):
        """LLM returns valid sentinel-wrapped JSON → 200 with diff.ops non-empty."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        llm_output = f"""---BEGIN_MP_DIFF---
{{
  "ai_response": "我把基础期延长了两周",
  "ops": [
    {{
      "op": "resize_phase",
      "phase_id": "{phase_id}",
      "milestone_id": null,
      "old_value": {{"end_date": "2026-07-06"}},
      "new_value": {{"end_date": "2026-07-20"}},
      "spec_patch": {{"end_date": "2026-07-20"}}
    }}
  ]
}}
---END_MP_DIFF---"""

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.return_value = llm_output
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "把基础期延长两周", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert isinstance(data["ai_response"], str)
        assert data["diff"] is not None
        assert len(data["diff"]["ops"]) == 1
        assert data["diff"]["ops"][0]["op"] == "resize_phase"
        assert data["diff"]["plan_id"] == plan.plan_id

    def test_llm_unavailable_returns_503(self, app_client, monkeypatch):
        """LLMUnavailable → 503."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.side_effect = mp_mod.LLMUnavailable("no config")
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 503, resp.text

    def test_llm_error_retryable_returns_503(self, app_client, monkeypatch):
        """LLMError(retryable=True) → 503."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.side_effect = mp_mod.LLMError(
                "rate limit", retryable=True
            )
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 503, resp.text

    def test_llm_error_non_retryable_returns_502(self, app_client):
        """LLMError(retryable=False) → 502."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.side_effect = mp_mod.LLMError(
                "auth error", retryable=False
            )
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 502, resp.text

    def test_non_json_llm_output_returns_ai_response_diff_null(self, app_client):
        """LLM returns non-JSON → ai_response is raw text, diff=null."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.return_value = "好的，我帮您调整一下基础期的长度。"
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "好的" in data["ai_response"]
        assert data["diff"] is None

    def test_plan_not_found_returns_404(self, app_client):
        """Non-existent plan_id → 404."""
        client, token, tmp_path, _ = app_client

        with patch.object(mp_mod, "LLMClient"):
            resp = client.post(
                "/api/users/me/master-plan/nonexistent-plan-id/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 404, resp.text

    def test_active_plan_returns_409(self, app_client):
        """plan.status=ACTIVE → 409."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient"):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 409, resp.text

    def test_user_mismatch_returns_403(self, app_client):
        """Plan stored under USER_UUID bucket but plan.user_id=OTHER_UUID → 403.

        The store indexes by the requesting user's id (partition key), so to
        reach the 403 branch we need the plan row to be *findable* by USER_UUID
        but have a mismatched plan.user_id field.
        """
        client, token, tmp_path, private_pem = app_client
        store = _get_store()
        # Build a plan that is stored under USER_UUID but claims OTHER_UUID as owner.
        plan = _make_plan(user_id=OTHER_UUID)
        # Force-save under USER_UUID's partition by temporarily overriding user_id
        # during save only — we do this by directly calling save with a patched plan.
        plan_as_other = plan.model_copy(update={"user_id": USER_UUID})
        plan_stored = plan_as_other.model_copy(update={"user_id": OTHER_UUID})
        # Use FileMasterPlanStore internals: save keyed by USER_UUID, but payload has OTHER_UUID
        from stride_core.db import USER_DATA_DIR
        import json as _json
        plans_file = USER_DATA_DIR / ".master_plans.json"
        data: dict = {}
        if plans_file.exists():
            try:
                data = _json.loads(plans_file.read_text(encoding="utf-8"))
            except Exception:
                data = {}
        data.setdefault(USER_UUID, {})[plan.plan_id] = _json.loads(plan_stored.model_dump_json())
        from stride_server.master_plan_store import _write_json
        _write_json(plans_file, data)

        with patch.object(mp_mod, "LLMClient"):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),  # USER_UUID token
            )

        assert resp.status_code == 403, resp.text

    def test_diff_is_returned_for_stateless_apply(self, app_client):
        """Review messages returns the full typed diff for stateless apply."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        phase_id = plan.phases[0].id
        llm_output = f"""---BEGIN_MP_DIFF---
{{
  "ai_response": "延长基础期",
  "ops": [{{
    "op": "resize_phase",
    "phase_id": "{phase_id}",
    "old_value": {{"end_date": "2026-07-06"}},
    "new_value": {{"end_date": "2026-07-27"}},
    "spec_patch": {{"end_date": "2026-07-27"}}
  }}]
}}
---END_MP_DIFF---"""
        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.return_value = llm_output
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/review/messages",
                json={"message": "把基础期延长三周", "history": []},
                headers=_auth(token),
            )
        assert resp.status_code == 200, resp.text
        assert resp.json()["diff"]["plan_id"] == plan.plan_id


# ===========================================================================
# T21 review/apply tests
# ===========================================================================


class TestReviewApply:

    def _post_messages(self, client, token, plan_id: str, phase_id: str) -> tuple[dict, str]:
        """Helper: call /messages and return the full diff body."""
        llm_output = f"""---BEGIN_MP_DIFF---
{{
  "ai_response": "延长基础期",
  "ops": [
    {{
      "op": "resize_phase",
      "phase_id": "{phase_id}",
      "milestone_id": null,
      "old_value": {{"end_date": "2026-07-06"}},
      "new_value": {{"end_date": "2026-07-27"}},
      "spec_patch": {{"end_date": "2026-07-27"}}
    }}
  ]
}}
---END_MP_DIFF---"""
        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.return_value = llm_output
            resp = client.post(
                f"/api/users/me/master-plan/{plan_id}/review/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )
        assert resp.status_code == 200, resp.text
        return resp.json()["diff"], resp.json()["diff"]["ops"][0]["id"]

    def _make_resize_diff(self, plan_id: str, phase_id: str, end_date: str) -> tuple[MasterPlanDiff, str]:
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.RESIZE_PHASE,
            phase_id=phase_id,
            milestone_id=None,
            old_value={"end_date": "2026-07-06"},
            new_value={"end_date": end_date},
            spec_patch={"end_date": end_date},
            accepted=None,
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()),
            plan_id=plan_id,
            ops=[op],
            ai_explanation="延长基础期",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        return diff, op.id

    def test_apply_updates_plan(self, app_client):
        """Apply accepted op → plan phase end_date updated."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff_body, op_id = self._post_messages(client, token, plan.plan_id, phase_id)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={"diff": diff_body, "accepted_op_ids": [op_id], "change_reason": "想多打基础"},
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["applied"] == 1
        assert data["plan_id"] == plan.plan_id

        # Verify plan was updated in store
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.phases[0].end_date == "2026-07-27"
        # version should NOT be bumped (still 1)
        assert updated.version == 1
        # status should still be DRAFT
        assert updated.status == MasterPlanStatus.DRAFT

    def test_apply_accepts_stateless_diff_body(self, app_client):
        """Client can send the full diff back; apply does not require server memory."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        diff, op_id = self._make_resize_diff(plan.plan_id, plan.phases[0].id, "2026-08-03")

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "diff": diff.model_dump(mode="json"),
                "accepted_op_ids": [op_id],
                "change_reason": "需要更多基础",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 1
        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated is not None
        assert updated.phases[0].end_date == "2026-08-03"

    def test_apply_rejects_diff_plan_id_mismatch(self, app_client):
        """Client-supplied diff must match the path plan id."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        diff, op_id = self._make_resize_diff("other-plan", plan.phases[0].id, "2026-08-03")

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "diff": diff.model_dump(mode="json"),
                "accepted_op_ids": [op_id],
                "change_reason": "需要更多基础",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 400, resp.text

    def test_apply_missing_diff_body_returns_422(self, app_client):
        """Stateless review apply requires the typed diff body."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "accepted_op_ids": [],
                "change_reason": "",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 422, resp.text

    def test_review_apply_rejects_atomic_race_reschedule_op(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
            milestone_id=plan.milestones[0].id,
            spec_patch={"race_date": "2026-11-08"},
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()), plan_id=plan.plan_id, ops=[op],
            ai_explanation="move race",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "diff": diff.model_dump(mode="json"),
                "accepted_op_ids": [op.id],
                "change_reason": "move race",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 400
        assert "Coach 原子 apply" in resp.json()["detail"]

    def test_review_apply_rejects_atomic_target_race_time_op(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)
        op = MasterPlanDiffOp(
            id=str(uuid4()),
            op=MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME,
            milestone_id=plan.milestones[0].id,
            spec_patch={"target_time": "3:10:00"},
        )
        diff = MasterPlanDiff(
            diff_id=str(uuid4()), plan_id=plan.plan_id, ops=[op],
            ai_explanation="target time",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "diff": diff.model_dump(mode="json"),
                "accepted_op_ids": [op.id],
                "change_reason": "target time",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 400
        assert "Coach 原子 apply" in resp.json()["detail"]

    def test_apply_active_plan_returns_409(self, app_client):
        """Apply to active plan → 409."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={"diff": self._make_resize_diff(plan.plan_id, plan.phases[0].id, "2026-08-03")[0].model_dump(mode="json"), "accepted_op_ids": [], "change_reason": ""},
            headers=_auth(token),
        )

        assert resp.status_code == 409, resp.text

    def test_apply_skips_unknown_op_ids(self, app_client):
        """Unknown op_ids in accepted_op_ids are skipped gracefully."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff_body, real_op_id = self._post_messages(client, token, plan.plan_id, phase_id)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "diff": diff_body,
                "accepted_op_ids": ["nonexistent-op-id"],  # not the real op id
                "change_reason": "",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 0

    def test_apply_full_diff_directly(self, app_client):
        """Send a full stateless diff directly and apply it."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        diff, op_id = self._make_resize_diff(plan.plan_id, plan.phases[0].id, "2026-08-03")

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/review/apply",
            json={
                "diff": diff.model_dump(mode="json"),
                "accepted_op_ids": [op_id],
                "change_reason": "需要更多基础",
            },
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 1

        updated = store.get_plan(USER_UUID, plan.plan_id)
        assert updated.phases[0].end_date == "2026-08-03"
        assert updated.version == 1  # no version bump in review phase


# ===========================================================================
# T22 confirm tests
# ===========================================================================


class TestConfirm:

    def test_confirm_draft_plan_becomes_active(self, app_client):
        """Confirming a DRAFT plan → status=active."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch("stride_server.routes.generate.generate_week") as mock_gw:
            mock_gw.return_value = {"folder": "2026-05-11_05-17"}
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/confirm",
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["plan_id"] == plan.plan_id
        assert data["status"] == "active"
        assert "activated_at" in data

        saved = store.get_plan(USER_UUID, plan.plan_id)
        assert saved is not None
        assert saved.status == MasterPlanStatus.ACTIVE

    def test_confirm_already_active_returns_409(self, app_client):
        """Confirming an ACTIVE plan → 409."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/confirm",
            headers=_auth(token),
        )

        assert resp.status_code == 409, resp.text

    def test_confirm_nonexistent_returns_404(self, app_client):
        """Nonexistent plan → 404."""
        client, token, tmp_path, _ = app_client

        resp = client.post(
            "/api/users/me/master-plan/nonexistent-plan-id/confirm",
            headers=_auth(token),
        )

        assert resp.status_code == 404, resp.text

    def test_confirm_archives_previous_active_plan(self, app_client):
        """Confirming a new draft when an active plan exists → old plan archived."""
        client, token, tmp_path, _ = app_client
        store = _get_store()

        # Create and save an existing active plan
        old_plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(old_plan)

        # Create a new draft plan
        new_plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(new_plan)

        with patch("stride_server.routes.generate.generate_week") as mock_gw:
            mock_gw.return_value = {"folder": "2026-05-11_05-17"}
            resp = client.post(
                f"/api/users/me/master-plan/{new_plan.plan_id}/confirm",
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text

        # Old plan should now be archived
        old_saved = store.get_plan(USER_UUID, old_plan.plan_id)
        assert old_saved is not None
        assert old_saved.status == MasterPlanStatus.ARCHIVED

        # New plan should be active
        new_saved = store.get_plan(USER_UUID, new_plan.plan_id)
        assert new_saved is not None
        assert new_saved.status == MasterPlanStatus.ACTIVE

    def test_confirm_does_not_auto_generate_week(self, app_client):
        """Confirm must NOT trigger single-week generation.

        Single-week plans are generated lazily after the user finishes
        last week's training and supplies feedback. The mobile home
        screen surfaces a manual CTA to generate the first week.
        """
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch("stride_server.routes.generate.generate_week") as mock_gw:
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/confirm",
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "active"
        # Response no longer carries week-generation fields
        assert "triggered_week_generate" not in data
        assert "first_week_folder" not in data
        # generate_week must NOT have been called
        mock_gw.assert_not_called()


# ===========================================================================
# T23 current endpoint tests
# ===========================================================================


class TestCurrentMasterPlan:

    def test_no_active_plan_returns_404(self, app_client):
        """No active plan for user → 404."""
        client, token, tmp_path, _ = app_client

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 404, resp.text

    def test_active_plan_returns_full_fields(self, app_client):
        """Active plan returns all required fields."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(plan)

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["plan_id"] == plan.plan_id
        assert data["status"] == "active"
        assert "phases" in data
        assert "goal" in data
        assert "weeks" in data
        assert "milestones" in data
        assert "current_phase_id" in data
        assert "current_week_number" in data
        assert "total_weeks" in data
        assert "next_milestone" in data
        assert isinstance(data["total_weeks"], int)
        assert data["total_weeks"] > 0
        assert data["phases"][0]["key_session_types"] == ["长距离", "有氧"]
        assert data["milestones"][0]["type"] == "test_run"
        assert "completed_actual" in data["milestones"][0]

    def test_current_returns_canonical_goal_and_weeks(self, app_client):
        """/current returns the canonical MasterPlan contract plus derived position."""
        client, token, tmp_path, _ = app_client
        store = _get_store()

        today = today_shanghai()
        phase_id = str(uuid4())
        goal_id = str(uuid4())
        phase = Phase(
            id=phase_id,
            name="测试期",
            start_date=today.isoformat(),
            end_date=(today + timedelta(days=6)).isoformat(),
            focus="测试结构化响应",
            weekly_distance_km_low=30.0,
            weekly_distance_km_high=40.0,
            key_session_types=["长距离"],
            milestone_ids=[],
        )
        now = datetime.now(timezone.utc).isoformat()
        plan = MasterPlan(
            plan_id=str(uuid4()),
            user_id=USER_UUID,
            status=MasterPlanStatus.ACTIVE,
            goal=MasterPlanGoal(
                goal_id=goal_id,
                race_name="Shanghai Marathon",
                distance="FM",
                race_date=(today + timedelta(days=30)).isoformat(),
                target_time="3:30:00",
            ),
            start_date=today.isoformat(),
            end_date=(today + timedelta(days=6)).isoformat(),
            total_weeks=1,
            phases=[phase],
            milestones=[],
            weeks=[
                MasterPlanWeek(
                    week_index=1,
                    week_start=today.isoformat(),
                    phase_id=phase_id,
                    target_weekly_km_low=30.0,
                    target_weekly_km_high=40.0,
                    target_training_dose_low=180.0,
                    target_training_dose_high=230.0,
                    key_sessions=[KeySession(type="long_run", distance_km=18.0)],
                )
            ],
            training_load_projection=TrainingLoadProjection(
                status="available",
                calculated_at=now,
            ),
            training_principles=[],
            generated_by="gpt-4.1",
            version=1,
            created_at=now,
            updated_at=now,
        )
        store.save_plan(plan)

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["goal"]["goal_id"] == goal_id
        assert data["goal"]["target_time"] == "3:30:00"
        assert data["goal"]["timezone"] == "Asia/Shanghai"
        assert "goal_id" not in data
        assert data["total_weeks"] == 1
        assert data["weeks"][0]["week_index"] == 1
        assert data["weeks"][0]["key_sessions"][0]["type"] == "long_run"
        assert data["weeks"][0]["target_training_dose_low"] == 180.0
        assert data["weeks"][0]["target_training_dose_high"] == 230.0
        assert data["training_load_projection"]["status"] == "available"
        assert data["current_week_number"] == 1
        assert data["current_phase_id"] == phase_id

    def test_current_returns_unavailable_projection_for_legacy_plan(self, app_client):
        client, token, tmp_path, _ = app_client
        store = _get_store()
        now = datetime.now(timezone.utc).isoformat()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE).model_copy(update={
            "training_load_projection": TrainingLoadProjection(
                status="unavailable",
                unavailable_reason="weekly_skeleton_unavailable",
                calculated_at=now,
            ),
        })
        store.save_plan(plan)

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        projection = resp.json()["training_load_projection"]
        assert projection == {
            "status": "unavailable",
            "unavailable_reason": "weekly_skeleton_unavailable",
            "calculated_at": now,
        }
        assert all(
            week.get("target_training_dose_low") is None
            and week.get("target_training_dose_high") is None
            for week in resp.json()["weeks"]
        )

    def test_current_injects_completed_week_running_summary(self, app_client):
        """Completed weeks expose actual running km and aggregate metrics."""
        client, token, tmp_path, _ = app_client
        store = _get_store()

        today = today_shanghai()
        this_monday = today - timedelta(days=today.weekday())
        week_start = this_monday - timedelta(days=14)
        current_week = this_monday
        future_week = this_monday + timedelta(days=7)
        phase_id = str(uuid4())
        phase = Phase(
            id=phase_id,
            name="测试期",
            start_date=week_start.isoformat(),
            end_date=(future_week + timedelta(days=6)).isoformat(),
            focus="测试实际周跑量",
            weekly_distance_km_low=30.0,
            weekly_distance_km_high=60.0,
            key_session_types=["长距离"],
            milestone_ids=[],
        )
        now = datetime.now(timezone.utc).isoformat()
        plan = MasterPlan(
            plan_id=str(uuid4()),
            user_id=USER_UUID,
            status=MasterPlanStatus.ACTIVE,
            goal=MasterPlanGoal(
                goal_id=str(uuid4()),
                race_date=(today + timedelta(days=30)).isoformat(),
                target_time="",
            ),
            start_date=week_start.isoformat(),
            end_date=(future_week + timedelta(days=6)).isoformat(),
            total_weeks=4,
            phases=[phase],
            milestones=[],
            weeks=[
                MasterPlanWeek(
                    week_index=1,
                    week_start=week_start.isoformat(),
                    phase_id=phase_id,
                    target_weekly_km_low=30.0,
                    target_weekly_km_high=40.0,
                    key_sessions=[KeySession(type="long_run", distance_km=16.0)],
                ),
                MasterPlanWeek(
                    week_index=3,
                    week_start=current_week.isoformat(),
                    phase_id=phase_id,
                    target_weekly_km_low=40.0,
                    target_weekly_km_high=50.0,
                    key_sessions=[KeySession(type="tempo", distance_km=12.0)],
                ),
                MasterPlanWeek(
                    week_index=4,
                    week_start=future_week.isoformat(),
                    phase_id=phase_id,
                    target_weekly_km_low=45.0,
                    target_weekly_km_high=55.0,
                    key_sessions=[KeySession(type="long_run", distance_km=20.0)],
                ),
            ],
            training_principles=[],
            generated_by="gpt-4.1",
            version=1,
            created_at=now,
            updated_at=now,
        )
        store.save_plan(plan)

        db = Database(user=USER_UUID)
        try:
            db.upsert_activity(_activity(
                "run-a",
                date=f"{week_start.isoformat()}T01:00:00+00:00",
                distance_km=12.3,
                duration_s=3600,
                pace_s_km=300,
                avg_hr=140,
            ))
            db.upsert_activity(_activity(
                "run-b",
                date=f"{(week_start + timedelta(days=2)).isoformat()}T01:00:00+00:00",
                distance_km=8.2,
                duration_s=2400,
                pace_s_km=330,
                avg_hr=155,
            ))
            db.upsert_activity(_activity(
                "bike",
                date=f"{(week_start + timedelta(days=3)).isoformat()}T01:00:00+00:00",
                distance_km=40.0,
                duration_s=3600,
                pace_s_km=999,
                avg_hr=120,
                sport_type=200,
                sport_name="Bike",
            ))
            db.upsert_activity(_activity(
                "current-run",
                date=f"{today.isoformat()}T01:00:00+00:00",
                distance_km=7.0,
                duration_s=2100,
                pace_s_km=300,
                avg_hr=145,
            ))
            from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION

            # Completed week 1: full 7-day complete/rest_confirmed coverage.
            week1_rows = [
                (
                    (week_start + timedelta(days=offset)).isoformat(),
                    dose,
                    status,
                )
                for offset, dose, status in [
                    (0, 70, "complete"),
                    (1, 0, "rest_confirmed"),
                    (2, 55, "complete"),
                    (3, 45, "complete"),
                    (4, 0, "rest_confirmed"),
                    (5, 60, "complete"),
                    (6, 40, "complete"),
                ]
            ]
            # Current week: every elapsed day is covered. The DB aggregation can
            # therefore call the clamped window complete, but the API must still
            # expose it as partial / "as of now" until the canonical week ends.
            elapsed_days = (today - current_week).days + 1
            current_rows = [
                (
                    (current_week + timedelta(days=offset)).isoformat(),
                    50,
                    "complete",
                )
                for offset in range(elapsed_days)
            ]
            db._conn.executemany(
                "INSERT INTO daily_training_load "
                "(date, algorithm_version, training_dose, coverage_status) "
                "VALUES (?,?,?,?)",
                [
                    (d, TRAINING_LOAD_MODEL_VERSION, dose, status)
                    for d, dose, status in (week1_rows + current_rows)
                ],
            )
            db._conn.commit()
        finally:
            db.close()

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        weeks_by_index = {week["week_index"]: week for week in data["weeks"]}
        completed = weeks_by_index[1]
        current = weeks_by_index[3]
        future = weeks_by_index[4]
        assert completed["is_completed"] is True
        assert completed["planned_distance_km"] == 40.0
        assert completed["actual_distance_km"] == 20.5
        assert completed["actual_avg_pace_s_km"] == 312
        assert completed["actual_avg_pace_fmt"] == "5:12"
        assert completed["actual_avg_hr"] == 146
        assert completed["actual_run_count"] == 2
        assert completed["actual_training_dose"] == 270.0
        assert completed["actual_training_dose_coverage"] == 1.0
        assert completed["actual_training_dose_status"] == "complete"
        assert current["is_completed"] is False
        assert current["planned_distance_km"] == 50.0
        assert current["actual_distance_km"] == 7.0
        assert current["actual_avg_pace_s_km"] == 300
        assert current["actual_avg_pace_fmt"] == "5:00"
        assert current["actual_avg_hr"] == 145
        assert current["actual_run_count"] == 1
        # Current week is clamped to today; the canonical week has not finished,
        # so it is partial for plan comparison even if elapsed days are complete.
        assert current["actual_training_dose"] == 50.0 * elapsed_days
        assert current["actual_training_dose_coverage"] == 1.0
        assert current["actual_training_dose_status"] == "partial"
        assert future["is_completed"] is False
        assert "actual_distance_km" not in future
        # Future weeks must not fabricate actual dose values.
        assert future["actual_training_dose"] is None
        assert future["actual_training_dose_coverage"] == 0.0
        assert future["actual_training_dose_status"] == "unknown"

    def test_current_synthesizes_completed_lead_in_weeks(self, app_client):
        """Completed lead-in phases without weekly skeletons still expose actual weeks."""
        client, token, tmp_path, _ = app_client
        store = _get_store()

        today = today_shanghai()
        this_monday = today - timedelta(days=today.weekday())
        lead_start = this_monday - timedelta(weeks=3)
        future_week = this_monday
        completed_phase_id = str(uuid4())
        future_phase_id = str(uuid4())
        completed_phase = Phase(
            id=completed_phase_id,
            name="已完成基础期",
            start_date=lead_start.isoformat(),
            end_date=(lead_start + timedelta(days=20)).isoformat(),
            focus="历史基础期，不展开周课表",
            weekly_distance_km_low=120.0,
            weekly_distance_km_high=190.0,
            key_session_types=[],
            milestone_ids=[],
            is_completed=True,
        )
        future_phase = Phase(
            id=future_phase_id,
            name="速度期",
            start_date=future_week.isoformat(),
            end_date=(future_week + timedelta(days=6)).isoformat(),
            focus="未来周",
            weekly_distance_km_low=45.0,
            weekly_distance_km_high=55.0,
            key_session_types=["间歇"],
            milestone_ids=[],
        )
        now = datetime.now(timezone.utc).isoformat()
        plan = MasterPlan(
            plan_id=str(uuid4()),
            user_id=USER_UUID,
            status=MasterPlanStatus.ACTIVE,
            goal=MasterPlanGoal(
                goal_id=str(uuid4()),
                race_date=(today + timedelta(days=30)).isoformat(),
                target_time="",
            ),
            start_date=lead_start.isoformat(),
            end_date=(future_week + timedelta(days=6)).isoformat(),
            total_weeks=4,
            phases=[completed_phase, future_phase],
            milestones=[],
            weeks=[
                MasterPlanWeek(
                    week_index=4,
                    week_start=future_week.isoformat(),
                    phase_id=future_phase_id,
                    target_weekly_km_low=45.0,
                    target_weekly_km_high=55.0,
                    key_sessions=[KeySession(type="interval", distance_km=10.0)],
                ),
            ],
            training_principles=[],
            generated_by="gpt-4.1",
            version=1,
            created_at=now,
            updated_at=now,
        )
        store.save_plan(plan)

        db = Database(user=USER_UUID)
        try:
            db.upsert_activity(_activity(
                "lead-run-a",
                date=f"{lead_start.isoformat()}T01:00:00+00:00",
                distance_km=10.0,
                duration_s=3000,
                pace_s_km=300,
                avg_hr=140,
            ))
            db.upsert_activity(_activity(
                "lead-run-b",
                date=f"{(lead_start + timedelta(days=7)).isoformat()}T01:00:00+00:00",
                distance_km=12.0,
                duration_s=3840,
                pace_s_km=320,
                avg_hr=150,
            ))
        finally:
            db.close()

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        weeks = resp.json()["weeks"]
        assert [week["week_index"] for week in weeks] == [1, 2, 3, 4]
        assert weeks[0]["phase_id"] == completed_phase_id
        assert weeks[0]["is_completed"] is True
        assert weeks[0]["planned_distance_km"] is None
        assert weeks[0]["actual_distance_km"] == 10.0
        assert weeks[0]["actual_avg_pace_fmt"] == "5:00"
        assert weeks[1]["actual_distance_km"] == 12.0
        assert weeks[2]["actual_distance_km"] == 0.0
        assert weeks[3]["phase_id"] == future_phase_id
        assert weeks[3]["planned_distance_km"] == 55.0
        assert weeks[3]["is_completed"] is False
        assert weeks[3]["actual_distance_km"] == 0.0
        assert weeks[3]["actual_run_count"] == 0

    def test_current_phase_id_correct(self, app_client):
        """current_phase_id is set when today falls within a phase."""
        client, token, tmp_path, _ = app_client
        store = _get_store()

        today = datetime.now(timezone.utc).date()
        yesterday = (today - timedelta(days=1)).isoformat()
        next_month = (today + timedelta(days=30)).isoformat()

        phase_id = str(uuid4())
        phase = Phase(
            id=phase_id,
            name="测试期",
            start_date=yesterday,
            end_date=next_month,
            focus="测试",
            weekly_distance_km_low=30.0,
            weekly_distance_km_high=40.0,
            key_session_types=["有氧"],
            milestone_ids=[],
        )
        now = datetime.now(timezone.utc).isoformat()
        plan = MasterPlan(
            plan_id=str(uuid4()),
            user_id=USER_UUID,
            status=MasterPlanStatus.ACTIVE,
            goal_id=str(uuid4()),
            start_date=yesterday,
            end_date=(today + timedelta(days=90)).isoformat(),
            phases=[phase],
            milestones=[],
            training_principles=[],
            generated_by="gpt-4.1",
            version=1,
            created_at=now,
            updated_at=now,
        )
        store.save_plan(plan)

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["current_phase_id"] == phase_id

    def test_next_milestone_calculation(self, app_client):
        """next_milestone returns the nearest incomplete milestone."""
        client, token, tmp_path, _ = app_client
        store = _get_store()

        today = today_shanghai()
        future_date = (today + timedelta(days=14)).isoformat()

        phase_id = str(uuid4())
        ms_id = str(uuid4())
        phase = Phase(
            id=phase_id,
            name="基础期",
            start_date=today.isoformat(),
            end_date=(today + timedelta(days=60)).isoformat(),
            focus="有氧",
            weekly_distance_km_low=40.0,
            weekly_distance_km_high=50.0,
            key_session_types=["有氧"],
            milestone_ids=[ms_id],
        )
        ms = Milestone(
            id=ms_id,
            type=MilestoneType.TEST_RUN,
            date=future_date,
            phase_id=phase_id,
            target="30K 测试跑",
            completed_actual=None,
        )
        now = datetime.now(timezone.utc).isoformat()
        plan = MasterPlan(
            plan_id=str(uuid4()),
            user_id=USER_UUID,
            status=MasterPlanStatus.ACTIVE,
            goal_id=str(uuid4()),
            start_date=today.isoformat(),
            end_date=(today + timedelta(days=90)).isoformat(),
            phases=[phase],
            milestones=[ms],
            training_principles=[],
            generated_by="gpt-4.1",
            version=1,
            created_at=now,
            updated_at=now,
        )
        store.save_plan(plan)

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        nm = resp.json()["next_milestone"]
        assert nm is not None
        assert nm["id"] == ms_id
        assert nm["days_until"] == 14

    def test_get_by_id_returns_plan(self, app_client):
        """GET /{plan_id} works for any status."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(plan)

        resp = client.get(
            f"/api/users/me/master-plan/{plan.plan_id}",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["plan_id"] == plan.plan_id
        assert resp.json()["training_load_projection"] is None

    def test_get_by_id_unknown_returns_404(self, app_client):
        """GET /{plan_id} with unknown id → 404."""
        client, token, tmp_path, _ = app_client

        resp = client.get(
            "/api/users/me/master-plan/nonexistent-id",
            headers=_auth(token),
        )

        assert resp.status_code == 404, resp.text

    def test_draft_plan_not_returned_by_current(self, app_client):
        """DRAFT plan is not returned by /current (only active)."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(plan)

        resp = client.get(
            "/api/users/me/master-plan/current",
            headers=_auth(token),
        )

        assert resp.status_code == 404, resp.text

    def test_draft_endpoint_returns_latest_draft(self, app_client):
        """GET /draft returns the newest draft so review can survive refresh."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        older = _make_plan(status=MasterPlanStatus.DRAFT).model_copy(
            update={"updated_at": "2026-05-01T00:00:00+00:00"}
        )
        newer = _make_plan(status=MasterPlanStatus.DRAFT).model_copy(
            update={"updated_at": "2026-05-02T00:00:00+00:00"}
        )
        active = _make_plan(status=MasterPlanStatus.ACTIVE).model_copy(
            update={"updated_at": "2026-05-03T00:00:00+00:00"}
        )
        store.save_plan(older)
        store.save_plan(newer)
        store.save_plan(active)

        resp = client.get(
            "/api/users/me/master-plan/draft",
            headers=_auth(token),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["plan_id"] == newer.plan_id
        assert data["status"] == "draft"
        assert data["training_load_projection"] is None

    def test_draft_endpoint_returns_404_without_draft(self, app_client):
        """GET /draft returns 404 when only active/archived plans exist."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        store.save_plan(_make_plan(status=MasterPlanStatus.ACTIVE))

        resp = client.get(
            "/api/users/me/master-plan/draft",
            headers=_auth(token),
        )

        assert resp.status_code == 404, resp.text
