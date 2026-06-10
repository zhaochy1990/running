"""MasterPlan Pydantic models — long-term training plan (C module, M3).

A MasterPlan spans weeks-to-months and is the backbone for single-week plan
generation. It is composed of Phases (periodisation blocks) and Milestones
(key target events), authored by the LLM and confirmed by the user via a chat
review flow (C5).

Design notes:
- Pydantic v2 BaseModel (same dependency already used by plan_diff.py).
- All date fields are ISO YYYY-MM-DD strings — no datetime objects to keep
  serialisation trivial and match the rest of stride_core conventions.
- ``version`` starts at 1 and is bumped on every adjust operation; a full
  snapshot is stored as ``MasterPlanVersion.snapshot_json`` so the history
  tab (C8) can render diff comparisons without re-running the diff algorithm.
"""

from __future__ import annotations

from datetime import date as date_cls, timedelta
from enum import Enum
from typing import Any

from pydantic import AliasChoices, BaseModel, Field, ConfigDict, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class MasterPlanStatus(str, Enum):
    DRAFT    = "draft"     # 生成中 / review 中，未确认
    ACTIVE   = "active"    # 用户已确认，作为单周生成基础
    ARCHIVED = "archived"  # 被新版本替代


class TargetDistance(str, Enum):
    FIVE_K = "5K"
    TEN_K  = "10K"
    HM     = "HM"
    FM     = "FM"


class MilestoneType(str, Enum):
    RACE          = "race"
    TEST_RUN      = "test_run"
    LONG_RUN      = "long_run"
    STRENGTH_TEST = "strength_test"


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------


def _normalise_target_distance(value: Any) -> str:
    raw = str(value or "FM").strip()
    low = raw.lower().replace(" ", "").replace("_", "")
    mapping = {
        "5k": "5K",
        "5000m": "5K",
        "10k": "10K",
        "10000m": "10K",
        "hm": "HM",
        "half": "HM",
        "halfmarathon": "HM",
        "半马": "HM",
        "fm": "FM",
        "marathon": "FM",
        "fullmarathon": "FM",
        "全马": "FM",
        "trail": "FM",
        "ultra": "FM",
    }
    return mapping.get(low, raw if raw in {"5K", "10K", "HM", "FM"} else "FM")


def _date_plus_days(value: str, days: int) -> str:
    try:
        return (date_cls.fromisoformat(value) + timedelta(days=days)).isoformat()
    except (TypeError, ValueError):
        return ""


