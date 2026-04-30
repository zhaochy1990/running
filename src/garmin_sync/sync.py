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
    daily_hrv_from_garmin,
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
    activity_limit: int = 200,
    since_date: str | None = None,
) -> tuple[int, int]:
    """Sync the user's Garmin data into `db`. Returns `(activities_count, health_count)`.

    Incremental by default: stops paginating activities once it hits one
    that's already in the local DB. `full=True` pulls everything in the
    first `activity_limit` slot (Garmin paginates indefinitely; we cap so
    a "full" rebuild doesn't accidentally try to download a decade).

    `since_date` (YYYY-MM-DD) overrides `activity_limit` for full syncs:
    pagination stops once activities older than this date are reached.
    Also passed to the Garmin API as a server-side filter where supported.
    """
    # When since_date drives the cutoff, use a large safety cap so the
    # activity_limit doesn't truncate before we reach the date boundary.
    effective_limit = 2000 if since_date else activity_limit
    activities_synced, new_label_ids = _sync_activities(
        client, db, full=full, progress=progress, limit=effective_limit,
        since_date=since_date,
    )
    health_synced = _sync_health(client, db, progress=progress)

    # Mirror coros_sync behaviour: refresh today's ability snapshot so the
    # cached row at /api/{user}/ability/current reflects the new activities
    # without the user having to manually pass ?refresh=1. Best-effort —
    # never fails the sync.
    from stride_core.ability_hook import run_ability_hook
    run_ability_hook(db, new_label_ids)

    return activities_synced, health_synced


def _sync_activities(
    client: GarminClient,
    db: Database,
    *,
    full: bool,
    progress: SyncProgressCallback | None,
    limit: int,
    since_date: str | None = None,
) -> tuple[int, list[str]]:
    _emit(progress, phase="activity_list", message="正在获取佳明活动列表", percent=10)

    page_size = 25
    start = 0
    pulled = 0
    new_count = 0
    new_label_ids: list[str] = []

    while pulled < limit:
        chunk = client.get_activities(start, page_size)
        if not chunk:
            break
        for activity in chunk:
            activity_id = str(activity.get("activityId") or "")
            if not activity_id:
                continue

            # Date-based cutoff: stop when activity is older than since_date.
            if since_date:
                activity_date = (activity.get("startTimeGMT") or "")[:10]
                if activity_date and activity_date < since_date:
                    _emit(
                        progress,
                        phase="activity_details",
                        message=f"佳明同步完成：{new_count} 条新活动（已达起始日期）",
                        percent=80,
                    )
                    return new_count, new_label_ids

            if (not full) and db.activity_exists(activity_id):
                # Hit the first known activity — stop pagination.
                _emit(
                    progress,
                    phase="activity_details",
                    message=f"佳明同步完成：{new_count} 条新活动",
                    percent=80,
                )
                return new_count, new_label_ids

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
            new_label_ids.append(activity_id)
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

    return new_count, new_label_ids


def _sync_health(
    client: GarminClient,
    db: Database,
    *,
    progress: SyncProgressCallback | None,
    days: int = 28,
) -> int:
    """Pull `days` of daily health from Garmin (default 28 — matches the COROS
    `analyse/query` window so PMC / fatigue charts have comparable history).

    Each day calls four Garmin endpoints (training_status, user_summary,
    sleep, hrv, training_readiness). Rows with no usable signal are skipped
    so they don't shadow real COROS rows in mixed-provider DBs.
    """
    _emit(progress, phase="health", message="正在同步佳明健康指标", percent=85)

    today = date.today()
    health_count = 0
    consecutive_failures = 0

    # Walk most-recent → oldest. If we hit a week of consecutive empty days
    # (e.g. friend's account went idle before that), bail early instead of
    # burning hundreds of API calls on guaranteed-empty days.
    for offset in range(days):
        d = today - timedelta(days=offset)
        date_iso = d.isoformat()
        try:
            ts = client.get_training_status(date_iso)
            us = client.get_user_summary(date_iso)
            sleep = client.get_sleep_data(date_iso)
            hrv = client.get_hrv_data(date_iso)
        except Exception as exc:
            logger.warning("Garmin health fetch failed for %s: %s", date_iso, exc)
            consecutive_failures += 1
            if consecutive_failures >= 7:
                break
            continue

        h = daily_health_from_garmin(
            date_iso=date_iso,
            training_status=ts,
            user_summary=us,
            sleep_data=sleep,
        )
        wrote_anything = False
        if (h.ati or h.cti or h.rhr or h.training_load_ratio
                or h.sleep_total_s or h.body_battery_high
                or h.fatigue) is not None:
            db.upsert_daily_health(h, provider="garmin")
            health_count += 1
            wrote_anything = True
        hrv_row = daily_hrv_from_garmin(date_iso, hrv)
        if hrv_row.last_night_avg is not None or hrv_row.weekly_avg is not None:
            db.upsert_daily_hrv(hrv_row, provider="garmin")
            health_count += 1
            wrote_anything = True

        if wrote_anything:
            consecutive_failures = 0
            _emit(
                progress,
                phase="health",
                message=f"佳明健康：已同步 {date_iso}",
                percent=85 + min(10, health_count // 4),
                synced_health=health_count,
            )
        else:
            consecutive_failures += 1
            if consecutive_failures >= 7:
                break

    # Dashboard singleton — pull most-recent metrics
    try:
        ts_today = client.get_training_status(today.isoformat())
        us_today = client.get_user_summary(today.isoformat())
        hrv = client.get_hrv_data((today - timedelta(days=1)).isoformat())
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
