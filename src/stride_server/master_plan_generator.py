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
    from coach.schemas import ContinuitySignals, CurrentPhaseContext

from stride_core.master_plan import (
    KeySession,
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanWeek,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
    compute_total_weeks,
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
    goal: dict,
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

    goal_snapshot = _build_goal_snapshot(goal, plan_data, end_date)

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
    weeks: list[MasterPlanWeek] = []
    for w in _iter_plan_weeks(plan_data):
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
        weeks.append(
            MasterPlanWeek(
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
        goal_id=goal_snapshot.goal_id,
        goal=goal_snapshot,
        start_date=start_date,
        end_date=end_date,
        total_weeks=len(weeks) if weeks else compute_total_weeks(start_date, end_date),
        phases=phases,
        milestones=milestones,
        weeks=weeks,
        weekly_key_sessions=weeks,
        training_principles=plan_data.get("training_principles", []),
        generated_by=generated_by,
        version=1,
        created_at=now_iso,
        updated_at=now_iso,
    )


def _build_goal_snapshot(
    goal: dict,
    plan_data: dict,
    fallback_race_date: str,
) -> MasterPlanGoal:
    """Build the embedded MasterPlan.goal snapshot from TrainingGoal input."""
    goal_id = str(goal.get("goal_id") or goal.get("id") or uuid4())
    target_time = goal.get("target_time") or goal.get("target_finish_time")
    if not target_time:
        raise ValueError("goal.target_time is required for master-plan generation")

    raw_distance = goal.get("distance") or goal.get("race_distance") or plan_data.get("distance")
    race_name = (
        goal.get("race_name")
        or goal.get("race")
        or goal.get("name")
        or _default_race_name(raw_distance)
    )
    race_date = goal.get("race_date") or plan_data.get("race_date") or fallback_race_date

    return MasterPlanGoal(
        goal_id=goal_id,
        race_name=str(race_name or ""),
        distance=raw_distance or "FM",
        race_date=str(race_date or fallback_race_date),
        target_time=str(target_time),
        timezone=str(goal.get("timezone") or "Asia/Shanghai"),
        location=goal.get("location"),
    )


def _default_race_name(distance: Any) -> str:
    normalised = MasterPlanGoal.normalise_distance(distance or "FM")
    dist = normalised.value if hasattr(normalised, "value") else str(normalised)
    names = {
        "5K": "5K 目标赛",
        "10K": "10K 目标赛",
        "HM": "半程马拉松目标赛",
        "FM": "马拉松目标赛",
        "trail": "越野目标赛",
    }
    return names.get(dist, "目标赛事")


def _iter_plan_weeks(plan_data: dict) -> list:
    weeks = plan_data.get("weeks")
    if isinstance(weeks, list):
        return weeks
    legacy = plan_data.get("weekly_key_sessions")
    if isinstance(legacy, list):
        return legacy
    return []


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
    best_*_s (REAL personal bests — actual achieved efforts), and pred_*_s
    (COROS fitness-based race predictions — current-fitness ceilings, NOT
    achieved results; kept separate so milestones anchor to real PBs).

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
        "pred_5k_s": None,
        "pred_10k_s": None,
        "pred_hm_s": None,
        "pred_fm_s": None,
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

        # Real personal bests — actual achieved efforts from the activity
        # history via the canonical single-source detector (segment-matched,
        # whole-activity fallback). This is DISTINCT from the COROS
        # race_predictions below, which are fitness-based ESTIMATES (optimistic
        # ceilings), not results. Conflating them anchored milestones to paces
        # the athlete has never actually run (e.g. a "PB 38:38" 10K when the real
        # best is 40:06). Reuses the same detector as routes/pbs + ability +
        # the coach get_pbs tool (athlete-baseline single-source rule).
        try:
            from stride_core.pb_records import detect_personal_bests
            pb_map = detect_personal_bests(db)
            pb_key = {
                "5K": "best_5k_s",
                "10K": "best_10k_s",
                "HM": "best_hm_s",
                "FM": "best_fm_s",
            }
            for disp, key in pb_key.items():
                entry = pb_map.get(disp)
                if entry and entry.get("pb_time_sec"):
                    result[key] = round(entry["pb_time_sec"])
        except Exception as exc:  # noqa: BLE001 — PB detection must not block gen
            logger.warning("_query_history: PB detection failed for %s: %s", user_id, exc)

        # COROS fitness-based race predictions — current-fitness ceilings, NOT
        # achieved results. Kept as a SEPARATE signal (pred_*_s) so the planner
        # sees what current fitness projects without mistaking it for a PB.
        preds = conn.execute(
            "SELECT race_type, duration_s FROM race_predictions"
        ).fetchall()
        pred_map = {
            "5K": "pred_5k_s",
            "10K": "pred_10k_s",
            "Half Marathon": "pred_hm_s",
            "Marathon": "pred_fm_s",
        }
        for race_type, duration_s in preds:
            key = pred_map.get(race_type)
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
        f"实际最好成绩（PB，历史真实跑出，里程碑锚定用这一行）— "
        f"5K: {fmt_time(history.get('best_5k_s'))}  "
        f"10K: {fmt_time(history.get('best_10k_s'))}  "
        f"半马: {fmt_time(history.get('best_hm_s'))}  "
        f"全马: {fmt_time(history.get('best_fm_s'))}"
    )
    # COROS fitness predictions are current-fitness ceilings, NOT achieved
    # results (typically faster than real PB). Surfaced separately + explicitly
    # so the planner does NOT anchor milestones to a pace never actually run.
    if any(history.get(k) for k in ("pred_5k_s", "pred_10k_s", "pred_hm_s", "pred_fm_s")):
        lines.append(
            f"COROS 体能预测（当前体能上限，非实际成绩，**勿**直接作为里程碑基线）— "
            f"5K: {fmt_time(history.get('pred_5k_s'))}  "
            f"10K: {fmt_time(history.get('pred_10k_s'))}  "
            f"半马: {fmt_time(history.get('pred_hm_s'))}  "
            f"全马: {fmt_time(history.get('pred_fm_s'))}"
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


def _format_body_comp_fallback(bc: dict[str, Any]) -> str:
    """Minimal one-line body-comp summary used only when the caller did not
    supply a pre-formatted ``body_composition_summary`` (defence-in-depth so the
    prompt never carries a raw dict)."""
    parts = []
    if bc.get("weight_kg") is not None:
        parts.append(f"体重 {bc['weight_kg']}kg")
    if bc.get("body_fat_pct") is not None:
        parts.append(f"体脂 {bc['body_fat_pct']}%")
    scan = bc.get("scan_date", "?")
    return f"最新体测（{scan}）— " + "，".join(parts) if parts else f"最新体测（{scan}）"


def _build_system_prompt(
    goal: dict,
    profile: dict | None,
    history_summary: str,
    fitness_state: dict[str, Any],
    today: str,
    continuity: "ContinuitySignals | None" = None,
    body_composition: dict[str, Any] | None = None,
    body_composition_summary: str | None = None,
    current_phase: "CurrentPhaseContext | None" = None,
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

    # Natural-week alignment: anchor the plan start to the UPCOMING Monday so
    # every phase/week is a clean Mon→Sun block (today if today is a Monday).
    # LLMs are unreliable at day-of-week arithmetic, so compute it here and
    # inject the concrete date rather than asking the model to round.
    from datetime import date as _date_cls, timedelta as _timedelta
    try:
        _t = _date_cls.fromisoformat(today)
        plan_start = (_t + _timedelta(days=(7 - _t.weekday()) % 7)).isoformat()
    except (ValueError, TypeError):
        plan_start = today

    # Dynamic context blocks: data-presence conditionals + value computation stay
    # here (data logic), but the English prose lives in markdown fragments under
    # coach/skills/shared/blocks/ — rendered via render_fragment. Each non-empty
    # block is wrapped in newlines so they self-separate when concatenated in the
    # SKILL.md template (${current_phase_block}${continuity_block}...).
    from coach.skills import render_fragment

    continuity_block = ""
    if continuity is not None:
        c = continuity
        inj = "、".join(c.injuries) if c.injuries else "none"
        days = f"{c.days_since_last_race} days" if c.days_since_last_race is not None else "no recent race"
        longest = f"{c.recent_longest_run_km} km" if c.recent_longest_run_km is not None else "n/a"
        ctl = c.current_chronic_load if c.current_chronic_load is not None else "n/a"
        zone = c.current_form_zone or "n/a"
        season = f"; {c.season_context}" if c.season_context else ""
        continuity_block = "\n" + render_fragment("shared/blocks/continuity.md", {
            "macro_cycle": c.macro_cycle, "season": season, "days": days,
            "post_race_recovery_status": c.post_race_recovery_status,
            "recent_aerobic_weeks": c.recent_aerobic_weeks,
            "recent_volume_trend": c.recent_volume_trend, "longest": longest,
            "ctl": ctl, "form_zone": zone, "return_from_layoff": c.return_from_layoff,
            "injuries": inj, "plan_start": plan_start,
        }) + "\n"

    # Authoritative current-phase block (deterministic pre-generation): the planner
    # MUST begin at recommended_entry_phase and must not re-prescribe completed phases.
    current_phase_block = ""
    if current_phase is not None and current_phase.recommended_entry_phase is not None:
        cp = current_phase
        cur = cp.current_phase_type.value if cp.current_phase_type else "unknown"
        entry = cp.recommended_entry_phase.value
        wip = f"~{cp.weeks_in_phase} weeks" if cp.weeks_in_phase is not None else "unknown"
        src = {"existing_plan": "read prior training plan",
               "inferred": "inferred from recent activity records"}.get(cp.source, cp.source)
        current_phase_block = "\n" + render_fragment("shared/blocks/current_phase.md", {
            "src": src, "cur": cur, "wip": wip,
            "completed_aerobic_weeks": cp.completed_aerobic_weeks,
            "entry": entry, "confidence": cp.confidence, "rationale": cp.rationale,
        }) + "\n"

    macro_block = ""
    if continuity is not None and continuity.macro_cycle == "summer":
        macro_block = "\n" + render_fragment("shared/blocks/macro_summer.md", {}) + "\n"
    elif continuity is not None and continuity.macro_cycle == "winter":
        macro_block = "\n" + render_fragment("shared/blocks/macro_winter.md", {}) + "\n"

    body_comp_block = ""
    if body_composition:
        bc = body_composition

        def _fmt(key: str, unit: str = "") -> str:
            v = bc.get(key)
            return f"{v}{unit}" if v is not None else "n/a"

        summary_line = body_composition_summary or _format_body_comp_fallback(bc)
        body_comp_block = "\n" + render_fragment("shared/blocks/body_composition.md", {
            "summary_line": summary_line,
            "weight": _fmt("weight_kg", "kg"), "body_fat": _fmt("body_fat_pct", "%"),
            "smm": _fmt("smm_kg", "kg"), "fat_mass": _fmt("fat_mass_kg", "kg"),
            "bmr": _fmt("bmr_kcal", "kcal"), "bmi": _fmt("bmi"),
        }) + "\n"

    # Prompt content lives in the markdown skill src/coach/skills/master_plan_planner/
    # (SKILL.md + shared/ + references/), loaded + rendered here. The dynamic
    # blocks + input strings computed above are the runtime ${context}.
    from coach.skills import render_skill
    return render_skill("master_plan_planner", {
        "goal_json": goal_json,
        "profile_json": profile_json,
        "history_summary": history_summary,
        "fitness_summary": fitness_summary,
        "plan_start": plan_start,
        "race_date": race_date,
        "current_phase_block": current_phase_block,
        "continuity_block": continuity_block,
        "macro_block": macro_block,
        "body_comp_block": body_comp_block,
    })


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
