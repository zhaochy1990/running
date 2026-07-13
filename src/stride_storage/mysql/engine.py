"""SQLAlchemy engine construction for Tencent MySQL 8.0.

The caller supplies an already-resolved config dataclass. This module never
imports server-side config loading and never renders/logs a connection URL.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import Engine, URL, create_engine, event

from stride_storage.interfaces.config import ConfigError, DatabaseStorageConfig


def build_mysql_url(config: DatabaseStorageConfig) -> URL:
    """Build a password-safe SQLAlchemy URL object (never interpolate a DSN)."""
    config.validate_mysql_connection()
    return URL.create(
        drivername="mysql+pymysql",
        username=config.username.strip(),
        password=config.password,
        host=config.host.strip(),
        port=config.port,
        database=config.database.strip(),
    )


def _initialize_session(dbapi_connection: Any, _connection_record: Any) -> None:
    """Make every new pooled connection UTC + strict, independent of defaults."""
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute(
            "SET SESSION time_zone = '+00:00', sql_mode = "
            "IF(FIND_IN_SET('STRICT_TRANS_TABLES', @@session.sql_mode), "
            "@@session.sql_mode, CONCAT_WS(',', NULLIF(@@session.sql_mode, ''), "
            "'STRICT_TRANS_TABLES'))"
        )
    finally:
        cursor.close()


def create_mysql_engine(config: DatabaseStorageConfig) -> Engine:
    """Create a pooled MySQL engine. The backend remains opt-in/dormant."""
    config.validate()
    config.validate_mysql_connection()

    connect_args: dict[str, Any] = {
        "connect_timeout": config.connect_timeout_s,
        "read_timeout": config.read_timeout_s,
        "write_timeout": config.write_timeout_s,
        "charset": "utf8mb4",
    }
    if config.tls_ca_path:
        ca_path = Path(config.tls_ca_path)
        if not ca_path.is_file():
            raise ConfigError("storage.database.tls_ca_path must be a readable file")
        connect_args["ssl"] = {"ca": str(ca_path), "check_hostname": True}

    engine = create_engine(
        build_mysql_url(config),
        pool_pre_ping=True,
        pool_size=config.pool_size,
        max_overflow=config.max_overflow,
        pool_timeout=config.pool_timeout_s,
        pool_recycle=config.pool_recycle_s,
        connect_args=connect_args,
        isolation_level="READ COMMITTED",
    )
    event.listen(engine, "connect", _initialize_session)
    return engine
