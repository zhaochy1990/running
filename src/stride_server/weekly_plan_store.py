"""Canonical structured WeeklyPlan storage — server-side facade."""

from __future__ import annotations

from functools import lru_cache
import hashlib

from stride_core.plan_spec import PlannedNutrition, PlannedSession, WeeklyPlan
from stride_core.timefmt import parse_week_folder_dates
from stride_server.config import clear_server_config_cache, load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, ServerConfig, WeeklyPlanStorageConfig
from stride_server.config.sources import env_source
from stride_storage.azure.weekly_plan_backend import (  # noqa: F401
    DEFAULT_TABLE_NAME,
    AzureTableWeeklyPlanStore,
    FileWeeklyPlanStore,
    store_from_config,
)
from stride_storage.interfaces.weekly_plan import WeeklyPlanStore  # noqa: F401


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _weekly_plan_config_from_env() -> WeeklyPlanStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).storage.weekly_plan
    storage = env_source().get("storage", {})
    weekly_plan = storage.get("weekly_plan", {}) if isinstance(storage, dict) else {}
    return config.with_updates(**weekly_plan) if isinstance(weekly_plan, dict) else config


def _weekly_plan_config() -> WeeklyPlanStorageConfig:
    try:
        return load_server_config().storage.weekly_plan
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _weekly_plan_config_from_env()


@lru_cache(maxsize=1)
def get_weekly_plan_store() -> WeeklyPlanStore:
    return store_from_config(_weekly_plan_config())


def save_weekly_plan(
    user_id: str, plan: WeeklyPlan, *, expected_folder: str | None = None,
    generated_by: str | None = None,
    source_hash: str | None = None,
) -> None:
    """Validate request identity, then perform the sole structured-plan write."""
    if expected_folder is not None and plan.week_folder != expected_folder:
        raise ValueError(
            f"weekly plan folder {plan.week_folder!r} does not match "
            f"requested folder {expected_folder!r}"
        )
    kwargs = {"generated_by": generated_by}
    if source_hash is not None:
        kwargs["source_hash"] = source_hash
    get_weekly_plan_store().save_plan(user_id, plan, **kwargs)


def create_weekly_plan(
    user_id: str, plan: WeeklyPlan, *, expected_folder: str | None = None,
    generated_by: str | None = None,
) -> bool:
    """Atomically create a canonical week; never replace an existing row."""
    if expected_folder is not None and plan.week_folder != expected_folder:
        raise ValueError(
            f"weekly plan folder {plan.week_folder!r} does not match "
            f"requested folder {expected_folder!r}"
        )
    return get_weekly_plan_store().create_plan(
        user_id, plan, generated_by=generated_by
    )


def plans_in_range(user_id: str, date_from: str, date_to: str) -> list[WeeklyPlan]:
    """Canonical plans whose inclusive bounds overlap the requested range."""
    plans: list[WeeklyPlan] = []
    for plan in get_weekly_plan_store().list_plans(user_id):
        bounds = parse_week_folder_dates(plan.week_folder)
        if bounds is not None and bounds[0] <= date_to and bounds[1] >= date_from:
            plans.append(plan)
    return plans


def find_session(
    user_id: str, date: str, session_index: int, *, folder: str | None = None,
) -> tuple[WeeklyPlan, PlannedSession] | None:
    store = get_weekly_plan_store()
    plan = store.get_plan(user_id, folder) if folder else store.get_current_plan(user_id, date)
    if plan is None:
        return None
    for session in plan.sessions:
        if session.date == date and session.session_index == session_index:
            return plan, session
    return None


def session_api_id(folder: str, date: str, session_index: int) -> int:
    """Stable numeric compatibility id; canonical identity remains the tuple."""
    raw = f"{folder}\0{date}\0{session_index}".encode()
    return int.from_bytes(hashlib.sha256(raw).digest()[:6], "big")


def session_to_api(
    folder: str, session: PlannedSession, *, scheduled_workout_id: int | None = None,
) -> dict:
    payload = session.to_dict()
    payload.pop("schema", None)
    payload.update(
        id=session_api_id(folder, session.date, session.session_index),
        scheduled_workout_id=scheduled_workout_id,
        pushable=session.pushable,
    )
    return payload


def nutrition_to_api(item: PlannedNutrition) -> dict:
    payload = item.to_dict()
    payload.pop("schema", None)
    return payload


def reset_weekly_plan_store_cache() -> None:
    get_weekly_plan_store.cache_clear()
    clear_server_config_cache()
