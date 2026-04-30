"""GarminDataSource — Garmin implementation of stride_core.source.DataSource.

The server consumes this via the DataSource protocol; routes do not import
this module directly (except at the composition root in stride_server.main).

v1 capabilities: read-only sync. No workout push, no exercise catalog.
Capabilities are hardcoded for now; dynamic discovery from get_devices()
is a phase-3 enhancement.
"""

from __future__ import annotations

import logging

from stride_core.db import Database
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
from stride_core.workout_spec import NormalizedRunWorkout

from .auth import GarminCredentials
from .client import GarminAuthError, GarminClient
from .models import activity_detail_from_garmin
from .normalize import apply_to_detail
from .sync import run_sync
from .translate import normalized_to_garmin_workout

logger = logging.getLogger(__name__)


_GARMIN_INFO = ProviderInfo(
    name="garmin",
    display_name="佳明",
    regions=("cn", "global"),
    # Phase 3 added HRV detail; Phase 4 wires up run-workout push (still
    # using garminconnect upload + schedule under the hood). Strength push
    # + exercise catalog remain a future phase.
    capabilities=frozenset({
        Capability.SYNC_HRV_DETAIL,
        Capability.PUSH_RUN_WORKOUT,
    }),
)


class GarminNotLoggedInError(RuntimeError):
    """Raised when sync_user / resync_activity is called without valid tokens."""


class ActivityNotFoundError(LookupError):
    """Raised when resync_activity is called for a label_id not in the DB."""


class GarminDataSource(BaseDataSource):
    """Garmin Connect adapter — implements stride_core.source.DataSource."""

    name: str = "garmin"

    @property
    def info(self) -> ProviderInfo:
        return _GARMIN_INFO

    # ── auth ────────────────────────────────────────────────────────────────

    def login(self, user: str, creds: LoginCredentials) -> LoginResult:
        """Authenticate via garth and persist tokens + provider tag.

        Region selection: if credentials.region is explicitly set, use it
        (caller knows best — typically read off the onboarding picker).
        Otherwise default to 'cn' since this adapter currently only ships
        with explicit CN/global toggling and CN is the more common case
        for the deployment's userbase.
        """
        region = (creds.region or "cn").lower()
        if region not in ("cn", "global"):
            region = "cn"

        try:
            client = GarminClient.login(creds.email, creds.password, region=region)
        except GarminAuthError as exc:
            return LoginResult(success=False, message=str(exc))

        # Persist tokens for future sync invocations
        GarminCredentials.from_garth_client(creds.email, region, client.garth).save(user)
        # Tag the user as a Garmin user — registry.for_user(uuid) will now
        # dispatch back here on every subsequent request.
        write_user_provider(user, "garmin")

        profile = client.profile
        return LoginResult(
            success=True,
            user_id=str(profile.get("profileId") or profile.get("id") or ""),
            region=region,
        )

    def is_logged_in(self, user: str) -> bool:
        return GarminCredentials.load(user).is_logged_in

    def logout(self, user: str) -> None:
        # Wipe the local token blob; provider tag in config.json stays so
        # the user can re-login without going back through onboarding.
        creds_path = GarminCredentials.load(user)
        if not creds_path.is_logged_in:
            return
        from .auth import _auth_path
        path = _auth_path(user)
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    # ── sync ────────────────────────────────────────────────────────────────

    def sync_user(
        self,
        user: str,
        *,
        full: bool = False,
        progress: SyncProgressCallback | None = None,
    ) -> SyncResult:
        creds = GarminCredentials.load(user)
        if not creds.is_logged_in:
            raise GarminNotLoggedInError(
                f"用户 {user} 未登录佳明，请先在前端完成 Garmin 登录"
            )

        client = GarminClient.from_stored(creds)
        with Database(user=user) as db:
            activities, health = run_sync(client, db, full=full, progress=progress)
        return SyncResult(activities=activities, health=health)

    def push_run_workout(self, user: str, workout: NormalizedRunWorkout) -> str:
        """Translate `NormalizedRunWorkout` and push to the user's Garmin schedule.

        Two API calls:
          1. POST upload_workout → returns workoutId (template stored on Garmin)
          2. POST schedule_workout(workoutId, date) → places it on the calendar

        Returns the Garmin workoutId as a string. The watch picks it up on
        next sync.
        """
        creds = GarminCredentials.load(user)
        if not creds.is_logged_in:
            raise GarminNotLoggedInError(f"用户 {user} 未登录佳明")

        client = GarminClient.from_stored(creds)
        payload = normalized_to_garmin_workout(workout)

        # Garmin's `upload_workout` accepts the workoutSegments structure
        # built by translate.py and returns the new workoutId.
        upload_result = client.api.upload_workout(payload)
        workout_id = (
            (upload_result or {}).get("workoutId")
            if isinstance(upload_result, dict) else None
        )
        if not workout_id:
            raise RuntimeError(
                f"Garmin upload_workout returned no workoutId: {upload_result!r}"
            )

        # Schedule onto the calendar.
        client.api.schedule_workout(workout_id, workout.date)
        return str(workout_id)

    def resync_activity(self, user: str, label_id: str) -> bool:
        creds = GarminCredentials.load(user)
        if not creds.is_logged_in:
            raise GarminNotLoggedInError(f"用户 {user} 未登录佳明")

        db = Database(user=user)
        try:
            rows = db.query(
                "SELECT date FROM activities WHERE label_id = ?",
                (label_id,),
            )
            if not rows:
                raise ActivityNotFoundError(label_id)
            activity_date = rows[0]["date"]

            client = GarminClient.from_stored(creds)
            activity = client.get_activity(label_id)
            if not activity:
                raise ActivityNotFoundError(label_id)
            splits = client.get_activity_splits(label_id)
            hr_zones = client.get_activity_hr_in_timezones(label_id)
            weather = client.get_activity_weather(label_id)

            detail = activity_detail_from_garmin(
                activity,
                splits=splits,
                hr_zones=hr_zones,
                weather=weather,
            )
            if not detail.date:
                detail.date = activity_date
            apply_to_detail(detail, activity)
            db.upsert_activity(detail, provider="garmin")
        finally:
            db.close()
        return True
