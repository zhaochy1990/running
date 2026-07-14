"""Foundation contracts for the dormant SQLAlchemy/MySQL backend."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest
from sqlalchemy import JSON, DateTime, create_mock_engine
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from stride_server.config.loader import load_server_config
from stride_storage.interfaces.config import ConfigError, DatabaseStorageConfig
from stride_storage.mysql.engine import build_mysql_url, create_mysql_engine
from stride_storage.mysql.schema import activities, metadata, sync_meta


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"


def _configured(**updates: object) -> DatabaseStorageConfig:
    values: dict[str, object] = {
        "host": "mysql.example.com",
        "port": 3306,
        "database": "stride",
        "username": "stride_app",
        "password": "top:@secret/%",
    }
    values.update(updates)
    return DatabaseStorageConfig(**values)  # type: ignore[arg-type]


def test_database_config_defaults_keep_mysql_dormant() -> None:
    config = DatabaseStorageConfig()
    assert config.mode == "sqlite"
    assert config.dual_write_enabled is False
    assert config.mysql_read_all is False
    assert config.mysql_users == ()


def test_database_config_requires_canonical_mysql_users() -> None:
    with pytest.raises(ConfigError, match="canonical UUID"):
        _configured(mysql_users=(USER_A.upper(), USER_B)).validate()


def test_database_config_is_frozen_and_hides_password():
    config = _configured()
    with pytest.raises(FrozenInstanceError):
        config.host = "other"  # type: ignore[misc]
    assert config.password not in repr(config)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("mode", "unknown", "mode"),
        ("port", 0, "port"),
        ("pool_size", 0, "pool_size"),
        ("max_overflow", -1, "max_overflow"),
        ("pool_timeout_s", 0, "pool_timeout_s"),
        ("pool_recycle_s", 0, "pool_recycle_s"),
        ("connect_timeout_s", 0, "connect_timeout_s"),
        ("read_timeout_s", 0, "read_timeout_s"),
        ("write_timeout_s", 0, "write_timeout_s"),
    ],
)
def test_database_config_rejects_invalid_runtime_values(field, value, message):
    config = _configured(**{field: value})
    with pytest.raises(ConfigError, match=message):
        config.validate()


def test_database_config_rejects_duplicate_or_invalid_users() -> None:
    with pytest.raises(ConfigError, match="duplicate"):
        _configured(mysql_users=(USER_A, USER_A.upper())).validate()
    with pytest.raises(ConfigError, match="UUID"):
        _configured(mysql_users=("not-a-uuid",)).validate()


def test_database_config_requires_connection_when_mysql_is_enabled() -> None:
    with pytest.raises(ConfigError, match="storage.database.host"):
        DatabaseStorageConfig(mode="hybrid").validate()
    with pytest.raises(ConfigError, match="mode must be 'hybrid'"):
        DatabaseStorageConfig(dual_write_enabled=True).validate()
    with pytest.raises(ConfigError, match="mode must be 'hybrid'"):
        DatabaseStorageConfig(mysql_users=(USER_A,)).validate()


def test_server_config_loader_parses_database_table(tmp_path: Path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.toml").write_text(
        """
        env = "local"
        [storage.database]
        mode = "hybrid"
        host = "mysql.example.com"
        port = 25272
        database = "stride"
        username = "stride_app"
        password = "secret"
        dual_write_enabled = true
        mysql_users = ["a1b2c3d4-e5f6-4aaa-89ab-123456789012"]
        """,
        encoding="utf-8",
    )
    config = load_server_config(
        project_root=tmp_path,
        environ={"STRIDE_CONFIG_ENV": "local"},
        config_dir=config_dir,
        use_cache=False,
    )
    assert config.storage.database.mode == "hybrid"
    assert config.storage.database.port == 25272
    assert config.storage.database.mysql_users == (USER_A,)


def test_build_mysql_url_never_renders_password() -> None:
    config = _configured()
    url = build_mysql_url(config)
    assert url.drivername == "mysql+pymysql"
    assert url.password == config.password
    assert config.password not in str(url)
    assert "***" in str(url)
    assert config.password not in repr(config)


def test_create_mysql_engine_sets_pool_and_utc_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: dict[str, object] = {}
    ca_path = tmp_path / "ca.pem"
    ca_path.write_text("test-ca", encoding="utf-8")

    class _Cursor:
        def execute(self, statement: str) -> None:
            seen.setdefault("statements", []).append(statement)  # type: ignore[union-attr]

        def close(self) -> None:
            seen["closed"] = True

    class _Connection:
        def cursor(self) -> _Cursor:
            return _Cursor()

    engine = create_mock_engine("mysql+pymysql://", lambda *a, **k: None)

    def fake_create_engine(url, **kwargs):
        seen["url"] = url
        seen["kwargs"] = kwargs
        return engine

    def fake_listen(target, name, fn):
        seen["listener_target"] = target
        seen["listener_name"] = name
        fn(_Connection(), None)

    monkeypatch.setattr("stride_storage.mysql.engine.create_engine", fake_create_engine)
    monkeypatch.setattr("stride_storage.mysql.engine.event.listen", fake_listen)

    create_mysql_engine(
        _configured(
            pool_size=7,
            max_overflow=3,
            pool_timeout_s=4,
            pool_recycle_s=600,
            tls_ca_path=str(ca_path),
        )
    )

    kwargs = seen["kwargs"]
    assert kwargs["pool_pre_ping"] is True  # type: ignore[index]
    assert kwargs["pool_size"] == 7  # type: ignore[index]
    assert kwargs["max_overflow"] == 3  # type: ignore[index]
    assert kwargs["pool_timeout"] == 4  # type: ignore[index]
    assert kwargs["pool_recycle"] == 600  # type: ignore[index]
    assert kwargs["isolation_level"] == "READ COMMITTED"  # type: ignore[index]
    assert kwargs["connect_args"] == {  # type: ignore[index]
        "connect_timeout": 5,
        "read_timeout": 30,
        "write_timeout": 30,
        "charset": "utf8mb4",
        "ssl": {"ca": str(ca_path), "check_hostname": True},
    }
    assert seen["listener_target"] is engine
    assert seen["listener_name"] == "connect"
    assert "time_zone = '+00:00'" in " ".join(seen["statements"])
    assert "STRICT_TRANS_TABLES" in " ".join(seen["statements"])
    assert seen["closed"] is True


def test_create_mysql_engine_requires_valid_config() -> None:
    with pytest.raises(ConfigError, match="storage.database.database"):
        create_mysql_engine(_configured(database=""))
    with pytest.raises(ConfigError, match="port"):
        create_mysql_engine(_configured(port=70000))


def test_create_mysql_engine_validates_tls_ca(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="tls_ca_path"):
        create_mysql_engine(_configured(tls_ca_path=str(tmp_path / "missing.pem")))


def test_minimal_schema_is_multi_tenant_and_mysql_native():
    expected_columns = {
        "user_id", "label_id", "name", "sport_type", "sport_name", "date",
        "distance_m", "duration_s", "avg_pace_s_km", "adjusted_pace",
        "best_km_pace", "max_pace", "avg_hr", "max_hr", "avg_cadence",
        "max_cadence", "avg_power", "max_power", "avg_step_len_cm",
        "ascent_m", "descent_m", "calories_kcal", "aerobic_effect",
        "anaerobic_effect", "training_load", "vo2max", "performance",
        "train_type", "temperature", "humidity", "feels_like", "wind_speed",
        "device", "feel_type", "sport_note", "sport", "train_kind", "feel",
        "provider", "vertical_oscillation_mm", "ground_contact_time_ms",
        "vertical_ratio_pct", "pauses", "route_thumb_json", "synced_at",
        "shanghai_date",
    }
    assert set(activities.c.keys()) == expected_columns
    assert "user_id" in activities.c
    assert [column.name for column in activities.primary_key.columns] == ["user_id", "label_id"]
    assert isinstance(activities.c.date.type, DateTime)
    assert activities.c.date.type.timezone is False
    assert isinstance(activities.c.route_thumb_json.type, JSON)

    assert [column.name for column in sync_meta.primary_key.columns] == ["user_id", "key"]

    ddl = str(CreateTable(activities).compile(dialect=mysql.dialect()))
    assert "DATETIME(6)" in ddl
    assert "PRIMARY KEY (user_id, label_id)" in ddl
    assert "JSON" in ddl
    assert "DATE(`date` + INTERVAL 8 HOUR)" in ddl
    assert "ENGINE=InnoDB" in ddl
    assert "CHARSET=utf8mb4" in ddl
    assert "CHARACTER SET ascii COLLATE ascii_bin" in ddl
    index_names = {index.name for index in activities.indexes}
    assert index_names == {
        "idx_activities_user_date",
        "idx_activities_user_shanghai_day",
    }


def test_metadata_contains_only_dormant_foundation_slice():
    assert set(metadata.tables) == {"activities", "sync_meta"}
