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
from datetime import date as date_cls
from datetime import datetime, timedelta, timezone

from stride_core.timefmt import sqlite_mixed_date_expr, today_shanghai
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


_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")


def _json_loads_lenient(blob: str) -> Any | None:
    """Parse JSON-ish LLM output without weakening the public contract.

    The prompt still asks for strict JSON. This helper is only a final fallback
    for common model artifacts seen in live generation, such as trailing commas
    or a top-level one-item array around the envelope. It returns ``None`` on
    failure so the caller can continue to the next extraction layer.
    """
    text = blob.strip()
    if not text:
        return None

    candidates = [text]
    repaired = _TRAILING_COMMA_RE.sub(r"\1", text)
    if repaired != text:
        candidates.append(repaired)

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    try:
        import json5  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001 - optional fallback dependency
        return None

    try:
        return json5.loads(text)
    except Exception:  # noqa: BLE001 - json5 raises multiple parse errors
        return None


def _normalise_parsed_master_plan(data: Any) -> dict | None:
    """Return the master-plan envelope from a parsed JSON value if present."""
    if isinstance(data, dict):
        if "schema" in data and isinstance(data.get("plan"), dict):
            return data
        # Some models wrap the requested envelope in a descriptive object.
        for key in ("master_plan", "masterPlan", "output", "result", "data"):
            nested = _normalise_parsed_master_plan(data.get(key))
            if nested is not None:
                return nested
    elif isinstance(data, list):
        for item in data:
            nested = _normalise_parsed_master_plan(item)
            if nested is not None:
                return nested
    return None


def _parse_json_candidate(blob: str) -> Any | None:
    return _json_loads_lenient(blob)


def _parse_first_json_object(raw: str) -> Any | None:
    """Parse the first complete JSON object from text with trailing prose."""
    first_brace = raw.find("{")
    if first_brace == -1:
        return None
    try:
        parsed, _end = json.JSONDecoder().raw_decode(raw[first_brace:])
        return parsed
    except json.JSONDecodeError:
        return _parse_json_candidate(raw[first_brace:])


def _parse_llm_output(raw: str) -> dict | None:
    """Parse LLM output into a generic JSON object with 3-tier fallback.

    Layer 1: sentinel-anchored  ---BEGIN_MASTER_PLAN--- ... ---END_MASTER_PLAN---
    Layer 2: fenced code block  ```json ... ```
    Layer 3: balanced braces    first { to last }

    This helper is shared by master-plan, weekly-plan, and phase-at-once
    adapters, so it must stay schema-agnostic and return any parsed dict
    envelope. Master-plan-specific wrapper unwrapping lives in
    ``_parse_master_plan_output`` below.
    """
    # Layer 1: sentinel
    sentinel_match = re.search(
        r"---BEGIN_MASTER_PLAN---(.*?)---END_MASTER_PLAN---",
        raw,
        re.DOTALL,
    )
    if sentinel_match:
        parsed = _parse_json_candidate(sentinel_match.group(1))
        if isinstance(parsed, dict):
            return parsed

    # Layer 2: fenced code block
    fenced_match = re.search(r"```json\s*(.*?)```", raw, re.DOTALL)
    if fenced_match:
        parsed = _parse_json_candidate(fenced_match.group(1))
        if isinstance(parsed, dict):
            return parsed

    # Layer 3: first complete JSON object. ``raw_decode`` is stricter than the
    # old first-brace→last-brace slice in the useful direction: it returns the
    # first complete object and tolerates trailing prose/stray braces, while
    # still failing when the object itself is malformed.
    parsed = _parse_first_json_object(raw)
    if isinstance(parsed, dict):
        return parsed

    return None


def _parse_master_plan_output(raw: str) -> dict | None:
    """Parse S1 master-plan output, including model-added wrappers."""
    sentinel_match = re.search(
        r"---BEGIN_MASTER_PLAN---(.*?)---END_MASTER_PLAN---",
        raw,
        re.DOTALL,
    )
    if sentinel_match:
        parsed = _normalise_parsed_master_plan(
            _parse_json_candidate(sentinel_match.group(1))
        )
        if parsed is not None:
            return parsed

    fenced_match = re.search(r"```json\s*(.*?)```", raw, re.DOTALL)
    if fenced_match:
        parsed = _normalise_parsed_master_plan(
            _parse_json_candidate(fenced_match.group(1))
        )
        if parsed is not None:
            return parsed

    parsed = _normalise_parsed_master_plan(_parse_first_json_object(raw))
    if parsed is not None:
        return parsed

    parsed = _normalise_parsed_master_plan(_parse_json_candidate(raw))
    if parsed is not None:
        return parsed

    return None


# ---------------------------------------------------------------------------
# MasterPlan builder
# ---------------------------------------------------------------------------


