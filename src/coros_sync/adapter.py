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
from stride_core.workout_spec import NormalizedRunWorkout, NormalizedStrengthWorkout

from .auth import Credentials
from .client import CorosClient, CorosAuthError
from .normalize import apply_to_detail
from .sync import run_sync
from .translate import normalized_to_coros_run, normalized_to_coros_strength
from .workout import push_strength_workout as _push_strength_to_watch
from .workout import push_workout


class CorosNotLoggedInError(RuntimeError):
    """Raised when sync_user / resync_activity is called without valid credentials."""


class ActivityNotFoundError(LookupError):
    """Raised when resync_activity is called for a label_id not in the DB."""


# Capabilities declared here describe what is wired through the DataSource
# interface today. Phase 4: PUSH_RUN_WORKOUT now goes through the registered
# adapter (normalized translation → existing coros_sync.workout pipeline).
# Strength push + exercise catalog remain CLI-only for now.
_COROS_INFO = ProviderInfo(
    name="coros",
    display_name="高驰",
    regions=("global", "cn", "eu"),
    capabilities=frozenset({
        Capability.PUSH_RUN_WORKOUT,
        Capability.PUSH_STRENGTH_WORKOUT,
        Capability.DELETE_WORKOUT,
    }),
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

    def push_run_workout(self, user: str, workout: NormalizedRunWorkout) -> str:
        """Push a `NormalizedRunWorkout` to the user's COROS schedule.

        Translates to the existing `coros_sync.workout.RunWorkout` builder
        and reuses the proven calculate→update push flow. Returns the COROS
        idInPlan as a string (the watch-side identifier for this workout).
        """
        creds = Credentials.load(user=user)
        if not creds.is_logged_in:
            raise CorosNotLoggedInError(f"用户 {user} 未登录")

        coros_workout = normalized_to_coros_run(workout)
        with CorosClient(creds, user=user) as client:
            response = push_workout(client, coros_workout)
        # Response shape varies; extract the id_in_plan we know we sent
        program = (response or {}).get("data", {}).get("programs") or []
        if program and isinstance(program[0], dict) and program[0].get("idInPlan"):
            return str(program[0]["idInPlan"])
        # Fallback: re-derive from the workout we built (push_workout stamped
        # the id_in_plan onto its payload before calling the API).
        return str(coros_workout.date)

    def delete_scheduled_workout(self, user: str, date: str) -> bool:
        """Delete previously-pushed [STRIDE] workouts on `date` from the watch.

        Mirrors the CLI ``coros-sync workout delete`` flow but additionally
        filters by the ``[STRIDE]`` name prefix per the project rule "never
        delete non-STRIDE workouts" — protects the user's own watch entries
        from accidental deletion when our re-push flow runs.

        ``date`` arrives as ISO ``YYYY-MM-DD`` (matches ``scheduled_workout.date``
        and ``planned_session.date``); COROS API expects ``YYYYMMDD`` so we
        coerce. Returns ``True`` when at least one matching entity was
        deleted, ``False`` when no STRIDE entries existed on that date
        (still considered success — re-push can proceed).
        """
        creds = Credentials.load(user=user)
        if not creds.is_logged_in:
            raise CorosNotLoggedInError(f"用户 {user} 未登录")

        coros_date = date.replace("-", "")  # 2026-05-04 -> 20260504
        deleted = 0
        with CorosClient(creds, user=user) as client:
            data = client.query_schedule(coros_date, coros_date)
            schedule = data.get("data", {})
            plan_id = schedule.get("id", "")
            entities = schedule.get("entities", []) or []
            programs = schedule.get("programs", []) or []

            # Build a name lookup keyed by idInPlan. The schedule API returns
            # the program name in `programs[]` (parallel array), not on the
            # entity itself — entities only carry `idInPlan` / `planProgramId`
            # references. exerciseBarChart is empty for newly-pushed entries
            # that haven't been completed yet, so the previous code path
            # never matched anything.
            programs_by_idinplan: dict[str, str] = {}
            for prog in programs:
                idip = str(prog.get("idInPlan") or prog.get("id") or "")
                if idip:
                    programs_by_idinplan[idip] = str(prog.get("name") or "")

            for entity in entities:
                if str(entity.get("happenDay")) != coros_date:
                    continue
                idip = str(entity.get("idInPlan") or entity.get("planProgramId") or "")
                program_name = programs_by_idinplan.get(idip, "")
                if not program_name.startswith("[STRIDE]"):
                    continue
                client.delete_scheduled_workout(entity, plan_id)
                deleted += 1
        return deleted > 0

    def push_strength_workout(self, user: str, workout: NormalizedStrengthWorkout) -> str:
        """Push a `NormalizedStrengthWorkout` to the user's COROS schedule.

        For each `StrengthExerciseSpec.display_name`, we first try to match a
        COROS built-in exercise (419 catalog entries) by substring match on
        the localized `overview` / `name` fields. Misses fall back to creating
        a custom exercise via `client.add_exercise()` then re-translating.
        """
        creds = Credentials.load(user=user)
        if not creds.is_logged_in:
            raise CorosNotLoggedInError(f"用户 {user} 未登录")

        with CorosClient(creds, user=user) as client:
            available = client.query_exercises(sport_type=4)
            coros_workout, missing = normalized_to_coros_strength(workout, available)
            if missing:
                # Fallback: create custom exercises for any unmatched names,
                # then re-translate against the refreshed library so the new
                # IDs are picked up.
                for ex_payload in missing:
                    client.add_exercise(ex_payload)
                available = client.query_exercises(sport_type=4)
                coros_workout, _ = normalized_to_coros_strength(workout, available)
            response = _push_strength_to_watch(client, coros_workout)

        program = (response or {}).get("data", {}).get("programs") or []
        if program and isinstance(program[0], dict) and program[0].get("idInPlan"):
            return str(program[0]["idInPlan"])
        return str(coros_workout.date)

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
                apply_to_detail(detail, detail_data)
                db.upsert_activity(detail)
        finally:
            db.close()
        return True
