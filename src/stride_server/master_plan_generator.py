"""LLM-driven master plan generator (T13).

Implements ``run_generate_job`` — the main async function invoked from the
endpoint layer (T12) in a daemon thread. Calls the LLM, parses the JSON
output with a 3-tier fallback strategy (sentinel → fenced block → balanced
braces), constructs a ``MasterPlan`` instance, and persists it via
``MasterPlanStore``.

Thread-safety: function has no module-level mutable state; job state is
mutated exclusively through ``job_runner.update_job`` which holds its own
lock.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
)

from .job_runner import JobStage, JobStatus, update_job
from .llm_client import LLMClient, LLMError, LLMUnavailable
from .master_plan_store import get_master_plan_store

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 3-tier JSON parser
# ---------------------------------------------------------------------------


def _parse_llm_output(raw: str) -> dict | None:
    """Parse LLM output with 3-tier fallback.

    Layer 1: sentinel-anchored  ---BEGIN_MASTER_PLAN--- ... ---END_MASTER_PLAN---
    Layer 2: fenced code block  ```json ... ```
    Layer 3: balanced braces    first { to last }
    """
    # Layer 1: sentinel
    sentinel_match = re.search(
        r"---BEGIN_MASTER_PLAN---(.*?)---END_MASTER_PLAN---",
        raw,
        re.DOTALL,
    )
    if sentinel_match:
        try:
            return json.loads(sentinel_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Layer 2: fenced code block
    fenced_match = re.search(r"```json\s*(.*?)```", raw, re.DOTALL)
    if fenced_match:
        try:
            return json.loads(fenced_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Layer 3: balanced braces
    first_brace = raw.find("{")
    last_brace = raw.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(raw[first_brace : last_brace + 1])
        except json.JSONDecodeError:
            pass

    return None


# ---------------------------------------------------------------------------
# MasterPlan builder
# ---------------------------------------------------------------------------


def _build_master_plan(
    parsed: dict,
    user_id: str,
    goal_id: str,
) -> MasterPlan:
    """Map LLM output JSON -> MasterPlan instance.

    Raises ValueError if schema is invalid or required fields are missing.
    """
    if parsed.get("schema") != "weekly-plan/master/v1":
        raise ValueError(f"unexpected schema: {parsed.get('schema')!r}")

    plan_data = parsed.get("plan")
    if not isinstance(plan_data, dict):
        raise ValueError("missing or invalid 'plan' field")

    # Validate required top-level date fields
    start_date = plan_data.get("start_date")
    end_date = plan_data.get("end_date")
    if not start_date or not end_date:
        raise ValueError("plan missing start_date or end_date")

    # Build phases first (need ids before milestones)
    phases: list[Phase] = []
    phase_name_to_id: dict[str, str] = {}
    for p in plan_data.get("phases", []):
        phase_id = str(uuid4())
        phase_name = p.get("name", "")
        phase_name_to_id[phase_name] = phase_id
        phases.append(
            Phase(
                id=phase_id,
                name=phase_name,
                start_date=p.get("start_date", start_date),
                end_date=p.get("end_date", end_date),
                focus=p.get("focus", ""),
                weekly_distance_km_low=float(p.get("weekly_distance_km_low", 0)),
                weekly_distance_km_high=float(p.get("weekly_distance_km_high", 0)),
                key_session_types=p.get("key_session_types", []),
                milestone_ids=[],
            )
        )

    # Build a phase_id lookup dict (by id) for milestone attachment
    phase_by_id: dict[str, Phase] = {ph.id: ph for ph in phases}
    fallback_phase_id = phases[0].id if phases else ""

    # Build milestones, attach to phases
    milestones: list[Milestone] = []
    for m in plan_data.get("milestones", []):
        milestone_id = str(uuid4())
        phase_id = phase_name_to_id.get(m.get("phase_name", ""), fallback_phase_id)

        # Validate milestone type — skip unknown types gracefully
        raw_type = m.get("type", "long_run")
        try:
            milestone_type = MilestoneType(raw_type)
        except ValueError:
            logger.warning("unknown milestone type %r; defaulting to long_run", raw_type)
            milestone_type = MilestoneType.LONG_RUN

        milestones.append(
            Milestone(
                id=milestone_id,
                type=milestone_type,
                date=m.get("date", start_date),
                phase_id=phase_id,
                target=m.get("target", ""),
                completed_actual=None,
            )
        )

        # Append to the owning phase's milestone_ids list
        phase = phase_by_id.get(phase_id)
        if phase is not None:
            phase.milestone_ids.append(milestone_id)

    now_iso = datetime.now(timezone.utc).isoformat()
    return MasterPlan(
        plan_id=str(uuid4()),
        user_id=user_id,
        status=MasterPlanStatus.DRAFT,
        goal_id=goal_id,
        start_date=start_date,
        end_date=end_date,
        phases=phases,
        milestones=milestones,
        training_principles=plan_data.get("training_principles", []),
        generated_by="gpt-4.1",
        version=1,
        created_at=now_iso,
        updated_at=now_iso,
    )


# ---------------------------------------------------------------------------
# History / fitness helpers
# ---------------------------------------------------------------------------


def _query_history(user_id: str) -> dict[str, Any]:
    """Query activities DB for a 3-year training history summary.

    Returns a dict with keys: monthly_km, max_weekly_km, total_activities,
    best_5k_s, best_10k_s, best_hm_s, best_fm_s.

    All failures are silently absorbed — returns zeros / empty lists rather
    than blocking the generation flow.
    """
    result: dict[str, Any] = {
        "monthly_km": [],
        "max_weekly_km": 0.0,
        "total_activities": 0,
        "best_5k_s": None,
        "best_10k_s": None,
        "best_hm_s": None,
        "best_fm_s": None,
    }
    try:
        from stride_core.db import Database

        db = Database(user=user_id)
        conn = db._conn

        # Monthly running km (last 36 months) — sport_type 1=running
        rows = conn.execute(
            """
            SELECT strftime('%Y-%m', date) AS month,
                   SUM(distance_m) / 1000.0 AS km
            FROM activities
            WHERE sport_type = 1
              AND date >= date('now', '-36 months')
            GROUP BY month
            ORDER BY month
            """
        ).fetchall()
        result["monthly_km"] = [{"month": r[0], "km": round(r[1], 1)} for r in rows]

        # Max single-week km (approximate: 7-day windows using SQLite strftime week)
        row = conn.execute(
            """
            SELECT MAX(week_km)
            FROM (
                SELECT strftime('%Y-%W', date) AS wk,
                       SUM(distance_m) / 1000.0 AS week_km
                FROM activities
                WHERE sport_type = 1
                  AND date >= date('now', '-36 months')
                GROUP BY wk
            )
            """
        ).fetchone()
        result["max_weekly_km"] = round(row[0] or 0.0, 1)

        # Total running activities
        row = conn.execute(
            "SELECT COUNT(*) FROM activities WHERE sport_type = 1"
        ).fetchone()
        result["total_activities"] = row[0] or 0

        # Best race times from race_predictions table
        preds = conn.execute(
            "SELECT race_type, duration_s FROM race_predictions"
        ).fetchall()
        type_map = {
            "5K": "best_5k_s",
            "10K": "best_10k_s",
            "Half Marathon": "best_hm_s",
            "Marathon": "best_fm_s",
        }
        for race_type, duration_s in preds:
            key = type_map.get(race_type)
            if key and duration_s:
                result[key] = round(duration_s)

    except Exception as exc:  # noqa: BLE001
        logger.warning("_query_history failed for user %s: %s", user_id, exc)

    return result


def _query_fitness_state(user_id: str) -> dict[str, Any]:
    """Query daily_health for the most recent 90-day fitness snapshot.

    Returns the latest CTL/ATL/TSB/fatigue/RHR row plus a human-readable
    summary string.
    """
    result: dict[str, Any] = {
        "ctl": None,
        "atl": None,
        "tsb": None,
        "fatigue": None,
        "rhr": None,
        "training_load_state": None,
        "summary": "体能数据暂无",
    }
    try:
        from stride_core.db import Database

        db = Database(user=user_id)
        conn = db._conn

        row = conn.execute(
            """
            SELECT ati, cti, fatigue, rhr, training_load_ratio, training_load_state
            FROM daily_health
            WHERE date >= date('now', '-90 days')
            ORDER BY date DESC
            LIMIT 1
            """
        ).fetchone()
        if row:
            atl, ctl, fatigue, rhr, ratio, state = row
            tsb = round((ctl or 0) - (atl or 0), 1) if ctl and atl else None
            result.update(
                {
                    "ctl": round(ctl, 1) if ctl else None,
                    "atl": round(atl, 1) if atl else None,
                    "tsb": tsb,
                    "fatigue": round(fatigue, 1) if fatigue else None,
                    "rhr": rhr,
                    "training_load_state": state,
                }
            )
            # Human-readable summary
            ctl_str = f"CTL {ctl:.0f}" if ctl else "CTL 未知"
            atl_str = f"ATL {atl:.0f}" if atl else "ATL 未知"
            tsb_str = f"TSB {tsb:+.0f}" if tsb is not None else "TSB 未知"
            fat_str = f"疲劳 {fatigue:.0f}" if fatigue else ""
            rhr_str = f"RHR {rhr}bpm" if rhr else ""
            state_str = f"负荷状态: {state}" if state else ""
            parts = [s for s in [ctl_str, atl_str, tsb_str, fat_str, rhr_str, state_str] if s]
            result["summary"] = "，".join(parts)

    except Exception as exc:  # noqa: BLE001
        logger.warning("_query_fitness_state failed for user %s: %s", user_id, exc)

    return result


# ---------------------------------------------------------------------------
# History summary formatter
# ---------------------------------------------------------------------------


def _format_history_summary(history: dict[str, Any]) -> str:
    """Convert raw history dict into a readable summary string for the prompt."""
    lines: list[str] = []

    total = history.get("total_activities", 0)
    max_wk = history.get("max_weekly_km", 0)
    monthly = history.get("monthly_km", [])

    lines.append(f"历史跑步活动总数：{total} 次")
    lines.append(f"历史最大单周里程：{max_wk} km")

    if monthly:
        recent = monthly[-6:]  # last 6 months
        monthly_str = "、".join(f"{m['month']} {m['km']}km" for m in recent)
        lines.append(f"近 6 个月月跑量：{monthly_str}")
        avg_km = sum(m["km"] for m in recent) / len(recent)
        lines.append(f"近 6 个月平均月跑量：{avg_km:.0f} km（约 {avg_km/4:.0f} km/周）")
    else:
        lines.append("暂无历史跑量数据")

    # Best times
    def fmt_time(sec: int | None) -> str:
        if sec is None:
            return "未知"
        h, rem = divmod(sec, 3600)
        m2, s = divmod(rem, 60)
        return f"{h}:{m2:02d}:{s:02d}" if h else f"{m2}:{s:02d}"

    lines.append(
        f"最好成绩 — 5K: {fmt_time(history.get('best_5k_s'))}  "
        f"10K: {fmt_time(history.get('best_10k_s'))}  "
        f"半马: {fmt_time(history.get('best_hm_s'))}  "
        f"全马: {fmt_time(history.get('best_fm_s'))}"
    )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# LLM prompt builder
# ---------------------------------------------------------------------------


def _build_system_prompt(
    goal: dict,
    profile: dict | None,
    history_summary: str,
    fitness_state: dict[str, Any],
    today: str,
) -> str:
    goal_json = json.dumps(goal, ensure_ascii=False, indent=2)
    profile_json = json.dumps(profile, ensure_ascii=False, indent=2) if profile else "未填写"
    fitness_summary = fitness_state.get("summary", "体能数据暂无")
    race_date = goal.get("race_date") or "未指定"

    return f"""你是专业马拉松训练教练。根据以下信息生成训练总纲 JSON。

