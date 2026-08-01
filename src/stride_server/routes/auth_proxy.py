"""Same-origin reverse proxy for ``/api/auth/*`` → the in-house auth-service.

Why this exists (ADR 0017 fallout)
----------------------------------
The frontend now calls the auth flows at **relative, same-origin**
``/api/auth/{login,register,refresh,logout}`` and relies on a front-door to
forward them to the auth-service. The new ``stride-web`` Node BFF does exactly
that (``AUTH_UPSTREAM_URL``). But during the staged domain cutover the old
``stride-app`` Python image keeps serving the *same* SPA bundle as a fallback
(see ``static.py::mount_frontend``), and it had **no** ``/api/auth/*`` handler —
so a browser ``POST /api/auth/login`` landed on the GET-only SPA catch-all and
failed (405 / no route). Login on the stride-app-served SPA broke the moment the
frontend dropped its absolute ``VITE_AUTH_BASE_URL`` and went same-origin.

This router restores parity: it gives ``stride-app`` the same same-origin auth
front door by transparently proxying ``/api/auth/*`` to
``config.auth_service.base_url`` — the very same auth-service that
``auth_service_client`` already talks to for teams / ``/api/users/me``.

Why a transparent proxy and not ``auth_service_client``
-------------------------------------------------------
``auth_service_client`` is a *typed* client that forwards the caller's Bearer
token and raises on any 4xx. The browser auth flow is the opposite shape: it is
unauthenticated (it *mints* the token) and needs the upstream's status + body
passed through verbatim (e.g. a 401 "invalid credentials" with the
auth-service's own error JSON). A byte-for-byte pass-through is the right tool
here, so this is a distinct concern, not a duplicate.

This router is registered WITHOUT ``require_bearer`` (these are the
unauthenticated token-minting flows).
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Request, Response

from stride_server.config import load_server_config

logger = logging.getLogger(__name__)

router = APIRouter()

# Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded end-to-end.
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

# Methods the auth flows use (POST for login/register/refresh/logout); GET is
# included defensively. OPTIONS is intentionally omitted so the CORS middleware
# keeps owning preflight.
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]

_JSON = "application/json"


def _forward_request_headers(request: Request) -> dict[str, str]:
    """Copy the browser's request headers minus Host / framing / hop-by-hop.

    Keeps ``X-Client-Id``, ``Content-Type``, ``Accept`` (and ``Authorization``
    if present for ``/logout``) so the auth-service sees the original request.
    """
    headers: dict[str, str] = {}
    for name, value in request.headers.items():
        lower = name.lower()
        if lower in _HOP_BY_HOP or lower in ("host", "content-length"):
            continue
        headers[name] = value
    return headers


def _forward_response_headers(upstream: httpx.Response) -> dict[str, str]:
    """Copy upstream response headers, dropping now-invalid framing.

    httpx already decoded the body, so the upstream ``Content-Encoding`` /
    ``Content-Length`` would be wrong if forwarded with the decoded bytes
    (browser → ERR_CONTENT_DECODING_FAILED). Let Starlette recompute framing.
    """
    headers: dict[str, str] = {}
    for name, value in upstream.headers.items():
        lower = name.lower()
        if lower in _HOP_BY_HOP or lower in ("content-encoding", "content-length"):
            continue
        headers[name] = value
    return headers


@router.api_route("/api/auth/{path:path}", methods=_METHODS)
async def proxy_auth(path: str, request: Request) -> Response:
    config = load_server_config()
    base_url = config.auth_service.base_url.strip().rstrip("/")
    if not base_url:
        logger.warning("auth proxy: auth_service.base_url not configured; cannot forward /api/auth/%s", path)
        return Response(
            content=b'{"detail":"auth_service_not_configured"}',
            status_code=503,
            media_type=_JSON,
        )

    target = f"{base_url}/api/auth/{path}"
    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=config.auth_service.timeout_s) as client:
            upstream = await client.request(
                request.method,
                target,
                params=request.query_params,
                headers=_forward_request_headers(request),
                content=body,
            )
    except httpx.HTTPError as exc:
        # Don't log request bodies/headers — they carry credentials.
        logger.warning("auth proxy %s /api/auth/%s upstream error: %s", request.method, path, exc)
        return Response(
            content=b'{"detail":"auth_upstream_unreachable"}',
            status_code=502,
            media_type=_JSON,
        )

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_forward_response_headers(upstream),
    )