def _build_master_plan(
    parsed: dict,
    user_id: str,
    goal: dict,
    profile: dict | None = None,
    generated_by: str = "unknown",
    pb_seconds: dict[str, float] | None = None,
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
                rhythm=str(p.get("rhythm", "") or ""),
                key_workouts=str(p.get("key_workouts", "") or ""),
                monitoring_triggers=[
                    str(t) for t in (p.get("monitoring_triggers") or []) if t
                ],
                coach_note=str(p.get("coach_note", "") or ""),
                is_completed=bool(p.get("is_completed", False)),
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

        # Validate milestone type — accept common LLM aliases gracefully.
        milestone_date = str(m.get("date", start_date))
        milestone_type = _normalise_milestone_type_for_goal(
            _parse_milestone_type(m.get("type", "long_run")),
            milestone_date,
            goal,
        )

        milestones.append(
            Milestone(
                id=milestone_id,
                type=milestone_type,
                date=milestone_date,
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

    milestones = _align_long_run_milestones_to_weeks(milestones, weeks)
    weeks = _raise_post_recovery_under_rebound(weeks)
    weeks = _drop_three_day_stacked_hard_sessions(weeks, goal, profile)

    now_iso = datetime.now(timezone.utc).isoformat()
    # Plan-level start_date / total_weeks span the WHOLE season, including any
    # already-completed leading phase (is_completed). The weekly skeleton only
    # covers the active portion (e.g. weeks W9-24 when a base phase took W1-8),
    # so total_weeks is the continuous season length = max(week_index), NOT
    # len(weeks). start_date is the earliest phase start. With no completed
    # lead-in these reduce to the old values (max == len, earliest == start),
    # so existing plans are unaffected.
    phase_starts = [p.start_date for p in phases if p.start_date]
    plan_start = min(phase_starts) if phase_starts else start_date
    plan_total_weeks = (
        max(w.week_index for w in weeks)
        if weeks
        else compute_total_weeks(plan_start, end_date)
    )
    training_principles = _normalise_short_race_nutrition_principles(
        _ensure_pushback_multi_cycle_path(plan_data.get("training_principles", [])),
        goal,
    )
    training_principles, milestones = _ensure_aggressive_fm_combination_gate(
        training_principles,
        milestones,
        goal,
        pb_seconds,
    )
    return MasterPlan(
        plan_id=str(uuid4()),
        user_id=user_id,
        status=MasterPlanStatus.DRAFT,
        goal=goal_snapshot,
        start_date=plan_start,
        end_date=end_date,
        total_weeks=plan_total_weeks,
        phases=phases,
        milestones=milestones,
        weeks=weeks,
        weekly_key_sessions=weeks,
        training_principles=training_principles,
        generated_by=generated_by,
        version=1,
        created_at=now_iso,
        updated_at=now_iso,
    )


def _inject_completed_phase_summaries(plan: MasterPlan, user_id: str) -> MasterPlan:
    """Cache a deterministic actual-results summary on each is_completed phase.

    Opens the per-user coros.db once and aggregates each completed phase's
    Shanghai-day window via ``phase_summary.aggregate_phase_summary`` (no LLM).
    Returns a new MasterPlan with the summaries populated; phases with no
    completed lead-in (the common case) come back unchanged.

    Graceful by design: any failure (no DB, aggregation error) leaves the
    affected phase's ``summary`` as ``None`` rather than failing generation.
    """
    completed = [p for p in plan.phases if getattr(p, "is_completed", False)]
    if not completed:
        return plan

    try:
        from stride_storage.sqlite.database import Database

        from .phase_summary import aggregate_phase_summary
    except Exception:  # noqa: BLE001 — import failure must not block gen
        logger.warning("phase_summary import failed; skipping summaries", exc_info=True)
        return plan

    db = None
    try:
        db = Database(user=user_id)
        new_phases: list[Phase] = []
        for phase in plan.phases:
            if not getattr(phase, "is_completed", False):
                new_phases.append(phase)
                continue
            try:
                summary = aggregate_phase_summary(db, phase.start_date, phase.end_date)
                new_phases.append(phase.model_copy(update={"summary": summary}))
            except Exception:  # noqa: BLE001 — one phase failing leaves it None
                logger.warning(
                    "phase summary failed for phase=%s (%s~%s); leaving None",
                    phase.id, phase.start_date, phase.end_date, exc_info=True,
                )
                new_phases.append(phase)
        return plan.model_copy(update={"phases": new_phases})
    except Exception:  # noqa: BLE001 — DB open / outer failure must not block gen
        logger.warning("completed-phase summary injection failed", exc_info=True)
        return plan
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:  # noqa: BLE001
                pass


def _build_goal_snapshot(
    goal: dict,
    plan_data: dict,
    fallback_race_date: str,
) -> MasterPlanGoal:
    """Build the embedded MasterPlan.goal snapshot from TrainingGoal input."""
    goal_id = str(goal.get("goal_id") or goal.get("id") or uuid4())
    # Finish-only goals (「仅完赛即可」) carry no target time. That's allowed:
    # the plan targets completion rather than a finish time, and the
    # goal-realism prompt rule no-ops when no target time is present. We store
    # an empty string rather than raising so generation proceeds.
    target_time = (
        goal.get("target_time")
        or goal.get("target_finish_time")
        or _format_seconds_as_hms(goal.get("goal_time_s"))
        or ""
    )

    raw_distance = goal.get("distance") or goal.get("race_distance") or plan_data.get("distance")
    race_name = (
        goal.get("race_name")
        or goal.get("race")
        or goal.get("name")
        or _default_race_name(raw_distance)
    )
    race_date = goal.get("race_date") or plan_data.get("race_date") or fallback_race_date
    raw_location = goal.get("location")
    location = str(raw_location).strip() if raw_location is not None else None

    return MasterPlanGoal(
        goal_id=goal_id,
        race_name=str(race_name or ""),
        distance=raw_distance or "FM",
        race_date=str(race_date or fallback_race_date),
        target_time=str(target_time),
        timezone=str(goal.get("timezone") or "Asia/Shanghai"),
        location=location or None,
    )


def _format_seconds_as_hms(value: Any) -> str | None:
    """Format integer seconds as ``H:MM:SS`` for the embedded goal snapshot."""
    if value is None or isinstance(value, bool):
        return None
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


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


_MILESTONE_TYPE_ALIASES: dict[str, MilestoneType] = {
    "tune_up_race": MilestoneType.TEST_RUN,
    "time_trial": MilestoneType.TEST_RUN,
    "fitness_test": MilestoneType.TEST_RUN,
}


def _parse_milestone_type(raw_type: Any) -> MilestoneType:
    """Parse LLM milestone type, accepting common test-run aliases."""
    raw = str(raw_type or "long_run")
    alias = _MILESTONE_TYPE_ALIASES.get(raw.lower())
    if alias is not None:
        return alias
    try:
        return MilestoneType(raw)
    except ValueError:
        logger.warning("unknown milestone type %r; defaulting to long_run", raw_type)
        return MilestoneType.LONG_RUN


def _goal_race_date(goal: dict) -> str | None:
    race_date = goal.get("race_date")
    if race_date:
        return str(race_date)
    target_race = goal.get("target_race")
    if isinstance(target_race, dict) and target_race.get("race_date"):
        return str(target_race["race_date"])
    return None


def _normalise_milestone_type_for_goal(
    milestone_type: MilestoneType,
    milestone_date: str,
    goal: dict,
) -> MilestoneType:
    """Only the target-race date should remain a race milestone."""
    if milestone_type != MilestoneType.RACE:
        return milestone_type
    race_date = _goal_race_date(goal)
    if race_date and milestone_date != race_date:
        logger.info(
            "downgrading non-target race milestone on %s to test_run "
            "(target race %s)",
            milestone_date,
            race_date,
        )
        return MilestoneType.TEST_RUN
    return milestone_type


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


def _week_long_run_km(week: MasterPlanWeek) -> float | None:
    distances = [
        session.distance_km
        for session in week.key_sessions
        if session.type == "long_run" and session.distance_km is not None
    ]
    if not distances:
        return None
    return max(float(distance) for distance in distances)


def _week_start_date(week: MasterPlanWeek) -> date_cls | None:
    try:
        return date_cls.fromisoformat(week.week_start)
    except (TypeError, ValueError):
        return None


def _align_long_run_milestones_to_weeks(
    milestones: list[Milestone],
    weeks: list[MasterPlanWeek],
) -> list[Milestone]:
    """Move long-run milestone dates onto a matching weekly skeleton week.

    The LLM sometimes writes a checkpoint on the Sunday just before the week
    whose skeleton contains that long run. Keep the target intact and move the
    date to the matching week's Sunday when a same-phase week already contains
    that exact-or-longer long run. If no such week exists, leave the milestone
    untouched so L1 can surface the real mismatch.
    """
    if not milestones or not weeks:
        return milestones

    aligned: list[Milestone] = []
    for milestone in milestones:
        if (
            milestone.type != MilestoneType.LONG_RUN
            or milestone.target_value is None
            or not str(milestone.metric or "").lower().startswith("long_run")
        ):
            aligned.append(milestone)
            continue

        target_km = float(milestone.target_value)
        matching_week: MasterPlanWeek | None = None
        try:
            milestone_date = date_cls.fromisoformat(milestone.date)
        except (TypeError, ValueError):
            milestone_date = None

        same_phase_weeks: list[tuple[MasterPlanWeek, date_cls, float]] = []
        for week in weeks:
            if week.phase_id != milestone.phase_id:
                continue
            week_start = _week_start_date(week)
            long_run_km = _week_long_run_km(week)
            if week_start is None or long_run_km is None:
                continue
            same_phase_weeks.append((week, week_start, long_run_km))
            if (
                milestone_date is not None
                and week_start <= milestone_date <= week_start + timedelta(days=6)
            ):
                matching_week = week

        if matching_week is not None:
            week_lr = _week_long_run_km(matching_week)
            if week_lr is not None and week_lr + 0.5 >= target_km:
                aligned.append(milestone)
                continue

        candidates = [
            (week, week_start, long_run_km)
            for week, week_start, long_run_km in same_phase_weeks
            if long_run_km + 0.5 >= target_km
        ]
        if not candidates:
            aligned.append(milestone)
            continue

        def _candidate_key(item: tuple[MasterPlanWeek, date_cls, float]) -> tuple[int, int]:
            week, week_start, _long_run_km = item
            distance_days = (
                abs((week_start - milestone_date).days)
                if milestone_date is not None else week.week_index
            )
            recovery_penalty = 1 if (week.is_recovery_week or week.is_taper_week) else 0
            return (recovery_penalty, distance_days)

        chosen_week, chosen_start, _chosen_long_run = min(candidates, key=_candidate_key)
        new_date = (chosen_start + timedelta(days=6)).isoformat()
        if new_date != milestone.date:
            logger.info(
                "aligning long_run milestone date %s -> %s for %.0fkm target "
                "(week_index=%s)",
                milestone.date,
                new_date,
                target_km,
                chosen_week.week_index,
            )
            aligned.append(milestone.model_copy(update={"date": new_date}))
        else:
            aligned.append(milestone)
    return aligned


def _raise_post_recovery_under_rebound(
    weeks: list[MasterPlanWeek], *, min_rebound_ratio: float = 0.90
) -> list[MasterPlanWeek]:
    """Raise load weeks that crawl up from a recovery trough.

    A recovery week is an intentional cut from the prior load week; the next
    non-taper load week should be anchored to that prior load week, not to the
    trough. This post-process is deliberately narrow: it never touches taper
    weeks and never raises above the prior load week.
    """
    if not weeks:
        return weeks
    out: list[MasterPlanWeek] = []
    current_load: MasterPlanWeek | None = None
    pending_recovery: MasterPlanWeek | None = None
    prior_load_before_recovery: MasterPlanWeek | None = None
    changed = False

    for week in sorted(weeks, key=lambda w: (w.week_index, w.week_start)):
        if week.is_recovery_week or week.is_taper_week:
            if week.is_recovery_week and current_load is not None:
                pending_recovery = week
                prior_load_before_recovery = current_load
            out.append(week)
            continue

        emitted = week
        if pending_recovery is not None and prior_load_before_recovery is not None:
            prior = float(prior_load_before_recovery.target_weekly_km_high or 0.0)
            current = float(week.target_weekly_km_high or 0.0)
            floor = round(prior * min_rebound_ratio, 1)
            if prior > 0 and current > 0 and current < floor:
                delta = floor - current
                low = float(week.target_weekly_km_low or 0.0)
                emitted = week.model_copy(
                    update={
                        "target_weekly_km_high": floor,
                        "target_weekly_km_low": round(max(0.0, low + delta), 1),
                    }
                )
                changed = True
                logger.info(
                    "raised post-recovery week %s from %.1fkm to %.1fkm "
                    "against prior load %.1fkm",
                    week.week_index,
                    current,
                    floor,
                    prior,
                )
            pending_recovery = None
            prior_load_before_recovery = None
        current_load = emitted
        out.append(emitted)

    return out if changed else weeks


def _normalise_target_distance(value: object) -> str:
    token = str(value or "").strip().lower().replace("_", "-")
    lookup = {
        "5-k": "5k",
        "five-k": "5k",
        "five-km": "5k",
        "5公里": "5k",
        "5千米": "5k",
        "5km": "5k",
        "10-k": "10k",
        "ten-k": "10k",
        "ten-km": "10k",
        "10公里": "10k",
        "10千米": "10k",
        "10km": "10k",
        "half": "hm",
        "half-marathon": "hm",
        "half marathon": "hm",
        "半马": "hm",
        "半程马拉松": "hm",
        "marathon": "fm",
        "full": "fm",
        "full-marathon": "fm",
        "full marathon": "fm",
        "马拉松": "fm",
        "全马": "fm",
    }
    return lookup.get(token, token)


def _is_target_distance(goal: dict, distance: str) -> bool:
    for key in ("distance", "race_distance"):
        if _normalise_target_distance(goal.get(key)) == distance:
            return True
    target = goal.get("target_race")
    if isinstance(target, dict):
        return _normalise_target_distance(target.get("distance")) == distance
    return False


def _is_target_10k(goal: dict) -> bool:
    return _is_target_distance(goal, "10k")


def _is_target_5k(goal: dict) -> bool:
    return _is_target_distance(goal, "5k")


def _normalise_short_race_nutrition_principles(
    principles: list[Any],
    goal: dict,
) -> list[str]:
    rendered = [str(item) for item in (principles or [])]
    if not rendered or not (_is_target_5k(goal) or _is_target_10k(goal)):
        return rendered

    race_label = "5K" if _is_target_5k(goal) else "10K"
    out: list[str] = []
    changed = False
    for principle in rendered:
        compact = principle.replace(" ", "").lower()
        mentions_short_race = race_label.lower() in compact or race_label in principle
        mentions_phase = (
            "peak" in compact
            or "taper" in compact
            or "峰值" in principle
            or "锐化" in principle
            or "减量" in principle
        )
        if not mentions_short_race and not mentions_phase:
            out.append(principle)
            continue

        updated = principle
        updated = re.sub(r"5-7\s*g/kg", "按训练日适量", updated, flags=re.IGNORECASE)
        updated = re.sub(r"5-7g/kg", "训练日适量碳水", updated, flags=re.IGNORECASE)
        updated = updated.replace("练胶和钠", "熟悉早餐和少量补水")
        updated = updated.replace("练胶+钠", "熟悉早餐和少量补水")
        updated = updated.replace("练胶", "熟悉早餐")
        updated = updated.replace("补钠", "少量补水")
        if updated != principle:
            changed = True
        out.append(updated)

    return out if changed else rendered


def _goal_time_seconds(goal: dict) -> float | None:
    value = goal.get("goal_time_s")
    if value is None:
        value = goal.get("target_time_s")
    if value is None:
        value = _parse_hms_to_seconds(str(goal.get("target_finish_time") or ""))
    if value is None:
        target = goal.get("target_race")
        if isinstance(target, dict):
            value = target.get("goal_time_s")
            if value is None:
                value = target.get("target_time_s")
            if value is None:
                value = _parse_hms_to_seconds(str(target.get("target_finish_time") or ""))
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


_PB_SECONDS_KEY_ALIASES: dict[str, str] = {
    "5k": "5k",
    "5-k": "5k",
    "5km": "5k",
    "10k": "10k",
    "10-k": "10k",
    "10km": "10k",
    "half": "hm",
    "hm": "hm",
    "half_marathon": "hm",
    "half-marathon": "hm",
    "marathon": "fm",
    "full": "fm",
    "fm": "fm",
}


def _normalise_pb_seconds(pb_seconds: dict | None) -> dict[str, float]:
    if not isinstance(pb_seconds, dict):
        return {}
    out: dict[str, float] = {}
    for raw_key, raw_value in pb_seconds.items():
        key = _PB_SECONDS_KEY_ALIASES.get(
            str(raw_key or "").strip().lower().replace("_", "-")
        )
        if key is None:
            key = _normalise_target_distance(raw_key)
        if key not in {"5k", "10k", "hm", "fm"}:
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        if value > 0:
            out[key] = value
    return out


def _fm_pb_improvement(goal_s: float | None, pb_seconds: dict | None) -> float | None:
    pb_s = _normalise_pb_seconds(pb_seconds).get("fm")
    if goal_s is None or pb_s is None or goal_s <= 0 or pb_s <= 0:
        return None
    return (pb_s - goal_s) / pb_s


def _has_advanced_pb(pb_seconds: dict | None) -> bool:
    pbs = _normalise_pb_seconds(pb_seconds)
    thresholds = {
        "5k": 19 * 60,
        "10k": 40 * 60,
        "hm": 90 * 60,
        "fm": 3 * 3600 + 10 * 60,
    }
    return any(pbs.get(distance, float("inf")) <= seconds for distance, seconds in thresholds.items())


def _is_aggressive_advanced_fm_goal(goal: dict, pb_seconds: dict | None) -> bool:
    if not _is_target_distance(goal, "fm"):
        return False
    goal_s = _goal_time_seconds(goal)
    improvement = _fm_pb_improvement(goal_s, pb_seconds)
    if improvement is None or improvement <= 0.03 or improvement > 0.15:
        return False
    return _has_advanced_pb(pb_seconds)


def _format_race_time(seconds: float) -> str:
    rounded = int(round(seconds / 15.0) * 15)
    h, rem = divmod(rounded, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _format_goal_time(seconds: float) -> str:
    h, rem = divmod(int(round(seconds)), 3600)
    m, s = divmod(rem, 60)
    if s:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{h}:{m:02d}"


def _aggressive_fm_gate_thresholds(goal_s: float) -> tuple[str, str, str, str]:
    # Riegel-equivalent tune-up times with a small buffer so a tune-up only
    # opens A when it supports the full marathon goal, not merely the B plan.
    hm_s = goal_s * (21.0975 / 42.195) ** 1.06 * 1.035
    ten_k_s = goal_s * (10.0 / 42.195) ** 1.06 * 1.02
    observation_hm_s = hm_s + 60
    observation_10k_s = ten_k_s + 15
    return (
        _format_race_time(hm_s),
        _format_race_time(ten_k_s),
        _format_race_time(observation_hm_s),
        _format_race_time(observation_10k_s),
    )


def _aggressive_fm_b_band(goal_s: float) -> str:
    low = _format_goal_time(goal_s + 120)
    high = _format_goal_time(goal_s + 300)
    return low if low == high else f"{low}-{high}"


def _compose_aggressive_fm_combination_gate(goal_s: float) -> str:
    goal_time = _format_goal_time(goal_s)
    hm_gate, ten_k_gate, hm_observe, ten_k_observe = _aggressive_fm_gate_thresholds(goal_s)
    b_band = _aggressive_fm_b_band(goal_s)
    return (
        f"A={goal_time}仅在HM<={hm_gate}或10K<={ten_k_gate}之一达标，且最大合法MP彩排"
        "(29-32km含22-24kmMP；29-30km仅限显式风险/历史/ramp上限)、"
        f"VO2/HR/RPE、跟腱反应全部通过时开放；HM<={hm_observe}或10K>={ten_k_observe}"
        f"只算观察/B；否则默认B={b_band}，C=破PB/稳健完赛。"
    )


def _compose_aggressive_fm_supporting_gate(goal_s: float) -> str:
    goal_time = _format_goal_time(goal_s)
    return f"A={goal_time}按比赛里程碑HM/10K+MP彩排+VO2/HR/RPE+跟腱组合门槛开放。"


def _normalise_aggressive_fm_gate_text(text: str) -> str:
    return (
        text.replace("≤", "<=")
        .replace("＜", "<")
        .replace("＝", "=")
        .replace("：", ":")
        .replace("　", "")
        .replace(" ", "")
    )


def _has_aggressive_fm_combo_gate(text: str, goal_s: float) -> bool:
    compact = _normalise_aggressive_fm_gate_text(text)
    goal_time = _format_goal_time(goal_s)
    hm_gate, ten_k_gate, _, _ = _aggressive_fm_gate_thresholds(goal_s)
    return all(
        token in compact
        for token in (
            f"A={goal_time}", f"HM<={hm_gate}", f"10K<={ten_k_gate}",
            "29-32km", "22-24kmMP", "MP", "VO2", "HR/RPE",
        )
    ) and ("跟腱" in text or "Achilles" in text)


def _is_aggressive_fm_gate_principle(text: str, goal_s: float) -> bool:
    compact = _normalise_aggressive_fm_gate_text(text)
    goal_time = _format_goal_time(goal_s)
    if goal_time not in compact or "A" not in compact:
        return False
    return any(token in compact for token in ("HM<=", "10K<=", "MP", "VO2", "HR/RPE")) or any(
        token in text for token in ("关口", "门槛", "闸门", "开放", "过关", "全过")
    )


def _aggressive_fm_principle_prefix(text: str, goal_s: float) -> str:
    stripped = text.strip().rstrip("。；; ")
    markers = ("；A", ";A", "，A", ",A", " A", "A需", "A=", "A可", "A目标", "A<", "A≤")
    positions = [pos for marker in markers if (pos := stripped.find(marker)) >= 0]
    if positions:
        return stripped[: min(positions)].rstrip("。；;，, ")
    if "PB" in stripped and _format_goal_time(goal_s) in stripped and not stripped.startswith("A"):
        return stripped
    return ""


def _compose_aggressive_fm_gate_principle(text: str, goal_s: float) -> str:
    prefix = _aggressive_fm_principle_prefix(text, goal_s)
    gate = _compose_aggressive_fm_combination_gate(goal_s)
    if prefix:
        return prefix + "；" + gate
    return gate


def _normalise_aggressive_fm_supporting_gate_target(target: str, goal_s: float) -> str | None:
    compact = _normalise_aggressive_fm_gate_text(target)
    if "A" not in compact or ("HM<=" not in compact and "10K<=" not in compact):
        return None
    if _has_aggressive_fm_combo_gate(target, goal_s):
        return None

    prefix = _aggressive_fm_principle_prefix(target, goal_s)
    supporting_gate = _compose_aggressive_fm_supporting_gate(goal_s)
    observation_parts = []
    for part in re.split(r"[；;。]+", target):
        part = part.strip()
        if not part:
            continue
        part_compact = _normalise_aggressive_fm_gate_text(part)
        if "A" in part_compact and ("HM<=" in part_compact or "10K<=" in part_compact):
            continue
        if "观察" in part or "B" in part_compact:
            observation_parts.append(part)
    if observation_parts:
        return "；".join(observation_parts + [supporting_gate])
    if prefix and ("观察" in prefix or "B" in prefix):
        return prefix + "；" + supporting_gate
    return supporting_gate


def _ensure_aggressive_fm_combination_gate(
    principles: list[str],
    milestones: list[Milestone],
    goal: dict,
    pb_seconds: dict | None,
) -> tuple[list[str], list[Milestone]]:
    """Make aggressive advanced FM A-gates explicit combination gates."""
    if not _is_aggressive_advanced_fm_goal(goal, pb_seconds):
        return principles, milestones
    goal_s = _goal_time_seconds(goal)
    if goal_s is None:
        return principles, milestones
    combination_gate = _compose_aggressive_fm_combination_gate(goal_s)

    updated_principles: list[str] = []
    gate_inserted = False
    for principle in principles:
        text = str(principle)
        if _is_aggressive_fm_gate_principle(text, goal_s):
            if not gate_inserted:
                updated_principles.append(_compose_aggressive_fm_gate_principle(text, goal_s))
                gate_inserted = True
            continue
        updated_principles.append(text)

    if not _has_aggressive_fm_combo_gate("\n".join(updated_principles), goal_s):
        if updated_principles:
            updated_principles[0] = (
                updated_principles[0].rstrip("。；; ")
                + "；"
                + combination_gate
            )
        else:
            updated_principles.append(combination_gate)

    updated_milestones: list[Milestone] = []
    for milestone in milestones:
        target = milestone.target or ""
        if milestone.type != MilestoneType.RACE:
            supporting_target = _normalise_aggressive_fm_supporting_gate_target(target, goal_s)
            if supporting_target:
                updated_milestones.append(
                    milestone.model_copy(update={"target": supporting_target})
                )
                continue
            updated_milestones.append(milestone)
            continue
        needs_combo = "A" in target and _format_goal_time(goal_s) in target and (
            not _has_aggressive_fm_combo_gate(target, goal_s)
            or "或" in target
            or "or" in target.lower()
        )
        if needs_combo:
            updated_milestones.append(
                milestone.model_copy(update={"target": combination_gate})
            )
            continue

        supporting_target = _normalise_aggressive_fm_supporting_gate_target(target, goal_s)
        if supporting_target:
            updated_milestones.append(
                milestone.model_copy(update={"target": supporting_target})
            )
            continue

        if not needs_combo:
            updated_milestones.append(milestone)
            continue

    return updated_principles, updated_milestones


_THREE_DAY_EXTRA_HARD_TYPES = {
    "threshold", "tempo", "interval", "vo2max", "hill", "tune_up_race", "time_trial",
}


def _weekly_run_days_max(goal: dict, profile: dict | None = None) -> int | None:
    for source in (profile, goal):
        if not isinstance(source, dict):
            continue
        for key in ("weekly_run_days_max", "weekly_training_days"):
            value = source.get(key)
            if isinstance(value, int):
                return value
    return None


def _week_has_mp_or_long_long_run(week: MasterPlanWeek) -> bool:
    for session in week.key_sessions:
        if session.type != "long_run":
            continue
        purpose = str(session.purpose or "").lower()
        if (session.distance_km or 0) >= 24:
            return True
        if any(marker in purpose for marker in ("mp", "马配", "目标配速")):
            return True
    return False


def _drop_three_day_stacked_hard_sessions(
    weeks: list[MasterPlanWeek],
    goal: dict,
    profile: dict | None = None,
) -> list[MasterPlanWeek]:
    """For 3-run plans, long/MP weeks cannot carry another hard workout."""
    max_days = _weekly_run_days_max(goal, profile)
    if max_days is None or max_days > 3:
        return weeks

    out: list[MasterPlanWeek] = []
    changed = False
    for week in weeks:
        if week.is_recovery_week or week.is_taper_week or not _week_has_mp_or_long_long_run(week):
            out.append(week)
            continue
        sessions = [
            session for session in week.key_sessions
            if session.type not in _THREE_DAY_EXTRA_HARD_TYPES
        ]
        if len(sessions) != len(week.key_sessions):
            logger.info(
                "dropping stacked hard sessions from 3-run MP/long-run week %s",
                week.week_index,
            )
            out.append(week.model_copy(update={"key_sessions": sessions}))
            changed = True
        else:
            out.append(week)
    return out if changed else weeks


def _ensure_pushback_multi_cycle_path(principles: list[Any]) -> list[str]:
    """Add the expected multi-cycle path when a 100km pushback is present."""
    rendered = [str(item) for item in (principles or [])]
    joined = "\n".join(rendered)
    compact = joined.replace(" ", "")
    has_pushback = "100km" in compact and "55km" in compact
    has_path = all(token in compact for token in ("下周期80", "再后周期90"))
    if not has_pushback or has_path or not rendered:
        return rendered

    rendered[0] = (
        rendered[0].rstrip("。；; ")
        + "；本周期60-70km，下周期80km，再后周期90+km，100km需更长期适应。"
    )
    return rendered


# ---------------------------------------------------------------------------
# History / fitness helpers
# ---------------------------------------------------------------------------


# Monday-of-week for a ``YYYY-MM-DD`` date expression ``D``. ``%w`` is
# 0=Sun..6=Sat; ``(%w+6)%7`` = days elapsed since Monday, so subtracting that
# many days snaps any date back to its ISO-week Monday. Year-boundary safe
# because SQLite's ``date(..., '-N days')`` does real calendar arithmetic.
# ``date_expr`` is interpolated twice, so callers MUST pass a deterministic,
# side-effect-free expression (a column or a pure transform of one) — never
# anything containing ``random()`` / ``now`` without an explicit anchor.
def _monday_expr(date_expr: str) -> str:
    return f"date({date_expr}, '-' || ((strftime('%w', {date_expr}) + 6) % 7) || ' days')"


# Per-run km from canonical metre storage.
_PER_RUN_KM = "distance_m / 1000.0"

# train_kind values that are unambiguously hard/speed work. ``base`` (= easy)
# and ``aerobic`` are deliberately excluded. NULL train_kind falls through to
# the pace heuristic in _query_weekly_profile.
_SPEED_TRAIN_KINDS = ("interval", "threshold", "vo2max", "anaerobic")

# Coarse name-keyword race heuristic (see _query_weekly_profile docstring).
# Keywords overlap by design (``%赛%`` ⊃ ``%比赛%``); n_race is COUNT-per-row so
# the overlap is harmless, but ``%赛%`` is broad and will also match names like
# "备赛长距" — n_race is a soft signal, not an authoritative race flag.
_RACE_NAME_KEYWORDS = ("%马拉松%", "%marathon%", "%比赛%", "%race%", "%赛%")


def _query_weekly_profile(
    db: Any,
    *,
    weeks: int = 16,
    threshold_speed_mps: float | None = None,
    as_of: date_cls | None = None,
) -> list[dict[str, Any]]:
    """Build a per-Shanghai-week athlete profile, oldest → newest.

    Merges four heterogeneously-dated source tables on a common Monday-of-week
    key (``week_start``), then returns the ``weeks`` most-recent buckets.

    The four sources store ``date`` differently and MUST be normalised to the
    same Shanghai calendar week before bucketing:
      * ``activities.date``      — UTC ISO 8601; shift +8h first, then Monday.
      * ``daily_training_load``  — already Shanghai ``YYYY-MM-DD``; Monday direct.
      * ``daily_health.date``    — Shanghai compact ``YYYYMMDD``; reformat first.
      * ``daily_hrv.date``       — Shanghai ``YYYY-MM-DD``; Monday direct.

    EWMA states (ctl/atl/form) are END-OF-WEEK SNAPSHOTS (value on the latest
    daily_training_load date in the week) — they are NOT summable. ``dose`` IS
    per-day additive, so it's summed.

    Race detection is a COARSE name-keyword heuristic (matches 马拉松/marathon/
    比赛/race/赛 in ``activities.name``) — NOT an authoritative race flag, which
    the schema lacks. It will over-count (e.g. a "race-pace" workout named so)
    and under-count unnamed races; treat ``n_race`` as a soft signal only.
    """
    from stride_core.models import RUN_SPORT_SQL_LIST

    conn = db._conn
    buckets: dict[str, dict[str, Any]] = {}

    def _bucket(week_start: str) -> dict[str, Any]:
        b = buckets.get(week_start)
        if b is None:
            b = {
                "week_start": week_start,
                "distance_km": 0.0,
                "hours": 0.0,
                "avg_pace_s_km": None,
                "avg_hr": None,
                "ctl": None,
                "atl": None,
                "training_load_ratio": None,
                "form": None,
                "dose": 0.0,
                "dose_coverage_status": None,
                "rhr": None,
                "hrv": None,
                "n_runs": 0,
                "n_long": 0,
                "n_speed": 0,
                "n_race": 0,
            }
            buckets[week_start] = b
        return b

    # --- activities: distance / time / pace / hr / run counts ---------------
    act_monday = _monday_expr("datetime(date, '+8 hours')")
    speed_in = ", ".join(f"'{k}'" for k in _SPEED_TRAIN_KINDS)
    race_like = " OR ".join(f"name LIKE '{kw}'" for kw in _RACE_NAME_KEYWORDS)
    # pace fallback bound: a run whose true avg speed >= threshold is "hard".
    # avg speed = total_km*1000 / total_s; compare to threshold_speed_mps.
    pace_speed_clause = "0"
    if threshold_speed_mps is not None and threshold_speed_mps > 0:
        pace_speed_clause = (
            f"(duration_s > 0 AND ({_PER_RUN_KM}) * 1000.0 / duration_s >= {threshold_speed_mps})"
        )
    as_of = as_of or today_shanghai()
    rows = conn.execute(
        f"""
        SELECT {act_monday} AS wk,
               SUM({_PER_RUN_KM}) AS km,
               SUM(COALESCE(duration_s, 0)) AS dur_s,
               SUM(CASE WHEN avg_hr IS NOT NULL
                        THEN avg_hr * COALESCE(duration_s, 0) ELSE 0 END) AS hr_wsum,
               SUM(CASE WHEN avg_hr IS NOT NULL
                        THEN COALESCE(duration_s, 0) ELSE 0 END) AS hr_wden,
               COUNT(*) AS n_runs,
               SUM(CASE WHEN ({_PER_RUN_KM}) >= 20 THEN 1 ELSE 0 END) AS n_long,
               SUM(CASE WHEN train_kind IN ({speed_in})
                          OR (train_kind IS NULL AND {pace_speed_clause})
                        THEN 1 ELSE 0 END) AS n_speed,
               SUM(CASE WHEN {race_like} THEN 1 ELSE 0 END) AS n_race
        FROM activities
        WHERE sport_type IN ({RUN_SPORT_SQL_LIST})
          AND date(datetime(date, '+8 hours')) <= ?
        GROUP BY wk
        """,
        (as_of.isoformat(),),
    ).fetchall()
    for r in rows:
        wk = r[0]
        if wk is None:
            continue
        b = _bucket(wk)
        km = r[1] or 0.0
        dur_s = r[2] or 0.0
        b["distance_km"] = km
        b["hours"] = dur_s / 3600.0
        b["avg_pace_s_km"] = (dur_s / km) if km else None
        b["avg_hr"] = (r[3] / r[4]) if r[4] else None
        b["n_runs"] = r[5] or 0
        b["n_long"] = r[6] or 0
        b["n_speed"] = r[7] or 0
        b["n_race"] = r[8] or 0

    # --- daily_training_load: dose (sum) + ctl/atl/form (end-of-week) --------
    # NOTE: column order here is chronic_load (CTL) FIRST, intentionally NOT
    # matching _query_fitness_state which selects acute_load first. The explicit
    # r[3]=chronic→ctl / r[4]=acute→atl mapping below is the anchor; don't copy
    # the column list from the other function or the two will silently swap.
    rows = db.fetch_daily_training_load_weekly_source(as_of=as_of.isoformat())
    dose_acc: dict[str, float] = {}
    dose_known_weeks: set[str] = set()
    dose_incomplete_weeks: set[str] = set()
    for r in rows:
        wk = date_cls.fromisoformat(r["date"]).strftime("%Y-%m-%d")
        wk = (date_cls.fromisoformat(wk) - timedelta(days=date_cls.fromisoformat(wk).weekday())).isoformat()
        if wk is None:
            continue
        b = _bucket(wk)
        coverage_status = r["coverage_status"]
        if coverage_status in {"complete", "partial", "rest_confirmed"}:
            dose_acc[wk] = dose_acc.get(wk, 0.0) + (r["training_dose"] or 0.0)
            dose_known_weeks.add(wk)
        if coverage_status in {"partial", "unknown"}:
            dose_incomplete_weeks.add(wk)
        # rows ascend by date, so the last write per week is the latest day.
        b["ctl"] = r["chronic_load"]
        b["atl"] = r["acute_load"]
        b["training_load_ratio"] = (r["acute_load"] / r["chronic_load"]) if r["chronic_load"] else None
        b["form"] = r["form"]
    for wk, total in dose_acc.items():
        buckets[wk]["dose"] = total
    for wk in dose_known_weeks:
        buckets[wk]["dose_coverage_status"] = (
            "partial" if wk in dose_incomplete_weeks else "complete"
        )
    for wk in dose_incomplete_weeks - dose_known_weeks:
        buckets[wk]["dose_coverage_status"] = "unknown"
        # These weeks have no confirmed dose days; reset the 0.0 initializer so
        # the value is explicitly absent rather than appearing as a confirmed zero.
        buckets[wk]["dose"] = None

    # --- daily_health: rhr (avg) --------------------------------------------
    health_norm = sqlite_mixed_date_expr("date")
    health_monday = _monday_expr(health_norm)
    rows = conn.execute(
        f"""
        SELECT {health_monday} AS wk, AVG(rhr) AS rhr
        FROM daily_health
        WHERE rhr IS NOT NULL
          AND {health_norm} <= ?
        GROUP BY wk
        """,
        (as_of.isoformat(),),
    ).fetchall()
    for r in rows:
        wk = r[0]
        if wk is None:
            continue
        _bucket(wk)["rhr"] = r[1]

    # --- daily_hrv: last_night_avg (avg) ------------------------------------
    hrv_norm = sqlite_mixed_date_expr("date")
    hrv_monday = _monday_expr(hrv_norm)
    rows = conn.execute(
        f"""
        SELECT {hrv_monday} AS wk, AVG(last_night_avg) AS hrv
        FROM daily_hrv
        WHERE last_night_avg IS NOT NULL
          AND {hrv_norm} <= ?
        GROUP BY wk
        """,
        (as_of.isoformat(),),
    ).fetchall()
    for r in rows:
        wk = r[0]
        if wk is None:
            continue
        _bucket(wk)["hrv"] = r[1]

    # Most-recent ``weeks`` buckets, returned oldest → newest.
    ordered = sorted(buckets.values(), key=lambda b: b["week_start"])
    return ordered[-weeks:]


def _query_history(user_id: str, *, as_of: date_cls | None = None) -> dict[str, Any]:
    """Query activities DB for a 3-year training history summary.

    Returns a dict with keys: monthly_km, max_weekly_km, total_activities,
    and weekly_profile. PB loading happens in load_master_context via
    load_personal_bests so training-history and race-time anchors stay separate.

    All failures are silently absorbed — returns zeros / empty lists rather
    than blocking the generation flow.
    """
    result: dict[str, Any] = {
        "monthly_km": [],
        "max_weekly_km": 0.0,
        "total_activities": 0,
        "weekly_profile": [],
    }
    try:
        from stride_storage.sqlite.database import Database
        from stride_core.models import RUN_SPORT_SQL_LIST

        db = Database(user=user_id)
        conn = db._conn

        # Running activities are matched against the canonical RUN_SPORT_IDS set
        # (COROS 100-104/600-601 + Garmin-synced 8001-8005), NOT a literal
        # ``sport_type = 1`` — ``1`` is not a stored running code, so the old
        # filter silently matched zero rows (especially for Garmin-synced
        # users). RUN_SPORT_SQL_LIST is the same single-source fragment
        # ability.py uses; keep them in sync.

        as_of = as_of or today_shanghai()

        # Monthly running km (last 36 months). Activity distances are stored in
        # metres and converted to kilometres here.
        _KM_EXPR = "SUM(distance_m) / 1000.0"
        _HR_EXPR = "SUM(COALESCE(duration_s, 0)) / 3600.0"
        # Bucket by Shanghai calendar (UTC+8), per the Timezone discipline HARD
        # rule: a run finishing 23:30 UTC on the 31st is 07:30 CST the next day
        # and must land in the next month/week, not the UTC one.
        _SH_MONTH = "strftime('%Y-%m', datetime(date, '+8 hours'))"
        _SH_WEEK = "strftime('%Y-%W', datetime(date, '+8 hours'))"
        rows = conn.execute(
            f"""
            SELECT {_SH_MONTH} AS month,
                   {_KM_EXPR} AS km,
                   {_HR_EXPR} AS hours
            FROM activities
            WHERE sport_type IN ({RUN_SPORT_SQL_LIST})
              AND date(datetime(date, '+8 hours')) >= date(?, '-36 months')
              AND date(datetime(date, '+8 hours')) <= ?
            GROUP BY month
            ORDER BY month
            """,
            (as_of.isoformat(), as_of.isoformat()),
        ).fetchall()
        result["monthly_km"] = [
            {"month": r[0], "km": round(r[1], 1), "hours": round(r[2] or 0.0, 1)}
            for r in rows
        ]

        # Max single-week km (approximate: 7-day Shanghai-week windows)
        row = conn.execute(
            f"""
            SELECT MAX(week_km)
            FROM (
                SELECT {_SH_WEEK} AS wk,
                       {_KM_EXPR} AS week_km
                FROM activities
                WHERE sport_type IN ({RUN_SPORT_SQL_LIST})
                  AND date(datetime(date, '+8 hours')) >= date(?, '-36 months')
                  AND date(datetime(date, '+8 hours')) <= ?
                GROUP BY wk
            )
            """,
            (as_of.isoformat(), as_of.isoformat()),
        ).fetchone()
        result["max_weekly_km"] = round(row[0] or 0.0, 1)

        # Total running activities
        row = conn.execute(
            f"""
            SELECT COUNT(*) FROM activities
            WHERE sport_type IN ({RUN_SPORT_SQL_LIST})
              AND date(datetime(date, '+8 hours')) <= ?
            """,
            (as_of.isoformat(),),
        ).fetchone()
        result["total_activities"] = row[0] or 0

        # 16-week weekly athlete profile. The threshold speed (for the NULL-
        # train_kind pace fallback in speed classification) is read from the
        # canonical running-calibration reader — never inline-computed (repo
        # HARD rule). If it's unavailable, the fallback is simply disabled.
        try:
            from stride_storage.sqlite.calibration_connector import (
                SQLiteRunningCalibrationRepository,
            )
            threshold_speed_mps: float | None = None
            try:
                snap = SQLiteRunningCalibrationRepository(db).fetch_latest(as_of)
                if snap is not None:
                    threshold_speed_mps = snap.threshold_speed_mps
                    result["threshold_speed_mps"] = threshold_speed_mps
            except Exception:  # noqa: BLE001 — calibration read must not block
                logger.warning(
                    "_query_history: threshold_speed read failed for %s", user_id, exc_info=True
                )
            result["weekly_profile"] = _query_weekly_profile(
                db, weeks=16, threshold_speed_mps=threshold_speed_mps, as_of=as_of
            )
        except Exception:  # noqa: BLE001 — weekly profile must not block gen
            logger.warning(
                "_query_history: weekly_profile build failed for %s", user_id, exc_info=True
            )

    except Exception as exc:  # noqa: BLE001
        logger.warning("_query_history failed for user %s: %s", user_id, exc)

    return result


def _ensure_training_load_current(db, as_of=None) -> None:
    """Ensure daily_training_load reaches ``as_of`` — computing INCREMENTALLY.

    daily_training_load (and the calibration snapshot) are maintained at sync
    time by the post-sync TrainingLoadHandler, so on the common path (DB freshly
    synced before a generation) the table already reaches ``as_of`` and we skip
    the recompute entirely — just read the latest row. This is the fix for a
    ~47s stall: the old code re-derived the full 365-day PMC on every generation,
    and the dominant cost was the threshold calibration recompute (~35s over
    180-365 days of activities), even though nothing had changed since the sync.

    When the table IS stale (e.g. synced yesterday, generating today) we extend
    only the missing CTL/ATL tail and **reuse the persisted calibration** rather
    than refitting it. The athlete calibration (threshold_hr/speed, hrmax, rhr)
    is a slow-moving baseline already computed at sync time + a weekly job and
    persisted in ``running_calibration_snapshot``; refitting it over 180 days was
    the ~35s cost that dominated this call even though the snapshot was already
    current. ``recompute_training_load`` reads the latest persisted snapshot via
    ``_fetch_latest_calibration`` when no ``calibration_override`` is passed, then
    extends just the gap (CTL/ATL are EWMAs seeded from the last persisted row),
    dropping a stale-by-a-day generation from ~40s to ~1s. The full 365-day
    warmup + calibration refit is reserved for a cold start (empty table), where
    no snapshot may exist yet and the chronic EWMA needs ~3x42 days to converge.
    """
    from datetime import date as _date, timedelta as _timedelta

    from stride_core.timefmt import today_shanghai, utc_iso_to_shanghai_iso
    from stride_core.training_load import (
        TRAINING_LOAD_MODEL_VERSION,
        backfill_training_load,
        recompute_training_load,
    )

    as_of = as_of or today_shanghai()
    if not db.is_training_load_backfill_complete(TRAINING_LOAD_MODEL_VERSION):
        # Existing canonical rows stay readable while an algorithm upgrade is
        # pending, but they do not prove that the full warmup window completed.
        # Rebuild once from a zero prior; backfill_training_load writes the
        # independent completion marker only after a successful 365-day pass.
        backfill_training_load(
            db,
            as_of_date=as_of,
            load_lookback_days=365,
            calibration_lookback_days=365,
            persist=True,
        )
        return

    # Chronic load is a 42-day EWMA; it needs ~3x its time-constant of warmup
    # before it converges. A table seeded by post-sync (only the recent synced
    # window) can REACH as_of yet still be only a few weeks deep — its chronic
    # EWMA is cold-started from zero and reads far below steady state (e.g.
    # CTL 21 for an athlete actually training ~65 km/wk). That understated CTL
    # then mis-frames the athlete as detrained/overreached in the plan prompt
    # and breaks the dose≈CTL×7 heuristic. So before trusting a "current" table,
    # check its depth and force a full backfill when it is too shallow.
    _CHRONIC_WARMUP_DAYS = 126  # 3 x the 42-day chronic EWMA time-constant
    try:
        earliest, last = db.fetch_training_load_bounds()

        # Shallow-table guard: if the earliest persisted row is younger than the
        # chronic warmup window AND older activity history exists to warm up on,
        # the chronic EWMA has not converged — refit the full 365-day window.
        # (When no older activities exist the athlete genuinely has a short
        # history; a backfill can't deepen it, so fall through and avoid an
        # expensive no-op refit on every generation.)
        if last:
            if earliest is not None:
                # Measure the actual persisted span (earliest..last), not
                # earliest..as_of — a shallow *and* stale table would otherwise
                # over-report its depth. daily_training_load.date is Shanghai-local.
                coverage_days = (
                    _date.fromisoformat(last[:10]) - _date.fromisoformat(earliest[:10])
                ).days
                if coverage_days < _CHRONIC_WARMUP_DAYS:
                    act_row = db._conn.execute(
                        "SELECT MIN(date) FROM activities"
                    ).fetchone()
                    # activities.date is stored UTC ISO; daily_training_load.date
                    # is Shanghai-local. Convert before comparing so the
                    # "older history exists" test is timezone-consistent
                    # (CLAUDE.md timezone discipline) — a raw UTC slice could be
                    # one calendar day off and spuriously fire the backfill.
                    act_min = (
                        utc_iso_to_shanghai_iso(act_row[0])[:10]
                        if act_row and act_row[0] else None
                    )
                    if act_min is not None and act_min < earliest[:10]:
                        logger.info(
                            "_ensure_training_load_current: daily_training_load only "
                            "%d days deep (< %d warmup); older activities exist from %s "
                            "— forcing full 365-day backfill so chronic load converges",
                            coverage_days, _CHRONIC_WARMUP_DAYS, act_min,
                        )
                        backfill_training_load(
                            db, as_of_date=as_of,
                            load_lookback_days=365,
                            calibration_lookback_days=365, persist=True,
                        )
                        return

        if last and last >= as_of.isoformat():
            return  # already current — the post-sync handler computed it

        if last:
            # Incremental EWMA-only tail: recompute from a small buffer before
            # the last persisted day (prior_state seeds the EWMA from the row
            # before the window). No calibration_override → recompute reads the
            # already-current persisted snapshot instead of the ~35s 180-day
            # refit.
            gap_days = (as_of - _date.fromisoformat(last)).days
            load_start = as_of - _timedelta(days=max(1, gap_days) + 2)
            recompute_training_load(db, start=load_start, end=as_of, persist=True)
        else:
            # Cold start (no persisted rows) — full warmup for EWMA convergence
            # plus a calibration refit, since no snapshot may exist yet.
            backfill_training_load(db, as_of_date=as_of,
                                   load_lookback_days=365,
                                   calibration_lookback_days=365, persist=True)
    except Exception as exc:  # noqa: BLE001 — context load must never hard-fail
        logger.warning("_ensure_training_load_current failed: %s", exc)


def _query_fitness_state(user_id: str, *, as_of: date_cls | None = None) -> dict[str, Any]:
    """Query STRIDE daily_training_load for the most recent fitness snapshot.

    Returns the latest CTL/ATL/form from the canonical STRIDE PMC table (not
    the COROS vendor ati/cti fields which use a different scale). RHR is still
    read from daily_health as a raw measurement.
    """
    result: dict[str, Any] = {
        "ctl": None,
        "atl": None,
        "tsb": None,
        "rhr": None,
        "hrv": None,
        "hrv_date": None,
        "summary": "体能数据暂无",
    }
    try:
        from stride_storage.sqlite.database import Database
        db = Database(user=user_id)
        conn = db._conn
        as_of = as_of or today_shanghai()

        # daily_training_load is maintained at sync time by the post-sync
        # TrainingLoadHandler, so this call is now a cheap freshness check
        # (~0.01s) on the common path — it returns immediately when the table
        # already reaches today, and only computes the missing tail incrementally
        # (seeded from the last persisted EWMA) when the DB is stale. It is NOT
        # the old ~47s full 365-day recompute. Kept as a safety net so a
        # generation against an un-synced DB still gets a current fitness state.
        _ensure_training_load_current(db, as_of=as_of)

        row = db.fetch_latest_daily_training_load(as_of=as_of.isoformat())
        # RHR for the fitness context: prefer the calibration baseline (smoothed
        # P10/25 over 30-90d — the CLAUDE.md single source) over a single noisy
        # last reading; fall back to the latest measured value when there is no
        # calibration snapshot yet.
        from stride_storage.sqlite.calibration_connector import (
            SQLiteRunningCalibrationRepository,
        )
        _calib = SQLiteRunningCalibrationRepository(db).fetch_latest(as_of)
        rhr = _calib.rhr_baseline if _calib and _calib.rhr_baseline is not None else None
        if rhr is None:
            rhr_row = conn.execute(
                "SELECT rhr FROM daily_health WHERE rhr IS NOT NULL "
                "AND (substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2)) <= ? "
                "ORDER BY date DESC LIMIT 1",
                (as_of.isoformat(),),
            ).fetchone()
            rhr = rhr_row[0] if rhr_row else None

        from stride_storage.sqlite.database import HRV_PREFERRED_PER_DATE_SQL

        hrv_row = conn.execute(
            f"SELECT date, last_night_avg FROM ({HRV_PREFERRED_PER_DATE_SQL}) "
            "WHERE last_night_avg IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 1",
            (as_of.isoformat(),),
        ).fetchone()
        hrv_date = hrv_row[0] if hrv_row else None
        hrv = hrv_row[1] if hrv_row else None

        if row:
            atl = row["acute_load"]
            ctl = row["chronic_load"]
            form = row["form"]
            ratio = round(atl / ctl, 2) if ctl else None
            result.update({
                "ctl": round(ctl, 1) if ctl is not None else None,
                "atl": round(atl, 1) if atl is not None else None,
                "tsb": round(form, 1) if form is not None else None,
                "rhr": rhr,
                "hrv": round(hrv, 1) if hrv is not None else None,
                "hrv_date": hrv_date,
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
            if hrv is not None:
                parts.append(f"HRV {hrv:.0f}ms")
            result["summary"] = "，".join(parts) if parts else "体能数据暂无"

    except Exception as exc:  # noqa: BLE001
        logger.warning("_query_fitness_state failed for user %s: %s", user_id, exc)

    return result


# ---------------------------------------------------------------------------
# History summary formatter
# ---------------------------------------------------------------------------


def _format_weekly_profile(profile: list[dict[str, Any]]) -> list[str]:
    """Render the 16-week weekly profile as compact one-line rows.

    One row per week (oldest → newest). Missing metrics render as ``n/a`` rather
    than being silently dropped, so the model can tell "no data that week" apart
    from a genuine low value. A trailing totals line follows the rows.
    """
    if not profile:
        return ["16-week weekly profile: no recent weekly data"]

    NA = "n/a"

    def pace(s: float | None) -> str:
        # None = no distance that week; <= 0 is physically impossible — both n/a.
        if s is None or s <= 0:
            return NA
        m, sec = divmod(int(round(s)), 60)
        return f"{m}:{sec:02d}/km"

    def num(v: float | None, fmt: str) -> str:
        return format(v, fmt) if v is not None else NA

    def iso_week(week_start: str) -> str:
        try:
            d = datetime.strptime(week_start, "%Y-%m-%d").date()
            iy, iw, _ = d.isocalendar()
            return f"{iy}-W{iw:02d}"
        except (ValueError, TypeError):
            return week_start

    lines: list[str] = [
        "16-week weekly profile (most recent last; n/a=no data):",
        "W|km|h|pace|HR|CTL/ATL|ratio|form|dose|RHR/HRV|runs/L/S/R",
    ]
    for w in profile:
        dose_text = num(w.get('dose'), '.0f')
        if w.get("dose_coverage_status") == "partial":
            dose_text += "(partial)"
        lines.append(
            f"{iso_week(w['week_start'])}|"
            f"{num(w.get('distance_km'), '.1f')}|"
            f"{num(w.get('hours'), '.1f')}|"
            f"{pace(w.get('avg_pace_s_km'))}|"
            f"{num(w.get('avg_hr'), '.0f')}|"
            f"{num(w.get('ctl'), '.0f')}/{num(w.get('atl'), '.0f')}|"
            f"{num(w.get('training_load_ratio'), '.2f')}|"
            f"{num(w.get('form'), '+.0f')}|"
            f"{dose_text}|"
            f"{num(w.get('rhr'), '.0f')}/{num(w.get('hrv'), '.0f')}|"
            f"{w.get('n_runs', 0)}/{w.get('n_long', 0)}/"
            f"{w.get('n_speed', 0)}/{w.get('n_race', 0)}"
        )

    active = [w for w in profile if w.get("n_runs", 0) > 0]
    n_total = sum(w.get("n_runs", 0) for w in profile)
    long_total = sum(w.get("n_long", 0) for w in profile)
    speed_total = sum(w.get("n_speed", 0) for w in profile)
    race_total = sum(w.get("n_race", 0) for w in profile)
    avg_runs = (n_total / len(active)) if active else 0.0
    lines.append(
        f"Totals ({len(profile)}wk): {n_total} runs, {long_total} long, "
        f"{speed_total} speed, {race_total} race, "
        f"{avg_runs:.1f} runs/active-week"
    )
    return lines


def _format_history_summary(history: dict[str, Any]) -> str:
    """Convert raw history dict into a readable (English) summary for the prompt.

    Volume is now reported as a 16-week weekly athlete profile (distance/time/
    pace/HR/CTL-ATL-load-ratio-form/dose/RHR/HRV + run-type counts per week),
    replacing the former monthly-volume block. Total / max-week / real-PB
    anchor lines are kept.
    """
    lines: list[str] = []

    total = history.get("total_activities", 0)
    max_wk = history.get("max_weekly_km", 0)

    lines.append(f"Running activities (history total): {total}")
    lines.append(f"Max single-week distance (history): {max_wk} km")

    lines.extend(_format_weekly_profile(history.get("weekly_profile", [])))
    try:
        from stride_server.coach_adapters.master_plan_load import (
            build_training_history_load_anchor,
            format_training_load_anchor_for_prompt,
        )

        lines.append(format_training_load_anchor_for_prompt(
            build_training_history_load_anchor(history)
        ))
    except Exception:  # noqa: BLE001 — history formatting must not block prompts
        logger.warning("_format_history_summary: load anchor formatting failed", exc_info=True)

    def fmt_time(sec: int | None) -> str:
        if sec is None:
            return "n/a"
        h, rem = divmod(sec, 3600)
        m2, s = divmod(rem, 60)
        return f"{h}:{m2:02d}:{s:02d}" if h else f"{m2}:{s:02d}"

    lines.append(
        f"Actual personal bests (PB — really run in history; anchor milestones "
        f"to this line) — 5K: {fmt_time(history.get('best_5k_s'))}  "
        f"10K: {fmt_time(history.get('best_10k_s'))}  "
        f"HM: {fmt_time(history.get('best_hm_s'))}  "
        f"FM: {fmt_time(history.get('best_fm_s'))}"
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


def build_master_prompts(
    goal: dict,
    profile: dict | None,
    history_summary: str,
    fitness_state: dict[str, Any],
    today: str,
    continuity: "ContinuitySignals | None" = None,
    body_composition: dict[str, Any] | None = None,
    body_composition_summary: str | None = None,
    previous_master_plan_md: str | None = None,
    current_phase: "CurrentPhaseContext | None" = None,
    athlete_memories: "list | None" = None,
    training_load_tool_summary: str | None = None,
) -> tuple[str, str]:
    """Build the ``(system_prompt, user_prompt)`` pair for S1 generation.

    Prompt role discipline (see CLAUDE.md "Prompt role discipline"):

    * **system** — the invariant doctrine: coach persona, output-language rule,
      the output JSON schema, and all the HARD rules. It carries **no**
      per-athlete or per-call value, so it is byte-identical across every user
      and every call — a stable prompt-cache prefix.
    * **user** — *this turn's* task + input data: the athlete's goal / profile /
      history / fitness, the computed ``plan_start`` & ``race_date``, the
      conditional current-phase / continuity / macro / body-composition context
      blocks, and the final "generate the plan" instruction.

    Keeping the per-athlete data in the user turn is what lets the large static
    doctrine cache-hit across generations; it also matches the plain semantics
    of the two roles (system = who you are + the rules; user = the request).
    """
    # Normalise prod-route field names before serialising into the prompt.
    # Without this, prod payloads carry ``target_finish_time`` / ``pbs`` and
    # the goal-realism HARD pushback rule (which references ``goal_time_s`` /
    # ``profile.prs``) silently no-ops in production.
    goal, profile = _normalize_for_prompt(goal, profile)

    prompt_today = goal.get("as_of_date") or today

    goal_json = json.dumps(goal, ensure_ascii=False, separators=(",", ":"))
    profile_json = (
        json.dumps(profile, ensure_ascii=False, separators=(",", ":"))
        if profile
        else "未填写"
    )

    fitness_summary = fitness_state.get("summary", "体能数据暂无")
    race_date = goal.get("race_date") or "未指定"

    # Natural-week alignment: anchor the plan start to the UPCOMING Monday so
    # every phase/week is a clean Mon→Sun block (today if today is a Monday).
    # Offline S1 eval fixtures may freeze an explicit season_start; use that
    # as the anchor so replay does not drift with the wall clock.
    from datetime import date as _date_cls, timedelta as _timedelta
    plan_start_anchor = goal.get("season_start") or prompt_today
    try:
        _t = _date_cls.fromisoformat(str(plan_start_anchor))
        plan_start = (_t + _timedelta(days=(7 - _t.weekday()) % 7)).isoformat()
    except (ValueError, TypeError):
        plan_start = prompt_today

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
    explicit_season_start = bool(goal.get("season_start"))
    if current_phase is not None and current_phase.recommended_entry_phase is not None:
        cp = current_phase
        cur = cp.current_phase_type.value if cp.current_phase_type else "unknown"
        entry = cp.recommended_entry_phase.value
        wip = f"~{cp.weeks_in_phase} weeks" if cp.weeks_in_phase is not None else "unknown"
        src = {"existing_plan": "read prior training plan",
               "inferred": "inferred from recent activity records"}.get(cp.source, cp.source)
        current_phase_fragment = (
            "shared/blocks/current_phase_no_lead_in.md"
            if explicit_season_start
            else "shared/blocks/current_phase.md"
        )
        current_phase_block = "\n" + render_fragment(current_phase_fragment, {
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

    previous_plan_block = ""
    previous_plan_text = previous_master_plan_md or (profile or {}).get("prev_master_plan_md")
    if previous_plan_text:
        previous_plan_block = (
            "\nPrevious master plan context (evidence only; do not emit completed "
            "phases unless an explicit Current cycle position block authorizes them):\n"
            f"{previous_plan_text}\n\n"
            "Continuity extraction requirement: cite the prior peak weekly km, "
            "prior long-run range (for example 32-34km), completed recovery status, "
            "and prior-cycle reflection in `training_principles[0..2]`, phase focus, "
            "or milestone target text. Apply those facts to current volume and MP work.\n"
        )

    # Prompt content lives in the markdown skill src/coach/skills/master_plan_planner/
    # (SKILL.md + shared/ + references/), loaded + rendered here.
    #
    # SKILL.md is the *system* prompt: persona + output schema + HARD rules,
    # with no runtime placeholders — rendered with an empty context it is a
    # stable, cacheable prefix. user_prompt.md is the *user* turn: every
    # per-athlete / per-call value computed above is injected there.
    # Known athlete facts from long-term memory (A4) — soft constraints so future
    # plans auto-adapt (e.g. relocation to altitude). Injected in the *user* turn.
    known_constraints_block = ""
    active_mems = [m for m in (athlete_memories or []) if getattr(m, "status", "active") == "active"]
    if active_mems:
        mem_lines = "\n".join(
            f"- [{m.kind}] {m.content}"
            + (f"（影响：{', '.join(m.affects)}）" if getattr(m, "affects", None) else "")
            for m in active_mems
        )
        known_constraints_block = "\n" + render_fragment(
            "shared/blocks/known_constraints.md", {"memories": mem_lines}
        ) + "\n"

    from coach.skills import render_fragment, render_skill
    system_prompt = render_skill("master_plan_planner", {})
    user_prompt = render_fragment("master_plan_planner/user_prompt.md", {
        "today": prompt_today,
        "plan_start": plan_start,
        "race_date": race_date,
        "goal_json": goal_json,
        "profile_json": profile_json,
        "history_summary": history_summary,
        "training_load_tool_summary": training_load_tool_summary or "Training-load estimator tool: not available.",
        "fitness_summary": fitness_summary,
        "current_phase_block": current_phase_block,
        "continuity_block": continuity_block,
        "known_constraints_block": known_constraints_block,
        "macro_block": macro_block,
        "body_comp_block": body_comp_block,
        "previous_plan_block": previous_plan_block,
    })
    return system_prompt, user_prompt


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
        #   "load_estimation_failed: ..." — deterministic weekly dose failed
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
        if msg.startswith("load_estimation_failed"):
            logger.warning("job=%s weekly load projection failed: %s", job_id, exc)
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

    # Q2a: cache deterministic "actual results" summaries on completed phases.
    # Done here (generation time) so GET is a pure read — never recompute on
    # read. Aggregation touches coros.db so it lives in the adapter layer.
    plan = _inject_completed_phase_summaries(plan, user_id)

    store = get_master_plan_store()
    store.save_plan(plan)
    logger.info("job=%s plan saved plan_id=%s", job_id, plan.plan_id)

    update_job(
        job_id,
        status=JobStatus.DONE,
        result_plan_id=plan.plan_id,
        progress=100,
    )
