"""Master plan endpoints (T12 + T21 + T22 + T23 + T42).

Implemented endpoints:
  POST /api/users/me/master-plan/generate             — T12: async generation
  GET  /api/users/me/master-plan/jobs/{job_id}        — T12: poll job
  POST /api/users/me/master-plan/{plan_id}/review/messages  — T21: review chat
  POST /api/users/me/master-plan/{plan_id}/review/apply     — T21: apply diff
  POST /api/users/me/master-plan/{plan_id}/confirm          — T22: confirm draft→active
  GET  /api/users/me/master-plan/current                    — T23: active plan
  GET  /api/users/me/master-plan/{plan_id}                  — T23: by id
  POST /api/users/me/master-plan/{plan_id}/adjust/messages  — T42: adjust chat (active)
  POST /api/users/me/master-plan/{plan_id}/adjust/apply     — T42: apply adjust diff
  GET  /api/users/me/master-plan/{plan_id}/versions         — T42: version list
  GET  /api/users/me/master-plan/{plan_id}/versions/{ver}   — T42: version snapshot
"""

from __future__ import annotations

import json
import logging
import time
import threading
from datetime import date as date_cls, datetime, timezone, timedelta
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from stride_core.master_plan import MasterPlanStatus, _apply_review_diff
from stride_core.timefmt import today_shanghai
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
)

from ..bearer import require_bearer
from ..content_store import read_json
from .. import job_runner
from ..job_runner import JobStatus, JobStage, STAGE_LABEL_MAP
from .. import llm_client as _llm_client_mod
from ..llm_client import LLMClient, LLMError, LLMUnavailable
from .. import master_plan_generator
from ..master_plan_store import get_master_plan_store

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory pending master-plan diffs (TTL 900s)
# ---------------------------------------------------------------------------

_PENDING_MP_DIFFS: dict[tuple[str, str, str], tuple[MasterPlanDiff, float]] = {}
# key: (user_id, plan_id, diff_id)   value: (diff, mono_time)
_MP_DIFF_TTL = 900  # 15 minutes


def _mp_diff_cleanup() -> None:
    now = time.monotonic()
    expired = [k for k, (_, ts) in _PENDING_MP_DIFFS.items() if now - ts > _MP_DIFF_TTL]
    for k in expired:
        del _PENDING_MP_DIFFS[k]


def _mp_diff_store(user_id: str, plan_id: str, diff: MasterPlanDiff) -> None:
    _mp_diff_cleanup()
    _PENDING_MP_DIFFS[(user_id, plan_id, diff.diff_id)] = (diff, time.monotonic())


def _mp_diff_get(user_id: str, plan_id: str, diff_id: str) -> MasterPlanDiff | None:
    entry = _PENDING_MP_DIFFS.get((user_id, plan_id, diff_id))
    if entry is None:
        return None
    diff, ts = entry
    if time.monotonic() - ts > _MP_DIFF_TTL:
        del _PENDING_MP_DIFFS[(user_id, plan_id, diff_id)]
        return None
    return diff

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    goal_id: str | None = None      # 不填时用当前 active goal
    profile_id: str | None = None   # 不填时用当前 running-profile


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_current_goal(user_id: str) -> dict[str, Any] | None:
    """Read current training goal from content store. Returns None if absent."""
    item = read_json(f"{user_id}/training_goal.json")
    if item is None:
        return None
    data, _ = item
    if isinstance(data, dict):
        return data.get("current")
    return None


def _read_current_profile(user_id: str) -> dict[str, Any] | None:
    """Read current running profile from content store. Returns None if absent."""
    item = read_json(f"{user_id}/running_profile.json")
    if item is None:
        return None
    data, _ = item
    if isinstance(data, dict):
        return data.get("current")
    return None


# ---------------------------------------------------------------------------
# POST /api/users/me/master-plan/generate
# ---------------------------------------------------------------------------


