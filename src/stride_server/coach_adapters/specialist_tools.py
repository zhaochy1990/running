"""Specialist 必传上下文 calculators + pull tools — see Stage-3a spec §4.

Adapter layer (reads DB + running calibration). Returns the **core** types
``PaceTargets`` / ``VolumeTargets`` (defined in ``coach.schemas``); the
dependency points adapter → core, which is correct.

Single-source discipline (CLAUDE.md HARD):
- Athlete baselines (threshold pace, LTHR, pace/HR zones) come ONLY from
  ``stride_core.running_calibration`` via ``SQLiteRunningCalibrationRepository``
  + ``compute_training_zones``. We never recompute threshold/HR from raw
  activities here, and never hard-code a magic 185-style default.
- The injury → contraindicated-exercise keyword map is reused from
  ``coach.graphs.generation.rule_filter.INJURY_CONTRAINDICATION_KEYWORDS``,
  not re-invented.
- Running-row matching uses ``RUN_SPORT_SQL_LIST`` and the misnamed-``distance_m``
  km-normalization established in ``master_plan_generator`` / ``continuity_analyzer``.
- Timezone: ``activities.date`` is UTC ISO; weekly buckets use Shanghai-day
  (``SHANGHAI_DAY_SQL`` from ``stride_core.timefmt``).
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from datetime import date as date_cls
from typing import Any

from coach.graphs.generation.rule_filter import INJURY_CONTRAINDICATION_KEYWORDS
from coach.schemas import PaceTargets, ToolResult, VolumeTargets
from stride_core.master_plan import PhaseType
from stride_core.models import RUN_SPORT_SQL_LIST
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.zones import compute_training_zones
from stride_core.timefmt import SHANGHAI_DAY_SQL, today_shanghai

logger = logging.getLogger(__name__)

# Same km-normalization fragment used across the adapter layer: activities.distance_m
# is misnamed — it stores KILOMETERS when < 500, legacy rows store meters (>= 500).
_KM_EXPR = "CASE WHEN distance_m < 500 THEN distance_m ELSE distance_m / 1000.0 END"

_FM_DISTANCE_KM = 42.195


# ---------------------------------------------------------------------------
# 必传上下文 — pace_targets
# ---------------------------------------------------------------------------


def pace_targets(db: Any, *, goal: dict, as_of: date_cls) -> PaceTargets:
    """Build the athlete's real pace table from calibration + the goal.

    Source of truth:
      * threshold pace + easy/z2 band + interval band come from the running
        calibration snapshot and its derived zones (single-source).
      * MP (marathon pace) is derived from the goal.

    Raises ``ValueError`` when no usable calibration snapshot exists (no
    snapshot at all, or threshold speed missing). The caller MUST be able to
    tell the difference between a real pace table and a degraded one — we do
    NOT fabricate a magic default (CLAUDE.md anti-pattern).
    """
    repo = SQLiteRunningCalibrationRepository(db)
    snapshot = repo.fetch_latest(as_of_date=as_of)
    if snapshot is None:
        raise ValueError(
            "pace_targets: no running calibration snapshot available "
            f"as of {as_of.isoformat()}; cannot derive pace table"
        )
    if not snapshot.threshold_speed_mps or snapshot.threshold_speed_mps <= 0:
        raise ValueError(
            "pace_targets: calibration snapshot has no threshold_speed_mps; "
            "cannot derive threshold/interval/easy paces"
        )

    threshold_speed = float(snapshot.threshold_speed_mps)
    threshold_pace = 1000.0 / threshold_speed  # s/km

    zones = compute_training_zones(snapshot)
    pace_by_name = {z.name: z for z in zones.pace_zones}

    # Easy / z2 band: the "easy" zone's pace bounds. Faster end = min_pace,
    # slower end = max_pace. Fall back to a conventional band around threshold
    # if zones are unexpectedly missing the easy zone.
    easy_zone = pace_by_name.get("easy")
    if easy_zone and easy_zone.min_pace_s_per_km and easy_zone.max_pace_s_per_km:
        easy_low = float(easy_zone.min_pace_s_per_km)
        easy_high = float(easy_zone.max_pace_s_per_km)
    else:
        # easy speed ≈ 0.72–0.84 × threshold speed (mirrors zones.PACE_ZONE_SPEED_RATIOS)
        easy_low = 1000.0 / (threshold_speed * 0.84)
        easy_high = 1000.0 / (threshold_speed * 0.72)

    # Interval / VO2max (~5k effort): the "interval" zone band's faster (min_pace)
    # end. Conventionally VO2max pace ≈ threshold × ~1.06 speed; the calibration
    # interval zone (1.03–1.11 × threshold speed) brackets this — take its fast end.
    interval_zone = pace_by_name.get("interval")
    if interval_zone and interval_zone.min_pace_s_per_km:
        interval_pace = float(interval_zone.min_pace_s_per_km)
    else:
        interval_pace = 1000.0 / (threshold_speed * 1.08)

    # Rep paces. Conventional (Daniels-style) ratios relative to threshold pace:
    #   1km rep ≈ slightly faster than 5k/VO2max → ~0.985 × interval pace
    #   400m rep ≈ faster still → ~0.93 × interval pace
    # We anchor reps off interval_pace (not threshold) so the ordering
    # 400m < 1000m <= interval < threshold always holds.
    rep_1000 = interval_pace * 0.985
    rep_400 = interval_pace * 0.93

    marathon_pace = _marathon_pace_s_km(goal, threshold_pace=threshold_pace)

    return PaceTargets(
        easy_pace_low_s_km=round(easy_low, 1),
        easy_pace_high_s_km=round(easy_high, 1),
        marathon_pace_s_km=round(marathon_pace, 1),
        threshold_pace_s_km=round(threshold_pace, 1),
        interval_pace_s_km=round(interval_pace, 1),
        rep_1000m_s_km=round(rep_1000, 1),
        rep_400m_s_km=round(rep_400, 1),
    )


def _marathon_pace_s_km(goal: dict, *, threshold_pace: float) -> float:
    """Derive marathon pace (s/km) from the normalized goal dict.

    The goal dict carries ``goal_time_s`` (int seconds) and ``distance``
    (``5k/10k/hm/fm/ultra``) — see ``master_plan_generator._normalize_for_prompt``.

    * FM goal: MP = goal_time_s / 42.195 (direct — this is the target race pace).
    * Non-FM goal: there is no marathon target time, so we derive a
      marathon-EQUIVALENT MP from threshold. MP for a trained marathoner sits
      ~6% slower than threshold speed (≈ threshold pace × 1.06). This is a
      conventional, documented fallback — it intentionally ignores the shorter
      goal's pace because a 5k/10k goal pace is far faster than any MP and would
      misrepresent the easy/long-run aerobic target. Assumption noted here.
    """
    goal = goal or {}
    distance = str(goal.get("distance") or "").lower()
    goal_time_s = goal.get("goal_time_s")

    if distance == "fm" and isinstance(goal_time_s, (int, float)) and goal_time_s > 0:
        return float(goal_time_s) / _FM_DISTANCE_KM

    # Non-FM (or FM without a usable time): threshold-derived marathon-equivalent.
    return threshold_pace * 1.06


# ---------------------------------------------------------------------------
# 必传上下文 — volume_targets
# ---------------------------------------------------------------------------

# Per-phase quality-km share of the weekly volume. "quality" = threshold /
# interval / MP / progression work (everything that isn't easy or the long run).
# base small · build medium · speed medium (high-zone) · peak MP-dominant ·
# taper small · recovery ~0. These shares are intentionally monotone
# base < build <= peak so phase scaling is observable.
_QUALITY_SHARE_BY_PHASE: dict[PhaseType, float] = {
    PhaseType.BASE: 0.10,
    PhaseType.BUILD: 0.18,
    PhaseType.SPEED: 0.20,
    PhaseType.PEAK: 0.22,
    PhaseType.TAPER: 0.12,
    PhaseType.RECOVERY: 0.0,
}

# Long-run share of weekly volume, bounded so it never violates the HARD
# ≤35% long-run rule. Peak/taper allow the upper end (race-specific long runs);
# recovery pulls it down.
_LONG_RUN_SHARE_BY_PHASE: dict[PhaseType, float] = {
    PhaseType.BASE: 0.28,
    PhaseType.BUILD: 0.30,
    PhaseType.SPEED: 0.27,
    PhaseType.PEAK: 0.33,
    PhaseType.TAPER: 0.30,
    PhaseType.RECOVERY: 0.25,
}

_LONG_RUN_SHARE_CAP = 0.35
_LONG_RUN_KM_CAP = 38.0  # a single long run rarely exceeds ~38 km in training


def volume_targets(
    target_weekly_km: float,
    phase_type: PhaseType,
    level: float,
) -> VolumeTargets:
    """Pure weekly volume budget — no DB.

    Args:
        target_weekly_km: the week's volume target (from Stage-1's phase band).
        phase_type: the periodization phase (drives quality share + long-run share).
        level: an athlete-level signal (e.g. CTL, or recent average weekly km).
            Higher level → marginally larger long run / quality budget within
            the phase share, reflecting that fitter athletes tolerate more
            quality km. Kept a gentle ±5% nudge so weekly_km stays dominant.

    Returns a ``VolumeTargets`` whose components sum to ~``target_weekly_km``.
    """
    weekly = max(float(target_weekly_km), 0.0)
    if weekly <= 0:
        return VolumeTargets(weekly_km=0.0, long_run_km=0.0, quality_km_budget=0.0, easy_km=0.0)

    # Level nudge: scale within a tight band so higher-CTL athletes get a touch
    # more long run + quality. Centered at level=60 (typical runner CTL), capped
    # at ±5% so it never overrides phase/weekly scaling — those are the primary
    # signals and the spec's scaling test compares equal-level weeks.
    level_factor = 1.0 + max(min((float(level) - 60.0) / 60.0, 1.0), -1.0) * 0.05

    long_share = _LONG_RUN_SHARE_BY_PHASE.get(phase_type, 0.28)
    long_run_km = weekly * long_share * level_factor
    # Enforce the HARD ≤35% rule and a sane absolute cap.
    long_run_km = min(long_run_km, weekly * _LONG_RUN_SHARE_CAP, _LONG_RUN_KM_CAP)

    quality_share = _QUALITY_SHARE_BY_PHASE.get(phase_type, 0.15)
    quality_km = weekly * quality_share * level_factor
    # Quality + long run must leave room for easy; clamp quality so easy >= 0.
    quality_km = max(min(quality_km, weekly - long_run_km), 0.0)

    easy_km = weekly - long_run_km - quality_km

    return VolumeTargets(
        weekly_km=round(weekly, 1),
        long_run_km=round(long_run_km, 1),
        quality_km_budget=round(quality_km, 1),
        easy_km=round(easy_km, 1),
    )


# ---------------------------------------------------------------------------
# Pull tool — strength_library
# ---------------------------------------------------------------------------

# Curated per-target-group catalog of COROS built-in strength exercises.
# Codes verified against src/coros_sync/exercise_catalog.md (do NOT call the
# COROS network client — eval runs against a frozen DB with no network). The
# ``name`` strings carry the English exercise name so the injury keyword filter
# (knee↔squat/lunge, back↔deadlift, ankle↔plyo) can match against them.
_STRENGTH_CATALOG: dict[str, list[dict[str, str]]] = {
    # Calf / Achilles eccentric loading — runner durability staple.
    "calf_eccentric": [
        {"code": "T1070", "name": "standing calf raises", "sets_reps": "3×12 (eccentric, 3s lower)",
         "note": "小腿/跟腱离心负荷，慢放"},
        {"code": "T1005", "name": "skipping rope", "sets_reps": "3×30s",
         "note": "小腿弹性 + 频率"},
    ],
    # Gluteus medius / lateral hip — counters runner's hip drop.
    "glute_med": [
        {"code": "T1317", "name": "clamshell", "sets_reps": "3×15/side",
         "note": "臀中肌单独激活，无膝关节负荷"},
        {"code": "T1321", "name": "banded hip abduction", "sets_reps": "3×15/side",
         "note": "弹力带外展"},
        {"code": "T1167", "name": "single leg squats", "sets_reps": "3×8/side",
         "note": "单腿蹲，复合臀中肌负荷"},
    ],
    # Hip stability / posterior chain.
    "hip_stability": [
        {"code": "T1160", "name": "single leg bridge", "sets_reps": "3×12/side",
         "note": "单腿臀桥，髋稳定"},
        {"code": "T1289", "name": "hip thrust", "sets_reps": "3×10",
         "note": "髋伸展力量"},
        {"code": "T1233", "name": "donkey kicks", "sets_reps": "3×15/side",
         "note": "臀大肌激活"},
        {"code": "T1064", "name": "dumbbell lunges", "sets_reps": "3×10/side",
         "note": "弓步，复合髋/腿"},
    ],
    # Trunk / core anti-rotation + anti-extension.
    "core": [
        {"code": "T1010", "name": "planks", "sets_reps": "3×40s",
         "note": "前侧核心抗伸展"},
        {"code": "T1185", "name": "side plank", "sets_reps": "3×30s/side",
         "note": "侧链抗侧屈"},
        {"code": "T1243", "name": "dead bug", "sets_reps": "3×10/side",
         "note": "抗伸展 + 协调"},
        {"code": "T1249", "name": "bird dog balance", "sets_reps": "3×10/side",
         "note": "抗旋转 + 后链"},
    ],
    # Thoracic mobility — opens up rotation for arm carriage / breathing.
    "thoracic_mobility": [
        {"code": "T1248", "name": "thoracic spine rotation", "sets_reps": "2×12/side",
         "note": "胸椎旋转活动度"},
        {"code": "T1234", "name": "cat cow stretch", "sets_reps": "2×30s",
         "note": "脊柱屈伸流动"},
    ],
}


def strength_library(
    targets: list[str] | tuple[str, ...],
    injuries: list[str] | tuple[str, ...] | None,
) -> list[dict[str, str]]:
    """Return curated COROS-T-code exercises for the requested target group(s),
    filtered against logged injuries.

    Unknown target groups are silently skipped (no exception). Injury filtering
    reuses the canonical keyword map from ``rule_filter`` (single-source) — an
    exercise whose name contains a contraindicated substring for any logged
    injury is dropped.
    """
    inj_lower = {str(i).lower() for i in (injuries or []) if i and str(i) != "none"}
    contraindicated_tokens: set[str] = set()
    for inj in inj_lower:
        contraindicated_tokens.update(INJURY_CONTRAINDICATION_KEYWORDS.get(inj, ()))

    out: list[dict[str, str]] = []
    seen_codes: set[str] = set()
    for group in targets:
        for ex in _STRENGTH_CATALOG.get(group, []):
            name_lower = ex["name"].lower()
            if any(tok in name_lower for tok in contraindicated_tokens):
                continue
            if ex["code"] in seen_codes:
                continue
            seen_codes.add(ex["code"])
            out.append(dict(ex))
    return out


# ---------------------------------------------------------------------------
# Pull tool — recent_training
# ---------------------------------------------------------------------------


def recent_training(
    db: Any,
    weeks: int,
    *,
    as_of: date_cls | None = None,
    filter: str | None = None,
) -> list[dict[str, Any]]:
    """Aggregate running activities into compact per-week summary rows.

    Args:
        db: a Database handle (or anything exposing ``_conn``).
        weeks: how many weeks back from ``as_of`` to include.
        as_of: the reference date (defaults to today, Shanghai).
        filter: optional row filter — must be one of ``None`` (default),
            ``"long_run"``, or ``"quality"``. An unrecognized value raises
            ``ValueError`` so a caller typo cannot silently return unfiltered
            data. ``"long_run"`` narrows each row to the week's longest-run
            distance signal; ``"quality"`` is a reserved documented no-op
            passthrough (behaves like ``None`` until a per-activity intensity
            marker is confirmed — see continuity_analyzer's quality_sessions note).

    Row shape differs by filter mode (return logic is intentionally not unified):
      * ``None`` / ``"quality"``: ``{week, total_km, session_count, longest_km}``
      * ``"long_run"``: ``{week, longest_km}`` only (the other keys are dropped)

    Only running sport-types are counted (``RUN_SPORT_SQL_LIST``); ``distance_m``
    is km-normalized. Weeks are bucketed by Shanghai-local day
    (``SHANGHAI_DAY_SQL``) so the 00:00–07:59 Shanghai window is not silently
    misfiled into the wrong UTC week.

    Boundary buckets may be partial weeks: the GROUP BY uses ``%W``
    (Monday-start ISO-ish weeks) while the lookback is a rolling N×7-day window
    anchored on ``as_of``, so the first and/or last returned bucket can cover
    fewer than 7 days. Do not read an edge week's ``total_km`` as a full-week
    volume.
    """
    if filter not in (None, "long_run", "quality"):
        raise ValueError(
            f"recent_training: unrecognized filter {filter!r}; "
            "expected one of None, 'long_run', 'quality'"
        )

    conn = getattr(db, "_conn", db)
    ref = as_of or today_shanghai()
    cutoff = ref.isoformat()
    lookback_days = max(int(weeks), 0) * 7

    # Week key uses the Shanghai-shifted date so day-of-week boundaries match
    # the user-facing week. SHANGHAI_DAY_SQL is ``date(datetime(date, '+8 hours'))``.
    shanghai_week = "strftime('%Y-%W', datetime(date, '+8 hours'))"
    rows = conn.execute(
        f"SELECT {shanghai_week} AS wk, "
        f"SUM({_KM_EXPR}) AS total_km, "
        f"COUNT(*) AS session_count, "
        f"MAX({_KM_EXPR}) AS longest_km "
        f"FROM activities "
        f"WHERE sport_type IN ({RUN_SPORT_SQL_LIST}) "
        f"AND {SHANGHAI_DAY_SQL} >= date(?, '-{lookback_days} days') "
        f"AND {SHANGHAI_DAY_SQL} <= date(?) "
        f"GROUP BY wk ORDER BY wk",
        (cutoff, cutoff),
    ).fetchall()

    summary: list[dict[str, Any]] = []
    for r in rows:
        total_km = float(r["total_km"] or 0.0)
        longest_km = float(r["longest_km"] or 0.0)
        row = {
            "week": r["wk"],
            "total_km": round(total_km, 1),
            "session_count": int(r["session_count"] or 0),
            "longest_km": round(longest_km, 1),
        }
        if filter == "long_run":
            # Long-run lens: report only the week's longest run distance.
            row = {"week": r["wk"], "longest_km": round(longest_km, 1)}
        summary.append(row)
    return summary


# ---------------------------------------------------------------------------
# LLM-facing tool wrappers (Stage-3a Task 8 Part B)
#
# The pure ``strength_library`` / ``recent_training`` functions above stay
# intact — ``generate_phase_weeks`` and Task-3 tests call them deterministically.
# These wrapper classes adapt them to the langchain tool-calling surface:
#   * a clean LLM-facing signature (no ``db`` arg — the wrapper opens its own),
#   * a ``ToolResult`` envelope (``{ok, data, errors}``),
#   * ``_tool_safe`` so a failure returns ``ToolResult(ok=False)`` not a raise.
#
# Wired into the per-week generator via ``week_specialist_adapter`` (Part C).
# Descriptions tell the LLM what each does + when to call it.
# ---------------------------------------------------------------------------


def _tool_safe(func: Callable[..., ToolResult]) -> Callable[..., ToolResult]:
    """Convert any uncaught exception to ``ToolResult(ok=False, errors=[...])``.

    Mirrors ``coach_adapters.tool_impls.read_impls._tool_safe`` (kept a local
    copy here so this module does not depend on the read-tool package's import
    side effects). Tools that surface *known* failures should construct the
    ``ok=False`` result themselves; this only handles the *unexpected* path."""

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> ToolResult:
        try:
            return func(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — tool-safety boundary
            logger.exception("specialist tool %s raised", func.__qualname__)
            return ToolResult(ok=False, errors=[f"{type(exc).__name__}: {exc}"])

    return wrapper


# Tool descriptions surfaced to the LLM (used by the langchain StructuredTool
# wrapping in week_specialist_adapter).
STRENGTH_LIBRARY_TOOL_DESCRIPTION = (
    "查询经过校验的 COROS 内置力量/核心动作库（带 T-code），按目标肌群返回"
    "可直接写进计划的动作（含组×次 + 中文备注）。targets 用肌群关键字，可多选："
    "calf_eccentric（小腿/跟腱离心）、glute_med（臀中肌）、hip_stability（髋稳定/后链）、"
    "core（核心抗旋/抗伸展）、thoracic_mobility（胸椎活动度）。当本周需要安排力量/核心/"
    "稳定性课次时调用本工具拿真实 T-code，不要凭空编造动作或编号。可传 injuries 让工具"
    "过滤掉与伤病冲突的动作（如 knee 过滤深蹲/弓步、back 过滤硬拉、ankle 过滤跳跃）。"
)
RECENT_TRAINING_TOOL_DESCRIPTION = (
    "返回该跑者最近 weeks 周（默认 4 周）按周聚合的真实跑步负荷："
    "每周总公里、课次数、最长单次距离（仅计跑步运动类型，上海周边界）。"
    "当你需要参考跑者近期实际训练量来设定本周量/长跑距离的合理增幅时调用。"
    "可选 filter='long_run' 只看每周最长跑；filter='quality' 为预留透传（行为同默认）。"
)


class StrengthLibraryTool:
    """LLM-facing wrapper over the pure ``strength_library`` catalog lookup.

    Bound to a ``user_id`` for symmetry with the read-tool impls (and so the
    bound context can default ``injuries`` from the generation payload), though
    the curated catalog itself needs no DB.
    """

    def __init__(self, user_id: str, *, default_injuries: list[str] | None = None) -> None:
        self._user_id = user_id
        # The generator binds the week's logged injuries here so the LLM can
        # omit the arg and still get injury-safe filtering; an explicit
        # ``injuries`` kwarg from the model overrides this default.
        self._default_injuries = list(default_injuries or [])

    @_tool_safe
    def __call__(
        self,
        *,
        targets: list[str],
        injuries: list[str] | None = None,
    ) -> ToolResult:
        inj = injuries if injuries is not None else self._default_injuries
        exercises = strength_library(targets, inj)
        return ToolResult(ok=True, data={"exercises": exercises})


class RecentTrainingTool:
    """LLM-facing wrapper over the pure ``recent_training`` aggregation.

    Opens a short-lived ``Database(user=user_id)`` internally so the LLM-facing
    signature carries no ``db`` arg (mirrors the read-tool impls' DB-per-call
    pattern)."""

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, weeks: int = 4, filter: str | None = None) -> ToolResult:
        from stride_core.db import Database

        db = Database(user=self._user_id)
        try:
            summary = recent_training(db, int(weeks), filter=filter)
        finally:
            db.close()
        return ToolResult(ok=True, data={"weeks": summary})
