from __future__ import annotations

from datetime import date
from functools import lru_cache
from typing import Any

from stride_storage.interfaces.config import ConfigError, DatabaseStorageConfig
from stride_storage.interfaces.season_plan import CanonicalSeasonPlanDataUnavailable
from stride_storage.mysql.engine import create_mysql_engine
from stride_storage.mysql.season_plan_reader import (
    CONTRACT_VERSION,
    MySQLSeasonPlanReader,
    probe_canonical_mysql,
)

from .config import load_server_config
from .config.models import ServerConfig


def _database_config(config: ServerConfig | None = None) -> DatabaseStorageConfig:
    database = (config or load_server_config()).storage.database
    if database.mode != "mysql":
        raise ConfigError("canonical MySQL season-plan generation requires storage.database.mode='mysql'")
    database.validate_mysql_connection()
    return database


@lru_cache(maxsize=1)
def _engine(database: DatabaseStorageConfig | None = None) -> Any:
    return create_mysql_engine(database or _database_config())


def get_canonical_season_plan_reader(
    config: ServerConfig | None = None,
) -> MySQLSeasonPlanReader:
    return MySQLSeasonPlanReader(_engine(_database_config(config)))


def probe_canonical_season_plan_reader(
    config: ServerConfig | None = None,
    *,
    engine: Any | None = None,
) -> str:
    """Probe the resolved canonical MySQL reader without reading user data."""
    database = _database_config(config)
    try:
        probe_canonical_mysql(engine if engine is not None else _engine(database))
    except (ConfigError, CanonicalSeasonPlanDataUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 — normalize external DB boundary
        raise CanonicalSeasonPlanDataUnavailable(
            "canonical MySQL season-plan reader is unavailable"
        ) from exc
    return CONTRACT_VERSION


def load_canonical_season_context(user_id: str, *, goal_id: str | None = None, as_of: date | None = None) -> dict[str, Any]:
    try:
        return dict(get_canonical_season_plan_reader().read(user_id, goal_id=goal_id, as_of=as_of))
    except (ConfigError, CanonicalSeasonPlanDataUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        raise CanonicalSeasonPlanDataUnavailable("canonical MySQL season-plan context is unavailable") from exc


def reset_canonical_season_plan_reader_for_tests() -> None:
    _engine.cache_clear()