@router.post("/api/users/me/master-plan/generate", status_code=status.HTTP_201_CREATED)
def generate_master_plan(
    body: GenerateRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Trigger async master plan generation.

    Idempotent: if a QUEUED/RUNNING job already exists for this user, returns
    that job (HTTP 200) instead of starting a duplicate.
    """
    user_id: str = payload["sub"]

    # --- Idempotency check ---
    existing = job_runner.get_running_job_for_user(user_id)
    if existing is not None:
        # Return existing job — do not create a duplicate
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "job_id": existing.job_id,
                "status": existing.status.value,
                "eta_seconds": 120,
            },
        )

    # --- Validate explicit goal_id if provided ---
    if body.goal_id is not None:
        goal_store_item = read_json(f"{user_id}/training_goal.json")
        if goal_store_item is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Training goal '{body.goal_id}' not found",
            )
        store_data, _ = goal_store_item
        current_goal = store_data.get("current") if isinstance(store_data, dict) else None
        if current_goal is None or current_goal.get("goal_id") != body.goal_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Training goal '{body.goal_id}' not found",
            )

    # --- Read current goal (required) ---
    goal = _read_current_goal(user_id)
    if goal is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="训练目标未设置",
        )

    # --- Read current profile (optional) ---
    profile = _read_current_profile(user_id)

    # --- Create job ---
    job_id = job_runner.create_job(user_id)

    # --- Launch daemon thread ---
    t = threading.Thread(
        target=master_plan_generator.run_generate_job,
        args=(job_id, user_id, goal, profile),
        daemon=True,
        name=f"master-plan-gen-{job_id}",
    )
    t.start()

    return {
        "job_id": job_id,
        "status": JobStatus.QUEUED.value,
        "eta_seconds": 120,
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/master-plan/jobs/{job_id}
# ---------------------------------------------------------------------------


@router.get("/api/users/me/master-plan/jobs/{job_id}")
def get_job_status(
    job_id: str,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Poll the status of an async master plan generation job."""
    import time as _time

    user_id: str = payload["sub"]

    job = job_runner.get_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job '{job_id}' not found or expired",
        )

    # User isolation — only the owning user may poll this job
    if job.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: job belongs to a different user",
        )

    elapsed_seconds = int(_time.monotonic() - job.created_at)

    stage_label = ""
    if job.stage is not None:
        stage_label = STAGE_LABEL_MAP.get(job.stage, "")

    # Only expose raw_output on failure
    raw_output = job.raw_output if job.status == JobStatus.FAILED else None

    return {
        "job_id": job.job_id,
        "status": job.status.value,
        "stage": job.stage.value if job.stage is not None else None,
        "progress": job.progress,
        "stage_label": stage_label,
        "result_plan_id": job.result_plan_id,
        "error": job.error,
        "raw_output": raw_output,
        "created_at": job.created_at_iso,
        "elapsed_seconds": elapsed_seconds,
    }


# ===========================================================================
# T21 — review-chat endpoints
# ===========================================================================

_DIFF_OP_KINDS_STR = ", ".join(k.value for k in MasterPlanDiffOpKind)


def _build_review_system_prompt(plan_summary: str) -> str:
    return f"""你是一名专业的跑步教练助手，帮助运动员 review 和调整长期训练总纲（master plan）。

当前训练总纲：
{plan_summary}

你的任务：理解用户的调整请求，输出严格 JSON，格式如下：

---BEGIN_MP_DIFF---
{{
  "ai_response": "中文自然语言回复，解释做了哪些调整",
  "ops": [
    {{
      "op": "<MasterPlanDiffOpKind>",
      "phase_id": "<phase uuid 或 null>",
      "milestone_id": "<milestone uuid 或 null>",
      "old_value": {{}},
      "new_value": {{}},
      "spec_patch": {{}}
    }}
  ]
}}
---END_MP_DIFF---

MasterPlanDiffOpKind 枚举值（只能用这些）：{_DIFF_OP_KINDS_STR}

spec_patch 说明（按 op 类型）：
- add_phase: {{id, name, start_date, end_date, focus, weekly_distance_km_low, weekly_distance_km_high, key_session_types, milestone_ids}}
- remove_phase: null（phase_id 指定）
- resize_phase: {{start_date?, end_date?}}（phase_id 指定）
- replace_phase_focus: {{focus}}（phase_id 指定）
- replace_weekly_range: {{weekly_distance_km_low?, weekly_distance_km_high?}}（phase_id 指定）
- add_milestone: {{id, type, date, phase_id, target, completed_actual?}}
- remove_milestone: null（milestone_id 指定）
- replace_milestone_date: {{date}}（milestone_id 指定）
- replace_milestone_target: {{target}}（milestone_id 指定）

规则：
1. 如果用户请求无需修改（只是询问），ops 数组为空，ai_response 正常回答。
2. 只修改用户明确要求的内容。
3. 输出必须包含 ---BEGIN_MP_DIFF--- 和 ---END_MP_DIFF--- 哨兵。
4. 哨兵之间必须是可被 json.loads() 解析的纯 JSON。"""


