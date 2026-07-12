"""Onboarding-pipeline progress → notification-center messages.

Single source for the onboarding progress notification's copy, its stable
``notification_id``, and the write-throttle. The whole onboarding run surfaces
as ONE notification row (``ONBOARDING_NOTIFICATION_ID``) that is upserted in
place as the run advances: syncing → sync done → analyzing → complete (or
failed). The notification store upserts by ``notification_id``, so re-publishing
the same id overwrites the row rather than adding a new inbox entry.

Publishing is best-effort: a notification failure must never abort the
pipeline, so every call swallows its own errors.

Called from two layers (both in the worker process):
- ``handlers/onboarding.py`` — live sync progress (only place with current/total)
- ``jobs/orchestrator.py`` — step/run transitions
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

ONBOARDING_NOTIFICATION_ID = "onboarding-progress"

# Progress-bar bands per phase. Sync dominates wall-clock, so it owns the widest
# band; calibration/backfill ("analyzing") is quick so it sits near the end.
_SYNC_BAND_MAX = 60  # syncing maps current/total into 0.._SYNC_BAND_MAX
_SYNC_DONE_PCT = 60
_ANALYZING_PCT = 80
_COMPLETE_PCT = 100

_TITLE = "STRIDE 初始化"

# Only re-publish the syncing row when the mapped percent advances by at least
# this much (or on the final activity) — a 700+ activity sync ticks per-activity
# but we don't want to write Azure Table hundreds of times.
_THROTTLE_STEP_PCT = 5

_last_pct: dict[str, int] = {}
_lock = threading.Lock()


def reset_throttle(user_id: str | None = None) -> None:
    """Clear the per-user throttle memory (test helper / run restart)."""
    with _lock:
        if user_id is None:
            _last_pct.clear()
        else:
            _last_pct.pop(user_id, None)


def _publish(
    user_id: str,
    *,
    body: str,
    severity: str,
    progress_pct: int,
    state: str,
) -> None:
    """Upsert the single onboarding notification row. Best-effort."""
    from stride_server.notifications import store as nstore

    try:
        nstore.upsert_notification(
            user_id,
            ONBOARDING_NOTIFICATION_ID,
            title=_TITLE,
            body=body,
            severity=severity,
            action_url="/activities",
            progress_pct=progress_pct,
            metadata={"type": "onboarding_sync", "state": state},
        )
    except Exception:  # noqa: BLE001 — notifications must never break the pipeline
        logger.warning("onboarding notification publish failed for %s", user_id, exc_info=True)


def publish_started(user_id: str) -> None:
    """Pipeline kicked off: '正在处理你的数据'.

    Emitted from ``start_pipeline`` (API process) the moment the run is created —
    BEFORE the worker picks up the first step. This guarantees the user sees the
    job is running even if the very first step fails immediately (e.g. a watch
    credential problem), instead of a silent gap until the terminal-failure
    notification.
    """
    reset_throttle(user_id)
    _publish(
        user_id,
        body="STRIDE 正在处理你的数据",
        severity="info",
        progress_pct=5,
        state="started",
    )


def publish_syncing(user_id: str, current: int, total: int) -> None:
    """Live sync progress: '正在同步你的数据，当前进度 59/783'. Throttled.

    Writes only when the mapped percent has advanced ``_THROTTLE_STEP_PCT`` since
    the last write, or when the sync reaches its last activity (current==total).
    """
    if total <= 0:
        return
    current = max(0, min(current, total))
    pct = round(current / total * _SYNC_BAND_MAX)
    is_final = current >= total
    with _lock:
        last = _last_pct.get(user_id)
        if not is_final and last is not None and pct - last < _THROTTLE_STEP_PCT:
            return
        _last_pct[user_id] = pct
    _publish(
        user_id,
        body=f"STRIDE 正在同步你的数据，当前进度 {current}/{total}",
        severity="info",
        progress_pct=pct,
        state="syncing",
    )


def publish_sync_done(user_id: str, activities: int) -> None:
    """Sync step finished: '已完成数据同步，共同步 783 条运动记录'."""
    reset_throttle(user_id)
    _publish(
        user_id,
        body=f"STRIDE 已完成数据同步，共同步 {activities} 条运动记录",
        severity="info",
        progress_pct=_SYNC_DONE_PCT,
        state="sync_done",
    )


def publish_analyzing(user_id: str) -> None:
    """Calibration/backfill running: '正在分析你的数据'."""
    _publish(
        user_id,
        body="STRIDE 正在分析你的数据",
        severity="info",
        progress_pct=_ANALYZING_PCT,
        state="analyzing",
    )


def publish_complete(user_id: str) -> None:
    """Whole run done: '已完成初始化，快去看看你的训练状态吧'."""
    reset_throttle(user_id)
    _publish(
        user_id,
        body="STRIDE 已完成初始化，快去看看你的训练状态吧",
        severity="success",
        progress_pct=_COMPLETE_PCT,
        state="done",
    )


def publish_failed(user_id: str, step_name: str) -> None:
    """A step failed → the run is stuck. Generic copy, no internal detail leaked."""
    reset_throttle(user_id)
    logger.warning("onboarding failed at step %s for %s", step_name, user_id)
    _publish(
        user_id,
        body="STRIDE 初始化未完成，请稍后重试",
        severity="error",
        progress_pct=0,
        state="failed",
    )
