"""Chatbot-style weekly plan adjustment endpoint (D4 / T31).

Two routes:

  POST /api/{user}/plan/{folder}/chat/messages
    — Send a user message (with optional history); returns AI response + diff.

  POST /api/{user}/plan/{folder}/chat/apply
    — Accept a set of diff ops and mutate the planned_session store.

Design decisions
~~~~~~~~~~~~~~~~
- PlanDiff objects are kept **in-memory** (module-level dict) for the duration
  of a single request-response round-trip.  They are never persisted to SQLite.
  TTL: 10 minutes.  Known limitations: restart loses pending diffs; multi-instance
  deployments share nothing (follow-up: move to a Redis/Azure Cache layer).
- LLM output is expected to be strict JSON; on parse failure we return the raw
  AI text as ``ai_response`` with ``diff = null`` (graceful degradation).
- All errors from LLMUnavailable / LLMError map to 503/502 so the Flutter UI
  can show a coherent "AI 教练暂时不可用" message.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, status
from pydantic import BaseModel

from stride_core.plan_diff import DiffOp, DiffOpKind, PlanDiff, apply_diff
from stride_core.state_stores import PlanStateStore

from ..deps import get_plan_state_store
from .. import llm_client as _llm_client_mod
from ..llm_client import LLMClient, LLMError, LLMUnavailable  # noqa: F401 — kept for tests that monkeypatch by name

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory pending diffs store
# ---------------------------------------------------------------------------

_PENDING_DIFFS: dict[tuple[str, str, str], tuple[PlanDiff, float]] = {}
# key: (user, folder, diff_id)  value: (diff, created_ts)
_PENDING_TTL_SECONDS = 600  # 10 minutes


def _cleanup_expired() -> None:
    now = time.monotonic()
    expired = [k for k, (_, ts) in _PENDING_DIFFS.items() if now - ts > _PENDING_TTL_SECONDS]
    for k in expired:
        del _PENDING_DIFFS[k]


def _store_diff(user: str, folder: str, diff: PlanDiff) -> None:
    _cleanup_expired()
    _PENDING_DIFFS[(user, folder, diff.diff_id)] = (diff, time.monotonic())


def _get_diff(user: str, folder: str, diff_id: str) -> PlanDiff | None:
    entry = _PENDING_DIFFS.get((user, folder, diff_id))
    if entry is None:
        return None
    diff, ts = entry
    if time.monotonic() - ts > _PENDING_TTL_SECONDS:
        del _PENDING_DIFFS[(user, folder, diff_id)]
        return None
    return diff


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ChatHistoryItem(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatMessagesRequest(BaseModel):
    message: str
    history: list[ChatHistoryItem] = []


class ChatApplyRequest(BaseModel):
    diff_id: str
    accepted_op_ids: list[str]


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------

_DIFF_OP_KINDS = ", ".join(k.value for k in DiffOpKind)


def _build_system_prompt(sessions_context: str) -> str:
    return f"""你是一名专业的跑步教练助手，帮助运动员调整本周训练计划。

当前本周计划：
{sessions_context}

你的任务：理解用户的调整请求，输出**严格 JSON**（不要有任何额外文字）：

{{
  "ai_response": "中文自然语言回复，解释你做了哪些调整",
  "ops": [
    {{
      "op": "<DiffOpKind>",
      "date": "YYYY-MM-DD",
      "session_index": 0,
      "old_value": {{"summary": "..."}},
      "new_value": {{"summary": "..."}},
      "spec_patch": {{}}
    }}
  ]
}}

DiffOpKind 枚举值（只能用这些）：{_DIFF_OP_KINDS}

spec_patch 字段说明：
- move_session: {{"new_date": "YYYY-MM-DD", "new_session_index": 0}}
- replace_kind: {{"kind": "run"|"strength"|"rest"|"note"}}
- replace_distance: {{"total_distance_m": 10000, "summary": "E 10K"}}
- add_session: {{"kind": "run", "summary": "...", "date": "YYYY-MM-DD", "session_index": 0}}
- remove_session: null
- replace_note: {{"notes_md": "..."}}

