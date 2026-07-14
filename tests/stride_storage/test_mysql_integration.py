"""Opt-in real MySQL 8 integration for the dormant SQLAlchemy foundation.

Set STRIDE_MYSQL_INTEGRATION=1 and STRIDE_DATABASE_* variables. Tests are
read-only and never print credentials or render the connection URL.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import text

from stride_storage.interfaces.config import DatabaseStorageConfig
from stride_storage.mysql.engine import create_mysql_engine

pytestmark = pytest.mark.mysql_integration


def _config_from_env() -> DatabaseStorageConfig:
    if os.environ.get("STRIDE_MYSQL_INTEGRATION") != "1":
        pytest.skip("set STRIDE_MYSQL_INTEGRATION=1 for real MySQL tests")
    required = {
        "host": os.environ.get("STRIDE_DATABASE_HOST", ""),
        "database": os.environ.get("STRIDE_DATABASE_NAME", ""),
        "username": os.environ.get("STRIDE_DATABASE_USERNAME", ""),
        "password": os.environ.get("STRIDE_DATABASE_PASSWORD", ""),
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        pytest.fail(
            "MySQL integration was enabled but required fields are missing: "
            + ", ".join(missing)
        )
    return DatabaseStorageConfig(
        host=required["host"],
        port=int(os.environ.get("STRIDE_DATABASE_PORT", "3306")),
        database=required["database"],
        username=required["username"],
        password=required["password"],
        tls_ca_path=os.environ.get("STRIDE_DATABASE_TLS_CA_PATH", ""),
        connect_timeout_s=8,
        read_timeout_s=10,
        write_timeout_s=10,
    )


def test_mysql_8_session_is_utc_and_strict() -> None:
    engine = create_mysql_engine(_config_from_env())
    try:
        with engine.connect() as connection:
            version = str(connection.execute(text("SELECT VERSION()" )).scalar_one())
            time_zone = connection.execute(text("SELECT @@session.time_zone")).scalar_one()
            sql_mode = str(connection.execute(text("SELECT @@session.sql_mode")).scalar_one())
            isolation = connection.execute(text("SELECT @@transaction_isolation")).scalar_one()
        assert version.startswith("8.0.")
        assert time_zone == "+00:00"
        assert "STRICT_TRANS_TABLES" in sql_mode
        assert isolation == "READ-COMMITTED"
    finally:
        engine.dispose()
