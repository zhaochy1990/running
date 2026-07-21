"""``GET /api/{user}/home`` — mobile home-screen aggregation.

Bundles status-ring (fatigue + TSB + load), recent activities (with commentary
excerpts), weekly + lifetime rollups, plan slot, and watch info into a single
payload so the mobile app's home screen only needs one round-trip.

A small in-memory TTL cache (60s) sits in front of the aggregation because
this endpoint hits ~5 tables on every call and the underlying data only
updates on watch sync — there is no point recomputing on every refresh.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel

from stride_core.distance import meters_to_km
from stride_core.models import RUN_SPORT_SQL_LIST as _RUN_SPORT_SQL
from stride_core.registry import read_user_provider, user_has_config
from stride_core.timefmt import SHANGHAI_DAY_SQL, today_shanghai, utc_iso_to_shanghai_iso

from ..deps import get_db

router = APIRouter()


# ── Response schema ────────────────────────────────────────────────────────


class StatusRing(BaseModel):
    # STRIDE-computed training load only — no vendor (COROS/Garmin) fatigue or
    # load-state scores. `tsb` is STRIDE form (chronic − acute); `load_ratio`
    # is STRIDE acute/chronic. See routes/health.py `/pmc` for the same source.
    tsb: float | None
    tsb_band: Literal[
        "race_ready", "transitional", "productive", "overload", "detraining"
    ] | None
    load_ratio: float | None
    chronic_load: float | None
    acute_load: float | None


class RecentActivity(BaseModel):
    label_id: str
    date: str
    name: str | None
    sport_type: int | None
    distance_km: float | None
    duration_sec: float | None
    avg_pace_sec_per_km: float | None
    avg_hr: int | None
    calories: int | None
    commentary_excerpt: str | None
    commentary_generated_by: str | None


class WeeklyStats(BaseModel):
    week_start: str
    total_distance_km: float
    total_duration_sec: float
    session_count: int
    long_run_km: float


class LifetimeStats(BaseModel):
    total_distance_km: float
    total_activities: int


class WatchInfo(BaseModel):
    brand: Literal["coros", "garmin"] | None
    last_sync_at: str | None


class HomeResponse(BaseModel):
    status_ring: StatusRing
    recent_activities: list[RecentActivity]
    weekly_stats: WeeklyStats
    lifetime_stats: LifetimeStats
    # plan_state semantics:
    #   "none"           → user has no active master plan yet (CTA: build plan)
    #   "active_no_week" → master plan active but no planned_session this week
    #                       (CTA: generate this week's plan)
    #   "active"         → master plan active and this week's plan exists
    plan_state: Literal["none", "active_no_week", "active"] = "none"
    watch: WatchInfo


# ── 60s TTL cache ──────────────────────────────────────────────────────────

_CACHE_TTL_SEC = 60.0
_cache: dict[tuple[str, int], tuple[float, HomeResponse]] = {}


def _cache_get(key: tuple[str, int]) -> HomeResponse | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.monotonic() - ts > _CACHE_TTL_SEC:
        _cache.pop(key, None)
        return None
    return value


def _cache_put(key: tuple[str, int], value: HomeResponse) -> None:
    _cache[key] = (time.monotonic(), value)


def _clear_cache() -> None:
    """Test hook — wipe the module-level cache between cases."""
    _cache.clear()


# ── Band helpers ───────────────────────────────────────────────────────────


def _tsb_band(
    ratio: float | None,
) -> Literal["race_ready", "transitional", "productive", "overload", "detraining"] | None:
    """Map ACWR (ATI/CTI) to a TSB descriptor.

    Mirrors the bands in ``routes/health.py``'s ``/pmc`` endpoint so the
    mobile home ring and the web PMC chart agree on labels.
    """
    if ratio is None:
        return None
    if ratio < 0.6:
        return "detraining"
    if ratio < 0.85:
        return "race_ready"
    if ratio < 1.1:
        return "transitional"
    if ratio < 1.3:
        return "productive"
    return "overload"


# ── Aggregation ────────────────────────────────────────────────────────────


def _build_status_ring(db) -> StatusRing:
    # STRIDE-computed load from `daily_training_load` (NOT COROS ati/cti). Same
    # table the `/pmc` endpoint reads; canonical one-row-per-date series.
    # `form` = chronic − acute; `load_ratio` = acute/chronic.
    row = db.fetch_latest_daily_training_load()
    if row is None:
        return StatusRing(
            tsb=None, tsb_band=None, load_ratio=None,
            chronic_load=None, acute_load=None,
        )
    r = dict(row)
    chronic = r.get("chronic_load")
    acute = r.get("acute_load")
    form = r.get("form")
    if form is None and chronic is not None and acute is not None:
        form = round(chronic - acute, 1)
    ratio = r.get("load_ratio")
    if ratio is None and chronic:
        ratio = acute / chronic if acute is not None else None
    return StatusRing(
        tsb=form,
        tsb_band=_tsb_band(ratio),
        load_ratio=ratio,
        chronic_load=round(chronic, 1) if chronic is not None else None,
        acute_load=round(acute, 1) if acute is not None else None,
    )


def _build_recent_activities(db, days: int) -> list[RecentActivity]:
    # Cutoff in Shanghai calendar (server TZ is UTC on Azure Container Apps —
    # date.today() would drift). The SQL converts the UTC-stored `date` to
    # Shanghai-local YYYY-MM-DD for an apples-to-apples comparison.
    cutoff = (today_shanghai() - timedelta(days=days)).isoformat()
    rows = db.query(
        f"""
        SELECT a.label_id, a.name, a.sport_type, a.date,
               a.distance_m, a.duration_s, a.avg_pace_s_km, a.avg_hr, a.calories_kcal,
               c.commentary, c.generated_by AS commentary_generated_by
        FROM activities a
        LEFT JOIN activity_commentary c ON c.label_id = a.label_id
        WHERE date(datetime(a.date, '+8 hours')) >= ?
        ORDER BY a.date DESC, a.label_id DESC
        """,
        (cutoff,),
    )
    out: list[RecentActivity] = []
    for r in rows:
        commentary = r["commentary"]
        excerpt = None
        if isinstance(commentary, str) and commentary.strip():
            text = commentary.strip().replace("\r", "")
            # Take first non-empty line, capped at 140 chars.
            first = next((ln.strip() for ln in text.split("\n") if ln.strip()), "")
            excerpt = first[:140] if first else None
        distance_m = r["distance_m"]
        out.append(RecentActivity(
            label_id=r["label_id"],
            # UTC → Shanghai ISO at the API boundary; see stride_core/timefmt.py.
            date=utc_iso_to_shanghai_iso(r["date"]) or r["date"],
            name=r["name"],
            sport_type=r["sport_type"],
            distance_km=meters_to_km(distance_m, digits=2),
            duration_sec=r["duration_s"],
            avg_pace_sec_per_km=r["avg_pace_s_km"],
            avg_hr=r["avg_hr"],
            calories=r["calories_kcal"],
            commentary_excerpt=excerpt,
            commentary_generated_by=r["commentary_generated_by"],
        ))
    return out


def _build_weekly_stats(db) -> WeeklyStats:
    # Week boundary in Shanghai calendar — see stride_core/timefmt.py.
    today = today_shanghai()
    monday = today - timedelta(days=today.weekday())
    week_start_iso = monday.isoformat()
    rows = db.query(
        f"""
        SELECT distance_m, duration_s
        FROM activities
        WHERE {SHANGHAI_DAY_SQL} >= ? AND sport_type IN ({_RUN_SPORT_SQL})
        """,
        (week_start_iso,),
    )
    total_km = 0.0
    total_sec = 0.0
    long_km = 0.0
    count = 0
    for r in rows:
        d = r["distance_m"] or 0
        s = r["duration_s"] or 0
        total_km += d / 1000.0
        total_sec += s
        if d / 1000.0 > long_km:
            long_km = d / 1000.0
        count += 1
    return WeeklyStats(
        week_start=week_start_iso,
        total_distance_km=round(total_km, 2),
        total_duration_sec=round(total_sec, 1),
        session_count=count,
        long_run_km=round(long_km, 2),
    )


def _build_lifetime_stats(db) -> LifetimeStats:
    row = db.query(
        "SELECT count(*) AS cnt, coalesce(sum(distance_m), 0) / 1000.0 AS km FROM activities"
    )
    if not row:
        return LifetimeStats(total_distance_km=0.0, total_activities=0)
    r = dict(row[0])
    return LifetimeStats(
        total_distance_km=round(r["km"] or 0.0, 2),
        total_activities=int(r["cnt"] or 0),
    )


def _build_watch_info(db, user: str) -> WatchInfo:
    brand_raw = read_user_provider(user, default="")
    brand: Literal["coros", "garmin"] | None
    if brand_raw == "coros":
        brand = "coros"
    elif brand_raw == "garmin":
        brand = "garmin"
    elif user_has_config(user):
        # Legacy user: config.json exists (watch credentials present) but
        # predates the explicit `provider` field, so read_user_provider
        # returns "". They ARE bound — default to COROS rather than showing
        # the incorrect "未绑定手表".
        brand = "coros"
    else:
        brand = None

    last_sync: str | None = None
    try:
        row = db._conn.execute(
            "SELECT value FROM sync_meta WHERE key = 'last_sync_time'"
        ).fetchone()
        if row and row[0]:
            last_sync = row[0]
    except Exception:
        pass
    # Normalize naive-ISO legacy rows (written before tz=UTC enforcement) by
    # assuming UTC + converting to canonical Shanghai-offset ISO. No fallback
    # to activities.date — that's the latest workout time, not the sync time.
    last_sync = utc_iso_to_shanghai_iso(last_sync)
    return WatchInfo(brand=brand, last_sync_at=last_sync)


def _compute_plan_state(user_id: str) -> Literal["none", "active_no_week", "active"]:
    """Decide which CTA the home screen should surface.

    - No active master plan → "none" (user should build one via C1).
    - Active master plan but no planned_session this week → "active_no_week"
      (user should generate this week's plan via D1).
    - Active master plan + this week's plan present → "active" (normal).
    """
    try:
        from ..master_plan_store import get_master_plan_store

        store = get_master_plan_store()
        active = store.get_active_plan_for_user(user_id)
        if active is None:
            return "none"
    except Exception:  # noqa: BLE001 — store backend errors degrade to "none"
        return "none"

    # Check for any planned_session in the current week
    from datetime import timedelta
    today = today_shanghai()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    try:
        from ..weekly_plan_store import get_weekly_plan_store
        plan = get_weekly_plan_store().get_current_plan(
            user_id, today.isoformat()
        )
        if plan and plan.sessions:
            return "active"
        return "active_no_week"
    except Exception:  # noqa: BLE001
        # If plan store query fails, assume no week so user can retry
        return "active_no_week"


@router.get("/api/{user}/home", response_model=HomeResponse)
def get_home(
    user: str,
    recent_days: int = Query(14, ge=1, le=90),
) -> HomeResponse:
    """Single-call home aggregation for the mobile app.

    Cached in-process for 60s per ``(user, recent_days)`` pair.
    """
    cache_key = (user, recent_days)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    db = get_db(user)
    try:
        response = HomeResponse(
            status_ring=_build_status_ring(db),
            recent_activities=_build_recent_activities(db, recent_days),
            weekly_stats=_build_weekly_stats(db),
            lifetime_stats=_build_lifetime_stats(db),
            plan_state=_compute_plan_state(user),
            watch=_build_watch_info(db, user),
        )
    finally:
        db.close()

    _cache_put(cache_key, response)
    return response
