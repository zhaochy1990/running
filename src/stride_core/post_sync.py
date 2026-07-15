"""Provider-neutral post-sync event runner.

Watch adapters write normalized rows and return the labels they changed.
This module owns the derived work that should happen after a successful sync:
STRIDE objective load, ability snapshots, and activity commentary drafts.
Each handler is isolated so post-sync failures never turn a successful watch
sync into a failed sync.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from stride_core.ability_hook import run_ability_hook
from stride_storage.sqlite.database import Database
from stride_core.source import SyncProgressCallback, SyncResult
from stride_core.timefmt import SHANGHAI_DAY_SQL
from stride_core.timefmt import today_shanghai
from stride_core.training_load import recompute_training_load

logger = logging.getLogger(__name__)

_IN_CLAUSE_CHUNK = 500


@dataclass(frozen=True)
class PostSyncContext:
    user: str | None
    provider: str
    operation: str
    db: Database
    activity_label_ids: tuple[str, ...] = ()
    progress: SyncProgressCallback | None = None


class PostSyncHandler(Protocol):
    name: str

    def applies_to(self, context: PostSyncContext) -> bool: ...
    def run(self, context: PostSyncContext) -> None: ...


def _emit(progress: SyncProgressCallback | None, **payload: Any) -> None:
    if progress is None:
        return
    progress({k: v for k, v in payload.items() if v is not None})


def _unique_labels(labels: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in labels or ():
        label = str(raw).strip()
        if not label or label in seen:
            continue
        seen.add(label)
        out.append(label)
    return tuple(out)


def _chunks(values: Sequence[str], size: int = _IN_CLAUSE_CHUNK) -> Iterable[tuple[str, ...]]:
    for i in range(0, len(values), size):
        yield tuple(values[i : i + size])


def _activity_shanghai_window(db: Database, label_ids: Sequence[str]) -> tuple[str, str] | None:
    dates: list[str] = []
    for chunk in _chunks(label_ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.query(
            f"SELECT {SHANGHAI_DAY_SQL} AS shanghai_date "
            f"FROM activities WHERE label_id IN ({placeholders})",
            tuple(chunk),
        )
        for row in rows:
            value = row["shanghai_date"]
            if value:
                dates.append(str(value))
    if not dates:
        return None
    return min(dates), max(dates)


class StrideTrainingLoadHandler:
    name = "stride_training_load"

    def __init__(self, *, attempts: int = 3, backoff_s: float = 0.2) -> None:
        self._attempts = max(1, attempts)
        self._backoff_s = max(0.0, backoff_s)

    def applies_to(self, context: PostSyncContext) -> bool:
        return bool(context.activity_label_ids)

    def run(self, context: PostSyncContext) -> None:
        label_ids = _unique_labels(context.activity_label_ids)
        if not label_ids:
            return
        window = _activity_shanghai_window(context.db, label_ids)
        if window is None:
            return
        start, changed_end = window
        # ATL/CTL are recursive: changing a historical activity changes every
        # later day, not only the activity's own date. Recompute the full tail
        # through today so persisted PMC state cannot retain stale descendants.
        end = max(changed_end, today_shanghai().isoformat())
        _emit(
            context.progress,
            phase="stride_training_load",
            message="正在更新 STRIDE 自算训练负荷",
            activity_label_count=len(label_ids),
        )

        for attempt in range(1, self._attempts + 1):
            try:
                # Daily training load is date-scoped, so recompute every
                # activity in the affected Shanghai date window. A label-only
                # activity set would overwrite same-day daily totals.
                recompute_training_load(
                    context.db,
                    start=start,
                    end=end,
                )
                return
            except Exception:
                if attempt >= self._attempts:
                    logger.error(
                        "STRIDE training-load post-sync failed for user=%s provider=%s "
                        "operation=%s labels=%s",
                        context.user,
                        context.provider,
                        context.operation,
                        label_ids,
                        exc_info=True,
                    )
                    return
                if self._backoff_s:
                    time.sleep(self._backoff_s)


class ActivityZonesHandler:
    """Materialize per-activity time-in-zone from STRIDE calibration zones.

    Runs before AbilityHandler (whose L1 reads the `zones` table) so the activity
    page and HR-zone analytics see STRIDE-derived zones rather than the provider's
    own buckets. Uses the latest persisted running-calibration snapshot, preferring
    the one as-of the activity's date; that snapshot is maintained by the
    training-load calibration refresh, not recomputed here.
    """

    name = "activity_zones"

    def applies_to(self, context: PostSyncContext) -> bool:
        return bool(context.activity_label_ids)

    def run(self, context: PostSyncContext) -> None:
        label_ids = _unique_labels(context.activity_label_ids)
        if not label_ids:
            return

        from datetime import date as _date

        from stride_core.activity_zones import (
            ZoneSample,
            compute_activity_time_in_zone,
            dwell_seconds,
        )
        from stride_core.models import RUN_SPORT_IDS
        from stride_storage.sqlite.calibration_connector import (
            SQLiteRunningCalibrationRepository,
        )
        from stride_core.running_calibration.zones import compute_training_zones

        db = context.db
        repo = SQLiteRunningCalibrationRepository(db)

        _emit(
            context.progress,
            phase="activity_zones",
            message="正在计算 STRIDE 配速 / 心率区间",
            activity_label_count=len(label_ids),
        )

        for lid in label_ids:
            try:
                meta = db.query(
                    f"SELECT sport_type, distance_m, provider, "
                    f"{SHANGHAI_DAY_SQL} AS shanghai_date "
                    f"FROM activities WHERE label_id = ?",
                    (lid,),
                )
                if not meta:
                    continue
                row = dict(meta[0])
                if row.get("sport_type") not in RUN_SPORT_IDS:
                    continue
                day = row.get("shanghai_date")
                if not day:
                    continue

                # Prefer the calibration as-of the activity's date; fall back to
                # the latest snapshot when none predates it (activity synced late,
                # or a new user whose only snapshot is dated after this run) so the
                # zones still render rather than silently vanishing.
                snapshot = repo.fetch_latest(
                    as_of_date=_date.fromisoformat(str(day))
                ) or repo.fetch_latest()
                if snapshot is None:
                    continue
                zone_set = compute_training_zones(snapshot)
                if not zone_set.pace_zones and not zone_set.heart_rate_zones:
                    continue

                running_samples = repo.fetch_activity_samples(
                    lid,
                    provider=row.get("provider"),
                    activity_distance_m=row.get("distance_m"),
                )
                if not running_samples:
                    continue
                # dwell_seconds returns one entry per input sample (same length),
                # so the zip stays 1:1 even when some samples lack a timestamp.
                dwell = dwell_seconds([s.elapsed_s for s in running_samples])
                samples = [
                    ZoneSample(dwell_s=d, speed_mps=s.speed_mps, hr_bpm=s.heart_rate_bpm)
                    for s, d in zip(running_samples, dwell)
                ]

                rows = compute_activity_time_in_zone(
                    samples, zone_set.pace_zones, zone_set.heart_rate_zones
                )
                db._conn.execute("DELETE FROM zones WHERE label_id = ?", (lid,))
                for zone in rows:
                    db._upsert_zone(lid, zone)
                db._conn.commit()
            except Exception:
                # Roll back the pending DELETE/insert so a later activity's commit
                # in this same loop can't land this one's half-applied write.
                try:
                    db._conn.rollback()
                except Exception:
                    pass
                logger.warning(
                    "activity-zones post-sync failed for %s", lid, exc_info=True
                )


class AbilityHandler:
    name = "ability"

    def applies_to(self, context: PostSyncContext) -> bool:
        return bool(context.activity_label_ids)

    def run(self, context: PostSyncContext) -> None:
        label_ids = list(_unique_labels(context.activity_label_ids))
        if not label_ids:
            return
        _emit(
            context.progress,
            phase="ability",
            message="正在更新能力模型和训练状态",
            activity_label_count=len(label_ids),
        )
        run_ability_hook(context.db, label_ids)


class ActivityCommentaryHandler:
    name = "activity_commentary"

    def applies_to(self, context: PostSyncContext) -> bool:
        return bool(context.activity_label_ids)

    def run(self, context: PostSyncContext) -> None:
        if not context.user:
            logger.debug("commentary post-sync skipped: no user in context")
            return
        label_ids = _unique_labels(context.activity_label_ids)
        if not label_ids:
            return
        try:
            from stride_server.commentary_ai import is_enabled, regenerate_and_save
        except Exception as exc:  # pragma: no cover - optional server deps
            logger.debug("commentary module unavailable: %s", exc)
            return
        if not is_enabled():
            return

        _emit(
            context.progress,
            phase="commentary",
            message="正在准备活动解读草稿",
            activity_label_count=len(label_ids),
        )
        for label_id in label_ids:
            try:
                if context.db.activity_commentary_exists(label_id):
                    logger.debug("commentary already exists for %s, skipping auto-gen", label_id)
                    continue
                regenerate_and_save(context.user, label_id, db=context.db)
                logger.info("auto-generated commentary for %s (user=%s)", label_id, context.user)
            except Exception:
                logger.exception(
                    "activity commentary post-sync failed for %s (user=%s)",
                    label_id,
                    context.user,
                )


class PersonalBestsHandler:
    name = "personal_bests"

    def applies_to(self, context: PostSyncContext) -> bool:
        return bool(context.activity_label_ids)

    def run(self, context: PostSyncContext) -> None:
        if not _unique_labels(context.activity_label_ids):
            return
        _emit(
            context.progress,
            phase="personal_bests",
            message="正在更新历史最好成绩 (PB)",
        )
        # A new/changed activity may set a fresh PB at any distance, so recompute
        # the whole best-effort scan and cache it into the personal_bests table.
        from stride_core.pb_records import persist_personal_bests

        persist_personal_bests(context.db)


DEFAULT_POST_SYNC_HANDLERS: tuple[PostSyncHandler, ...] = (
    StrideTrainingLoadHandler(),
    ActivityZonesHandler(),
    AbilityHandler(),
    PersonalBestsHandler(),
    ActivityCommentaryHandler(),
)


def run_post_sync_events(
    context: PostSyncContext,
    *,
    handlers: Sequence[PostSyncHandler] = DEFAULT_POST_SYNC_HANDLERS,
) -> None:
    for handler in handlers:
        try:
            if not handler.applies_to(context):
                continue
        except Exception:
            logger.error("post-sync handler applies_to failed: %s", handler.name, exc_info=True)
            continue

        try:
            handler.run(context)
        except Exception:
            logger.error("post-sync handler failed: %s", handler.name, exc_info=True)


def run_post_sync_for_labels(
    *,
    user: str | None,
    provider: str,
    operation: str,
    activity_label_ids: Sequence[str],
    progress: SyncProgressCallback | None = None,
    handlers: Sequence[PostSyncHandler] = DEFAULT_POST_SYNC_HANDLERS,
) -> None:
    label_ids = _unique_labels(activity_label_ids)
    if not label_ids:
        return
    try:
        with Database(user=user) as db:
            run_post_sync_events(
                PostSyncContext(
                    user=user,
                    provider=provider,
                    operation=operation,
                    db=db,
                    activity_label_ids=label_ids,
                    progress=progress,
                ),
                handlers=handlers,
            )
    except Exception:
        logger.error(
            "post-sync event runner failed for user=%s provider=%s operation=%s labels=%s",
            user,
            provider,
            operation,
            label_ids,
            exc_info=True,
        )


def run_post_sync_for_result(
    *,
    user: str | None,
    provider: str,
    operation: str,
    result: SyncResult,
    progress: SyncProgressCallback | None = None,
    handlers: Sequence[PostSyncHandler] = DEFAULT_POST_SYNC_HANDLERS,
) -> None:
    run_post_sync_for_labels(
        user=user,
        provider=provider,
        operation=operation,
        activity_label_ids=getattr(result, "activity_label_ids", ()) or (),
        progress=progress,
        handlers=handlers,
    )


__all__ = [
    "AbilityHandler",
    "ActivityCommentaryHandler",
    "ActivityZonesHandler",
    "DEFAULT_POST_SYNC_HANDLERS",
    "PostSyncContext",
    "PostSyncHandler",
    "StrideTrainingLoadHandler",
    "run_post_sync_events",
    "run_post_sync_for_labels",
    "run_post_sync_for_result",
]
