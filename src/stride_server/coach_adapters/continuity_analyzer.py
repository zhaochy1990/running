"""Deterministic continuity signals — see spec §4. Adapter layer (reads DB)."""
from __future__ import annotations

import logging
from datetime import date as date_cls

from coach.schemas import ContinuitySignals
from stride_core.models import RUN_SPORT_SQL_LIST

logger = logging.getLogger(__name__)

_KM_EXPR = "distance_m / 1000.0"


def _macro_cycle(race_date: str | None) -> str:
    if not race_date:
        return "unknown"
    try:
        m = date_cls.fromisoformat(race_date).month
    except (ValueError, TypeError):
        return "unknown"
    if m in (9, 10, 11):
        return "summer"
    if m in (2, 3, 4):
        return "winter"
    return "unknown"


def _injuries(profile: dict | None) -> list[str]:
    raw = (profile or {}).get("injuries") or []
    return [i for i in raw if isinstance(i, str) and i != "none"]


def _classify_form_zone(chronic, acute) -> str | None:
    """Canonical CTL-ratio form classification (spec §4 ratio bands). NOTE: this
    duplicates band logic elsewhere in the repo; spec flags single-source
    consolidation as a follow-up. Until then mirror it exactly."""
    if not chronic or chronic <= 0 or acute is None:
        return None
    ratio = acute / chronic
    if ratio < 0.75:
        return "减量过多"
    if ratio < 0.90:
        return "比赛就绪"
    if ratio <= 1.10:
        return "维持期"
    if ratio <= 1.25:
        return "提升期"
    return "过度负荷"


def _volume_signals(conn, as_of):
    rows = conn.execute(
        "SELECT strftime('%Y-%W', date) AS wk, SUM(" + _KM_EXPR + ") AS km, "
        "MAX(" + _KM_EXPR + ") AS longest FROM activities "
        "WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ") AND date >= date(?, '-56 days') "
        "GROUP BY wk ORDER BY wk",
        (as_of.isoformat(),),
    ).fetchall()
    if not rows:
        return 0, "unknown", None, 0.0
    weekly_km = [r[1] or 0.0 for r in rows]
    longest = max((r[2] or 0.0) for r in rows)
    aerobic_weeks = sum(1 for km in weekly_km if km >= 30.0)
    if len(weekly_km) >= 4:
        first, last = sum(weekly_km[:2]) / 2, sum(weekly_km[-2:]) / 2
        trend = "rising" if last > first * 1.08 else "falling" if last < first * 0.92 else "flat"
    else:
        trend = "unknown"
    # quality_sessions_per_week deferred to a follow-up (needs a confirmed
    # per-activity intensity/zone marker); v1 returns 0.0.
    return aerobic_weeks, trend, round(longest, 1) if longest else None, 0.0


def _detect_layoff(conn, as_of) -> bool:
    rows = conn.execute(
        "SELECT date(date) FROM activities WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ") "
        "AND date >= date(?, '-120 days') ORDER BY date",
        (as_of.isoformat(),),
    ).fetchall()
    days = [date_cls.fromisoformat(r[0]) for r in rows if r[0]]
    return any((b - a).days > 28 for a, b in zip(days, days[1:]))


def _season_context(race_date, as_of) -> str:
    mc = _macro_cycle(race_date)
    if mc == "summer":
        return "夏训块：起于夏季高温窗口，向秋季比赛过渡；长课需避正午、适合发展速度"
    if mc == "winter":
        return "冬训块：低温、消耗小，适合堆有氧大基础，向春季比赛过渡"
    return ""


def analyze_continuity(db, *, goal: dict, profile: dict | None, as_of: date_cls) -> ContinuitySignals:
    conn = db._conn
    race_date = (goal or {}).get("race_date")

    chronic = None
    form_zone = None
    try:
        row = conn.execute(
            "SELECT acute_load, chronic_load, form FROM daily_training_load ORDER BY date DESC LIMIT 1"
        ).fetchone()
        if row:
            atl, chronic, _form = row
            form_zone = _classify_form_zone(chronic, atl)
    except Exception as exc:  # noqa: BLE001
        logger.warning("continuity: load read failed: %s", exc)

    days_since_last_race = None
    recovery = "no_recent_race"
    try:
        # Race-flag column: `activities.train_kind` is the provider-agnostic
        # normalized TrainKind enum (stride_core.normalize.TrainKind), whose
        # RACE member's value is exactly the string "race" — so equality on
        # train_kind is the canonical race marker. COROS `trainType` 1-8 has NO
        # native race code (RACE is inferred), and the legacy `train_type`
        # column holds Title-Case localized labels ("Base", "Threshold", ...)
        # with no race string, so a `train_type LIKE '%race%'` would never
        # match anything useful. We additionally check `train_type = 'race'`
        # as a defensive exact-match backstop for any non-COROS provider that
        # might have written the literal into the legacy column.
        row = conn.execute(
            "SELECT MAX(date) FROM activities WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ") "
            "AND (train_kind = 'race' OR train_type = 'race')"
        ).fetchone()
        if row and row[0]:
            last = date_cls.fromisoformat(str(row[0])[:10])
            days_since_last_race = (as_of - last).days
            recovered = days_since_last_race >= 21 and form_zone in ("维持期", "比赛就绪", "减量过多")
            recovery = "recovered" if recovered else "recovering"
    except Exception as exc:  # noqa: BLE001
        logger.warning("continuity: race recency failed: %s", exc)

    aerobic_weeks, trend, longest_km, quality_per_week = _volume_signals(conn, as_of)

    return ContinuitySignals(
        days_since_last_race=days_since_last_race,
        post_race_recovery_status=recovery,
        recent_aerobic_weeks=aerobic_weeks,
        recent_volume_trend=trend,
        recent_longest_run_km=longest_km,
        recent_quality_sessions_per_week=quality_per_week,
        current_form_zone=form_zone,
        current_chronic_load=round(chronic, 1) if chronic is not None else None,
        return_from_layoff=_detect_layoff(conn, as_of),
        macro_cycle=_macro_cycle(race_date),
        season_context=_season_context(race_date, as_of),
        injuries=_injuries(profile),
    )
