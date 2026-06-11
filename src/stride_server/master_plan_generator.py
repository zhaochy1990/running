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
from datetime import datetime, timezone

from stride_core.timefmt import today_shanghai
from typing import TYPE_CHECKING, Any
from uuid import uuid4

if TYPE_CHECKING:
    from coach.schemas import ContinuitySignals

from stride_core.master_plan import (
    KeySession,
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
    WeeklyKeySessions,
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
    generated_by: str = "unknown",
) -> MasterPlan:
    """Map LLM output JSON -> MasterPlan instance.

    ``generated_by`` is the audit stamp recording which model produced the
    plan. The generator adapter passes the configured generator model id
    (from ``config/coach.toml`` ``[generator].model``) so this reflects the
    real model rather than a hardcoded literal; the ``"unknown"`` default
    only applies to direct callers that don't supply it.

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

        # Parse optional phase_type — unknown strings degrade to None (backcompat)
        raw_pt = p.get("phase_type")
        try:
            phase_type = PhaseType(raw_pt) if raw_pt else None
        except ValueError:
            logger.warning("unknown phase_type %r; leaving None", raw_pt)
            phase_type = None

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
                phase_type=phase_type,
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
                metric=m.get("metric"),
                target_value=_to_optional_float(m.get("target_value")),
                comparator=m.get("comparator"),
            )
        )

        # Append to the owning phase's milestone_ids list
        phase = phase_by_id.get(phase_id)
        if phase is not None:
            phase.milestone_ids.append(milestone_id)

    # Build weekly_key_sessions skeleton (Batch B). Maps phase_name → phase_id
    # the same way milestones do; unknown phase_name falls back to phases[0].id.
    # Plans authored before Batch B simply omit the field → empty list, which
    # makes the new Batch B L1 rules silent no-ops for backwards compatibility.
    weekly_key_sessions: list[WeeklyKeySessions] = []
    for w in plan_data.get("weekly_key_sessions", []) or []:
        if not isinstance(w, dict):
            continue
        wk_phase_id = phase_name_to_id.get(w.get("phase_name", ""), fallback_phase_id)
        sessions: list[KeySession] = []
        for ks in w.get("key_sessions", []) or []:
            if not isinstance(ks, dict):
                continue
            sessions.append(
                KeySession(
                    type=str(ks.get("type", "long_run")),
                    distance_km=_to_optional_float(ks.get("distance_km")),
                    duration_min=_to_optional_float(ks.get("duration_min")),
                    intensity=ks.get("intensity"),
                    purpose=ks.get("purpose"),
                )
            )
        weekly_key_sessions.append(
            WeeklyKeySessions(
                week_index=int(w.get("week_index", 0) or 0),
                week_start=str(w.get("week_start", start_date)),
                phase_id=wk_phase_id,
                target_weekly_km_low=float(w.get("target_weekly_km_low", 0)),
                target_weekly_km_high=float(w.get("target_weekly_km_high", 0)),
                key_sessions=sessions,
                is_recovery_week=bool(w.get("is_recovery_week", False)),
                is_taper_week=bool(w.get("is_taper_week", False)),
            )
        )

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
        weekly_key_sessions=weekly_key_sessions,
        training_principles=plan_data.get("training_principles", []),
        generated_by=generated_by,
        version=1,
        created_at=now_iso,
        updated_at=now_iso,
    )


def _to_optional_float(value: Any) -> float | None:
    """Coerce a JSON value to float; return None for missing / unparseable."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


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
        from stride_core.models import RUN_SPORT_SQL_LIST

        db = Database(user=user_id)
        conn = db._conn

        # Running activities are matched against the canonical RUN_SPORT_IDS set
        # (COROS 100-104/600-601 + Garmin-synced 8001-8005), NOT a literal
        # ``sport_type = 1`` — ``1`` is not a stored running code, so the old
        # filter silently matched zero rows (especially for Garmin-synced
        # users). RUN_SPORT_SQL_LIST is the same single-source fragment
        # ability.py uses; keep them in sync.

        # Monthly running km (last 36 months). NOTE: activities.distance_m is
        # misnamed — it stores KILOMETERS (magnitude < 500), with legacy rows
        # in meters (>= 500). Normalise per-row with the same heuristic as
        # stride_core.ability._distance_to_km; a plain ``/1000`` would be
        # ~1000x too small for the common km-valued rows.
        _KM_EXPR = "SUM(CASE WHEN distance_m < 500 THEN distance_m ELSE distance_m / 1000.0 END)"
        rows = conn.execute(
            f"""
            SELECT strftime('%Y-%m', date) AS month,
                   {_KM_EXPR} AS km
            FROM activities
            WHERE sport_type IN ({RUN_SPORT_SQL_LIST})
              AND date >= date('now', '-36 months')
            GROUP BY month
            ORDER BY month
            """
        ).fetchall()
        result["monthly_km"] = [{"month": r[0], "km": round(r[1], 1)} for r in rows]

        # Max single-week km (approximate: 7-day windows using SQLite strftime week)
        row = conn.execute(
            f"""
            SELECT MAX(week_km)
            FROM (
                SELECT strftime('%Y-%W', date) AS wk,
                       {_KM_EXPR} AS week_km
                FROM activities
                WHERE sport_type IN ({RUN_SPORT_SQL_LIST})
                  AND date >= date('now', '-36 months')
                GROUP BY wk
            )
            """
        ).fetchone()
        result["max_weekly_km"] = round(row[0] or 0.0, 1)

        # Total running activities
        row = conn.execute(
            f"SELECT COUNT(*) FROM activities WHERE sport_type IN ({RUN_SPORT_SQL_LIST})"
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


def _ensure_training_load_current(db, as_of=None) -> None:
    """Ensure daily_training_load is backfilled far enough that the 42-day
    chronic EWMA has converged at ``as_of``. The EWMA has ~42-day memory, so a
    365-day warmup window (>> 3x42) yields a converged chronic regardless of how
    few rows existed before. Idempotent; safe to call every generation."""
    from stride_core.training_load import backfill_training_load
    try:
        backfill_training_load(db, as_of_date=as_of, load_lookback_days=365,
                               calibration_lookback_days=365, persist=True)
    except Exception as exc:  # noqa: BLE001 — context load must never hard-fail
        logger.warning("_ensure_training_load_current failed: %s", exc)


def _query_fitness_state(user_id: str) -> dict[str, Any]:
    """Query STRIDE daily_training_load for the most recent fitness snapshot.

    Returns the latest CTL/ATL/form from the canonical STRIDE PMC table (not
    the COROS vendor ati/cti fields which use a different scale). RHR is still
    read from daily_health as a raw measurement.
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
        from stride_core.timefmt import today_shanghai

        db = Database(user=user_id)
        conn = db._conn

        _ensure_training_load_current(db, as_of=today_shanghai())

        row = conn.execute(
            "SELECT date, acute_load, chronic_load, form FROM daily_training_load "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        rhr_row = conn.execute(
            "SELECT rhr FROM daily_health WHERE rhr IS NOT NULL ORDER BY date DESC LIMIT 1"
        ).fetchone()
        rhr = rhr_row[0] if rhr_row else None

        if row:
            _date, atl, ctl, form = row
            ratio = round(atl / ctl, 2) if ctl else None
            result.update({
                "ctl": round(ctl, 1) if ctl is not None else None,
                "atl": round(atl, 1) if atl is not None else None,
                "tsb": round(form, 1) if form is not None else None,
                "rhr": rhr,
                "training_load_ratio": ratio,
            })
            parts = []
            if ctl is not None:
                parts.append(f"CTL {ctl:.0f}")
            if atl is not None:
                parts.append(f"ATL {atl:.0f}")
            if form is not None:
                parts.append(f"Form {form:+.0f}")
            if ratio is not None:
                parts.append(f"acute/chronic {ratio}")
            if rhr is not None:
                parts.append(f"RHR {rhr}bpm")
            result["summary"] = "，".join(parts) if parts else "体能数据暂无"

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
# Input normalisation — bridge prod-route field names to prompt-expected names
# ---------------------------------------------------------------------------


_PB_KEY_MAP: dict[str, str] = {"5K": "5k_s", "10K": "10k_s", "HM": "hm_s", "FM": "fm_s"}

# Map ``TrainingGoal.race_distance`` enum values to the canonical lowercase
# token the eval framework, prompt, and L1 rules read. The prod
# ``TrainingGoal`` enum is ``Literal["5K","10K","HM","FM","trail"]`` (see
# routes/training_goal.py); fixtures and rule_filter expect lowercase
# ``"5k"/"10k"/"hm"/"fm"/"ultra"``. ``trail`` maps to ``ultra`` since the
# prompt currently treats trail/ultra as the same category for distance-
# specificity decisions. Anything else passes through unchanged so an
# unrecognised value still surfaces a downstream violation rather than
# being silently dropped.
_RACE_DISTANCE_NORMALIZE: dict[str, str] = {
    "5K": "5k", "10K": "10k", "HM": "hm", "FM": "fm", "trail": "ultra",
}


def _parse_hms_to_seconds(value: str) -> int | None:
    """Parse ``H:MM:SS`` (or ``MM:SS``) into total seconds; ``None`` on bad input.

    The training_goal API stores ``target_finish_time`` as ``H:MM:SS`` and the
    running_profile API stores PB ``time`` the same way. The prompt's
    goal-realism rule and the S1 eval fixtures both expect integer seconds
    (``goal_time_s``, ``5k_s`` / ``10k_s`` / ``hm_s`` / ``fm_s``), so we
    normalise once at the prompt boundary.
    """
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    try:
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
        elif len(parts) == 2:
            h, m, s = 0, int(parts[0]), int(parts[1])
        else:
            return None
    except ValueError:
        return None
    if m >= 60 or s >= 60:
        return None  # reject malformed components like "1:75:00"
    return h * 3600 + m * 60 + s


def _normalize_for_prompt(
    goal: dict, profile: dict | None
) -> tuple[dict, dict | None]:
    """Map prod route field names → the names the prompt v2 expects.

    Specifically:

    * ``goal.target_finish_time`` (``"H:MM:SS"``) → ``goal.goal_time_s`` (int).
    * ``goal.race_distance`` (``"5K"/"10K"/"HM"/"FM"/"trail"``) →
      ``goal.distance`` (lowercase ``"5k"/"10k"/"hm"/"fm"/"ultra"``). Without
      this, the prompt's Distance specificity block and the input-aware L1
      rules (``target_distance_long_run`` / ``peak_before_race`` window)
      silently no-op against prod payloads.
    * ``profile.pbs`` (``[{distance: "FM", time: "H:MM:SS"}, ...]``) →
      ``profile.prs`` (``{fm_s: int, hm_s: int, ...}``).
    * ``profile.weekly_training_days`` (int 3-6 from ``TrainingGoal``) →
      ``profile.weekly_run_days_max``. Same rationale as ``distance``: the
      ``key_session_density`` rule reads ``weekly_run_days_max`` and would
      otherwise fall through to the lenient 3-session default in prod.
      Note ``TrainingGoal`` carries this field, not ``RunningProfile``;
      callers that pass the goal dict as the source of ``weekly_training_days``
      are also handled (we read from either).

    Existing canonical values are kept untouched (eval fixtures already use
    the normalised shape, and we don't want to clobber explicit overrides).
    Both inputs are shallow-copied so the caller's dicts are never mutated.

    Returns ``(goal_norm, profile_norm_or_None)``.
    """
    goal_norm: dict = dict(goal or {})
    profile_norm: dict | None = dict(profile) if profile else None

    if "goal_time_s" not in goal_norm:
        secs = _parse_hms_to_seconds(goal_norm.get("target_finish_time", ""))
        if secs is not None:
            goal_norm["goal_time_s"] = secs

    # race_distance → distance (lowercase canonical)
    if "distance" not in goal_norm:
        raw_dist = goal_norm.get("race_distance")
        if isinstance(raw_dist, str):
            canonical = _RACE_DISTANCE_NORMALIZE.get(raw_dist) or raw_dist.lower()
            goal_norm["distance"] = canonical

    if profile_norm is not None and "prs" not in profile_norm:
        raw_pbs = profile_norm.get("pbs") or []
        if isinstance(raw_pbs, list):
            prs: dict[str, int] = {}
            for pb in raw_pbs:
                if not isinstance(pb, dict):
                    continue
                dist = pb.get("distance")
                time_str = pb.get("time")
                if not isinstance(dist, str) or not isinstance(time_str, str):
                    continue
                key = _PB_KEY_MAP.get(dist.upper())
                if not key:
                    continue
                secs = _parse_hms_to_seconds(time_str)
                if secs is not None:
                    prs[key] = secs
            if prs:
                profile_norm["prs"] = prs

    # weekly_training_days (TrainingGoal) → weekly_run_days_max. Look in
    # both profile and goal because callers may pass it on either dict.
    # When ``profile`` was None and ``goal`` carries the field, synthesise
    # a minimal profile dict so the canonical name is available downstream
    # (rfk extraction in _run_generate_job_inner + the prompt block both
    # read ``profile.weekly_run_days_max``). Without this, prod requests
    # with no running-profile attached (which is the common path —
    # routes/master_plan.py treats profile as optional) silently dropped
    # weekly_training_days and key_session_density fell back to its
    # lenient 3-session default.
    if profile_norm is not None:
        if "weekly_run_days_max" not in profile_norm:
            wtd = profile_norm.get("weekly_training_days")
            if wtd is None:
                wtd = goal_norm.get("weekly_training_days")
            if isinstance(wtd, int):
                profile_norm["weekly_run_days_max"] = wtd
    else:
        goal_wtd = goal_norm.get("weekly_training_days")
        if isinstance(goal_wtd, int):
            profile_norm = {"weekly_run_days_max": goal_wtd}

    return goal_norm, profile_norm


# ---------------------------------------------------------------------------
# LLM prompt builder
# ---------------------------------------------------------------------------


def _build_system_prompt(
    goal: dict,
    profile: dict | None,
    history_summary: str,
    fitness_state: dict[str, Any],
    today: str,
    continuity: "ContinuitySignals | None" = None,
) -> str:
    # Normalise prod-route field names before serialising into the prompt.
    # Without this, prod payloads carry ``target_finish_time`` / ``pbs`` and
    # the goal-realism HARD pushback rule (which references ``goal_time_s`` /
    # ``profile.prs``) silently no-ops in production.
    goal, profile = _normalize_for_prompt(goal, profile)

    goal_json = json.dumps(goal, ensure_ascii=False, indent=2)
    profile_json = json.dumps(profile, ensure_ascii=False, indent=2) if profile else "未填写"
    fitness_summary = fitness_state.get("summary", "体能数据暂无")
    race_date = goal.get("race_date") or "未指定"

    continuity_block = ""
    if continuity is not None:
        c = continuity
        inj = "、".join(c.injuries) if c.injuries else "无"
        days = f"{c.days_since_last_race} 天" if c.days_since_last_race is not None else "无近期比赛"
        longest = f"{c.recent_longest_run_km} km" if c.recent_longest_run_km is not None else "暂无"
        ctl = c.current_chronic_load if c.current_chronic_load is not None else "暂无"
        zone = c.current_form_zone or "暂无"
        season = f"；{c.season_context}" if c.season_context else ""
        continuity_block = f"""
延续性信号（确定性，来自训练数据/结构化 profile）：
- macro_cycle: {c.macro_cycle}{season}
- 距上场比赛: {days}；赛后状态: {c.post_race_recovery_status}
- 近期有氧周数: {c.recent_aerobic_weeks}；周量趋势: {c.recent_volume_trend}；最近最长跑: {longest}
- 当前 STRIDE CTL(chronic): {ctl}；form 区: {zone}
- 断训回归: {c.return_from_layoff}
- 伤病（软约束，自行权衡，勿机械禁课）: {inj}

请据此调整周期结构：已恢复且距赛久则不排开头恢复期；已有多周有氧则缩短 base；断训回归则延长 base、放缓 ramp；夏训块可插速度周期。
"""

    macro_block = ""
    if continuity is not None and continuity.macro_cycle == "summer":
        macro_block = """
夏训块周期化指导（macro_cycle=summer）：长块（赛季备战 ~7-8 个月感），气温高、适合发展速度。
- phase 序列倾向：基础期 → 速度周期(speed) → 进展期(build) → 赛前期(peak) → taper；中段排一个独立速度周期。
- 长课避开正午高温，质量课优先清晨/傍晚；base 可铺得开。
"""
    elif continuity is not None and continuity.macro_cycle == "winter":
        macro_block = """
冬训块周期化指导（macro_cycle=winter）：压缩块（~4-5 个月），低温、消耗小、适合堆大量有氧。
- phase 序列倾向：基础期(长、堆有氧) → 进展期(build，速度并入) → 赛前期(peak) → taper；不排独立速度周期。
- base 偏长、尽快进专项；速度训练融进 build 而非单独成块。
"""

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
    {{"name":"基础期","phase_type":"base|build|speed|peak|taper|recovery","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","focus":"建立有氧基础；3:1 周期，每 4 周降量 1 周至该阶段下限的 70-80%","weekly_distance_km_low":35,"weekly_distance_km_high":45,"key_session_types":["长距离","中距离"]}},
    ...
  ],
  "milestones": [
    {{"type":"race|test_run|long_run|strength_test","date":"YYYY-MM-DD","phase_name":"<对应阶段>","target":"自然语言描述","metric":"race_time_s_5k","target_value":1140,"comparator":"<=|>=|=="}},
    ...
  ],
  "weekly_key_sessions": [
    {{"week_index":1,"week_start":"YYYY-MM-DD","phase_name":"<对应阶段>","target_weekly_km_low":45,"target_weekly_km_high":52,"is_recovery_week":false,"is_taper_week":false,"key_sessions":[
      {{"type":"long_run","distance_km":24,"intensity":"z2","purpose":"建立马拉松专项耐力"}},
      {{"type":"threshold","duration_min":35,"intensity":"z4","purpose":"提高乳酸阈值"}}
    ]}},
    ...
  ]
}}}}
---END_MASTER_PLAN---
{continuity_block}{macro_block}
规则：
- start_date 用今日（{today}），end_date 不晚于比赛日（{race_date}）
- 阶段顺序：基础期 → 进展期 → 赛前期 → 比赛 →（如有）恢复期
- 每个阶段至少 2 周
- weekly_distance_km_low / high 应反映该阶段周量目标
- 每个 phase 必须标注 phase_type（base|build|speed|peak|taper|recovery）；milestone 尽量给结构化出口目标（metric+target_value+comparator）
- 里程碑应贯穿训练周期（每 2-4 周一个）
- 训练原则 6-10 条（含下方营养、recovery week、目标现实性三项强制要求）
- 用户跑龄短 / 周量低时阶段周量更保守
- 周末日期作为 long_run 里程碑日期
- 输出**仅 JSON 块**，无额外解释文字

**Weekly key-session skeleton（HARD）**：
- `weekly_key_sessions` 必须**逐周**列出 plan.start_date 到 plan.end_date 之间的每一周（按 week_index 从 1 顺序递增，week_start 写该周周一的 ISO 日期）
- 每个 entry 关联到对应 phase 的 `phase_name`，并写明该周的 `target_weekly_km_low` / `target_weekly_km_high`（应落在该 phase 的周量区间内，recovery week 取 phase 下限的 70-80%）
- `key_sessions[]` **仅**列驱动训练适应或负载的重点课（long_run / threshold / tempo / interval / vo2max / hill / race_pace / time_trial / tune_up_race / race / strength_key），普通 easy / aerobic / recovery / commute run **不要**列入
- 每个非 recovery / taper 周必须有 **1-3 个**重点课；race 周可只列一个 `race` 类型；recovery week 允许 0-1 个
- 距离锚定的课（long_run / race_pace / tune_up_race / race）写 `distance_km`；时间锚定的课（threshold / interval / tempo）写 `duration_min`
- 同一周内 threshold / tempo / interval / vo2max / hill / race_pace 等高负荷课**不得超过 2 个**
- 当 `profile.weekly_run_days_max <= 3` 时，每周重点课**不得超过 2 个**；否则不超过 3 个
- 在 race 前 1-2 周必须将 `is_taper_week=true`，且 `target_weekly_km_high` 相比 peak 周下降 ≥ 25%
- 每 4 周一次 recovery week 时 `is_recovery_week=true`，对应 `target_weekly_km_*` 取 phase 下限的 70-80%
- peak 阶段最长 `long_run.distance_km` 必须匹配目标比赛距离：fm ≥ 28km，hm ≥ 18km，10k ≥ 10km，5k ≥ 6km

**Recovery week 节奏（HARD）**：
- 任何 ≥ 4 周的非 base 阶段（进展期 / 赛前期）必须采用 3:1 周期化：连续 3 周渐进负荷 + 1 周降量到该阶段周量下限的 70-80%
- 必须在对应 phase.focus 字段中显式写明 recovery week 安排，例如："3:1 周期，每 4 周降量 1 周至 W3 周量的 70%；recovery week 取消所有质量课"
- 阶段不足 4 周时可省略 recovery week，但 focus 必须说明"不足 4 周，无 recovery week"

**营养策略（HARD）**：
- training_principles 必须包含至少 3 条独立的营养原则，整体覆盖以下维度：
  - 基础期：维持热量平衡，蛋白质 1.4-1.6 g/kg/天，训后 30 min 补 carbs+protein 3:1
  - 进展期 / 赛前期：增加碳水至 5-7 g/kg/天，长课前 30-60 min 补碳 30-60 g，长课中每小时 30-60 g
  - 比赛减量期（taper）：维持糖原储备，赛前 3 天 carb-loading 8-10 g/kg/天
  - 比赛后恢复期：增蛋白至 1.8-2.0 g/kg/天促修复，补水 + 电解质
- 用户档案若含目标体重 / 体脂调整诉求，营养原则必须显式应对（如"build 期保持小幅热量盈余以支撑训练负荷而非追求减重"）
- **不要**只写一条笼统的"注重营养"，必须按 phase 给具体数字

**训练负荷分布（HARD）**：
- STRIDE 用 **CTL 比例 Form 分类**（chronic−acute 除以 chronic，不是经典 TSB 固定阈值）：
  - > +25% CTL = 减量过多 / +10~+25% = 比赛就绪 / ±10% = 维持期 / −25%~−10% = 提升期 / < −25% = 过度负荷
- 每个 phase 的 `focus` 字段必须**显式声明 Form 期望分布**（按 phase 类型）：
  - **Base（基础期）**：维持期 40-50% + 提升期 30-40% + 比赛就绪 10-20%；chronic 缓慢上行
  - **Build（进展期）**：**提升期 50-60%** + 维持期 20-30% + 比赛就绪 10%；chronic 明显上行
  - **Peak（赛前期）**：提升期 40% + 维持期 30% + 比赛就绪 30%；chronic 持平或微降
  - **Taper（减量期）**：比赛就绪 60-70% + 维持期 20-30%；acute 主动下降
  - **Recovery（恢复期）**：比赛就绪 70% + 维持期 30%；chronic 主动下行
- 周量 ramp heuristic：每周 dose 目标 ≈ **chronic × 7**（维持）/ **chronic × 7.7+**（推进入提升期）
- Anti-patterns（在 `training_principles` 中显式写明禁止）：
  - 单日 long run dose **不得 > 35%** 周总 dose（"spike + flat"根因）
  - 每周零 dose 天 **≤ 2**（典型布局：力量日 + 短 jog 30-40min 替代纯力量；mobility 日不计零 dose）
  - 周一 / 周日相邻零日**禁止**（acute 会被连续清零 2-3 天）
- 周计划生成时 `key_sessions` 必须能撑起 phase 的 Form 分布目标 —— 例如 build 周要让 ≥4 天有跑步 dose，而不是 2 个 spike + 4 个零日

**Distance specificity（HARD）**：
- 训练 / 备战的几乎一切（peak 周量、long_run 距离、taper 长度、间歇课比例）都要按 target_race.distance 调整。**不要**把 FM-style plan 套到 HM / 10K / 5K，反之亦然。
- FM (full marathon)：peak 周量 65-80 km；peak long_run **≥ 28 km**（典型 28-35）；taper **2 周**；peak phase 3-4 周；race-specific 期重 marathon-pace long runs + tempo
- HM (half marathon)：peak 周量 55-72 km；peak long_run **18-22 km**（不超过 25 km）；taper **1 周**；peak phase 2-3 周
- 10K：peak 周量 45-65 km；peak long_run **14-16 km**（不超过 18 km）；taper **3-7 天**；peak phase 1-2 周；key_sessions 重 interval / vo2max / threshold（远多于 long_run / race_pace）
- 5K：peak 周量 40-55 km；peak long_run **8-12 km**（不超过 14 km）；taper **3-5 天**；peak phase 1-2 周；key_sessions 重 vo2max / 短间歇（200m-1k 重复）+ 速度
- 把上述硬指标显式反映到 `weekly_key_sessions[].target_weekly_km_high` / `key_sessions[].distance_km`。

**Goal realism 与 pushback（HARD）**：
- 收到 goal_time_s 后，必须对照用户近期 PB（profile.prs 或 history_summary 里的"最好成绩"）计算改善幅度
- 单周期改善上限阈值（超过即视为不现实）：
  - 全马 (fm_s)：> 10%
  - 半马 (hm_s)：> 12%
  - 10K (10k_s)：> 15%
- 如果 goal 改善幅度 **超过**阈值（典型例子：FM PB 3:45 → goal 2:50 是 24% 提升）：
  - training_principles 第 1 条必须显式 push back，例如："用户 FM PB 3:45 → goal 2:50 单周期改善 24%（> 10% 上限），不现实。本周期建议目标 3:25-3:30（10-12% 改善），下个周期再冲击 sub-3:00"
  - 训练强度按建议的现实 target_time 排，**不能**按用户原 goal 配速排训练
  - race milestone 的 target 字段写本周期建议成绩 + 远期 A 目标，例如："本周期目标 3:30；2:50 为下一周期 A 目标"
- 如果 goal 改善幅度在阈值内：正常排训练，建议给出 A / B / C 目标分层（A 目标条件 / B 目标 / 保底）"""


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
    """Drive master-plan generation through the coach generation graph.

    Pipeline (load_context → generator → rule_filter → reviewer → verdict)
    is compiled here from adapter callables; the adapter emits READING_HISTORY
    / EVALUATING / PLANNING_PHASES stage updates. This function only owns
    OUTPUTTING + final persist + error mapping.
    """
    # Lazy imports — keeps the heavy coach / langgraph machinery out of cold
    # paths (e.g. routes that only need to enqueue a job without invoking it).
    from coach.graphs.generation.graph import build_generation_graph
    from coach.graphs.generation.master_rule_filter import run_master_rule_filter

    from .coach_adapters.master_plan_adapter import (
        apply_master_patches,
        generate_master_plan,
        load_master_context,
        master_reviewer,
    )

    update_job(job_id, status=JobStatus.RUNNING)

    # Build rule_filter kwargs from the same goal / profile shape the prompt
    # uses (post-normalisation). The input-aware L1 rules (season_window_fits
    # / goal_realism) need target_race + prs to do anything — missing kwargs
    # are silent no-ops per run_master_rule_filter's contract.
    norm_goal, norm_profile = _normalize_for_prompt(goal, profile)
    rfk: dict = {
        "target_race": {
            "distance": norm_goal.get("distance"),
            "goal_time_s": norm_goal.get("goal_time_s"),
            "race_date": norm_goal.get("race_date"),
        },
    }
    if norm_profile and norm_profile.get("prs"):
        rfk["prs"] = norm_profile["prs"]
    # season_window is a fixture-only concept (eval framework); prod uses
    # goal.race_date as the implicit upper bound and trusts the LLM to
    # respect it. Skip season_window_fits in prod by not passing it.
    if norm_profile and norm_profile.get("weekly_run_days_max") is not None:
        rfk["weekly_run_days_max"] = norm_profile["weekly_run_days_max"]

    graph = build_generation_graph(
        load_context=load_master_context,
        generator=generate_master_plan,
        reviewer=master_reviewer,
        apply_patches=apply_master_patches,
        rule_filter=run_master_rule_filter,
        rule_filter_kwargs=rfk,
    )

    initial_state: dict = {
        "job_id": job_id,
        "user_id": user_id,
        "plan_type": "master",
        "input_payload": {"goal": goal, "profile": profile},
    }

    try:
        final_state = graph.invoke(initial_state)
    except LLMUnavailable as exc:
        logger.warning("job=%s LLM unavailable: %s", job_id, exc)
        update_job(job_id, status=JobStatus.FAILED, error="llm_unavailable")
        return
    except LLMError as exc:
        retryable = getattr(exc, "retryable", False)
        logger.warning("job=%s LLM error retryable=%s: %s", job_id, retryable, exc)
        update_job(job_id, status=JobStatus.FAILED, error=f"llm_error: {exc}")
        return
    except ValueError as exc:
        # generate_master_plan raises two prefixed ValueError kinds:
        #   "parse_failed: ..." — all 3 parse tiers missed (raw_output attached)
        #   "bad_schema: ..."    — _build_master_plan rejected the parsed JSON
        msg = str(exc)
        if msg.startswith("parse_failed"):
            raw_output = getattr(exc, "raw_output", None)
            logger.warning("job=%s parse failed: %s", job_id, exc)
            update_job(
                job_id,
                status=JobStatus.FAILED,
                error="parse_failed",
                raw_output=raw_output,
            )
            return
        if msg.startswith("bad_schema"):
            logger.warning("job=%s plan build failed: %s", job_id, exc)
            update_job(job_id, status=JobStatus.FAILED, error=msg)
            return
        raise

    # ------------------------------------------------------------------
    # Stage 4: OUTPUTTING — verdict gate + persist
    # ------------------------------------------------------------------
    update_job(job_id, stage=JobStage.OUTPUTTING, progress=85)

    verdict = final_state.get("final_verdict")
    if verdict == "block":
        violations = final_state.get("rule_violations") or []
        rules_str = "; ".join(v.get("rule", "?") for v in violations) or "unknown"
        logger.warning("job=%s verdict=block rules=%s", job_id, rules_str)
        update_job(
            job_id,
            status=JobStatus.FAILED,
            error=f"rule_filter_failed: {rules_str}",
        )
        return

    parsed = final_state.get("final_artifact")
    if not isinstance(parsed, dict):
        logger.warning("job=%s no final_artifact in state", job_id)
        update_job(job_id, status=JobStatus.FAILED, error="no_artifact")
        return

    # current_draft is already a MasterPlan-shaped dict (adapter did the
    # _build_master_plan transform); model_validate is essentially round-trip
    # validation here, but kept as a safety net + to reconstruct the instance.
    try:
        plan = MasterPlan.model_validate(parsed)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError catch-all
        logger.warning("job=%s final_artifact model_validate failed: %s", job_id, exc)
        update_job(job_id, status=JobStatus.FAILED, error=f"bad_schema: {exc}")
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
