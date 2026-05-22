"""Session fixtures for the prod smoke suite.

Layered so the unit-testable bits (`_config`, `_jwt`) stay pure:
  * `e2e_config_path`   — resolves the config file (default + --e2e-config flag)
  * `e2e_config`        — parsed E2EConfig; suite skips if file is missing
  * `e2e_token`         — POSTs auth-service /api/auth/login, returns access_token
  * `e2e_user_id`       — extract_sub(e2e_token)
  * `prod_client`       — httpx.Client(base_url=prod_url, Bearer auth)
  * `prod_client_anon`  — httpx.Client(base_url=prod_url, no auth header)
"""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from tests.e2e._config import ConfigError, E2EConfig, load_config
from tests.e2e._jwt import extract_sub

DEFAULT_CONFIG_PATH = Path(__file__).parent / "e2e.config.local.json"
LOGIN_TIMEOUT_S = 15.0
REQUEST_TIMEOUT_S = 15.0


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--e2e-config",
        action="store",
        default=None,
        help="Path to e2e config JSON. Defaults to tests/e2e/e2e.config.local.json.",
    )


@pytest.fixture(scope="session")
def e2e_config_path(request: pytest.FixtureRequest) -> Path:
    override = request.config.getoption("--e2e-config")
    return Path(override) if override else DEFAULT_CONFIG_PATH


@pytest.fixture(scope="session")
def e2e_config(e2e_config_path: Path) -> E2EConfig:
    try:
        return load_config(e2e_config_path)
    except ConfigError as e:
        pytest.skip(str(e))


@pytest.fixture(scope="session")
def e2e_token(e2e_config: E2EConfig) -> str:
    url = f"{e2e_config.auth_url}/api/auth/login"
    headers = {"X-Client-Id": e2e_config.client_id}
    body = {"email": e2e_config.e2e_email, "password": e2e_config.e2e_password}
    try:
        resp = httpx.post(url, json=body, headers=headers, timeout=LOGIN_TIMEOUT_S)
    except httpx.HTTPError as e:
        pytest.fail(f"auth-service login network error: {e}")
    if resp.status_code != 200:
        pytest.fail(
            f"auth-service login failed: {resp.status_code} {resp.text[:300]}"
        )
    payload = resp.json()
    token = payload.get("access_token")
    if not isinstance(token, str) or not token.strip():
        pytest.fail(f"auth-service login response missing access_token: {payload}")
    return token


@pytest.fixture(scope="session")
def e2e_user_id(e2e_token: str) -> str:
    return extract_sub(e2e_token)


@pytest.fixture(scope="session")
def prod_client(e2e_config: E2EConfig, e2e_token: str):
    with httpx.Client(
        base_url=e2e_config.prod_url,
        headers={"Authorization": f"Bearer {e2e_token}"},
        timeout=REQUEST_TIMEOUT_S,
    ) as client:
        yield client


@pytest.fixture(scope="session")
def prod_client_anon(e2e_config: E2EConfig):
    """Same base URL, no Authorization header. For 401-assertion tests."""
    with httpx.Client(base_url=e2e_config.prod_url, timeout=REQUEST_TIMEOUT_S) as client:
        yield client
