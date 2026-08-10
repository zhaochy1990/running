from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from stride_server.config.models import ServerConfig
from stride_server.routes.public import router
from stride_storage.interfaces.config import DatabaseStorageConfig


class _Connection:
    def __init__(self, engine: "_Engine") -> None:
        self._engine = engine

    def __enter__(self) -> "_Connection":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: object, *_args: object, **_kwargs: object) -> None:
        self._engine.statements.append(str(statement))


class _Engine:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.statements: list[str] = []

    def connect(self) -> _Connection:
        if self.error is not None:
            raise self.error
        return _Connection(self)


def _mysql_config() -> ServerConfig:
    config = ServerConfig.default(env="prod")
    return config.with_updates(
        storage=config.storage.with_updates(
            database=DatabaseStorageConfig(
                mode="mysql",
                host="mysql.example",
                database="stride",
                username="reader",
                password="secret-value",
            )
        )
    )


def _client(config: ServerConfig, engine: _Engine) -> TestClient:
    app = FastAPI()
    app.state.config = config
    app.state.season_plan_reader_engine = engine
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_season_plan_reader_readiness_is_public_and_returns_contract_only() -> None:
    engine = _Engine()
    response = _client(_mysql_config(), engine).get("/readyz/season-plan-reader")

    assert response.status_code == 200
    assert response.json() == {
        "contract_version": "mysql-season-plan-context-v1",
        "reader_contract_version": "mysql-season-plan-context-v1",
    }
    assert engine.statements == ["SELECT 1 AS ready"]


def test_season_plan_reader_readiness_fails_closed_without_sqlite_fallback() -> None:
    config = ServerConfig.default(env="dev")
    engine = _Engine()
    response = _client(config, engine).get("/readyz/season-plan-reader")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert engine.statements == []


def test_season_plan_reader_readiness_hides_probe_errors_and_secrets() -> None:
    engine = _Engine(error=OSError("mysql.example:3306 password=secret-value"))
    response = _client(_mysql_config(), engine).get(
        "/readyz/season-plan-reader"
    )

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert "mysql.example" not in response.text
    assert "secret-value" not in response.text