def _build_plan_summary(plan: Any) -> str:
    """Build a concise text summary of the plan for the LLM system prompt."""
    lines = [
        f"计划期间：{plan.start_date} ~ {plan.end_date}",
        f"目标 ID：{plan.goal_id}",
        "",
        "阶段：",
    ]
    for phase in plan.phases:
        lines.append(
            f"  [{phase.id[:8]}] {phase.name}  {phase.start_date}~{phase.end_date}"
            f"  周量 {phase.weekly_distance_km_low}-{phase.weekly_distance_km_high}km"
            f"  重点: {phase.focus}"
        )
    lines.append("")
    lines.append("里程碑：")
    for ms in plan.milestones:
        milestone_label = ms.name or (ms.type.value if ms.type else "milestone")
        lines.append(
            f"  [{ms.id[:8]}] {milestone_label}  {ms.date}  {ms.target}"
        )
    lines.append("")
    if plan.training_principles:
        lines.append("训练原则：" + "；".join(plan.training_principles))
    return "\n".join(lines)


def _parse_review_llm_output(raw: str) -> tuple[str, list[dict] | None]:
    """3-tier JSON parse: sentinel → fenced → balanced-braces.

    Returns (ai_response, ops_list | None).
    """
    raw_stripped = raw.strip()

    # Tier 1: sentinel anchors ---BEGIN_MP_DIFF--- ... ---END_MP_DIFF---
    begin_marker = "---BEGIN_MP_DIFF---"
    end_marker = "---END_MP_DIFF---"
    bi = raw_stripped.find(begin_marker)
    ei = raw_stripped.find(end_marker)
    if bi != -1 and ei != -1 and ei > bi:
        json_candidate = raw_stripped[bi + len(begin_marker):ei].strip()
        try:
            data = json.loads(json_candidate)
            if isinstance(data, dict):
                return data.get("ai_response", raw), data.get("ops")
        except (json.JSONDecodeError, ValueError):
            pass

    # Tier 2: markdown fenced block
    if "```" in raw_stripped:
        lines = raw_stripped.split("\n")
        in_block = False
        inner: list[str] = []
        for line in lines:
            if line.startswith("```") and not in_block:
                in_block = True
                continue
            if line.startswith("```") and in_block:
                break
            if in_block:
                inner.append(line)
        json_candidate = "\n".join(inner).strip()
        try:
            data = json.loads(json_candidate)
            if isinstance(data, dict):
                return data.get("ai_response", raw), data.get("ops")
        except (json.JSONDecodeError, ValueError):
            pass

    # Tier 3: balanced-braces scan for first {...}
    start = raw_stripped.find("{")
    if start != -1:
        depth = 0
        for idx, ch in enumerate(raw_stripped[start:], start=start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    json_candidate = raw_stripped[start:idx + 1]
                    try:
                        data = json.loads(json_candidate)
                        if isinstance(data, dict):
                            return data.get("ai_response", raw), data.get("ops")
                    except (json.JSONDecodeError, ValueError):
                        break

    logger.warning("review LLM output: all 3 parse tiers failed")
    return raw_stripped, None


def _build_mp_diff_ops(ops_list: list[dict]) -> list[MasterPlanDiffOp]:
    result: list[MasterPlanDiffOp] = []
    for item in ops_list:
        try:
            op_kind = MasterPlanDiffOpKind(item.get("op", ""))
            result.append(
                MasterPlanDiffOp(
                    id=str(uuid4()),
                    op=op_kind,
                    phase_id=item.get("phase_id"),
                    milestone_id=item.get("milestone_id"),
                    old_value=item.get("old_value"),
                    new_value=item.get("new_value"),
                    spec_patch=item.get("spec_patch"),
                    accepted=None,
                )
            )
        except (ValueError, KeyError, TypeError) as exc:
            logger.warning("Skipping invalid mp diff op %s: %s", item, exc)
    return result


# ---------------------------------------------------------------------------
# Request / response models for T21
# ---------------------------------------------------------------------------


class ReviewMessagesRequest(BaseModel):
    message: str
    history: list[dict] = []  # [{"role": "user|assistant", "content": str}, ...]


class ReviewApplyRequest(BaseModel):
    diff_id: str
    accepted_op_ids: list[str]
    change_reason: str = ""


# ---------------------------------------------------------------------------
# POST /api/users/me/master-plan/{plan_id}/review/messages
# ---------------------------------------------------------------------------


@router.post("/api/users/me/master-plan/{plan_id}/review/messages")
def review_messages(
    plan_id: str,
    body: ReviewMessagesRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Send a chat message during draft review; get AI response + optional diff."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )
    if plan.status != MasterPlanStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "该总纲已确认（status=active）。"
                "如需调整已激活总纲，请使用 adjust-chat 接口。"
            ),
        )

    plan_summary = _build_plan_summary(plan)
    system_prompt = _build_review_system_prompt(plan_summary)

    messages: list[dict] = list(body.history)
    messages.append({"role": "user", "content": body.message})

    try:
        llm = LLMClient()
        raw_response = llm.chat_sync(system_prompt, messages, max_tokens=4096)
    except (LLMUnavailable, _llm_client_mod.LLMUnavailable) as exc:
        logger.warning("LLMUnavailable in review_messages: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI 教练当前不可用，请稍后重试",
        )
    except (LLMError, _llm_client_mod.LLMError) as exc:
        if exc.retryable:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"AI 服务暂时不可用，请稍后重试：{exc}",
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI 服务返回错误：{exc}",
        )

    ai_response, ops_list = _parse_review_llm_output(raw_response)

    if ops_list is None or not isinstance(ops_list, list):
        return {"ai_response": ai_response, "diff": None}

    diff_ops = _build_mp_diff_ops(ops_list)
    diff_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat()

    diff = MasterPlanDiff(
        diff_id=diff_id,
        plan_id=plan_id,
        ops=diff_ops,
        ai_explanation=ai_response,
        created_at=created_at,
    )

    _mp_diff_store(user_id, plan_id, diff)

    return {
        "ai_response": ai_response,
        "diff": diff.model_dump(),
    }


