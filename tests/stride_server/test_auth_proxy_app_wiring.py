"""Integration smoke: /api/auth/* is wired into the real app ahead of the SPA
catch-all and is reachable WITHOUT a bearer token, while other /api/* routes
stay bearer-protected. This pins the ADR-0017 regression fix at the app level.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from stride_server.config.models import AuthConfig, ServerConfig


@pytest.fixture
def rsa_public_pem() -> str:
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()


class _StubSource:
    name = "stub"

    @property
    def info(self):
        from stride_core.source import ProviderInfo

        return ProviderInfo(name="stub", display_name="Stub", regions=(), capabilities=frozenset())

    def is_logged_in(self, user: str) -> bool:
        return True


@pytest.fixture
def client(monkeypatch, rsa_public_pem):
    from stride_server.config import clear_server_config_cache

    clear_server_config_cache()
    import stride_server.bearer as bearer

    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)

    # Mock the auth upstream so the proxy forwards to a canned auth-service.
    import stride_server.routes.auth_proxy as auth_proxy

    fake_config = SimpleNamespace(
        auth_service=SimpleNamespace(base_url="https://auth.test", timeout_s=5.0)
    )
    monkeypatch.setattr(auth_proxy, "load_server_config", lambda *a, **k: fake_config)

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "tok", "path": str(request.url.path)})

    class _MockAsyncClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs.pop("timeout", None)
            super().__init__(*args, transport=httpx.MockTransport(_handler), **kwargs)

    monkeypatch.setattr(auth_proxy.httpx, "AsyncClient", _MockAsyncClient)

    from stride_server.app import create_app

    app = create_app(
        _StubSource(),
        config=ServerConfig.default(env="prod").with_updates(
            auth=AuthConfig(public_key_pem=rsa_public_pem)
        ),
    )
    return TestClient(app, raise_server_exceptions=False)


def test_auth_login_no_bearer_reaches_proxy(client):
    """POST /api/auth/login must hit the proxy (200), not the GET-only SPA
    catch-all (405) and not require_bearer (401)."""
    resp = client.post(
        "/api/auth/login",
        json={"email": "u@example.com", "password": "secret"},
        headers={"X-Client-Id": "app_123"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["access_token"] == "tok"
    assert body["path"] == "/api/auth/login"


def test_other_api_still_requires_bearer(client):
    """Sanity: a normal protected /api/* route without a token is still 401,
    proving the auth proxy didn't accidentally open the whole /api surface."""
    resp = client.get("/api/users")
    assert resp.status_code == 401
