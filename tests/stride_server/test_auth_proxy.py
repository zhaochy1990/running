"""Tests for the /api/auth/* same-origin reverse proxy (routes/auth_proxy.py).

Context: the stride-app-served SPA fallback went same-origin for auth
(ADR 0017), so the old Python backend must forward /api/auth/* to the
auth-service. These tests pin: transparent forwarding (method/path/body/
X-Client-Id), pass-through of upstream status + body (incl. 401), no bearer
required, framing headers stripped, and graceful 502/503 on failure.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import stride_server.routes.auth_proxy as auth_proxy


def _make_client(monkeypatch, handler, *, base_url: str = "https://auth.test", timeout_s: float = 5.0):
    """Build a TestClient over just the auth_proxy router with httpx mocked.

    ``handler`` is an httpx.MockTransport handler: (httpx.Request) -> httpx.Response.
    """
    fake_config = SimpleNamespace(
        auth_service=SimpleNamespace(base_url=base_url, timeout_s=timeout_s)
    )
    monkeypatch.setattr(auth_proxy, "load_server_config", lambda *a, **k: fake_config)

    captured: dict = {}

    def _wrapped(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return handler(request)

    class _MockAsyncClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs.pop("timeout", None)
            super().__init__(*args, transport=httpx.MockTransport(_wrapped), **kwargs)

    monkeypatch.setattr(auth_proxy.httpx, "AsyncClient", _MockAsyncClient)

    app = FastAPI()
    app.include_router(auth_proxy.router)
    return TestClient(app, raise_server_exceptions=False), captured


def test_login_forwards_and_passes_through(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "tok", "refresh_token": "ref"})

    client, captured = _make_client(monkeypatch, handler)

    resp = client.post(
        "/api/auth/login",
        json={"email": "u@example.com", "password": "secret"},
        headers={"X-Client-Id": "app_123"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"access_token": "tok", "refresh_token": "ref"}

    # Forwarded to {base}/api/auth/login preserving method + X-Client-Id + body.
    fwd = captured["request"]
    assert str(fwd.url) == "https://auth.test/api/auth/login"
    assert fwd.method == "POST"
    assert fwd.headers.get("x-client-id") == "app_123"
    assert b"secret" in fwd.content
    # Host must be the upstream, not the incoming testclient host.
    assert fwd.headers["host"] == "auth.test"


def test_invalid_credentials_status_and_body_pass_through(monkeypatch):
    """A 401 from the auth-service must reach the browser verbatim (not 200/500)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid_credentials"})

    client, _ = _make_client(monkeypatch, handler)

    resp = client.post(
        "/api/auth/login",
        json={"email": "u@example.com", "password": "wrong"},
        headers={"X-Client-Id": "app_123"},
    )

    assert resp.status_code == 401
    assert resp.json() == {"detail": "invalid_credentials"}


def test_no_bearer_required(monkeypatch):
    """The proxy must not require Authorization — it mints the token."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"ok": True})

    client, _ = _make_client(monkeypatch, handler)

    resp = client.post("/api/auth/register", json={"email": "u@example.com"})
    assert resp.status_code == 200


def test_refresh_path_and_query_forwarded(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "new"})

    client, captured = _make_client(monkeypatch, handler)

    resp = client.post("/api/auth/refresh?foo=bar", json={"refresh_token": "r"})
    assert resp.status_code == 200
    fwd = captured["request"]
    assert str(fwd.url) == "https://auth.test/api/auth/refresh?foo=bar"


def test_content_encoding_stripped(monkeypatch):
    """Upstream Content-Encoding must not survive (httpx already decoded body)."""
    import gzip

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=gzip.compress(b'{"ok":true}'),
            headers={"content-type": "application/json", "content-encoding": "gzip"},
        )

    client, _ = _make_client(monkeypatch, handler)

    resp = client.post("/api/auth/login", json={})
    assert resp.status_code == 200
    assert "content-encoding" not in {k.lower() for k in resp.headers}
    assert resp.json() == {"ok": True}


def test_upstream_unreachable_returns_502(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down")

    client, _ = _make_client(monkeypatch, handler)

    resp = client.post("/api/auth/login", json={})
    assert resp.status_code == 502
    assert resp.json()["detail"] == "auth_upstream_unreachable"


def test_not_configured_returns_503(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(200)

    client, _ = _make_client(monkeypatch, handler, base_url="")

    resp = client.post("/api/auth/login", json={})
    assert resp.status_code == 503
    assert resp.json()["detail"] == "auth_service_not_configured"


def test_credentials_not_logged(monkeypatch, caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client, _ = _make_client(monkeypatch, handler)

    with caplog.at_level("WARNING"):
        client.post(
            "/api/auth/login",
            json={"email": "u@example.com", "password": "hunter2"},
            headers={"X-Client-Id": "app_123"},
        )
    assert "hunter2" not in caplog.text
