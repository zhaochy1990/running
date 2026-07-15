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
from datetime import date as date_cls, timedelta
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
    """Open a ``stride_storage.sqlite.database.Database`` for ``user_id``. Lazy-imported so
    tool_impls is testable without ``stride_core.db`` initialised in unusual
    environments (e.g. minimal CI containers)."""
    from stride_storage.sqlite.database import Database

    return Database(user=user_id)


def _activity_payload(row: Any) -> dict[str, Any]:
    """Return raw activity facts plus an explicitly STRIDE-computed load."""
    import json

    from stride_core.models import pace_str
    from stride_server.deps import format_duration

    d = dict(row)
    d["distance_km"] = round(d["distance_m"] / 1000.0, 2) if d.get("distance_m") else 0
    d["duration_fmt"] = format_duration(d.get("duration_s"))
    d["pace_fmt"] = pace_str(d.get("avg_pace_s_km")) or "—"
    raw_reasons = d.pop("stride_reasons_json", None)
    try:
        reasons = json.loads(raw_reasons) if raw_reasons else []
    except (TypeError, ValueError):
        reasons = []
    stride_load = {
        "source": "stride",
        "vendor_derived": False,
        "algorithm_version": d.pop("stride_algorithm_version", None),
        "calibration_id": d.pop("stride_calibration_id", None),
        "session_class": d.pop("stride_session_class", None),
        "cardio_load_raw": d.pop("stride_cardio_load_raw", None),
        "cardio_tss": d.pop("stride_cardio_tss", None),
        "external_tss": d.pop("stride_external_tss", None),
        "mechanical_load": d.pop("stride_mechanical_load", None),
        "subjective_internal_load": d.pop("stride_subjective_internal_load", None),
        "training_dose": d.pop("stride_training_dose", None),
        "load_confidence": d.pop("stride_load_confidence", None),
        "excluded_from_pmc": (
            bool(value) if (value := d.pop("stride_excluded_from_pmc", None)) is not None else None
        ),
        "reasons": reasons,
    }
    stride_load["available"] = stride_load["algorithm_version"] is not None
    if not stride_load["available"]:
        stride_load["missing_reason"] = "stride_load_not_computed"
    d["stride_training_load"] = stride_load
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
# 1. get_training_summary
# ---------------------------------------------------------------------------


class GetTrainingSummaryImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(
        self, *, date_from: str | None = None, date_to: str | None = None
    ) -> ToolResult:
        from stride_core.timefmt import today_shanghai
        from stride_storage.sqlite.coach_metrics import coach_metric_provenance
        from stride_storage.sqlite.training_summary import get_training_summary

        if (date_from is None) != (date_to is None):
            return ToolResult(
                ok=False,
                errors=["date_from and date_to must be provided together"],
            )
        if date_from is None:
            this_monday = today_shanghai() - timedelta(days=today_shanghai().weekday())
            start = this_monday - timedelta(days=7)
            end = this_monday - timedelta(days=1)
            date_from, date_to = start.isoformat(), end.isoformat()

        db = _open_db(self._user_id)
        try:
            data = get_training_summary(
                db, date_from=str(date_from), date_to=str(date_to)
            )
        finally:
            db.close()
        data["provenance"] = coach_metric_provenance()
        return ToolResult(ok=True, data=data)


# ---------------------------------------------------------------------------
# 2. get_recent_activities
# ---------------------------------------------------------------------------


class GetRecentActivitiesImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, limit: int = 14) -> ToolResult:
        from stride_storage.sqlite.coach_metrics import (
            coach_metric_provenance,
            fetch_recent_activities,
        )

        db = _open_db(self._user_id)
        try:
            rows = fetch_recent_activities(db, limit=limit)
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={
                "activities": [_activity_payload(r) for r in rows],
                "provenance": coach_metric_provenance(),
            },
        )