# ---------------------------------------------------------------------------
# POST /api/users/me/master-plan/{plan_id}/review/apply
# ---------------------------------------------------------------------------


@router.post("/api/users/me/master-plan/{plan_id}/review/apply")
def review_apply(
    plan_id: str,
    body: ReviewApplyRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Apply accepted diff ops to a DRAFT plan (no version bump)."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )
    if plan.status != MasterPlanStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该总纲已确认（status=active），不能再 apply review diff",
        )

    diff = _mp_diff_get(user_id, plan_id, body.diff_id)
    if diff is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Diff '{body.diff_id}' not found or expired (TTL={_MP_DIFF_TTL}s)",
        )

    # Filter to known op ids; silently skip unknowns (fault-tolerant)
    known_ids = {op.id for op in diff.ops}
    accepted_op_ids = [oid for oid in body.accepted_op_ids if oid in known_ids]
    applied = len(accepted_op_ids)

    if applied > 0:
        updated_plan = _apply_review_diff(plan, diff, accepted_op_ids)
        store.save_plan(updated_plan)
    else:
        updated_plan = plan

    # Clean up pending diff after successful apply
    _PENDING_MP_DIFFS.pop((user_id, plan_id, body.diff_id), None)

    return {
        "applied": applied,
        "plan_id": plan_id,
        "version": updated_plan.version,
        "updated_at": updated_plan.updated_at,
    }