规则：
1. 如果用户请求无需修改计划（例如只是询问），ops 数组为空，ai_response 正常回答。
2. 只修改用户明确要求的内容，不要主动增减其他训练。
3. 日期必须是本周内的 ISO 格式 YYYY-MM-DD。
4. 输出必须是可被 json.loads() 解析的纯 JSON，不要加 markdown 代码块。"""


def _build_sessions_context(sessions: list[Any]) -> str:
    if not sessions:
        return "（本周暂无结构化课时）"
    lines = []
    day_map: dict[str, list[Any]] = {}
    for s in sessions:
        # sqlite3.Row doesn't have .get(); normalise to plain dict once here.
        row = dict(s) if not isinstance(s, dict) else s
        day_map.setdefault(row["date"], []).append(row)
    weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    for date_str in sorted(day_map.keys()):
        try:
            dt = datetime.fromisoformat(date_str)
            wd = weekday_names[dt.weekday()]
        except Exception:
            wd = date_str
        for idx, s in enumerate(day_map[date_str]):
            kind = s.get("kind", "note")
            summary = s.get("summary") or kind
            distance = s.get("total_distance_m")
            dist_str = f" {distance/1000:.1f}K" if distance else ""
            lines.append(f"- {wd} ({date_str}) [{idx}]: {summary}{dist_str}")
    return "\n".join(lines) if lines else "（本周暂无结构化课时）"


def _parse_llm_output(raw: str) -> tuple[str, list[dict] | None]:
    """Parse LLM output. Returns (ai_response, ops_list | None).

    On any JSON parse failure: returns raw text as ai_response, ops=None.
    """
    raw = raw.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        lines = raw.split("\n")
        # Drop first line (```json or ```) and last line (```)
        inner_lines = []
        in_block = False
        for line in lines:
            if line.startswith("```") and not in_block:
                in_block = True
                continue
            if line.startswith("```") and in_block:
                break
            if in_block:
                inner_lines.append(line)
        raw = "\n".join(inner_lines).strip()

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("LLM output is not valid JSON, falling back to raw text")
        return raw, None

    if not isinstance(data, dict):
        return raw, None

    ai_response = data.get("ai_response", "")
    ops = data.get("ops")
    if not isinstance(ai_response, str) or not ai_response:
        ai_response = raw

    return ai_response, ops


def _build_diff_ops(ops_list: list[dict]) -> list[DiffOp]:
    """Convert raw dicts from LLM output into DiffOp instances."""
    result = []
    for item in ops_list:
        try:
            op_kind = DiffOpKind(item.get("op", ""))
            result.append(
                DiffOp(
                    id=str(uuid4()),
                    op=op_kind,
                    date=item.get("date", ""),
                    session_index=int(item.get("session_index", 0)),
                    old_value=item.get("old_value"),
                    new_value=item.get("new_value"),
                    spec_patch=item.get("spec_patch"),
                    accepted=None,
                )
            )
        except (ValueError, KeyError, TypeError) as exc:
            logger.warning("Skipping invalid diff op %s: %s", item, exc)
    return result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/api/{user}/plan/{folder}/chat/messages")
def chat_messages(
    user: str,
    folder: str,
    body: ChatMessagesRequest = Body(...),
) -> dict[str, Any]:
    """Send a user message; get AI response + optional diff."""
    # Validate folder has sessions
    plan_store = get_plan_state_store(user)
    try:
        sessions = plan_store.get_planned_sessions(week_folder=folder)
    finally:
        plan_store.close()

    if not sessions:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No planned sessions found for folder {folder!r}",
        )

    sessions_context = _build_sessions_context(sessions)
    system_prompt = _build_system_prompt(sessions_context)

    # Build messages list: history + current message
    messages: list[dict] = []
    for h in body.history:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": body.message})

    # Call LLM
    try:
        llm = LLMClient()
        raw_response = llm.chat_sync(system_prompt, messages, max_tokens=2048)
    except (LLMUnavailable, _llm_client_mod.LLMUnavailable) as exc:
        # Tuple catches both the module-level binding and the live class on the
        # llm_client module. Tests that ``importlib.reload(llm_client)`` swap
        # the latter's identity; the original binding stays stale otherwise.
        logger.warning("LLMUnavailable in chat_messages: %s", exc)
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

    # Parse output
    ai_response, ops_list = _parse_llm_output(raw_response)

    if ops_list is None or not isinstance(ops_list, list):
        # Graceful degradation: return AI text, diff = null
        return {"ai_response": ai_response, "diff": None}

    diff_ops = _build_diff_ops(ops_list)
    diff_id = str(uuid4())
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    diff = PlanDiff(
        diff_id=diff_id,
        folder=folder,
        ops=diff_ops,
        ai_explanation=ai_response,
        created_at=created_at,
    )

    # Store for /apply
    _store_diff(user, folder, diff)

    return {
        "ai_response": ai_response,
        "diff": diff.model_dump(),
    }


@router.post("/api/{user}/plan/{folder}/chat/apply")
def chat_apply(
    user: str,
    folder: str,
    body: ChatApplyRequest = Body(...),
) -> dict[str, Any]:
    """Apply accepted ops from a pending diff to the planned_session store."""
    diff = _get_diff(user, folder, body.diff_id)
    if diff is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Diff {body.diff_id!r} not found or expired",
        )

    # Validate accepted_op_ids against known op ids (skip unknowns)
    known_ids = {op.id for op in diff.ops}
    accepted_op_ids = [oid for oid in body.accepted_op_ids if oid in known_ids]

    plan_store = get_plan_state_store(user)
    try:
        apply_diff(plan_store, folder, diff, accepted_op_ids)
    finally:
        plan_store.close()

    # Remove from pending store after apply
    _PENDING_DIFFS.pop((user, folder, body.diff_id), None)

    updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "applied": len(accepted_op_ids),
        "folder": folder,
        "updated_at": updated_at,
    }