# ---------------------------------------------------------------------------
# 2. get_health_snapshot
# ---------------------------------------------------------------------------


class GetHealthSnapshotImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_storage.sqlite.coach_metrics import (
            coach_metric_provenance,
            fetch_latest_health_context,
        )

        db = _open_db(self._user_id)
        try:
            context = fetch_latest_health_context(db)
            stride_training_load = context["load"]
            if stride_training_load is not None:
                zone, label = _form_zone(
                    stride_training_load.get("form"),
                    stride_training_load.get("chronic_load"),
                )
                stride_training_load["form_zone"] = zone
                stride_training_load["form_zone_label"] = label
                stride_training_load["source"] = "stride"
                stride_training_load["vendor_derived"] = False
            raw_measurements = {
                "rhr": context["rhr"],
                "hrv": context["hrv"],
            }

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
            data={
                "stride_training_load": stride_training_load,
                "raw_measurements": raw_measurements,
                "stride_calibration": calibration,
                "provenance": coach_metric_provenance(),
            },
        )


# ---------------------------------------------------------------------------
# 3. get_health_series
# ---------------------------------------------------------------------------


_HEALTH_SERIES_LOAD_METRICS = (
    "training_dose",
    "acute_load",
    "chronic_load",
    "form",
    "load_ratio",
)
_HEALTH_SERIES_HRV_METRICS = (
    "hrv_last_night_avg",
    "hrv_last_night_5min_high",
)
_SUPPORTED_HEALTH_SERIES_METRICS = (
    "rhr",
    *_HEALTH_SERIES_HRV_METRICS,
    *_HEALTH_SERIES_LOAD_METRICS,
)
_DEFAULT_HEALTH_SERIES_METRICS = (
    "rhr",
    "hrv_last_night_avg",
    "acute_load",
    "chronic_load",
    "form",
    "load_ratio",
)
_HEALTH_SERIES_ALIASES: dict[str, tuple[str, ...]] = {
    "all": _SUPPORTED_HEALTH_SERIES_METRICS,
    "hrv": _HEALTH_SERIES_HRV_METRICS,
    "load": _HEALTH_SERIES_LOAD_METRICS,
    "pmc": _HEALTH_SERIES_LOAD_METRICS,
    "training_load": _HEALTH_SERIES_LOAD_METRICS,
    "recovery": (
        "rhr",
        "hrv_last_night_avg",
        "acute_load",
        "chronic_load",
        "form",
        "load_ratio",
    ),
}


def _normalise_health_series_metrics(metrics: list[str] | None) -> tuple[list[str], list[str]]:
    requested = metrics or list(_DEFAULT_HEALTH_SERIES_METRICS)
    supported = set(_SUPPORTED_HEALTH_SERIES_METRICS)
    selected: list[str] = []
    invalid: list[str] = []
    for raw in requested:
        key = str(raw).strip().lower().replace("-", "_")
        if not key:
            continue
        expanded = _HEALTH_SERIES_ALIASES.get(key, (key,))
        for metric in expanded:
            if metric not in supported:
                invalid.append(metric)
            elif metric not in selected:
                selected.append(metric)
    return selected, invalid