# ===========================================================================
# T22 — confirm endpoint
# ===========================================================================


@router.post("/api/users/me/master-plan/{plan_id}/confirm")
def confirm_master_plan(
    plan_id: str,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Confirm a DRAFT plan → ACTIVE. Triggers first single-week generation."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )
    if plan.status != MasterPlanStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该总纲已确认（status=active），无需重复确认",
        )

    # Archive any existing active plans for this user
    store.archive_previous(user_id, plan_id)

    # Activate this plan (version stays at 1 — first confirmation)
    now_iso = datetime.now(timezone.utc).isoformat()
    activated_plan = plan.model_copy(
        update={
            "status": MasterPlanStatus.ACTIVE,
            "updated_at": now_iso,
        }
    )
    store.save_plan(activated_plan)

    # NOTE: Single-week plans are generated lazily — after the user finishes
    # last week's training and supplies feedback (D7), the next-week plan can
    # be generated. There is no automatic first-week generation on confirm;
    # the mobile home screen surfaces a manual "立即生成本周计划" CTA.
    return {
        "plan_id": plan_id,
        "status": MasterPlanStatus.ACTIVE.value,
        "activated_at": now_iso,
    }


# ===========================================================================
# T23 — current + by-id endpoints
# ===========================================================================


def _build_current_response(plan: Any) -> dict[str, Any]:
    """Build the enriched response dict for the current-plan endpoint."""
    today = today_shanghai()

    # current_phase_id: find which phase contains today
    current_phase_id: str | None = None
    for phase in plan.phases:
        try:
            phase_start = date_cls.fromisoformat(phase.start_date)
            phase_end = date_cls.fromisoformat(phase.end_date)
            if phase_start <= today <= phase_end:
                current_phase_id = phase.id
                break
        except (ValueError, TypeError):
            pass

    # current_week_number: prefer the stored canonical week ranges.
    current_week_number: int | None = None
    for week in getattr(plan, "weeks", []) or []:
        try:
            week_start = date_cls.fromisoformat(week.start_date)
            week_end = date_cls.fromisoformat(week.end_date)
            if week_start <= today <= week_end:
                current_week_number = week.week_number
                break
        except (ValueError, TypeError):
            pass
    if current_week_number is None:
        try:
            plan_start = date_cls.fromisoformat(plan.start_date)
            plan_end = date_cls.fromisoformat(plan.end_date)
            if plan_start <= today <= plan_end:
                current_week_number = ((today - plan_start).days // 7) + 1
        except (ValueError, TypeError):
            pass

    total_weeks = int(getattr(plan, "total_weeks", 0) or 0)

    # next_milestone: first incomplete milestone by date
    next_milestone: dict | None = None
    incomplete = [
        ms for ms in plan.milestones if ms.completed_actual is None
    ]
    if incomplete:
        try:
            incomplete.sort(key=lambda m: m.date)
            ms = incomplete[0]
            ms_date = date_cls.fromisoformat(ms.date)
            days_until = (ms_date - today).days
            next_milestone = {
                "id": ms.id,
                "date": ms.date,
                "target": ms.target,
                "days_until": days_until,
            }
        except (ValueError, TypeError):
            pass

    response = plan.model_dump(
        mode="json",
        exclude={
            "weekly_key_sessions": True,
            "weeks": {"__all__": {"key_session_details": True, "is_taper_week": True}},
            "milestones": {"__all__": {"type": True, "completed_actual": True}},
        },
    )
    response.update(
        {
            "current_phase_id": current_phase_id,
            "current_week_number": current_week_number,
            "total_weeks": total_weeks,
            # Back-compat for existing frontend/tests. Progress-specific APIs can
            # replace this derived convenience field later.
            "next_milestone": next_milestone,
        }
    )
    return response


# NOTE: /current must be registered BEFORE /{plan_id} so FastAPI doesn't
# accidentally treat the literal string "current" as a plan_id path param.
@router.get("/api/users/me/master-plan/current")
def get_current_master_plan(
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Return the user's active master plan with derived position fields."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_active_plan(user_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="当前没有激活的训练总纲",
        )

    return _build_current_response(plan)


@router.get("/api/users/me/master-plan/{plan_id}")
def get_master_plan_by_id(
    plan_id: str,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Return a master plan by id (any status — used for version details)."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )

    return _build_current_response(plan)


# ===========================================================================
# T42 — adjust-chat endpoints (status=ACTIVE plans)
# ===========================================================================


def _build_adjust_system_prompt(plan_summary: str) -> str:
    return f"""你是一名专业的跑步教练助手，帮助运动员调整已激活的长期训练总纲（master plan）。

当前训练总纲（已激活）：
{plan_summary}

重要约束：
1. 该总纲已激活，用户正在按此计划训练。
2. 已经过去的阶段不可改动（start_date 在今日之前的阶段请勿修改起始日期）。
3. 已推送到手表的训练将失效，应在回复中提醒用户清理受影响周次的手表训练。
4. 新增阶段或调整阶段必须从今日之后开始。

你的任务：理解用户的调整请求，输出严格 JSON，格式如下：

---BEGIN_MP_DIFF---
{{
  "ai_response": "中文自然语言回复，解释做了哪些调整，并提醒用户受影响的周次需清理手表训练",
  "ops": [
    {{
      "op": "<MasterPlanDiffOpKind>",
      "phase_id": "<phase uuid 或 null>",
      "milestone_id": "<milestone uuid 或 null>",
      "old_value": {{}},
      "new_value": {{}},
      "spec_patch": {{}}
    }}
  ]
}}
---END_MP_DIFF---

MasterPlanDiffOpKind 枚举值（只能用这些）：{_DIFF_OP_KINDS_STR}

spec_patch 说明（按 op 类型）：
- add_phase: {{id, name, start_date, end_date, focus, weekly_distance_km_low, weekly_distance_km_high, key_session_types, milestone_ids}}
- remove_phase: null（phase_id 指定）
- resize_phase: {{start_date?, end_date?}}（phase_id 指定）
- replace_phase_focus: {{focus}}（phase_id 指定）
- replace_weekly_range: {{weekly_distance_km_low?, weekly_distance_km_high?}}（phase_id 指定）
- add_milestone: {{id, type, date, phase_id, target, completed_actual?}}
- remove_milestone: null（milestone_id 指定）
- replace_milestone_date: {{date}}（milestone_id 指定）
- replace_milestone_target: {{target}}（milestone_id 指定）

规则：
1. 如果用户请求无需修改（只是询问），ops 数组为空，ai_response 正常回答。
2. 只修改用户明确要求的内容。
3. 输出必须包含 ---BEGIN_MP_DIFF--- 和 ---END_MP_DIFF--- 哨兵。
4. 哨兵之间必须是可被 json.loads() 解析的纯 JSON。"""


class AdjustMessagesRequest(BaseModel):
    message: str
    history: list[dict] = []


class AdjustApplyRequest(BaseModel):
    diff_id: str
    accepted_op_ids: list[str]
    change_reason: str = ""


def _compute_affected_weeks(ops: list, plan: Any) -> list[dict]:
    """Compute weekly folders affected by the given accepted ops.

    For each op that involves a phase or milestone date range, find all
    Mondays whose week overlaps with the changed date range and return
    unique week folder entries.
    """
    from datetime import date as date_cls, timedelta

    affected_dates: set[date_cls] = set()
    phase_map = {p.id: p for p in plan.phases}

    for op in ops:
        try:
            op_kind = op.op if hasattr(op, "op") else op.get("op", "")
            op_kind_str = op_kind.value if hasattr(op_kind, "value") else str(op_kind)
            spec = op.spec_patch if hasattr(op, "spec_patch") else op.get("spec_patch") or {}

            # Determine date range from the op
            start_str: str | None = None
            end_str: str | None = None

            if op_kind_str in ("resize_phase", "add_phase"):
                phase_id = op.phase_id if hasattr(op, "phase_id") else op.get("phase_id")
                if op_kind_str == "resize_phase" and phase_id and phase_id in phase_map:
                    ph = phase_map[phase_id]
                    start_str = spec.get("start_date") or ph.start_date
                    end_str = spec.get("end_date") or ph.end_date
                elif op_kind_str == "add_phase" and spec:
                    start_str = spec.get("start_date")
                    end_str = spec.get("end_date")

            elif op_kind_str == "remove_phase":
                phase_id = op.phase_id if hasattr(op, "phase_id") else op.get("phase_id")
                if phase_id and phase_id in phase_map:
                    ph = phase_map[phase_id]
                    start_str = ph.start_date
                    end_str = ph.end_date

            elif op_kind_str in ("replace_phase_focus", "replace_weekly_range"):
                phase_id = op.phase_id if hasattr(op, "phase_id") else op.get("phase_id")
                if phase_id and phase_id in phase_map:
                    ph = phase_map[phase_id]
                    start_str = ph.start_date
                    end_str = ph.end_date

            elif op_kind_str in ("add_milestone", "replace_milestone_date"):
                if spec:
                    date_val = spec.get("date")
                    if date_val:
                        start_str = end_str = date_val

            elif op_kind_str == "remove_milestone":
                ms_id = op.milestone_id if hasattr(op, "milestone_id") else op.get("milestone_id")
                for ms in plan.milestones:
                    if ms.id == ms_id:
                        start_str = end_str = ms.date
                        break

            if start_str and end_str:
                s = date_cls.fromisoformat(start_str)
                e = date_cls.fromisoformat(end_str)
                # Walk mondays in range [s, e]
                # Find first Monday <= s
                monday = s - timedelta(days=s.weekday())
                while monday <= e:
                    affected_dates.add(monday)
                    monday += timedelta(days=7)
        except Exception:
            logger.debug("_compute_affected_weeks: skipped op due to error", exc_info=True)

    # Build folder list sorted by date desc
    today = date_cls.today()
    result: list[dict] = []
    for monday in sorted(affected_dates):
        sunday = monday + timedelta(days=6)
        folder = f"{monday.isoformat()}_{sunday.strftime('%m-%d')}"
        # Determine reason
        reason = "plan_adjusted"
        result.append({"folder": folder, "reason": reason})

    return result


# ---------------------------------------------------------------------------
# POST /api/users/me/master-plan/{plan_id}/adjust/messages
# ---------------------------------------------------------------------------


@router.post("/api/users/me/master-plan/{plan_id}/adjust/messages")
def adjust_messages(
    plan_id: str,
    body: AdjustMessagesRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Send a chat message during active-plan adjustment; get AI response + optional diff."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )
    if plan.status != MasterPlanStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "该总纲尚未确认（status=draft）。"
                "如需调整草稿总纲，请使用 review-chat 接口。"
            ),
        )

    plan_summary = _build_plan_summary(plan)
    system_prompt = _build_adjust_system_prompt(plan_summary)

    messages: list[dict] = list(body.history)
    messages.append({"role": "user", "content": body.message})

    try:
        llm = LLMClient()
        raw_response = llm.chat_sync(system_prompt, messages, max_tokens=4096)
    except (LLMUnavailable, _llm_client_mod.LLMUnavailable) as exc:
        logger.warning("LLMUnavailable in adjust_messages: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI 教练当前不可用，请稍后重试",
        )
    except (LLMError, _llm_client_mod.LLMError) as exc:
        if exc.retryable:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"AI 服务暂时不可用，请稍后重试：{exc}",
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI 服务返回错误：{exc}",
        )

    ai_response, ops_list = _parse_review_llm_output(raw_response)

    if ops_list is None or not isinstance(ops_list, list):
        return {"ai_response": ai_response, "diff": None}

    diff_ops = _build_mp_diff_ops(ops_list)
    diff_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat()

    diff = MasterPlanDiff(
        diff_id=diff_id,
        plan_id=plan_id,
        ops=diff_ops,
        ai_explanation=ai_response,
        created_at=created_at,
    )

    _mp_diff_store(user_id, plan_id, diff)

    return {
        "ai_response": ai_response,
        "diff": diff.model_dump(),
    }


