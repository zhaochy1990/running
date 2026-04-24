"""Incremental sync orchestrator — fetches from COROS API and stores in SQLite."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

from .client import CorosClient, CorosAPIError
from stride_core.db import Database
from stride_core.models import Activity, ActivityDetail, DailyHealth, Dashboard

logger = logging.getLogger(__name__)


def sync_activities(
    client: CorosClient,
    db: Database,
    full: bool = False,
    max_pages: int = 50,
    page_size: int = 20,
    jobs: int = 1,
) -> int:
    """Sync activities from COROS to local DB. Returns count of new activities synced."""
    synced = 0

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
    ) as progress:
        # Phase 1: Discover new activities
        task = progress.add_task("Fetching activity list...", total=None)
        new_activities: list[Activity] = []

        for page in range(1, max_pages + 1):
            data = client.list_activities(page=page, size=page_size)
            data_list = data.get("data", {}).get("dataList", [])
            if not data_list:
                break

            for item in data_list:
                activity = Activity.from_api(item)
                if not full and db.activity_exists(activity.label_id):
                    # Found existing activity — stop pagination (activities are sorted by date desc)
                    break
                new_activities.append(activity)
            else:
                # Inner loop didn't break, continue to next page
                progress.update(task, description=f"Scanning page {page}... ({len(new_activities)} new)")
                continue
            break  # Inner loop broke, stop pagination

        if not new_activities:
            progress.update(task, description="No new activities found", total=1, completed=1)
            return 0

        # Phase 2: Fetch details for each new activity (parallel API calls, sequential DB writes)
        ordered = list(reversed(new_activities))  # Oldest first
        progress.update(task, description="Fetching activity details...", total=len(ordered), completed=0)

        def fetch_detail(activity: Activity) -> tuple[Activity, ActivityDetail | None]:
            try:
                detail_data = client.get_activity_detail(activity.label_id, activity.sport_type)
                detail = ActivityDetail.from_api(detail_data, activity.label_id)
                if not detail.date:
                    detail.date = activity.date
                return activity, detail
            except CorosAPIError as e:
                logger.warning("Failed to sync activity %s: %s", activity.label_id, e)
                return activity, None
            except Exception as e:
                logger.warning("Unexpected error syncing %s: %s", activity.label_id, e)
                return activity, None

        results: dict[str, ActivityDetail | None] = {}
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {pool.submit(fetch_detail, a): a for a in ordered}
            for future in as_completed(futures):
                activity = futures[future]
                _, detail = future.result()
                results[activity.label_id] = detail
                done = len(results)
                date_str = activity.date
                if len(date_str) == 8:
                    date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
                label = f"{date_str} {activity.name or activity.sport_name}"
                progress.update(task, description=f"Syncing: {label}", completed=done)

        # Write to DB in original order
        ai_targets: list[str] = []
        for activity in ordered:
            detail = results[activity.label_id]
            if detail:
                db.upsert_activity(detail)
                db.set_meta("last_activity_date", activity.date)
                synced += 1
                ai_targets.append(activity.label_id)

    # AOAI auto-commentary for each newly synced activity (fire-and-forget).
    # Isolated here so any import/network failure cannot break sync.
    if ai_targets:
        _try_generate_commentaries(db, ai_targets)

    return synced


def _try_generate_commentaries(db: Database, label_ids: list[str]) -> None:
    """Kick off AOAI commentary generation in a bounded thread pool.

    Best-effort: never raises, never blocks the caller for long.
    """
    try:
        # Lazy import — stride_server is not a hard dep of coros_sync
        from stride_server.commentary_ai import maybe_generate_for_new_activity
        from stride_server.aoai_client import is_enabled
    except Exception as e:
        logger.debug("AOAI commentary module unavailable: %s", e)
        return
    if not is_enabled():
        return
    # Resolve user from the DB path: data/{user}/coros.db
    try:
        user = db._path.parent.name  # type: ignore[attr-defined]
    except Exception:
        logger.debug("Cannot resolve user from DB path, skipping AOAI")
        return

    def worker(lid: str) -> None:
        try:
            maybe_generate_for_new_activity(user, lid)
        except Exception:
            logger.exception("AOAI worker failed for %s", lid)

    # Small pool, daemon threads — do not wait for them to finish.
    import threading
    for lid in label_ids:
        t = threading.Thread(target=worker, args=(lid,), daemon=True)
        t.start()


def resync_date_range(
    client: CorosClient,
    db: Database,
    date_from: str,
    date_to: str,
    jobs: int = 1,
) -> int:
    """Re-sync activities within a date range. Dates are YYYY-MM-DD or YYYYMMDD format."""
    # Normalize dates for comparison with DB
    df = date_from.replace("-", "")
    dt = date_to.replace("-", "")

    # Find all activities in range from existing DB
    rows = db.query(
        "SELECT label_id, sport_type, date, name, sport_name FROM activities WHERE date >= ? AND date < ?",
        (date_from if "-" in date_from else f"{df[:4]}-{df[4:6]}-{df[6:]}",
         date_to + "T99" if "-" in date_to else f"{dt[:4]}-{dt[4:6]}-{dt[6:]}T99"),
    )
    activities = [dict(r) for r in rows]

    if not activities:
        return 0

    synced = 0
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
    ) as progress:
        task = progress.add_task(f"Re-syncing {len(activities)} activities...", total=len(activities))

        def fetch_detail(act: dict) -> tuple[dict, ActivityDetail | None]:
            try:
                detail_data = client.get_activity_detail(act["label_id"], act["sport_type"])
                detail = ActivityDetail.from_api(detail_data, act["label_id"])
                if not detail.date:
                    detail.date = act["date"]
                return act, detail
            except Exception as e:
                logger.warning("Failed to re-sync %s: %s", act["label_id"], e)
                return act, None

        results: dict[str, ActivityDetail | None] = {}
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {pool.submit(fetch_detail, a): a for a in activities}
            for future in as_completed(futures):
                act = futures[future]
                _, detail = future.result()
                results[act["label_id"]] = detail
                progress.update(
                    task,
                    description=f"Re-syncing: {act.get('name') or act.get('sport_name', '')}",
                    completed=len(results),
                )

        for act in activities:
            detail = results[act["label_id"]]
            if detail:
                db.upsert_activity(detail)
                synced += 1

    return synced


def sync_health(client: CorosClient, db: Database) -> int:
    """Sync health/body metrics from COROS. Returns count of daily records synced."""
    synced = 0

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
    ) as progress:
        task = progress.add_task("Syncing health data...")

        # Daily health from /analyse/query
        try:
            progress.update(task, description="Fetching training analysis...")
            analyse_data = client.get_analyse()
            day_list = analyse_data.get("data", {}).get("dayList", [])
            for day in day_list:
                health = DailyHealth.from_api(day)
                db.upsert_daily_health(health)
                synced += 1
        except CorosAPIError as e:
            logger.warning("Failed to sync health analysis: %s", e)

        # Dashboard from /dashboard/query + /dashboard/detail/query
        try:
            progress.update(task, description="Fetching dashboard...")
            dashboard_data = client.get_dashboard()
            summary = dashboard_data.get("data", {}).get("summaryInfo", {})

            detail_data = client.get_dashboard_detail()
            week = detail_data.get("data", {}).get("currentWeekRecord", {})

            dashboard = Dashboard.from_api(summary, week)
            db.upsert_dashboard(dashboard)
        except CorosAPIError as e:
            logger.warning("Failed to sync dashboard: %s", e)

        progress.update(task, description="Health sync complete")

    db.set_meta("last_health_sync", datetime.now().isoformat())
    return synced


def run_sync(
    client: CorosClient,
    db: Database,
    full: bool = False,
    jobs: int = 1,
) -> tuple[int, int]:
    """Run full sync: activities + health. Returns (activities_synced, health_days_synced)."""
    activities = sync_activities(client, db, full=full, jobs=jobs)
    health = sync_health(client, db)
    db.set_meta("last_sync_time", datetime.now().isoformat())
    return activities, health
