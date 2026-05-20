"""Concrete read-tool implementations — see plan §5.1.

Each impl is a callable class bound to a single ``user_id``; calling it opens
a short-lived DB connection, queries, and returns a :class:`ToolResult`.

Per plan §5.4 tools MUST NOT raise: unexpected exceptions are caught by
:func:`_tool_safe` and surfaced as ``ToolResult(ok=False, errors=[...])`` so
the graph can stay deterministic.

We migrate the loader logic from ``coach_agent/context.py`` here rather than
calling the existing route handlers — those handlers expect FastAPI
dependency injection (``payload: dict = Depends(require_bearer)``), which we
can't satisfy from a coach tool context.
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from coach.schemas import ToolResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tool_safe(func: Callable[..., ToolResult]) -> Callable[..., ToolResult]:
    """Decorator that converts uncaught exceptions to ``ToolResult(ok=False)``.

    Tools that need to surface known failures (DB closed, plan missing) should
    construct ``ToolResult(ok=False, errors=[...])`` themselves; this wrapper
    only handles the *unexpected* failure mode."""

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> ToolResult:
        try:
            return func(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — tool-safety boundary
            logger.exception("tool %s raised", func.__qualname__)
            return ToolResult(ok=False, errors=[f"{type(exc).__name__}: {exc}"])

    return wrapper


def _open_db(user_id: str) -> Any:
    """Open a ``stride_core.db.Database`` for ``user_id``. Lazy-imported so
    tool_impls is testable without ``stride_core.db`` initialised in unusual
    environments (e.g. minimal CI containers)."""
    from stride_core.db import Database

    return Database(user=user_id)


def _activity_payload(row: Any) -> dict[str, Any]:
    """Mirror the shape :func:`coach_agent.context._activity_payload` produced
    so we stay drop-in compatible with downstream prompts."""
    from stride_core.models import pace_str
    from stride_server.deps import format_duration

    d = dict(row)
    d["distance_km"] = round(d["distance_m"] / 1000.0, 2) if d.get("distance_m") else 0
    d["duration_fmt"] = format_duration(d.get("duration_s"))
    d["pace_fmt"] = pace_str(d.get("avg_pace_s_km")) or "—"
    return d


def _tsb_zone(tsb: float) -> tuple[str, str]:
    if tsb >= 25:
        return "overtaper", "减量过多"
    if tsb >= 10:
        return "race_ready", "比赛就绪"
    if tsb >= -10:
        return "neutral", "过渡区"
    if tsb >= -30:
        return "training", "正常训练"
    return "overreaching", "过度负荷"


# ---------------------------------------------------------------------------
# 1. get_recent_activities
# ---------------------------------------------------------------------------


class GetRecentActivitiesImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, limit: int = 14) -> ToolResult:
        db = _open_db(self._user_id)
        try:
            rows = db.query(
                """SELECT label_id, name, sport_type, sport_name, date,
                    distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
                    avg_cadence, calories_kcal, training_load, vo2max, train_type,
                    feel_type, sport_note
                FROM activities
                ORDER BY date DESC, label_id DESC
                LIMIT ?""",
                (max(1, int(limit)),),
            )
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={"activities": [_activity_payload(r) for r in rows]},
        )


# ---------------------------------------------------------------------------
# 2. get_health_snapshot
# ---------------------------------------------------------------------------


class GetHealthSnapshotImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        db = _open_db(self._user_id)
        try:
            rows = db.query(
                """SELECT date, ati, cti, rhr, distance_m, duration_s,
                    training_load_ratio, training_load_state, fatigue
                FROM daily_health
                ORDER BY date DESC
                LIMIT 1"""
            )
            latest = dict(rows[0]) if rows else None
            if latest is not None and latest.get("ati") is not None and latest.get("cti") is not None:
                tsb = round(latest["cti"] - latest["ati"], 1)
                zone, label = _tsb_zone(tsb)
                latest["tsb"] = tsb
                latest["tsb_zone"] = zone
                latest["tsb_zone_label"] = label

            dash_rows = db.query(
                """SELECT avg_sleep_hrv, hrv_normal_low, hrv_normal_high, recovery_pct,
                    running_level, aerobic_score, threshold_hr, threshold_pace_s_km
                FROM dashboard WHERE id = 1"""
            )
            dashboard = dict(dash_rows[0]) if dash_rows else {}
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={"latest": latest, "dashboard": dashboard},
        )


# ---------------------------------------------------------------------------
# 3. get_pmc_series
# ---------------------------------------------------------------------------


class GetPmcSeriesImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, days: int = 42, granularity: str = "daily") -> ToolResult:
        if granularity not in ("daily", "weekly"):
            return ToolResult(
                ok=False,
                errors=[f"granularity must be 'daily' or 'weekly', got {granularity!r}"],
            )
        db = _open_db(self._user_id)
        try:
            rows = db.query(
                """SELECT date, ati, cti, training_load_ratio, training_load_state, fatigue
                FROM daily_health ORDER BY date DESC LIMIT ?""",
                (max(1, int(days)),),
            )
            records = [dict(r) for r in rows]
            for rec in records:
                if rec.get("ati") is not None and rec.get("cti") is not None:
                    rec["tsb"] = round(rec["cti"] - rec["ati"], 1)
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={"granularity": granularity, "days": days, "series": records},
        )


# ---------------------------------------------------------------------------
# 4. get_inbody_latest
# ---------------------------------------------------------------------------


class GetInbodyLatestImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_core.state_stores import SqliteInBodyStore

        db = _open_db(self._user_id)
        try:
            store = SqliteInBodyStore(db)
            latest = store.latest_body_composition_scan()
            if latest is None:
                return ToolResult(ok=True, data={"latest": None, "deltas": None})
            latest_d = dict(latest)
            prior_rows = db.query(
                "SELECT * FROM body_composition_scan WHERE scan_date < ? ORDER BY scan_date DESC LIMIT 1",
                (latest_d["scan_date"],),
            )
            prior = dict(prior_rows[0]) if prior_rows else None
            deltas = None
            if prior:
                deltas = {
                    "prev_date": prior["scan_date"],
                    "weight_kg": round(latest_d["weight_kg"] - prior["weight_kg"], 2),
                    "body_fat_pct": round(latest_d["body_fat_pct"] - prior["body_fat_pct"], 2),
                    "smm_kg": round(latest_d["smm_kg"] - prior["smm_kg"], 2),
                    "fat_mass_kg": round(latest_d["fat_mass_kg"] - prior["fat_mass_kg"], 2),
                    "visceral_fat_level": latest_d["visceral_fat_level"]
                    - prior["visceral_fat_level"],
                }
        finally:
            db.close()
        return ToolResult(ok=True, data={"latest": latest_d, "deltas": deltas})


# ---------------------------------------------------------------------------
# 5. get_ability_snapshot
# ---------------------------------------------------------------------------


class GetAbilitySnapshotImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        db = _open_db(self._user_id)
        try:
            rows = db.query(
                """SELECT date, level, dimension, value, evidence_activity_ids, computed_at
                FROM ability_snapshot
                ORDER BY date DESC, level, dimension
                LIMIT 80"""
            )
            records = [dict(r) for r in rows]
            latest_date = records[0]["date"] if records else None
            latest = [r for r in records if r["date"] == latest_date] if latest_date else []
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={"latest_date": latest_date, "latest": latest, "history": records},
        )


# ---------------------------------------------------------------------------
# 6. get_race_predictions
# ---------------------------------------------------------------------------


class GetRacePredictionsImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        db = _open_db(self._user_id)
        try:
            rows = db.query(
                "SELECT race_type, duration_s, avg_pace FROM race_predictions ORDER BY duration_s"
            )
            predictions = [dict(r) for r in rows]
        finally:
            db.close()
        return ToolResult(ok=True, data={"predictions": predictions})


# ---------------------------------------------------------------------------
# 7. get_pbs
# ---------------------------------------------------------------------------


class GetPbsImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        # Reuse the existing PB detection logic from routes/pbs.py so the
        # coach tool returns the same shape the dashboard already trusts.
        from stride_core.models import RUN_SPORT_SQL_LIST as _RUN_SPORT_SQL
        from stride_server.routes.pbs import _DISTANCE_ORDER, _detect_pbs

        db = _open_db(self._user_id)
        try:
            rows = db.query(
                f"""SELECT label_id, date, distance_m, duration_s
                FROM activities
                WHERE sport_type IN ({_RUN_SPORT_SQL})
                  AND distance_m IS NOT NULL
                  AND duration_s IS NOT NULL
                  AND duration_s > 0
                ORDER BY date ASC, label_id ASC"""
            )
            pb_map = _detect_pbs(rows)
        finally:
            db.close()
        pbs = [
            {**pb_map[dist], "distance": dist}
            for dist in _DISTANCE_ORDER
            if dist in pb_map
        ]
        return ToolResult(
            ok=True,
            data={
                "pbs": pbs,
                "computed_at": datetime.now(timezone.utc).isoformat(),
            },
        )


# ---------------------------------------------------------------------------
# 8. get_master_plan_current
# ---------------------------------------------------------------------------


class GetMasterPlanCurrentImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_server.master_plan_store import get_master_plan_store

        store = get_master_plan_store()
        plan = store.get_active_plan(self._user_id)
        if plan is None:
            return ToolResult(ok=True, data={"plan": None})
        return ToolResult(ok=True, data={"plan": plan.model_dump()})


# ---------------------------------------------------------------------------
# 9. get_master_plan_versions
# ---------------------------------------------------------------------------


class GetMasterPlanVersionsImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, plan_id: str) -> ToolResult:
        from stride_server.master_plan_store import get_master_plan_store

        store = get_master_plan_store()
        plan = store.get_plan(self._user_id, plan_id)
        if plan is None:
            return ToolResult(
                ok=False, errors=[f"master plan {plan_id!r} not found for user"]
            )
        versions = store.list_versions(plan_id)
        return ToolResult(
            ok=True,
            data={
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
            },
        )


# ---------------------------------------------------------------------------
# 10. get_week_plan
# ---------------------------------------------------------------------------


class GetWeekPlanImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, folder: str) -> ToolResult:
        from stride_core.state_stores import SqlitePlanStateStore
        from stride_server import content_store
        from stride_server.deps import parse_week_dates

        dates = parse_week_dates(folder)
        if not dates:
            return ToolResult(ok=False, errors=[f"invalid week folder {folder!r}"])
        date_from, date_to = dates

        db = _open_db(self._user_id)
        try:
            plan_store = SqlitePlanStateStore(db)
            plan_md = None
            plan_source = "none"
            plan_row = plan_store.get_weekly_plan_row(folder)
            if plan_row is not None:
                plan_md = plan_row["content_md"]
                plan_source = "db"
            else:
                plan_item = content_store.read_text(f"{self._user_id}/logs/{folder}/plan.md")
                if plan_item is not None:
                    plan_md = plan_item.content
                    plan_source = plan_item.source

            feedback_md = None
            feedback_source = "none"
            fb_row = plan_store.get_weekly_feedback_row(folder)
            if fb_row is not None:
                feedback_md = fb_row["content_md"]
                feedback_source = "db"
            else:
                fb_item = content_store.read_text(f"{self._user_id}/logs/{folder}/feedback.md")
                if fb_item is not None:
                    feedback_md = fb_item.content
                    feedback_source = fb_item.source

            sessions = plan_store.get_planned_sessions(week_folder=folder)
            nutrition = plan_store.get_planned_nutrition(week_folder=folder)
        finally:
            db.close()

        return ToolResult(
            ok=True,
            data={
                "folder": folder,
                "date_from": date_from,
                "date_to": date_to,
                "plan_md": plan_md,
                "plan_source": plan_source,
                "feedback_md": feedback_md,
                "feedback_source": feedback_source,
                "sessions": [dict(s) for s in sessions],
                "nutrition": [dict(n) for n in nutrition],
            },
        )


# ---------------------------------------------------------------------------
# 11. get_activity_detail
# ---------------------------------------------------------------------------


class GetActivityDetailImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, label_id: str) -> ToolResult:
        # Reuse the assembled detail builder from routes/activities.py so any
        # future change to the detail shape lands in both places at once.
        from stride_server.routes.activities import build_activity_detail

        db = _open_db(self._user_id)
        try:
            detail = build_activity_detail(db, label_id)
        finally:
            db.close()
        if detail is None:
            return ToolResult(ok=False, errors=[f"activity {label_id!r} not found"])
        return ToolResult(ok=True, data=detail)