# ---------------------------------------------------------------------------
# POST /api/users/me/master-plan/{plan_id}/adjust/apply
# ---------------------------------------------------------------------------


@router.post("/api/users/me/master-plan/{plan_id}/adjust/apply")
def adjust_apply(
    plan_id: str,
    body: AdjustApplyRequest,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Apply accepted diff ops to an ACTIVE plan (bumps version + writes snapshot)."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )
    if plan.status != MasterPlanStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该总纲尚未确认（status=draft），不能 apply adjust diff",
        )

    diff = _mp_diff_get(user_id, plan_id, body.diff_id)
    if diff is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Diff '{body.diff_id}' not found or expired (TTL={_MP_DIFF_TTL}s)",
        )

    # Filter to known op ids
    known_ids = {op.id for op in diff.ops}
    accepted_op_ids = [oid for oid in body.accepted_op_ids if oid in known_ids]
    applied = len(accepted_op_ids)

    # Build affected_weeks BEFORE applying (while plan still has original phase dates)
    accepted_ops = [op for op in diff.ops if op.id in set(accepted_op_ids)]
    affected_weeks = _compute_affected_weeks(accepted_ops, plan)

    if applied > 0:
        from stride_core.master_plan_diff import apply_master_plan_diff as _apply_diff

        # Store protocol bridge: wrap store to match master_plan_diff.MasterPlanStore protocol
        class _StoreBridge:
            def __init__(self, inner, uid: str):
                self._inner = inner
                self._uid = uid

            def get_plan(self, pid: str):
                return self._inner.get_plan(self._uid, pid)

            def save_plan(self, p):
                return self._inner.save_plan(p)

            def add_version(self, v):
                return self._inner.save_version(v)

        bridge = _StoreBridge(store, user_id)
        updated_plan = _apply_diff(
            bridge,
            plan_id,
            diff,
            accepted_op_ids,
            body.change_reason,
        )
    else:
        updated_plan = plan

    # Clean up pending diff after successful apply
    _PENDING_MP_DIFFS.pop((user_id, plan_id, body.diff_id), None)

    return {
        "plan_id": plan_id,
        "version": updated_plan.version,
        "updated_at": updated_plan.updated_at,
        "applied": applied,
        "affected_weeks": affected_weeks,
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/master-plan/{plan_id}/versions
# ---------------------------------------------------------------------------


@router.get("/api/users/me/master-plan/{plan_id}/versions")
def list_versions(
    plan_id: str,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Return all version snapshots for a plan, sorted by version desc."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )

    versions = store.list_versions(plan_id)  # already sorted desc by version

    return {
        "plan_id": plan_id,
        "versions": [
            {
                "version_id": v.version_id,
                "version": v.version,
                "changed_at": v.changed_at,
                "change_reason": v.change_reason,
                "change_summary": v.change_summary,
            }
            for v in versions
        ],
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/master-plan/{plan_id}/versions/{version}
# ---------------------------------------------------------------------------


@router.get("/api/users/me/master-plan/{plan_id}/versions/{version_number}")
def get_version_snapshot(
    plan_id: str,
    version_number: int,
    payload: dict = Depends(require_bearer),
) -> dict[str, Any]:
    """Return the full MasterPlan snapshot for a specific version number."""
    user_id: str = payload["sub"]
    store = get_master_plan_store()

    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Master plan '{plan_id}' not found",
        )
    if plan.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: plan belongs to a different user",
        )

    versions = store.list_versions(plan_id)
    matched = next((v for v in versions if v.version == version_number), None)
    if matched is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Version {version_number} not found for plan '{plan_id}'",
        )

    try:
        from stride_core.master_plan import MasterPlan as _MasterPlan
        snapshot_plan = _MasterPlan.model_validate_json(matched.snapshot_json)
        return _build_current_response(snapshot_plan)
    except Exception as exc:
        logger.error("get_version_snapshot: failed to parse snapshot_json: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="版本快照数据损坏，无法解析",
        )
