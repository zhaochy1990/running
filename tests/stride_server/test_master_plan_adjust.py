"""Tests for T42 — adjust-chat endpoints for ACTIVE master plans.

Covers:
  POST /api/users/me/master-plan/{plan_id}/adjust/messages
  POST /api/users/me/master-plan/{plan_id}/adjust/apply
  GET  /api/users/me/master-plan/{plan_id}/versions
  GET  /api/users/me/master-plan/{plan_id}/versions/{version}
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    MasterPlanVersion,
    Milestone,
    MilestoneType,
    Phase,
)
from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOp, MasterPlanDiffOpKind
from stride_server.master_plan_store import FileMasterPlanStore, reset_master_plan_store_cache
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
    milestone = Milestone(
        id=ms_id,
        type=MilestoneType.TEST_RUN,
        date="2026-07-05",
        phase_id=phase_id,
        target="30K 测试跑 4'55/km",
        completed_actual=None,
    )
    now = datetime.now(timezone.utc).isoformat()
    return MasterPlan(
        plan_id=str(uuid4()),
        user_id=user_id,
        status=status,
        goal_id=str(uuid4()),
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

    mp_mod._PENDING_MP_DIFFS.clear()

    from stride_server.bearer import require_bearer
    from stride_server.routes.master_plan import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    yield client, _token(private_pem), tmp_path, private_pem

    reset_master_plan_store_cache()
    mp_mod._PENDING_MP_DIFFS.clear()


def _get_store() -> FileMasterPlanStore:
    from stride_server.master_plan_store import get_master_plan_store
    return get_master_plan_store()


# ===========================================================================
# T42 — adjust/messages tests
# ===========================================================================


class TestAdjustMessages:

    def test_active_plan_returns_diff(self, app_client):
        """ACTIVE plan + valid LLM JSON → diff returned, diff_id stored."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.ACTIVE)
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        llm_output = f"""---BEGIN_MP_DIFF---
{{
  "ai_response": "已将基础期延长至 7 月 20 日，请注意清理手表中相关周次的训练",
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
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "把基础期延长两周", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert isinstance(data["ai_response"], str)
        assert data["diff"] is not None
        assert len(data["diff"]["ops"]) == 1
        assert data["diff"]["ops"][0]["op"] == "resize_phase"
        # diff_id stored in pending dict
        diff_id = data["diff"]["diff_id"]
        assert (USER_UUID, plan.plan_id, diff_id) in mp_mod._PENDING_MP_DIFFS

    def test_draft_plan_returns_409(self, app_client):
        """DRAFT plan → 409 (use review-chat instead)."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan(status=MasterPlanStatus.DRAFT)
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient"):
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "调整一下", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 409, resp.text

    def test_plan_not_found_returns_404(self, app_client):
        """Non-existent plan_id → 404."""
        client, token, tmp_path, _ = app_client

        with patch.object(mp_mod, "LLMClient"):
            resp = client.post(
                "/api/users/me/master-plan/nonexistent-id/adjust/messages",
                json={"message": "调整", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 404, resp.text

    def test_llm_unavailable_returns_503(self, app_client):
        """LLMUnavailable → 503."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.side_effect = mp_mod.LLMUnavailable("no config")
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "调整", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 503, resp.text

    def test_non_json_llm_output_returns_ai_response_diff_null(self, app_client):
        """LLM returns plain text → diff=null."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        with patch.object(mp_mod, "LLMClient") as MockLLM:
            MockLLM.return_value.chat_sync.return_value = "好的，我来看看怎么调整。"
            resp = client.post(
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "调整", "history": []},
                headers=_auth(token),
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["diff"] is None


# ===========================================================================
# T42 — adjust/apply tests
# ===========================================================================


class TestAdjustApply:

    def _post_messages_and_get_diff(
        self, client, token, plan, phase_id: str
    ) -> tuple[str, str]:
        """Helper: call /adjust/messages, return (diff_id, op_id)."""
        llm_output = f"""---BEGIN_MP_DIFF---
{{
  "ai_response": "已延长基础期",
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
                f"/api/users/me/master-plan/{plan.plan_id}/adjust/messages",
                json={"message": "延长基础期", "history": []},
                headers=_auth(token),
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["diff"]["diff_id"], data["diff"]["ops"][0]["id"]

    def test_apply_bumps_version_and_returns_affected_weeks(self, app_client):
        """Apply accepted op → version bumped, affected_weeks computed."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff_id, op_id = self._post_messages_and_get_diff(client, token, plan, phase_id)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff_id": diff_id,
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
        assert updated.phases[0].end_date == "2026-07-27"

    def test_apply_writes_version_snapshot(self, app_client):
        """apply → MasterPlanVersion snapshot stored in store."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        phase_id = plan.phases[0].id
        diff_id, op_id = self._post_messages_and_get_diff(client, token, plan, phase_id)

        client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff_id": diff_id,
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

    def test_apply_unknown_diff_id_returns_404(self, app_client):
        """Unknown diff_id → 404."""
        client, token, tmp_path, _ = app_client
        store = _get_store()
        plan = _make_plan()
        store.save_plan(plan)

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={"diff_id": "nonexistent", "accepted_op_ids": [], "change_reason": ""},
            headers=_auth(token),
        )
        assert resp.status_code == 404, resp.text

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
        mp_mod._PENDING_MP_DIFFS[(USER_UUID, plan.plan_id, diff.diff_id)] = (
            diff, time.monotonic()
        )

        resp = client.post(
            f"/api/users/me/master-plan/{plan.plan_id}/adjust/apply",
            json={
                "diff_id": diff.diff_id,
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
