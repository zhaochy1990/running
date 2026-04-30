"""Garmin sync orchestrator — fetches activities + health and stores in SQLite.

v1 keeps the surface narrow:
- Activity list paginated, then per-activity detail (no FIT timeseries yet).
- Daily health for yesterday + today (lighter than COROS's range pull).
- Dashboard singleton (HRV + threshold + race predictions).
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from stride_core.db import Database
from stride_core.source import SyncProgressCallback

from .client import GarminClient
from .models import (
    activity_detail_from_garmin,
    daily_health_from_garmin,
    dashboard_from_garmin,
)
from .normalize import apply_to_detail

logger = logging.getLogger(__name__)


def _emit(progress: SyncProgressCallback | None, **payload: Any) -> None:
    if progress is None:
        return
    progress({k: v for k, v in payload.items() if v is not None})


def run_sync(
    client: GarminClient,
    db: Database,
    *,
    full: bool = False,
    progress: SyncProgressCallback | None = None,
    activity_limit: int = 50,
) -> tuple[int, int]:
    """Sync the user's Garmin data into `db`. Returns `(activities_count, health_count)`.

    Incremental by default: stops paginating activities once it hits one
    that's already in the local DB. `full=True` pulls everything in the
    first `activity_limit` slot (Garmin paginates indefinitely; we cap so
    a "full" rebuild doesn't accidentally try to download a decade).
    """
    activities_synced = _sync_activities(
        client, db, full=full, progress=progress, limit=activity_limit
    )
    health_synced = _sync_health(client, db, progress=progress)
    return activities_synced, health_synced


def _sync_activities(
    client: GarminClient,
    db: Database,
    *,
    full: bool,
    progress: SyncProgressCallback | None,
    limit: int,
) -> int:
    _emit(progress, phase="activity_list", message="正在获取佳明活动列表", percent=10)

    page_size = 25
    start = 0
    pulled = 0
    new_count = 0

    while pulled < limit:
        chunk = client.get_activities(start, page_size)
        if not chunk:
            break
        for activity in chunk:
            activity_id = str(activity.get("activityId") or "")
            if not activity_id:
                continue
            if (not full) and db.activity_exists(activity_id):
                # Hit the first known activity — stop pagination.
                _emit(
                    progress,
                    phase="activity_details",
                    message=f"佳明同步完成：{new_count} 条新活动",
                    percent=80,
                )
                return new_count

            try:
                splits = client.get_activity_splits(activity_id)
                hr_zones = client.get_activity_hr_in_timezones(activity_id)
                weather = client.get_activity_weather(activity_id)
            except Exception as exc:
                logger.warning("Skipping detail fetch for %s: %s", activity_id, exc)
                splits, hr_zones, weather = None, None, None

            detail = activity_detail_from_garmin(
                activity,
                splits=splits,
                hr_zones=hr_zones,
                weather=weather,
            )
            apply_to_detail(detail, activity)
            db.upsert_activity(detail, provider="garmin")
            new_count += 1
            _emit(
                progress,
                phase="activity_details",
                current=new_count,
                total=min(limit, len(chunk) * 4),  # rough — pagination unknown
                message=f"佳明：{detail.name or 'activity'} 已同步",
                percent=10 + min(60, new_count * 2),
            )

        pulled += len(chunk)
        start += len(chunk)
        if len(chunk) < page_size:
            break

    return new_count


def _sync_health(
    client: GarminClient,
    db: Database,
    *,
    progress: SyncProgressCallback | None,
) -> int:
    _emit(progress, phase="health", message="正在同步佳明健康指标", percent=85)

    today = date.today()
    yesterday = today - timedelta(days=1)
    health_count = 0

    # Daily health rows for today + yesterday (Garmin returns null for
    # mid-day on today; yesterday is the most reliable single-day snapshot).
    for d in (yesterday, today):
        date_iso = d.isoformat()
        try:
            ts = client.get_training_status(date_iso)
            us = client.get_user_summary(date_iso)
        except Exception as exc:
            logger.warning("Garmin health fetch failed for %s: %s", date_iso, exc)
            continue
        h = daily_health_from_garmin(
            date_iso=date_iso, training_status=ts, user_summary=us
        )
        # Only persist rows where we got at least one signal — avoid
        # writing rows full of NULLs that would shadow a real COROS-source
        # row in mixed-provider databases.
        if (h.ati or h.cti or h.rhr or h.training_load_ratio) is not None:
            db.upsert_daily_health(h, provider="garmin")
            health_count += 1

    # Dashboard singleton — pull most-recent metrics
    try:
        ts_today = client.get_training_status(today.isoformat())
        us_today = client.get_user_summary(today.isoformat())
        hrv = client.get_hrv_data(yesterday.isoformat())
        lt = client.get_lactate_threshold()
        rp = client.get_race_predictions()
        dashboard = dashboard_from_garmin(
            training_status=ts_today,
            user_summary=us_today,
            hrv=hrv,
            lactate_threshold=lt,
            race_predictions=rp,
        )
        db.upsert_dashboard(dashboard, provider="garmin")
        health_count += 1
    except Exception as exc:
        logger.warning("Garmin dashboard sync failed: %s", exc)

    _emit(progress, phase="complete", message="佳明同步完成", percent=100)
    return health_count
