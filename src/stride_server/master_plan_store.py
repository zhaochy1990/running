"""MasterPlan storage — server-side facade.

The real implementation (file + Azure Table backends, the ``MasterPlanStore``
Protocol, ``store_from_config``) now lives in ``stride_storage``. This module
keeps only the *server* concerns: resolving ``MasterPlanStorageConfig`` from
``ServerConfig`` (TOML/env/Key Vault) and caching the chosen store.

Re-exports the moved symbols so existing
``from stride_server.master_plan_store import ...`` call sites keep working.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from stride_server.config import clear_server_config_cache, load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, MasterPlanStorageConfig, ServerConfig
from stride_server.config.sources import env_source

# Implementation lives in stride_storage; re-exported for backward-compat.
from stride_storage.azure.master_plan_backend import (  # noqa: F401  (re-export)
    DEFAULT_TABLE_NAME,
    AzureTableMasterPlanStore,
    FileMasterPlanStore,
    store_from_config,
    _plans_file,
    _read_json,
    _versions_file,
    _write_json,
)
from stride_storage.interfaces.master_plan import MasterPlanStore  # noqa: F401

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config resolution + cached store (server policy — stays here)
# ---------------------------------------------------------------------------


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _master_plan_config_from_env() -> MasterPlanStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).storage.master_plan
    storage = env_source().get("storage", {})
    master_plan = storage.get("master_plan", {}) if isinstance(storage, dict) else {}
    if isinstance(master_plan, dict):
        return config.with_updates(**master_plan)
    return config


def _master_plan_config() -> MasterPlanStorageConfig:
    try:
        return load_server_config().storage.master_plan
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _master_plan_config_from_env()


@lru_cache(maxsize=1)
def get_master_plan_store() -> MasterPlanStore:
    """Return the configured backend, cached as a singleton per process.

    Call ``reset_master_plan_store_cache()`` in tests to get a fresh instance.
    """
    return store_from_config(_master_plan_config())


def reset_master_plan_store_cache() -> None:
    """Test helper — drop the cached store so env changes take effect."""
    get_master_plan_store.cache_clear()
    clear_server_config_cache()
