"""Concrete read-tool implementations — see plan §5.1.

Each impl is a callable class bound to a single ``user_id``; calling it opens
a short-lived DB connection, queries, and returns a :class:`ToolResult`.

Per plan §5.4 tools MUST NOT raise: unexpected exceptions are caught by
:func:`_tool_safe` and surfaced as ``ToolResult(ok=False, errors=[...])`` so
the graph can stay deterministic.

The loader logic lives here rather than calling the existing route handlers —
those handlers expect FastAPI
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
    from stride_storage.sqlite.database import Database

    return Database(user=user_id)


def _activity_payload(row: Any) -> dict[str, Any]:
    """Return the compact activity shape consumed by coach prompts."""
    from stride_core.models import pace_str
    from stride_server.deps import format_duration

    d = dict(row)
    d["distance_km"] = round(d["distance_m"] / 1000.0, 2) if d.get("distance_m") else 0
    d["duration_fmt"] = format_duration(d.get("duration_s"))
    d["pace_fmt"] = pace_str(d.get("avg_pace_s_km")) or "—"
    return d


def _form_zone(form: float | None, chronic: float | None) -> tuple[str, str]:
    """Classify form by CTL ratio (``form / chronic``), per CLAUDE.md doctrine.

    NOT the classic fixed TSB thresholds — those are calibrated for cyclist
    CTL 80-120; runners run CTL 40-70, so the same absolute TSB means a very
    different state. ``form = chronic - acute`` (both STRIDE-computed). Mirrors
    ``frontend/src/pages/TrainingStatusPage.tsx::classifyForm``.
    """
    if form is None or not chronic or chronic <= 0:
        return "unknown", "数据不足"
    ratio = form / chronic
    if ratio > 0.25:
        return "detraining", "减量过多"
    if ratio >= 0.10:
        return "race_ready", "比赛就绪"
    if ratio >= -0.10:
        return "neutral", "维持期"
    if ratio >= -0.25:
        return "building", "提升期"
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
                    avg_cadence, calories_kcal, vo2max, train_type,
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
            # STRIDE self-computed training load (vendor-agnostic) — NOT COROS
            # ati/cti. Lets the coach reason on one scale across watch brands.
            rows = db.query(
                """SELECT date, acute_load, chronic_load, form, load_ratio
                FROM daily_training_load
                WHERE algorithm_version = (
                    SELECT MAX(algorithm_version) FROM daily_training_load
                )
                ORDER BY date DESC
                LIMIT 1"""
            )
            latest = dict(rows[0]) if rows else None
            if latest is not None:
                zone, label = _form_zone(latest.get("form"), latest.get("chronic_load"))
                latest["form_zone"] = zone
                latest["form_zone_label"] = label
                # Resting HR is a measured signal (not a vendor-computed load
                # metric), so it stays — sourced from daily_health.
                rhr_rows = db.query(
                    "SELECT rhr FROM daily_health ORDER BY date DESC LIMIT 1"
                )
                if rhr_rows:
                    latest["rhr"] = dict(rhr_rows[0]).get("rhr")

            # Dashboard keeps raw signals (HRV) + vendor readiness; threshold
            # HR/pace are NOT taken from here — those are STRIDE-calibrated below.
            dash_rows = db.query(
                """SELECT avg_sleep_hrv, hrv_normal_low, hrv_normal_high, recovery_pct,
                    running_level, aerobic_score
                FROM dashboard WHERE id = 1"""
            )
            dashboard = dict(dash_rows[0]) if dash_rows else {}

            # STRIDE self-computed threshold (LTHR + threshold pace) — single
            # source per CLAUDE.md (RunningCalibrationRepository), NOT the COROS
            # dashboard threshold. Supplementary, so a failure degrades to None
            # rather than failing the whole snapshot.
            calibration = None
            try:
                from stride_storage.sqlite.calibration_connector import (
                    SQLiteRunningCalibrationRepository,
                )
                from stride_core.timefmt import today_shanghai

                snap = SQLiteRunningCalibrationRepository(db).fetch_latest(
                    as_of_date=today_shanghai()
                )
                if snap is not None:
                    thr_pace = (
                        round(1000.0 / snap.threshold_speed_mps)
                        if snap.threshold_speed_mps
                        else None
                    )
                    conf = snap.threshold_hr_confidence
                    calibration = {
                        "threshold_hr": snap.threshold_hr,
                        "threshold_pace_s_km": thr_pace,
                        "threshold_hr_confidence": getattr(conf, "value", str(conf)),
                    }
            except Exception:  # noqa: BLE001 — calibration is supplementary
                logging.getLogger(__name__).warning(
                    "get_health_snapshot: STRIDE calibration fetch failed", exc_info=True
                )
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={"latest": latest, "dashboard": dashboard, "calibration": calibration},
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
            # STRIDE self-computed PMC (acute/chronic/form/load_ratio), NOT COROS
            # ati/cti — ``form`` is already ``chronic - acute``, no recompute.
            rows = db.query(
                """SELECT date, acute_load, chronic_load, form, load_ratio
                FROM daily_training_load
                WHERE algorithm_version = (
                    SELECT MAX(algorithm_version) FROM daily_training_load
                )
                ORDER BY date DESC LIMIT ?""",
                (max(1, int(days)),),
            )
            records = [dict(r) for r in rows]
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={"granularity": granularity, "days": days, "series": records},
        )


def _norm_day(value: object) -> str:
    """Normalise a stored date to ISO ``YYYY-MM-DD`` (daily_health uses YYYYMMDD)."""
    s = str(value)
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]


class GetTrainingEnvironmentImpl:
    """Training environment: altitude band + signal-informed acclimatization.

    Surfaces *where* the athlete trains (STRIDE-detected altitude, vendor-agnostic)
    and how far along an acute acclimatization episode they are (RHR/HRV trajectory
    vs the running_calibration baseline). ``weather`` is reserved for a later
    signal. Pure detection lives in ``coach.environment``; this only gathers data.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, days: int = 120) -> ToolResult:
        from datetime import timedelta

        from coach.environment import build_training_environment
        from stride_core.timefmt import today_shanghai, utc_iso_to_shanghai_iso

        db = _open_db(self._user_id)
        try:
            as_of = today_shanghai()
            cutoff = (as_of - timedelta(days=max(7, int(days)))).isoformat()
            # Per-run representative altitude (recent runs only — timeseries is large).
            alt_rows = db.query(
                """SELECT a.date AS udate, AVG(t.altitude) AS alt
                FROM activities a JOIN timeseries t ON t.label_id = a.label_id
                WHERE t.altitude IS NOT NULL
                  AND date(datetime(a.date, '+8 hours')) >= ?
                GROUP BY a.label_id
                ORDER BY a.date""",
                (cutoff,),
            )
            altitude_series = [
                (utc_iso_to_shanghai_iso(r["udate"])[:10], float(r["alt"]))
                for r in alt_rows
                if r["alt"] is not None
            ]
            rhr_rows = db.query(
                "SELECT date, rhr FROM daily_health WHERE rhr IS NOT NULL ORDER BY date"
            )
            rhr_series = [(_norm_day(r["date"]), float(r["rhr"])) for r in rhr_rows]
            # daily_hrv PK is (date, provider): a dual-watch user has two rows
            # per night. Read through the canonical per-date provider picker so
            # the series isn't double-counted (skews the acclimatization median).
            from stride_storage.sqlite.database import HRV_PREFERRED_PER_DATE_SQL

            hrv_rows = db.query(
                f"SELECT date, last_night_avg FROM ({HRV_PREFERRED_PER_DATE_SQL}) "
                "WHERE last_night_avg IS NOT NULL ORDER BY date"
            )
            hrv_series = [(_norm_day(r["date"]), float(r["last_night_avg"])) for r in hrv_rows]

            rhr_baseline = None
            try:
                from stride_storage.sqlite.calibration_connector import (
                    SQLiteRunningCalibrationRepository,
                )

                snap = SQLiteRunningCalibrationRepository(db).fetch_latest(as_of_date=as_of)
                if snap is not None:
                    rhr_baseline = snap.rhr_baseline
            except Exception:  # noqa: BLE001 — baseline is supplementary
                logging.getLogger(__name__).warning(
                    "get_training_environment: calibration fetch failed", exc_info=True
                )
        finally:
            db.close()

        if not altitude_series:
            return ToolResult(ok=True, data={"environment": None})

        env = build_training_environment(
            altitude_series=altitude_series,
            rhr_series=rhr_series,
            hrv_series=hrv_series,
            rhr_baseline=rhr_baseline,
            as_of=as_of,
        )
        return ToolResult(ok=True, data={"environment": env.model_dump()})


# ---------------------------------------------------------------------------
# 4. get_body_composition_latest
# ---------------------------------------------------------------------------


class GetBodyCompositionLatestImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_storage.sqlite.state_stores import SqliteInBodyStore

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
        from stride_core.pb_records import DISTANCE_ORDER, load_personal_bests

        db = _open_db(self._user_id)
        try:
            # Single source: read the persisted personal_bests table (populated
            # post-sync). load_personal_bests self-heals when never scanned and
            # records PB-less users so there's no ~7s re-scan per call.
            pb_map = load_personal_bests(db)
        finally:
            db.close()
        pbs = [
            pb_map[dist]
            for dist in DISTANCE_ORDER
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
        from stride_storage.sqlite.state_stores import SqlitePlanStateStore
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
