"""Plan-reminder cron job. Runs daily at 7:55am Asia/Shanghai (23:55 UTC the
previous day).

For each user with ``plan_reminder_enabled=True`` (read from Azure Table
``strideprefs``), look up today's planned session(s) from that user's
SQLite ``coros.db`` and fire a JPush notification.

Designed to be invoked as a one-shot script:

    python -m stride_server.notifications.plan_reminder_job

Intended deployment: Azure Container Apps Job (separate from the long-running
``stride-app`` revision) on a CRON schedule. Locally: invoke manually for
debugging, or run via systemd / cron.

Failures on one user don't block the rest.
"""

from __future__ import annotations

import logging
import re
import sys
from datetime import datetime, timedelta, timezone

from stride_core.db import USER_DATA_DIR, Database

from . import jpush_client
from . import store as nstore

logger = logging.getLogger(__name__)

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Asia/Shanghai is UTC+8 with no DST — keep it simple, no zoneinfo dep.
SHANGHAI_TZ = timezone(timedelta(hours=8))


def _today_iso() -> str:
    return datetime.now(SHANGHAI_TZ).date().isoformat()


def _now_hhmm() -> str:
    return datetime.now(SHANGHAI_TZ).strftime("%H:%M")


def _has_local_db(user_id: str) -> bool:
    return (USER_DATA_DIR / user_id / "coros.db").exists()


def _todays_sessions(db: Database, today: str) -> list[dict]:
    """Read today's planned sessions for this user."""
    rows = db._conn.execute(
        "SELECT kind, title, total_distance_m, total_duration_s,"
        "       target_pace, target_hr_zone"
        " FROM planned_session WHERE date = ? ORDER BY session_index",
        (today,),
    ).fetchall()
    return [dict(r) for r in rows]


def _format_message(sessions: list[dict]) -> tuple[str, str]:
    if not sessions:
        return "今日休息", "好好恢复，明天见。"
    if len(sessions) == 1:
        s = sessions[0]
        title = s["title"] or s["kind"] or "今日训练"
        parts: list[str] = []
        if s["total_distance_m"]:
            parts.append(f"{s['total_distance_m'] / 1000:.1f} km")
        if s["target_pace"]:
            parts.append(f"配速 {s['target_pace']}")
        elif s["target_hr_zone"]:
            parts.append(s["target_hr_zone"])
        body = " · ".join(parts) if parts else "查看详情"
        return f"今日 · {title}", body
    return "今日多组训练", f"今天有 {len(sessions)} 个训练课，去 STRIDE 查看详情。"


def run_for_user(user_id: str, *, today: str, current_hhmm: str) -> str:
    """Process a single user. Returns a status string for log aggregation."""
    if not _UUID4_RE.match(user_id):
        return "invalid_user_id"

    prefs = nstore.get_prefs(user_id)
    if not prefs.get("plan_reminder_enabled"):
        return "disabled"

    pref_time = prefs.get("plan_reminder_time", "08:00")
    try:
        pref_hh = int(pref_time.split(":")[0])
        cur_hh = int(current_hhmm.split(":")[0])
    except (ValueError, IndexError):
        pref_hh = cur_hh = 8
    if pref_hh != cur_hh:
        return f"wrong_hour(want={pref_time},now={current_hhmm})"

    devices = nstore.list_device_ids(user_id)
    if not devices:
        return "no_devices"

    if not _has_local_db(user_id):
        # Prefs row exists but the watch DB doesn't — we can't read planned
        # sessions, so skip cleanly.
        return "no_local_db"

    db = Database(user=user_id)
    sessions = _todays_sessions(db, today)
    title, body = _format_message(sessions)

    resp = jpush_client.push_to_registration_ids(
        devices,
        title=title,
        body=body,
        extras={
            "type": "plan_reminder",
            "date": today,
            "session_count": len(sessions),
        },
    )
    return "sent" if resp is not None else "send_failed"


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not jpush_client.is_enabled():
        logger.warning("JPush is not configured; aborting plan-reminder job")
        return 0

    today = _today_iso()
    now_hhmm = _now_hhmm()
    logger.info("plan_reminder_job: today=%s now=%s", today, now_hhmm)

    user_ids = nstore.list_users_with_prefs()
    logger.info("found %d users with notification prefs", len(user_ids))

    summary: dict[str, int] = {}
    for uid in user_ids:
        try:
            status = run_for_user(uid, today=today, current_hhmm=now_hhmm)
        except Exception as e:  # noqa: BLE001
            logger.exception("user=%s reminder failed: %s", uid[:8], e)
            status = "error"
        summary[status] = summary.get(status, 0) + 1
        logger.info("user=%s status=%s", uid[:8], status)

    logger.info("plan_reminder_job done: %s", summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