用户目标：
{goal_json}

跑步背景：
{profile_json}

历史训练摘要：
{history_summary}

当前体能状态：
{fitness_summary}

输出必须是以下格式的严格 JSON（用 ---BEGIN_MASTER_PLAN--- 和 ---END_MASTER_PLAN--- 包裹）：

---BEGIN_MASTER_PLAN---
{{"schema":"weekly-plan/master/v1","plan":{{
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "training_principles": ["原则1","原则2"],
  "phases": [
    {{"name":"基础期","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","focus":"建立有氧基础","weekly_distance_km_low":35,"weekly_distance_km_high":45,"key_session_types":["长距离","中距离"]}},
    ...
  ],
  "milestones": [
    {{"type":"race|test_run|long_run|strength_test","date":"YYYY-MM-DD","phase_name":"<对应阶段>","target":"自然语言描述"}},
    ...
  ]
}}}}
---END_MASTER_PLAN---

规则：
- start_date 用今日（{today}），end_date 不晚于比赛日（{race_date}）
- 阶段顺序：基础期 → 进展期 → 赛前期 → 比赛 →（如有）恢复期
- 每个阶段至少 2 周
- weekly_distance_km_low / high 应反映该阶段周量目标
- 里程碑应贯穿训练周期（每 2-4 周一个）
- 训练原则 3-5 条
- 用户跑龄短 / 周量低时阶段周量更保守
- 周末日期作为 long_run 里程碑日期
- 输出**仅 JSON 块**，无额外解释文字"""


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def run_generate_job(
    job_id: str,
    user_id: str,
    goal: dict,
    profile: dict | None,
) -> None:
    """Main LLM-driven master plan generation. Runs in a daemon thread.

    Updates job state via job_runner.update_job. Never raises — all
    failures are captured into job.status=FAILED with error field.
    """
    try:
        _run_generate_job_inner(job_id, user_id, goal, profile)
    except Exception as exc:  # noqa: BLE001
        logger.exception("run_generate_job unhandled error job=%s", job_id)
        update_job(job_id, status=JobStatus.FAILED, error=str(exc))


def _run_generate_job_inner(
    job_id: str,
    user_id: str,
    goal: dict,
    profile: dict | None,
) -> None:
    # ------------------------------------------------------------------
    # Stage 1: READING_HISTORY
    # ------------------------------------------------------------------
    update_job(
        job_id,
        status=JobStatus.RUNNING,
        stage=JobStage.READING_HISTORY,
        progress=10,
    )
    history = _query_history(user_id)
    history_summary = _format_history_summary(history)
    logger.debug("job=%s history loaded: %d activities", job_id, history.get("total_activities", 0))

    # ------------------------------------------------------------------
    # Stage 2: EVALUATING
    # ------------------------------------------------------------------
    update_job(job_id, stage=JobStage.EVALUATING, progress=30)
    fitness_state = _query_fitness_state(user_id)
    logger.debug("job=%s fitness state: %s", job_id, fitness_state.get("summary"))

    # ------------------------------------------------------------------
    # Stage 3: PLANNING_PHASES — call LLM
    # ------------------------------------------------------------------
    update_job(job_id, stage=JobStage.PLANNING_PHASES, progress=60)

    today = date.today().isoformat()
    system_prompt = _build_system_prompt(goal, profile, history_summary, fitness_state, today)
    user_message = [{"role": "user", "content": "请基于上述信息生成训练总纲"}]

    try:
        client = LLMClient()
        raw = client.chat_sync(system_prompt, user_message, max_tokens=8192)
    except Exception as exc:
        exc_type_name = type(exc).__name__
        if exc_type_name == "LLMUnavailable":
            logger.warning("job=%s LLM unavailable: %s", job_id, exc)
            update_job(job_id, status=JobStatus.FAILED, error="llm_unavailable")
            return
        if exc_type_name == "LLMError":
            retryable = getattr(exc, "retryable", False)
            logger.warning("job=%s LLM error retryable=%s: %s", job_id, retryable, exc)
            update_job(job_id, status=JobStatus.FAILED, error=f"llm_error: {exc}")
            return
        # Unknown exception — re-raise to outer handler
        raise

    # ------------------------------------------------------------------
    # Stage 4: OUTPUTTING — parse + persist
    # ------------------------------------------------------------------
    update_job(job_id, stage=JobStage.OUTPUTTING, progress=85)

    parsed = _parse_llm_output(raw)
    if parsed is None:
        logger.warning("job=%s JSON parse failed; raw output len=%d", job_id, len(raw))
        update_job(
            job_id,
            status=JobStatus.FAILED,
            error="parse_failed",
            raw_output=raw[:2000],
        )
        return

    try:
        goal_id = goal.get("id") or goal.get("goal_id") or str(uuid4())
        plan = _build_master_plan(parsed, user_id, goal_id)
    except ValueError as exc:
        logger.warning("job=%s plan build failed: %s", job_id, exc)
        update_job(
            job_id,
            status=JobStatus.FAILED,
            error=f"bad_schema: {exc}",
            raw_output=raw[:2000],
        )
        return

    store = get_master_plan_store()
    store.save_plan(plan)
    logger.info("job=%s plan saved plan_id=%s", job_id, plan.plan_id)

    update_job(
        job_id,
        status=JobStatus.DONE,
        result_plan_id=plan.plan_id,
        progress=100,
    )
