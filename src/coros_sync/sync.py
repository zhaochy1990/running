"""Incremental sync orchestrator — fetches from COROS API and stores in SQLite."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime
from typing import TypeVar

from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

from .client import CorosClient, CorosAPIError
from .normalize import apply_to_detail
from stride_core.db import Database
from stride_core.models import Activity, ActivityDetail, DailyHealth, Dashboard
from stride_core.source import SyncProgressCallback

logger = logging.getLogger(__name__)
T = TypeVar("T")


class ActivityDetailSyncTimeout(RuntimeError):
    """Raised when COROS detail requests stop making progress."""


def _emit_sync_progress(progress: SyncProgressCallback | None, **payload: object) -> None:
    if progress is None:
        return
    progress({k: v for k, v in payload.items() if v is not None})


def _detail_stall_timeout_seconds() -> float:
    value = os.environ.get("COROS_DETAIL_STALL_TIMEOUT_SECONDS", "90")
    try:
        timeout = float(value)
    except ValueError:
        logger.warning("Invalid COROS_DETAIL_STALL_TIMEOUT_SECONDS=%r; using 90s", value)
        return 90.0
    return max(timeout, 0.01)


def _run_detail_jobs(
    items: list[T],
    *,
    jobs: int,
    fetch_detail: Callable[[T], tuple[T, ActivityDetail | None]],
    label_for: Callable[[T], str],
    on_commit: Callable[[T, ActivityDetail | None, int, int], None],
    progress_callback: SyncProgressCallback | None = None,
    saved_count: Callable[[], int] | None = None,
) -> None:
    """Run COROS detail requests with ordered commits and a stall guard.

    A single stuck COROS request used to block ``as_completed`` forever, leaving
    onboarding in "running" indefinitely. If no detail request finishes within
    the configured stall timeout, abort the batch so the route can surface an
    error and allow a retry.

    Fetching may complete out of order, but commits are emitted only for the
    contiguous oldest-first prefix. This preserves the existing incremental
    scan invariant: once a retry sees the first existing activity, every older
    activity in this batch has already been processed.
    """
    timeout = _detail_stall_timeout_seconds()
    executor = ThreadPoolExecutor(max_workers=max(1, jobs))
    future_indexes: dict[Future[tuple[T, ActivityDetail | None]], int] = {
        executor.submit(fetch_detail, item): index for index, item in enumerate(items)
    }
    pending: set[Future[tuple[T, ActivityDetail | None]]] = set(future_indexes)
    completed_results: dict[int, tuple[T, ActivityDetail | None]] = {}
    completed_count = 0
    committed_count = 0

    try:
        while pending or completed_results:
            completed, pending = wait(pending, timeout=timeout, return_when=FIRST_COMPLETED)
            if not completed:
                samples = ", ".join(label_for(items[future_indexes[f]]) for f in list(pending)[:3])
                saved = saved_count() if saved_count is not None else committed_count
                message = (
                    f"COROS 训练详情请求超过 {int(timeout)} 秒没有进展，"
                    f"已处理 {committed_count}/{len(items)}，已保存 {saved} 条；请稍后重试"
                )
                logger.warning("%s. Pending samples: %s", message, samples)
                _emit_sync_progress(
                    progress_callback,
                    phase="activity_details",
                    message=message,
                    current=committed_count,
                    total=len(items),
                    synced_activities=saved,
                )
                raise ActivityDetailSyncTimeout(message)

            for future in completed:
                index = future_indexes[future]
                item, detail = future.result()
                completed_results[index] = (item, detail)
                completed_count += 1

            while committed_count in completed_results:
                item, detail = completed_results.pop(committed_count)
                committed_count += 1
                on_commit(item, detail, committed_count, completed_count)
    finally:
        if pending:
            for future in pending:
                future.cancel()
        executor.shutdown(wait=not pending, cancel_futures=bool(pending))


def sync_activities(
    client: CorosClient,
    db: Database,
    full: bool = False,
    max_pages: int = 50,
    page_size: int = 20,
    jobs: int = 1,
    progress_callback: SyncProgressCallback | None = None,
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
        _emit_sync_progress(
            progress_callback,
            phase="activities_scan",
            message="正在扫描 COROS 训练列表",
            percent=10,
        )

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
                _emit_sync_progress(
                    progress_callback,
                    phase="activities_scan",
                    message=f"正在扫描第 {page} 页训练列表，已发现 {len(new_activities)} 条新活动",
                    percent=min(30, 10 + page * 2),
                    current=len(new_activities),
                )
                continue
            break  # Inner loop broke, stop pagination

        if not new_activities:
            progress.update(task, description="No new activities found", total=1, completed=1)
            _emit_sync_progress(
                progress_callback,
                phase="activities_done",
                message="未发现新的训练记录",
                percent=76,
                current=0,
                total=0,
                synced_activities=0,
            )
            return 0

        # Phase 2: Fetch details for each new activity (parallel API calls, sequential DB writes)
        ordered = list(reversed(new_activities))  # Oldest first
        progress.update(task, description="Fetching activity details...", total=len(ordered), completed=0)
        _emit_sync_progress(
            progress_callback,
            phase="activity_details",
            message=f"发现 {len(ordered)} 条新活动，正在下载训练详情",
            percent=35,
            current=0,
            total=len(ordered),
        )

        def fetch_detail(activity: Activity) -> tuple[Activity, ActivityDetail | None]:
            try:
                detail_data = client.get_activity_detail(activity.label_id, activity.sport_type)
                detail = ActivityDetail.from_api(detail_data, activity.label_id)
                if not detail.date:
                    detail.date = activity.date
                # Translate COROS encodings (sport_type / trainType / feelType)
                # into our normalized enum strings on detail.{sport,train_kind,feel}
                # before the upsert hands it to db.upsert_activity.
                apply_to_detail(detail, detail_data)
                return activity, detail
            except CorosAPIError as e:
                logger.warning("Failed to sync activity %s: %s", activity.label_id, e)
                return activity, None
            except Exception as e:
                logger.warning("Unexpected error syncing %s: %s", activity.label_id, e)
                return activity, None

        def activity_label(activity: Activity) -> str:
            date_str = activity.date
            if len(date_str) == 8:
                date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
            return f"{date_str} {activity.name or activity.sport_name}"

        ai_targets: list[str] = []

        def on_activity_commit(
            activity: Activity,
            detail: ActivityDetail | None,
            processed: int,
            fetched: int,
        ) -> None:
            nonlocal synced
            label = activity_label(activity)
            if detail:
                db.upsert_activity(detail)
                db.set_meta("last_activity_date", activity.date)
                synced += 1
                ai_targets.append(activity.label_id)
            progress.update(task, description=f"Syncing: {label}", completed=processed)
            _emit_sync_progress(
                progress_callback,
                phase="activity_details",
                message=f"正在同步训练详情：{label}（已处理 {processed}/{len(ordered)}，已保存 {synced}）",
                percent=35 + round(processed / len(ordered) * 35),
                current=processed,
                total=len(ordered),
                fetched=fetched,
                synced_activities=synced,
            )

        _run_detail_jobs(
            ordered,
            jobs=jobs,
            fetch_detail=fetch_detail,
            label_for=activity_label,
            on_commit=on_activity_commit,
            progress_callback=progress_callback,
            saved_count=lambda: synced,
        )

        _emit_sync_progress(
            progress_callback,
            phase="activity_save",
            message=f"训练详情已保存 {synced}/{len(ordered)} 条",
            percent=74,
            current=len(ordered),
            total=len(ordered),
            synced_activities=synced,
        )

    # AOAI auto-commentary for each newly synced activity (fire-and-forget).
    # Isolated here so any import/network failure cannot break sync.
    if ai_targets:
        _emit_sync_progress(
            progress_callback,
            phase="commentary",
            message="正在准备活动解读草稿",
            percent=75,
            synced_activities=synced,
        )
        _try_generate_commentaries(db, ai_targets)

    # Ability hook — compute L1 per new activity + rebuild today's snapshot.
    # Wrapped so any failure cannot break the sync pipeline.
    _emit_sync_progress(
        progress_callback,
        phase="ability",
        message="正在更新能力模型和训练状态",
        percent=76,
        synced_activities=synced,
    )
    _try_run_ability_hook(db, ai_targets)
    _emit_sync_progress(
        progress_callback,
        phase="activities_done",
        message=f"训练数据同步完成，共写入 {synced} 条新活动",
        percent=78,
        synced_activities=synced,
    )

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
    # Resolve user from the DB path: data/{user_id}/coros.db
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


def _fmt_marathon(total_s: float | int | None) -> str:
    if total_s is None or total_s <= 0:
        return "—"
    s = int(round(total_s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def _fmt_delta(before: float | None, after: float | None, sign: bool = True) -> str:
    if before is None or after is None:
        return "—"
    delta = after - before
    if sign:
        return f"{'+' if delta >= 0 else ''}{delta:.1f}"
    return f"{delta:.1f}"


def _fmt_time_delta(before_s: int | None, after_s: int | None) -> str:
    if before_s is None or after_s is None:
        return "—"
    delta = after_s - before_s
    neg = delta < 0
    abs_s = abs(delta)
    m, sec = divmod(abs_s, 60)
    return f"{'-' if neg else '+'}{m}:{sec:02d}"


def _try_run_ability_hook(db: Database, new_label_ids: list[str]) -> None:
    """Post-sync ability computation.

    - For each newly-synced running activity: compute L1 quality and upsert.
    - Recompute today's full snapshot and upsert each L2/L3/L4 dimension.
    - Print a one-line summary showing L4 and marathon prediction delta.

    All wrapped in try/except — sync MUST NOT fail if this raises.
    """
    try:
        from datetime import datetime, timezone, timedelta

        from stride_core.ability import (
            ABILITY_MODEL_VERSION,
            compute_l1_quality,
            compute_ability_snapshot,
            L4_WEIGHTS,
        )
    except Exception as e:  # pragma: no cover — defensive
        logger.debug("ability module unavailable: %s", e)
        return

    try:
        today_iso = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")

        # Capture prior snapshot values (latest L4/marathon) BEFORE recompute,
        # so we can print a delta summary.
        prior_l4, prior_marathon = _fetch_latest_l4_and_marathon(db)

        # L1 for each new running activity.
        running_sports = (100, 101, 102, 103, 104)
        for lid in new_label_ids or []:
            try:
                activity = _load_activity_for_l1(db, lid)
                if activity is None:
                    continue
                if activity.get("sport_type") not in running_sports:
                    continue
                l1 = compute_l1_quality(activity, plan_target=None)
                db.upsert_activity_ability(
                    label_id=lid,
                    l1_quality=l1.get("total"),
                    l1_breakdown=l1.get("breakdown"),
                    contribution=None,  # full contribution requires a prior snapshot; skip for Phase 1
                )
            except Exception as e:
                logger.debug("ability L1 compute failed for %s: %s", lid, e)

        # Today's full snapshot.
        snapshot = compute_ability_snapshot(db, date=today_iso)

        # Persist L2/L3/L4/marathon.
        try:
            db.upsert_ability_snapshot(
                date=today_iso, level="meta", dimension="model_version",
                value=float(ABILITY_MODEL_VERSION),
            )
            l2 = snapshot.get("l2_freshness") or {}
            if l2.get("total") is not None:
                db.upsert_ability_snapshot(
                    date=today_iso, level="L2", dimension="total",
                    value=l2.get("total"),
                )
            for dim in L4_WEIGHTS.keys():
                d = (snapshot.get("l3_dimensions") or {}).get(dim) or {}
                db.upsert_ability_snapshot(
                    date=today_iso, level="L3", dimension=dim,
                    value=d.get("score"),
                    evidence_activity_ids=d.get("evidence"),
                )
            db.upsert_ability_snapshot(
                date=today_iso, level="L4", dimension="composite",
                value=snapshot.get("l4_composite"),
                evidence_activity_ids=snapshot.get("evidence_activity_ids"),
            )
            # Persist all 3 marathon-estimate tiers so API fast-path can read them.
            estimates = snapshot.get("marathon_estimates") or {}
            for dim_name, key in (
                ("marathon_training_s", "training_s"),
                ("marathon_race_s",     "race_s"),
                ("marathon_best_case_s", "best_case_s"),
            ):
                val = estimates.get(key)
                if val is not None:
                    db.upsert_ability_snapshot(
                        date=today_iso, level="L4", dimension=dim_name,
                        value=float(val),
                    )
        except Exception as e:
            logger.debug("ability snapshot persistence failed: %s", e)

        # Console summary.
        new_l4 = snapshot.get("l4_composite")
        new_marathon = snapshot.get("l4_marathon_estimate_s")
        l4_before = f"{prior_l4:.1f}" if prior_l4 is not None else "—"
        l4_after = f"{new_l4:.1f}" if new_l4 is not None else "—"
        l4_delta = _fmt_delta(prior_l4, new_l4)
        m_before = _fmt_marathon(prior_marathon)
        m_after = _fmt_marathon(new_marathon)
        m_delta = _fmt_time_delta(prior_marathon, new_marathon)
        print(
            f"ability: L4 {l4_before} -> {l4_after} ({l4_delta}) | "
            f"全马典型预测 {m_before} -> {m_after} ({m_delta})"
        )
    except Exception as e:
        logger.warning("ability hook failed: %s", e)


def _fetch_latest_l4_and_marathon(db: Database) -> tuple[float | None, int | None]:
    """Read the most recent persisted L4 composite + marathon_s snapshot values."""
    try:
        row_comp = db._conn.execute(
            "SELECT value FROM ability_snapshot WHERE level='L4' AND dimension='composite' "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        # Prefer the new headline dimension (race_s), fall back to legacy marathon_s.
        row_mar = db._conn.execute(
            "SELECT value FROM ability_snapshot "
            "WHERE level='L4' AND dimension IN ('marathon_race_s','marathon_s') "
            "ORDER BY date DESC, CASE dimension WHEN 'marathon_race_s' THEN 0 ELSE 1 END LIMIT 1"
        ).fetchone()
        comp = float(row_comp[0]) if row_comp and row_comp[0] is not None else None
        mar = int(row_mar[0]) if row_mar and row_mar[0] is not None else None
        return comp, mar
    except Exception:
        return None, None


def _load_activity_for_l1(db: Database, label_id: str) -> dict | None:
    """Load a single activity row + laps + zones + timeseries for L1 computation."""
    try:
        conn = db._conn
        row = conn.execute(
            "SELECT label_id, sport_type, train_type, avg_hr, max_hr, "
            "avg_pace_s_km, distance_m, duration_s, avg_cadence "
            "FROM activities WHERE label_id = ?",
            (label_id,),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["laps"] = [
            dict(x) for x in conn.execute(
                "SELECT lap_index, lap_type, distance_m, duration_s, avg_pace, "
                "avg_hr, max_hr, avg_cadence, exercise_type FROM laps "
                "WHERE label_id = ? ORDER BY lap_index",
                (label_id,),
            ).fetchall()
        ]
        d["zones"] = [
            dict(x) for x in conn.execute(
                "SELECT zone_type, zone_index, range_min, range_max, "
                "range_unit, duration_s, percent FROM zones WHERE label_id = ?",
                (label_id,),
            ).fetchall()
        ]
        d["timeseries"] = [
            dict(x) for x in conn.execute(
                "SELECT heart_rate, speed, cadence FROM timeseries "
                "WHERE label_id = ? ORDER BY id LIMIT 3000",
                (label_id,),
            ).fetchall()
        ]
        return d
    except Exception:
        return None


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
                apply_to_detail(detail, detail_data)
                return act, detail
            except Exception as e:
                logger.warning("Failed to re-sync %s: %s", act["label_id"], e)
                return act, None

        def on_resync_commit(
            act: dict,
            detail: ActivityDetail | None,
            processed: int,
            _fetched: int,
        ) -> None:
            nonlocal synced
            if detail:
                db.upsert_activity(detail)
                synced += 1
            progress.update(
                task,
                description=f"Re-syncing: {act.get('name') or act.get('sport_name', '')}",
                completed=processed,
            )

        _run_detail_jobs(
            activities,
            jobs=jobs,
            fetch_detail=fetch_detail,
            label_for=lambda act: str(act.get("name") or act.get("sport_name") or act["label_id"]),
            on_commit=on_resync_commit,
        )

    return synced


def sync_health(
    client: CorosClient,
    db: Database,
    progress_callback: SyncProgressCallback | None = None,
) -> int:
    """Sync health/body metrics from COROS. Returns count of daily records synced."""
    synced = 0

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
    ) as progress:
        task = progress.add_task("Syncing health data...")
        _emit_sync_progress(
            progress_callback,
            phase="health",
            message="正在同步疲劳、负荷和身体指标",
            percent=80,
        )

        # Daily health from /analyse/query
        try:
            progress.update(task, description="Fetching training analysis...")
            _emit_sync_progress(
                progress_callback,
                phase="health",
                message="正在读取训练负荷和疲劳趋势",
                percent=82,
            )
            analyse_data = client.get_analyse()
            day_list = analyse_data.get("data", {}).get("dayList", [])
            for day in day_list:
                health = DailyHealth.from_api(day)
                db.upsert_daily_health(health)
                synced += 1
            _emit_sync_progress(
                progress_callback,
                phase="health",
                message=f"已同步 {synced} 天健康指标",
                percent=88,
                current=synced,
                total=len(day_list),
                synced_health=synced,
            )
        except CorosAPIError as e:
            logger.warning("Failed to sync health analysis: %s", e)

        # Dashboard from /dashboard/query + /dashboard/detail/query
        try:
            progress.update(task, description="Fetching dashboard...")
            _emit_sync_progress(
                progress_callback,
                phase="dashboard",
                message="正在读取仪表盘汇总数据",
                percent=90,
                synced_health=synced,
            )
            dashboard_data = client.get_dashboard()
            summary = dashboard_data.get("data", {}).get("summaryInfo", {})

            detail_data = client.get_dashboard_detail()
            week = detail_data.get("data", {}).get("currentWeekRecord", {})

            dashboard = Dashboard.from_api(summary, week)
            db.upsert_dashboard(dashboard)
        except CorosAPIError as e:
            logger.warning("Failed to sync dashboard: %s", e)

        progress.update(task, description="Health sync complete")
        _emit_sync_progress(
            progress_callback,
            phase="health_done",
            message="健康指标同步完成",
            percent=95,
            synced_health=synced,
        )

    db.set_meta("last_health_sync", datetime.now().isoformat())
    return synced


def run_sync(
    client: CorosClient,
    db: Database,
    full: bool = False,
    jobs: int = 1,
    progress: SyncProgressCallback | None = None,
) -> tuple[int, int]:
    """Run full sync: activities + health. Returns (activities_synced, health_days_synced)."""
    _emit_sync_progress(
        progress,
        phase="connecting",
        message="已连接 COROS，准备开始同步",
        percent=5,
    )
    activities = sync_activities(
        client,
        db,
        full=full,
        jobs=jobs,
        progress_callback=progress,
    )
    health = sync_health(client, db, progress_callback=progress)
    _emit_sync_progress(
        progress,
        phase="finalizing",
        message="正在保存初始化结果",
        percent=98,
        synced_activities=activities,
        synced_health=health,
    )
    db.set_meta("last_sync_time", datetime.now().isoformat())
    return activities, health
