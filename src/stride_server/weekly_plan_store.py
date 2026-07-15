"""Canonical structured WeeklyPlan storage — server-side facade."""

from __future__ import annotations

from functools import lru_cache

from stride_core.plan_spec import WeeklyPlan
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


def save_weekly_plan_projection(
    user_id: str,
    folder: str,
    plan_state_store: object,
    *,
    generated_by: str | None = None,
) -> WeeklyPlan | None:
    """Promote the SQLite watch projection into the canonical JSON store."""
    plan = plan_state_store.get_structured_weekly_plan(folder)
    if plan is None:
        return None
    get_weekly_plan_store().save_plan(user_id, plan, generated_by=generated_by)
    return plan


def reset_weekly_plan_store_cache() -> None:
    get_weekly_plan_store.cache_clear()
    clear_server_config_cache()
