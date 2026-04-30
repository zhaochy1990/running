"""CorosDataSource — COROS implementation of stride_core.source.DataSource.

The server consumes this via the DataSource protocol; it does not import this
module directly (except at the composition root in stride_server.main).
"""

from __future__ import annotations

from stride_core.db import Database
from stride_core.models import ActivityDetail
from stride_core.registry import write_user_provider
from stride_core.source import (
    BaseDataSource,
    Capability,
    LoginCredentials,
    LoginResult,
    ProviderInfo,
    SyncProgressCallback,
    SyncResult,
)

from .auth import Credentials
from .client import CorosClient, CorosAuthError
from .sync import run_sync


class CorosNotLoggedInError(RuntimeError):
    """Raised when sync_user / resync_activity is called without valid credentials."""


class ActivityNotFoundError(LookupError):
    """Raised when resync_activity is called for a label_id not in the DB."""


# Capabilities declared here describe what is wired through the DataSource
# interface today. COROS the *device* supports run/strength push and the
# exercise catalog, but those paths still go through coros_sync.workout
# directly from the CLI; declaring them here would lie to capability-checking
# callers. Capabilities will be added as the adapter rewrite (follow-up task)
# wires each method to NormalizedRunWorkout / NormalizedStrengthWorkout.
_COROS_INFO = ProviderInfo(
    name="coros",
    display_name="高驰",
    regions=("global", "cn", "eu"),
    capabilities=frozenset(),
)


class CorosDataSource(BaseDataSource):
    """COROS adapter — implements stride_core.source.DataSource.

    Currently inherits default `FeatureNotSupported` raises for the workout-push
    and exercise-catalog methods even though COROS supports them; the concrete
    implementations are wired in as part of the abstraction-layer rollout
    (follow-up task — adapter rewrite to consume `NormalizedRunWorkout` etc.).
    Until then, push paths continue to go through `coros_sync.workout` directly
    from the CLI; routes do not call them.
    """

    name: str = "coros"

    def __init__(self, *, jobs: int = 4) -> None:
        self._jobs = jobs

    @property
    def info(self) -> ProviderInfo:
        return _COROS_INFO

    def login(self, user: str, creds: LoginCredentials) -> LoginResult:
        """Authenticate with COROS Training Hub and persist credentials.

        On success, writes both the COROS-specific credentials (email,
        pwd_hash, access_token, region, user_id) and the provider tag
        (`provider='coros'`) to `data/{user}/config.json`. The provider tag
        is what `ProviderRegistry.for_user(user)` reads to dispatch
        subsequent requests back to this adapter.

        On failure (auth or network), raises the underlying COROS exception
        unchanged — the caller (route layer) is responsible for collapsing
        these into a single 400 to avoid email-enumeration.
        """
        with CorosClient(user=user) as client:
            coros_creds = client.login(creds.email, creds.password)
        # CorosClient.login() already wrote credentials to config.json; this
        # adds the provider key alongside (Credentials.save preserves it on
        # subsequent re-logins).
        write_user_provider(user, "coros")
        return LoginResult(
            success=True,
            user_id=coros_creds.user_id,
            region=coros_creds.region,
        )

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