def _infer_total_weeks(start_date: Any, end_date: Any, weeks: list[Any]) -> int:
    if weeks:
        return len(weeks)
    try:
        start = date_cls.fromisoformat(str(start_date))
        end = date_cls.fromisoformat(str(end_date))
    except (TypeError, ValueError):
        return 0
    if end < start:
        return 0
    return ((end - start).days // 7) + 1


def _key_session_summary(session: "KeySession") -> str:
    parts = [session.type]
    if session.distance_km is not None:
        parts.append(f"{session.distance_km:g}km")
    if session.duration_min is not None:
        parts.append(f"{session.duration_min:g}min")
    if session.intensity:
        parts.append(str(session.intensity))
    if session.purpose:
        parts.append(str(session.purpose))
    return " ".join(parts)


def _key_session_from_summary(summary: str) -> "KeySession":
    token = (summary.strip().split() or ["key_session"])[0]
    distance_km = None
    duration_min = None
    text = summary.strip().lower()
    for suffix, attr in (("km", "distance"), ("min", "duration")):
        marker = text.find(suffix)
        if marker <= 0:
            continue
        prefix = text[:marker].rstrip()
        number = prefix.split()[-1] if prefix.split() else ""
        try:
            value = float(number)
        except ValueError:
            continue
        if attr == "distance":
            distance_km = value
        else:
            duration_min = value
    return KeySession(
        type=token,
        distance_km=distance_km,
        duration_min=duration_min,
        purpose=summary if summary else None,
    )


def _key_session_type(item: Any) -> str:
    if isinstance(item, KeySession):
        return item.type
    if isinstance(item, dict):
        return str(item.get("type") or "")
    return str(item).strip().split()[0] if str(item).strip() else ""


def _week_from_legacy_skeleton(raw: dict[str, Any]) -> dict[str, Any]:
    week_start = str(raw.get("week_start") or raw.get("start_date") or "")
    key_sessions = raw.get("key_sessions") or []
    details: list[dict[str, Any]] = []
    summaries: list[str] = []
    for item in key_sessions:
        if isinstance(item, KeySession):
            details.append(item.model_dump())
            summaries.append(_key_session_summary(item))
        elif isinstance(item, dict):
            session = KeySession.model_validate(item)
            details.append(session.model_dump())
            summaries.append(_key_session_summary(session))
        else:
            session = _key_session_from_summary(str(item))
            details.append(session.model_dump())
            summaries.append(str(item))
    return {
        "week_number": int(raw.get("week_index") or raw.get("week_number") or 0),
        "start_date": week_start,
        "end_date": raw.get("end_date") or _date_plus_days(week_start, 6),
        "phase_id": raw.get("phase_id"),
        "weekly_distance_km_low": float(
            raw.get("target_weekly_km_low")
            or raw.get("weekly_distance_km_low")
            or 0
        ),
        "weekly_distance_km_high": float(
            raw.get("target_weekly_km_high")
            or raw.get("weekly_distance_km_high")
            or 0
        ),
        "key_sessions": summaries,
        "is_deload": bool(raw.get("is_recovery_week") or raw.get("is_deload") or raw.get("is_taper_week")),
        "is_race_week": bool(raw.get("is_race_week") or any(d.get("type") == "race" for d in details)),
        "notes": raw.get("notes"),
        "key_session_details": details,
        "is_taper_week": bool(raw.get("is_taper_week")),
    }


# ---------------------------------------------------------------------------
# Component models
# ---------------------------------------------------------------------------


class Milestone(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str                        # uuid4
    name: str = ""                 # UI display name
    date: str                      # ISO YYYY-MM-DD
    phase_id: str | None = None
    week_number: int | None = None
    target: str = ""               # 自然语言目标描述，如 "30K 节奏跑 4'45/km"

    # Legacy fields retained so existing diff/review code can still reason
    # about old plans. New API responses omit them at the route boundary.
    type: MilestoneType | None = None
    completed_actual: str | None = None  # 实际完成情况，如 "4'52/km 完成"

    @model_validator(mode="before")
    @classmethod
    def _backfill_name(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        raw = dict(data)
        if not raw.get("name"):
            raw_type = raw.get("type")
            if raw_type:
                raw["name"] = str(raw_type)
            elif raw.get("target"):
                raw["name"] = str(raw["target"])
        return raw


class Phase(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str                        # uuid4
    name: str                      # 如 "基础期"
    start_date: str                # ISO YYYY-MM-DD
    end_date: str                  # ISO YYYY-MM-DD
    focus: str                     # 训练重点描述
    weekly_distance_km_low: float | None = None
    weekly_distance_km_high: float | None = None
    key_workout_types: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("key_workout_types", "key_session_types"),
    )   # 如 ["长距离","有氧","力量"]
    milestone_ids: list[str]

    @property
    def key_session_types(self) -> list[str]:
        """Backward-compatible name used by older diff/review code."""
        return self.key_workout_types


# ---------------------------------------------------------------------------
# Weekly key-session skeleton (S1 strategic — see docs/coach-eval_S1.md)
# ---------------------------------------------------------------------------


class KeySession(BaseModel):
    """One key training session inside a weekly skeleton.

    A *key* session drives physiological adaptation or carries injury /
    race risk — long runs, threshold / tempo / interval / VO2max / hill,
    race pace, time trials, tune-up races, the goal race, and key strength.
    Ordinary easy / aerobic / recovery / commute runs are NOT key sessions
    and do not appear here (they live in S2 weekly plans).

    ``type`` enumeration (str so we can extend without schema churn):
    ``long_run`` / ``threshold`` / ``tempo`` / ``interval`` / ``vo2max`` /
    ``hill`` / ``race_pace`` / ``time_trial`` / ``tune_up_race`` /
    ``race`` / ``strength_key``.

    One of ``distance_km`` / ``duration_min`` is typically populated:
    distance-anchored sessions (long_run / race_pace / tune_up_race / race)
    set ``distance_km``; time-anchored sessions (threshold / interval) set
    ``duration_min``. Both can be set when the prompt produces both.
    """

    type: str                       # see docstring enumeration
    distance_km: float | None = None
    duration_min: float | None = None
    intensity: str | None = None    # "z2" / "z4" / "race_pace" / "mp" / etc.
    purpose: str | None = None      # 1-line rationale, e.g. "建立 FM 专项耐力"


class WeeklyKeySessions(BaseModel):
    """One week of the weekly_key_sessions skeleton.

    Per ``docs/coach-eval_S1.md`` § "S1 Output Requirement: Weekly
    Key-Session Skeleton" — S1 doesn't expand full daily sessions; it only
    lists the key stimuli per week so the eval framework can check
    progression, taper, target-distance specificity, and density.

    ``is_recovery_week`` / ``is_taper_week`` flag deload / wind-down weeks
    so L1 rules can skip the volume-ramp cap and the
    weekly_key_sessions_present requirement for these weeks (a recovery
    week with 0-1 key sessions is correct; a build week with 0 is not).
    """

    week_index: int                # 1-based, sequential across the whole plan
    week_start: str                # ISO YYYY-MM-DD, the Monday of the week
    phase_id: str                  # owning phase (uuid4 from Phase.id)
    target_weekly_km_low: float
    target_weekly_km_high: float
    key_sessions: list[KeySession]
    is_recovery_week: bool = False
    is_taper_week: bool = False


class MasterPlanGoal(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    goal_id: str
    race_name: str
    distance: TargetDistance
    race_date: str
    target_time: str
    timezone: str = "Asia/Shanghai"
    location: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalise_goal(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        raw = dict(data)
        if "goal_id" not in raw and raw.get("id"):
            raw["goal_id"] = raw["id"]
        if "target_time" not in raw:
            raw["target_time"] = (
                raw.get("target_finish_time")
                or raw.get("goal_time")
                or raw.get("time")
                or "00:00:00"
            )
        if "distance" not in raw and raw.get("race_distance"):
            raw["distance"] = raw["race_distance"]
        raw["distance"] = _normalise_target_distance(raw.get("distance"))
        if not raw.get("race_date"):
            raw["race_date"] = raw.get("end_date") or "1970-01-01"
        if not raw.get("race_name"):
            raw["race_name"] = f"{raw['distance']} goal"
        if not raw.get("timezone"):
            raw["timezone"] = "Asia/Shanghai"
        return raw


class MasterPlanWeek(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    week_number: int = Field(validation_alias=AliasChoices("week_number", "week_index"))
    start_date: str = Field(validation_alias=AliasChoices("start_date", "week_start"))
    end_date: str = ""
    phase_id: str | None = None
    weekly_distance_km_low: float = Field(
        validation_alias=AliasChoices("weekly_distance_km_low", "target_weekly_km_low")
    )
    weekly_distance_km_high: float = Field(
        validation_alias=AliasChoices("weekly_distance_km_high", "target_weekly_km_high")
    )
    key_sessions: list[str] = Field(default_factory=list)
    is_deload: bool = Field(
        default=False,
        validation_alias=AliasChoices("is_deload", "is_recovery_week"),
    )
    is_race_week: bool = False
    notes: str | None = None

    # Structured details keep S1 L1 rule checks deterministic. Public API
    # responses strip this field and expose key_sessions as summaries.
    key_session_details: list[KeySession] = Field(default_factory=list)
    is_taper_week: bool = False

    @model_validator(mode="before")
    @classmethod
    def _normalise_week(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        raw = dict(data)
        start = raw.get("start_date") or raw.get("week_start")
        if start and not raw.get("end_date"):
            raw["end_date"] = _date_plus_days(str(start), 6)

        details = raw.get("key_session_details")
        sessions = raw.get("key_sessions") or []
        if details is None and sessions and all(isinstance(s, dict) for s in sessions):
            raw["key_session_details"] = sessions
            raw["key_sessions"] = [_key_session_summary(KeySession.model_validate(s)) for s in sessions]
        elif details is None:
            raw["key_session_details"] = [_key_session_from_summary(str(s)) for s in sessions]

        if raw.get("is_taper_week") and "is_deload" not in raw:
            raw["is_deload"] = True
        if "is_race_week" not in raw:
            raw["is_race_week"] = any(
                _key_session_type(item) == "race"
                for item in raw.get("key_session_details", [])
            )
        return raw

    @property
    def week_index(self) -> int:
        return self.week_number

    @property
    def week_start(self) -> str:
        return self.start_date

    @property
    def target_weekly_km_low(self) -> float:
        return self.weekly_distance_km_low

    @property
    def target_weekly_km_high(self) -> float:
        return self.weekly_distance_km_high

    @property
    def is_recovery_week(self) -> bool:
        return self.is_deload and not self.is_taper_week

    def to_weekly_key_sessions(self) -> WeeklyKeySessions:
        return WeeklyKeySessions(
            week_index=self.week_number,
            week_start=self.start_date,
            phase_id=self.phase_id or "",
            target_weekly_km_low=self.weekly_distance_km_low,
            target_weekly_km_high=self.weekly_distance_km_high,
            key_sessions=list(self.key_session_details),
            is_recovery_week=self.is_recovery_week,
            is_taper_week=self.is_taper_week,
        )


# ---------------------------------------------------------------------------
# Top-level plan models
# ---------------------------------------------------------------------------


class MasterPlan(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    plan_id: str                   # uuid4
    user_id: str                   # JWT sub UUID
    status: MasterPlanStatus
    goal: MasterPlanGoal           # immutable goal snapshot
    start_date: str                # 总纲开始日期 ISO YYYY-MM-DD
    end_date: str                  # 总纲结束日期 ISO YYYY-MM-DD
    total_weeks: int = 0
    phases: list[Phase]
    weeks: list[MasterPlanWeek] = Field(default_factory=list)
    milestones: list[Milestone]
    # Weekly key-session skeleton — list ordered by week_index. Default empty
    # so plans authored before Batch B (existing fixtures, test stubs, legacy
    # MasterPlanVersion snapshots) still validate. New plans MUST populate it
    # for the Batch B L1 rules (weekly_key_sessions_present /
    # weekly_volume_ramp / taper_volume_drop / target_distance_long_run /
    # key_session_density / hard_session_spacing) to do anything; empty list
    # → those rules silently no-op for backwards compatibility.
    weekly_key_sessions: list[WeeklyKeySessions] = Field(default_factory=list, exclude=True)
    training_principles: list[str]  # 训练原则，3-5 条
    generated_by: str | None       # "gpt-4.1" 等
    parent_plan_id: str | None = None
    change_reason: str | None = None
    version: int                   # 从 1 开始，每次 adjust 递增
    created_at: str                # ISO UTC datetime string
    updated_at: str                # ISO UTC datetime string

    @model_validator(mode="before")
    @classmethod
    def _backfill_current_contract(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        raw = dict(data)

        if "goal" not in raw:
            raw["goal"] = {
                "goal_id": raw.get("goal_id") or raw.get("id") or "legacy-goal",
                "race_name": raw.get("race_name") or "Legacy training goal",
                "distance": raw.get("distance") or raw.get("race_distance") or "FM",
                "race_date": raw.get("race_date") or raw.get("end_date") or "1970-01-01",
                "target_time": raw.get("target_time") or raw.get("target_finish_time") or "00:00:00",
                "timezone": raw.get("timezone") or "Asia/Shanghai",
                "location": raw.get("location"),
            }

        if not raw.get("weeks") and raw.get("weekly_key_sessions"):
            raw["weeks"] = [
                _week_from_legacy_skeleton(w)
                for w in raw.get("weekly_key_sessions", [])
                if isinstance(w, dict)
            ]

        if not raw.get("total_weeks"):
            raw["total_weeks"] = _infer_total_weeks(
                raw.get("start_date"),
                raw.get("end_date"),
                raw.get("weeks") or [],
            )
        return raw

    @model_validator(mode="after")
    def _sync_week_shapes(self) -> "MasterPlan":
        if self.weeks and not self.weekly_key_sessions:
            self.weekly_key_sessions = [w.to_weekly_key_sessions() for w in self.weeks]
        if self.weekly_key_sessions and not self.weeks:
            self.weeks = [
                MasterPlanWeek.model_validate(_week_from_legacy_skeleton(w.model_dump()))
                for w in self.weekly_key_sessions
            ]
        if not self.total_weeks:
            self.total_weeks = _infer_total_weeks(
                self.start_date, self.end_date, [w.model_dump() for w in self.weeks]
            )
        return self

    @property
    def goal_id(self) -> str:
        """Backward-compatible top-level goal id accessor."""
        return self.goal.goal_id


class MasterPlanVersion(BaseModel):
    """历史版本快照（存完整 plan JSON 供版本对比）。"""

    version_id: str                # uuid4
    plan_id: str
    version: int
    changed_at: str                # ISO UTC datetime string
    change_reason: str             # 用户输入的调整描述（来自最后一条 user 消息）
    change_summary: str            # AI 生成的一句话摘要
    snapshot_json: str             # 完整 MasterPlan JSON 序列化（用于版本对比）


# ---------------------------------------------------------------------------
# Review-diff apply helper (draft-phase only, no version bump)
# ---------------------------------------------------------------------------


def _apply_review_diff(
    plan: "MasterPlan",
    diff: object,  # MasterPlanDiff — avoid circular import; duck-typed
    accepted_op_ids: list[str],
) -> "MasterPlan":
    """Apply accepted diff ops to a DRAFT plan WITHOUT bumping version.

    Used by the review-chat /apply endpoint (T21) where the plan is still
    being shaped; we don't want history entries or a version increment until
    the user calls /confirm (T22).

    Args:
        plan: The current MasterPlan in DRAFT status.
        diff: A MasterPlanDiff whose ops should be applied selectively.
        accepted_op_ids: The subset of op ids the user accepted.

    Returns:
        A new MasterPlan instance (immutable model_copy) with the accepted
        ops applied; ``version`` and ``status`` are unchanged.
    """
    from datetime import datetime, timezone

    from stride_core.master_plan_diff import MasterPlanDiffOpKind as _K

    accepted_set = set(accepted_op_ids)
    active_ops = [op for op in diff.ops if op.id in accepted_set and op.accepted is not False]

    if not active_ops:
        return plan

    # Phase-affecting ops invalidate the weekly_key_sessions skeleton — its
    # week_start dates, target_weekly_km_* targets and phase_id back-refs all
    # tie to specific phase shapes. Rather than partially patch the skeleton
    # (which would need a diff op of its own to be safe), clear it so the
    # next generation pass / explicit edit can rebuild it consistently.
    PHASE_AFFECTING = {
        _K.ADD_PHASE,
        _K.REMOVE_PHASE,
        _K.RESIZE_PHASE,
        _K.REPLACE_WEEKLY_RANGE,
    }
    phase_affecting_applied = any(op.op in PHASE_AFFECTING for op in active_ops)

    phases: dict[str, Phase] = {p.id: p for p in plan.phases}
    milestones: dict[str, Milestone] = {m.id: m for m in plan.milestones}

    for op in active_ops:
        patch = op.spec_patch or {}
        op_kind = op.op  # MasterPlanDiffOpKind value

        if op_kind == _K.ADD_PHASE:
            new_phase = Phase(
                id=patch["id"],
                name=patch["name"],
                start_date=patch["start_date"],
                end_date=patch["end_date"],
                focus=patch.get("focus", ""),
                weekly_distance_km_low=float(patch.get("weekly_distance_km_low", 0)),
                weekly_distance_km_high=float(patch.get("weekly_distance_km_high", 0)),
                key_workout_types=list(
                    patch.get("key_workout_types")
                    or patch.get("key_session_types", [])
                ),
                milestone_ids=list(patch.get("milestone_ids", [])),
            )
            phases[new_phase.id] = new_phase

        elif op_kind == _K.REMOVE_PHASE:
            if op.phase_id:
                phase = phases.pop(op.phase_id, None)
                if phase:
                    for mid in list(phase.milestone_ids):
                        milestones.pop(mid, None)

        elif op_kind == _K.RESIZE_PHASE:
            if op.phase_id and op.phase_id in phases:
                updates = {}
                if "start_date" in patch:
                    updates["start_date"] = patch["start_date"]
                if "end_date" in patch:
                    updates["end_date"] = patch["end_date"]
                phases[op.phase_id] = phases[op.phase_id].model_copy(update=updates)

        elif op_kind == _K.REPLACE_PHASE_FOCUS:
            if op.phase_id and op.phase_id in phases and "focus" in patch:
                phases[op.phase_id] = phases[op.phase_id].model_copy(
                    update={"focus": patch["focus"]}
                )

        elif op_kind == _K.REPLACE_WEEKLY_RANGE:
            if op.phase_id and op.phase_id in phases:
                updates = {}
                if "weekly_distance_km_low" in patch:
                    updates["weekly_distance_km_low"] = float(patch["weekly_distance_km_low"])
                if "weekly_distance_km_high" in patch:
                    updates["weekly_distance_km_high"] = float(patch["weekly_distance_km_high"])
                phases[op.phase_id] = phases[op.phase_id].model_copy(update=updates)

        elif op_kind == _K.ADD_MILESTONE:
            new_ms = Milestone(
                id=patch["id"],
                name=patch.get("name", patch.get("target", "")),
                type=MilestoneType(patch["type"]) if patch.get("type") else None,
                date=patch["date"],
                phase_id=patch["phase_id"],
                week_number=patch.get("week_number"),
                target=patch.get("target", ""),
                completed_actual=patch.get("completed_actual"),
            )
            milestones[new_ms.id] = new_ms
            if new_ms.phase_id in phases:
                p = phases[new_ms.phase_id]
                if new_ms.id not in p.milestone_ids:
                    phases[new_ms.phase_id] = p.model_copy(
                        update={"milestone_ids": p.milestone_ids + [new_ms.id]}
                    )

        elif op_kind == _K.REMOVE_MILESTONE:
            if op.milestone_id:
                ms = milestones.pop(op.milestone_id, None)
                if ms and ms.phase_id in phases:
                    p = phases[ms.phase_id]
                    new_ids = [mid for mid in p.milestone_ids if mid != op.milestone_id]
                    phases[ms.phase_id] = p.model_copy(update={"milestone_ids": new_ids})

        elif op_kind == _K.REPLACE_MILESTONE_DATE:
            if op.milestone_id and op.milestone_id in milestones and "date" in patch:
                milestones[op.milestone_id] = milestones[op.milestone_id].model_copy(
                    update={"date": patch["date"]}
                )

        elif op_kind == _K.REPLACE_MILESTONE_TARGET:
            if op.milestone_id and op.milestone_id in milestones and "target" in patch:
                milestones[op.milestone_id] = milestones[op.milestone_id].model_copy(
                    update={"target": patch["target"]}
                )

    now_iso = datetime.now(timezone.utc).isoformat()
    update: dict = {
        "phases": list(phases.values()),
        "milestones": list(milestones.values()),
        "updated_at": now_iso,
        # version and status intentionally unchanged
    }
    if phase_affecting_applied:
        # See "Phase-affecting ops invalidate..." comment above. Caller (the
        # review-chat /apply route) is responsible for triggering a fresh
        # skeleton generation before the plan is /confirmed.
        update["weekly_key_sessions"] = []
        update["weeks"] = []
    return plan.model_copy(update=update)