class GetHealthSeriesImpl:
    """General daily health series reader for bounded, whitelisted metrics.

    This gives the coach one flexible read tool for questions such as "最近 7 天
    RHR/HRV", "近 14 天恢复状态", or "最近一个月负荷趋势" without
    exposing arbitrary SQL or provider-derived health/load scores.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, days: int = 14, metrics: list[str] | None = None) -> ToolResult:
        from stride_storage.sqlite.coach_metrics import (
            coach_metric_provenance,
            fetch_health_series_context,
        )

        limit = max(1, min(int(days), 365))
        selected, invalid = _normalise_health_series_metrics(metrics)
        if invalid:
            return ToolResult(
                ok=False,
                errors=[
                    "unsupported metrics: "
                    + ", ".join(sorted(set(invalid)))
                    + "; supported metrics: "
                    + ", ".join(_SUPPORTED_HEALTH_SERIES_METRICS)
                    + "; aliases: "
                    + ", ".join(sorted(_HEALTH_SERIES_ALIASES))
                ],
            )

        db = _open_db(self._user_id)
        try:
            context = fetch_health_series_context(db, limit=limit)
        finally:
            db.close()

        by_date: dict[str, dict[str, Any]] = {}
        for row in context["health"]:
            day = _norm_day(row["date"])
            merged = by_date.setdefault(day, {"date": day})
            if "rhr" in selected:
                merged["rhr"] = row["rhr"]

        for row in context["hrv"]:
            day = _norm_day(row["date"])
            merged = by_date.setdefault(day, {"date": day})
            hrv_metric_map = {
                "hrv_last_night_avg": row["last_night_avg"],
                "hrv_last_night_5min_high": row["last_night_5min_high"],
            }
            for metric, value in hrv_metric_map.items():
                if metric in selected:
                    merged[metric] = value

        for row in context["load"]:
            day = _norm_day(row["date"])
            merged = by_date.setdefault(day, {"date": day})
            for metric in _HEALTH_SERIES_LOAD_METRICS:
                if metric not in selected:
                    continue
                merged[metric] = row[metric]

        # Return chart/chat-friendly oldest -> newest order.
        series = sorted(by_date.values(), key=lambda item: item["date"])[-limit:]
        coverage = {
            metric: sum(1 for row in series if row.get(metric) is not None)
            for metric in selected
        }
        return ToolResult(
            ok=True,
            data={
                "days": limit,
                "metrics": selected,
                "series": series,
                "coverage": coverage,
                "supported_metrics": list(_SUPPORTED_HEALTH_SERIES_METRICS),
                "aliases": {k: list(v) for k, v in _HEALTH_SERIES_ALIASES.items()},
                "provenance": coach_metric_provenance(),
            },
        )


# ---------------------------------------------------------------------------
# 4. get_pmc_series
# ---------------------------------------------------------------------------


class GetPmcSeriesImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self, *, days: int = 42, granularity: str = "daily") -> ToolResult:
        from stride_storage.sqlite.coach_metrics import (
            coach_metric_provenance,
            fetch_stride_pmc_series,
        )

        if granularity not in ("daily", "weekly"):
            return ToolResult(
                ok=False,
                errors=[f"granularity must be 'daily' or 'weekly', got {granularity!r}"],
            )
        db = _open_db(self._user_id)
        try:
            rows = fetch_stride_pmc_series(db, limit=days)
            records = [
                {**dict(r), "source": "stride", "vendor_derived": False}
                for r in rows
            ]
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={
                "granularity": granularity,
                "days": days,
                "series": records,
                "provenance": coach_metric_provenance(include_raw_measurements=False),
            },
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
            return ToolResult(
                ok=True,
                data={
                    "environment": None,
                    "provenance": {
                        "environment": {
                            "source": "stride",
                            "kind": "computed",
                            "inputs": ["raw_altitude", "raw_rhr", "raw_hrv"],
                            "vendor_derived": False,
                        }
                    },
                },
            )

        env = build_training_environment(
            altitude_series=altitude_series,
            rhr_series=rhr_series,
            hrv_series=hrv_series,
            rhr_baseline=rhr_baseline,
            as_of=as_of,
        )
        return ToolResult(
            ok=True,
            data={
                "environment": env.model_dump(),
                "provenance": {
                    "environment": {
                        "source": "stride",
                        "kind": "computed",
                        "inputs": ["raw_altitude", "raw_rhr", "raw_hrv"],
                        "vendor_derived": False,
                    }
                },
            },
        )


# ---------------------------------------------------------------------------
# 5. estimate_master_plan_load
# ---------------------------------------------------------------------------


class EstimateMasterPlanLoadImpl:
    """Estimate historical anchors and planned load for a master plan draft.

    This is a read tool: it performs no writes and can be used both by the
    conversation agent and the S1 generation adapter. ``plan`` may be a raw LLM
    envelope, a ``MasterPlan.model_dump()`` dict, or omitted to estimate the
    user's active master plan.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(
        self,
        *,
        plan: dict | None = None,
        target_race: dict | None = None,
        weekly_run_days_max: int | None = None,
        injuries: list[str] | None = None,
        as_of_date: str | None = None,
    ) -> ToolResult:
        from stride_server.coach_adapters.master_plan_load import (
            build_training_history_load_anchor,
            estimate_master_plan_training_load,
        )
        from stride_server.master_plan_generator import _query_history
        from stride_server.master_plan_store import get_master_plan_store

        as_of = None
        if as_of_date:
            as_of = date_cls.fromisoformat(str(as_of_date))
        history = _query_history(self._user_id, as_of=as_of)
        anchor = build_training_history_load_anchor(history)
        source = "provided"
        plan_obj: dict | None = plan
        if plan_obj is None:
            active = get_master_plan_store().get_active_plan(self._user_id)
            plan_obj = active.model_dump(mode="json") if active is not None else None
            source = "active"
        if plan_obj is None:
            return ToolResult(
                ok=True,
                data={
                    "history_anchor": anchor,
                    "plan_estimate": None,
                    "plan_source": source,
                },
            )
        estimate = estimate_master_plan_training_load(
            plan_obj,
            history_anchor=anchor,
            target_race=target_race,
            weekly_run_days_max=weekly_run_days_max,
            injuries=injuries,
        )
        return ToolResult(
            ok=True,
            data={
                "history_anchor": anchor,
                "plan_estimate": estimate,
                "plan_source": source,
            },
        )


