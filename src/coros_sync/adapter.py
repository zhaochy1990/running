"""CorosDataSource — COROS implementation of stride_core.source.DataSource.

The server consumes this via the DataSource protocol; it does not import this
module directly (except at the composition root in stride_server.main).
"""

from __future__ import annotations

from stride_core.db import Database
from stride_core.models import ActivityDetail
from stride_core.source import SyncProgressCallback, SyncResult

from .auth import Credentials
from .client import CorosClient
from .sync import run_sync


class CorosNotLoggedInError(RuntimeError):
    """Raised when sync_user / resync_activity is called without valid credentials."""


class ActivityNotFoundError(LookupError):
    """Raised when resync_activity is called for a label_id not in the DB."""


class CorosDataSource:
    """COROS adapter — implements stride_core.source.DataSource."""

    name: str = "coros"

    def __init__(self, *, jobs: int = 4) -> None:
        self._jobs = jobs

    def is_logged_in(self, user: str) -> bool:
        return Credentials.load(user=user).is_logged_in

    def sync_user(
        self,
        user: str,
        *,
        full: bool = False,
        progress: SyncProgressCallback | None = None,
    ) -> SyncResult:
        creds = Credentials.load(user=user)
        if not creds.is_logged_in:
            raise CorosNotLoggedInError(
                f"用户 {user} 未登录，请先运行: coros-sync --profile {user} login"
            )

        kwargs = {"full": full, "jobs": self._jobs}
        if progress is not None:
            kwargs["progress"] = progress

        with CorosClient(creds, user=user) as client, Database(user=user) as db:
            activities, health = run_sync(client, db, **kwargs)
        return SyncResult(activities=activities, health=health)

    def resync_activity(self, user: str, label_id: str) -> bool:
        creds = Credentials.load(user=user)
        if not creds.is_logged_in:
            raise CorosNotLoggedInError(f"用户 {user} 未登录")

        db = Database(user=user)
        try:
            rows = db.query(
                "SELECT sport_type, date FROM activities WHERE label_id = ?",
                (label_id,),
            )
            if not rows:
                raise ActivityNotFoundError(label_id)
            sport_type = rows[0]["sport_type"]
            activity_date = rows[0]["date"]

            with CorosClient(creds, user=user) as client:
                detail_data = client.get_activity_detail(label_id, sport_type)
                detail = ActivityDetail.from_api(detail_data, label_id)
                if not detail.date:
                    detail.date = activity_date
                db.upsert_activity(detail)
        finally:
            db.close()
        return True
