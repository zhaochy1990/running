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
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel

from stride_core.models import RUN_SPORT_SQL_LIST as _RUN_SPORT_SQL
from stride_core.registry import read_user_provider
from stride_core.timefmt import SHANGHAI_DAY_SQL, today_shanghai, utc_iso_to_shanghai_iso

from ..deps import get_db

router = APIRouter()


# ── Response schema ────────────────────────────────────────────────────────


class StatusRing(BaseModel):
    fatigue: float | None
    fatigue_band: Literal["recovered", "normal", "fatigued", "high"] | None
    tsb: float | None
    tsb_band: Literal[
        "race_ready", "transitional", "productive", "overload", "detraining"
    ] | None
    load_ratio: float | None
    load_state: str | None


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
    plan_state: Literal["none"] = "none"
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


def _fatigue_band(
    fatigue: float | None,
) -> Literal["recovered", "normal", "fatigued", "high"] | None:
    if fatigue is None:
        return None
    if fatigue < 40:
        return "recovered"
    if fatigue < 50:
        return "normal"
    if fatigue < 60:
        return "fatigued"
    return "high"


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
    rows = db.query(
        "SELECT ati, cti, training_load_ratio, training_load_state, fatigue "
        "FROM daily_health ORDER BY date DESC LIMIT 1"
    )
    if not rows:
        return StatusRing(
            fatigue=None, fatigue_band=None, tsb=None, tsb_band=None,
            load_ratio=None, load_state=None,
        )
    r = dict(rows[0])
    ati = r.get("ati") or 0
    cti = r.get("cti") or 0
    tsb = round(cti - ati, 1) if (r.get("ati") is not None and r.get("cti") is not None) else None
    ratio = r.get("training_load_ratio")
    if ratio is None and cti > 0:
        ratio = ati / cti
    return StatusRing(
        fatigue=r.get("fatigue"),
        fatigue_band=_fatigue_band(r.get("fatigue")),
        tsb=tsb,
        tsb_band=_tsb_band(ratio),
        load_ratio=ratio,
        load_state=r.get("training_load_state"),
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
            distance_km=round(distance_m, 2) if distance_m else None,
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
        total_km += d
        total_sec += s
        if d > long_km:
            long_km = d
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
        "SELECT count(*) AS cnt, coalesce(sum(distance_m), 0) AS km FROM activities"
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
    else:
        brand = None

    last_sync: str | None = None
    try:
        row = db._conn.execute(
            "SELECT value FROM sync_meta WHERE key = 'last_sync'"
        ).fetchone()
        if row and row[0]:
            last_sync = row[0]
    except Exception:
        pass
    if not last_sync:
        try:
            row = db._conn.execute(
                "SELECT date FROM activities ORDER BY date DESC LIMIT 1"
            ).fetchone()
            if row:
                last_sync = row[0]
        except Exception:
            pass
    # Normalize YYYYMMDD → ISO date string for the mobile client.
    if last_sync and len(last_sync) == 8 and last_sync.isdigit():
        try:
            last_sync = datetime.strptime(last_sync, "%Y%m%d").date().isoformat()
        except ValueError:
            pass
    return WatchInfo(brand=brand, last_sync_at=last_sync)


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
            plan_state="none",
            watch=_build_watch_info(db, user),
        )
    finally:
        db.close()

    _cache_put(cache_key, response)
    return response