# ---------------------------------------------------------------------------
# 6. get_body_composition_latest
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
# 6. get_ability_snapshot
# ---------------------------------------------------------------------------


class GetAbilitySnapshotImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_storage.sqlite.coach_metrics import (
            coach_metric_provenance,
            fetch_coach_ability_rows,
        )

        db = _open_db(self._user_id)
        try:
            rows = fetch_coach_ability_rows(db)
            records = [dict(r) for r in rows]
            latest_date = records[0]["date"] if records else None
            latest = [r for r in records if r["date"] == latest_date] if latest_date else []
        finally:
            db.close()
        return ToolResult(
            ok=True,
            data={
                "latest_date": latest_date,
                "latest": latest,
                "history": records,
                "provenance": coach_metric_provenance(
                    include_raw_measurements=False, include_ability=True
                ),
            },
        )


# ---------------------------------------------------------------------------
# 7. get_race_predictions
# ---------------------------------------------------------------------------


class GetRacePredictionsImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_server.routes.predictions import (
            _predictions_from_vdot,
            _vdot_from_score,
        )
        from stride_storage.sqlite.coach_metrics import (
            fetch_latest_coach_vo2max_score,
        )

        db = _open_db(self._user_id)
        try:
            row = fetch_latest_coach_vo2max_score(db)
        finally:
            db.close()
        score = float(row["value"]) if row is not None and row["value"] is not None else None
        if score is None or score <= 0:
            return ToolResult(
                ok=True,
                data={
                    "predictions": [],
                    "provenance": {
                        "predictions": {
                            "source": "stride",
                            "kind": "computed",
                            "model": "ability_vdot_race_prediction",
                            "vendor_derived": False,
                        }
                    },
                },
            )
        vdot = _vdot_from_score(score)
        return ToolResult(
            ok=True,
            data={
                "predictions": _predictions_from_vdot(vdot),
                "vo2max": round(vdot, 1),
                "computed_at": row["date"],
                "provenance": {
                    "predictions": {
                        "source": "stride",
                        "kind": "computed",
                        "model": "ability_vdot_race_prediction",
                        "vendor_derived": False,
                    }
                },
            },
        )


