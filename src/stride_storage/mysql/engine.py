from __future__ import annotations

from pathlib import Path
from typing import Any

from stride_storage.interfaces.config import ConfigError, DatabaseStorageConfig


def create_mysql_engine(config: DatabaseStorageConfig) -> Any:
    config.validate_mysql_connection()
    try:
        from sqlalchemy import URL, create_engine, event
    except ImportError as exc:
        raise ConfigError("canonical MySQL generation requires sqlalchemy and pymysql") from exc
    connect_args = {
        "connect_timeout": config.connect_timeout_s,
        "read_timeout": config.read_timeout_s,
        "write_timeout": config.read_timeout_s,
        "charset": "utf8mb4",
    }
    if config.tls_ca_path:
        ca_path = Path(config.tls_ca_path)
        if not ca_path.is_file():
            raise ConfigError("storage.database.tls_ca_path must be a readable file")
        connect_args["ssl"] = {"ca": str(ca_path), "check_hostname": True}

    def initialize(connection: Any, _record: Any) -> None:
        cursor = connection.cursor()
        try:
            cursor.execute("SET SESSION time_zone = '+00:00'")
        finally:
            cursor.close()

    engine = create_engine(
        URL.create("mysql+pymysql", username=config.username.strip(), password=config.password,
                  host=config.host.strip(), port=config.port, database=config.database.strip()),
        pool_pre_ping=True, connect_args=connect_args, isolation_level="READ COMMITTED",
    )
    event.listen(engine, "connect", initialize)
    return engine