# ---------------------------------------------------------------------------
# 8. get_pbs
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
                "provenance": {
                    "personal_bests": {
                        "source": "stride",
                        "kind": "computed",
                        "model": "best_effort_activity_detector",
                        "inputs": ["raw_activity_distance", "raw_activity_duration"],
                        "vendor_derived": False,
                    }
                },
            },
        )


# ---------------------------------------------------------------------------
# 9. get_master_plan_current
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
# 10. get_master_plan_versions
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
# 11. get_week_plan
# ---------------------------------------------------------------------------


class GetWeekPlanImpl:
    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    @_tool_safe
    def __call__(self) -> ToolResult:
        from stride_core.timefmt import today_shanghai
        from stride_server.weekly_plan_store import get_weekly_plan_store

        on_date = today_shanghai().isoformat()
        canonical_plan = get_weekly_plan_store().get_current_plan(
            self._user_id, on_date
        )
        if canonical_plan is None:
            return ToolResult(
                ok=True,
                data={
                    "week_folder": None,
                    "on_date": on_date,
                    "date_from": None,
                    "date_to": None,
                    "structured_source": "weekly_plan_store",
                    "available": False,
                    "missing_reason": "no_plan_for_current_shanghai_week",
                    "user_message": "当前周还没有训练计划，你要创建本周的训练计划吗？",
                    "sessions": [],
                    "nutrition": [],
                    "notes_md": None,
                },
            )

        from stride_core.timefmt import parse_week_folder_dates

        dates = parse_week_folder_dates(canonical_plan.week_folder)
        if dates is None:  # defensive: canonical stores validate this on write
            return ToolResult(
                ok=False,
                errors=[f"invalid canonical week folder {canonical_plan.week_folder!r}"],
            )
        date_from, date_to = dates

        return ToolResult(
            ok=True,
            data={
                "week_folder": canonical_plan.week_folder,
                "on_date": on_date,
                "date_from": date_from,
                "date_to": date_to,
                "structured_source": "weekly_plan_store",
                "available": True,
                "missing_reason": None,
                "user_message": None,
                "sessions": [session.to_dict() for session in canonical_plan.sessions],
                "nutrition": [item.to_dict() for item in canonical_plan.nutrition],
                "notes_md": canonical_plan.notes_md,
            },
        )


# ---------------------------------------------------------------------------
# 12. get_activity_detail
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
        activity = detail.get("activity") or {}
        for field in (
            "training_load",
            "vo2max",
            "performance",
            "train_type",
            "aerobic_effect",
            "anaerobic_effect",
            "calories_kcal",
            "adjusted_pace",
            "commentary",
            "commentary_generated_by",
            "commentary_generated_at",
        ):
            activity.pop(field, None)
        for row in [*(detail.get("laps") or []), *(detail.get("segments") or [])]:
            row.pop("adjusted_pace", None)
        for row in detail.get("timeseries") or []:
            row.pop("adjusted_pace", None)
        # Provider-defined zones and existing commentary can carry derived
        # watch metrics. Coach gets raw series + STRIDE calibration/load instead.
        detail.pop("zones", None)
        stride_load = detail.get("stride_training_load")
        if stride_load is None:
            detail["stride_training_load"] = {
                "source": "stride",
                "vendor_derived": False,
                "available": False,
                "missing_reason": "stride_load_not_computed",
            }
        else:
            stride_load["source"] = "stride"
            stride_load["vendor_derived"] = False
            stride_load["available"] = True
        detail["provenance"] = {
            "activity": {
                "source": "watch_raw",
                "kind": "measurement",
                "vendor_derived": False,
            },
            "training_load": {
                "source": "stride",
                "kind": "computed",
                "model": "objective_training_load",
                "vendor_derived": False,
            },
        }
        return ToolResult(ok=True, data=detail)
