"""Minimal JPush v3 REST client.

We only need the `/v3/push` endpoint to send a notification by registration ID.
Auth: HTTP Basic with `<AppKey>:<MasterSecret>`. Both come from env vars
(`JPUSH_APP_KEY`, `JPUSH_MASTER_SECRET`) — Master Secret is also injected via
Azure Key Vault secretref `jpush-master-secret`.

Failures are logged and swallowed — push delivery is best-effort. We never
let a JPush hiccup fail the originating request (like a like-toggle).

Reference: https://docs.jiguang.cn/jpush/server/push/rest_api_v3_push
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

import httpx

from stride_server.config import load_server_config
from stride_server.config.models import JPushConfig

logger = logging.getLogger(__name__)

JPUSH_URL = "https://api.jpush.cn/v3/push"
TIMEOUT_S = 10.0


def credentials_from_config(config: JPushConfig) -> tuple[str, str] | None:
    app_key = config.app_key.strip()
    master_secret = config.master_secret.strip()
    if not app_key or not master_secret:
        return None
    return app_key, master_secret


def _jpush_config() -> JPushConfig:
    return load_server_config().notifications.jpush


def _credentials() -> tuple[str, str] | None:
    return credentials_from_config(_jpush_config())


def is_enabled() -> bool:
    """True when both env vars are present. Routes can short-circuit when off."""
    return _credentials() is not None


def _basic_header(app_key: str, master_secret: str) -> str:
    raw = f"{app_key}:{master_secret}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def push_to_registration_ids(
    registration_ids: list[str],
    *,
    title: str,
    body: str,
    extras: dict[str, Any] | None = None,
) -> dict | None:
    """Send a single push to a list of registration IDs.

    Returns the JPush response JSON on success, None on failure or when
    JPush is not configured. Never raises — push is best-effort.
    """
    config = _jpush_config()
    creds = credentials_from_config(config)
    if creds is None:
        logger.debug("JPush not configured (env vars missing); skipping push")
        return None
    if not registration_ids:
        return None

    app_key, master_secret = creds
    payload = {
        "platform": "all",
        "audience": {"registration_id": registration_ids},
        "notification": {
            "android": {
                "alert": body,
                "title": title,
                "extras": extras or {},
            },
            "ios": {
                "alert": {"title": title, "body": body},
                "extras": extras or {},
            },
        },
        "options": {
            "apns_production": config.apns_production,
        },
    }

    try:
        with httpx.Client(timeout=config.timeout_s) as client:
            resp = client.post(
                config.url,
                content=json.dumps(payload).encode(),
                headers={
                    "Authorization": _basic_header(app_key, master_secret),
                    "Content-Type": "application/json",
                },
            )
        if resp.status_code >= 400:
            logger.warning(
                "JPush push failed: status=%d body=%s",
                resp.status_code, resp.text[:500],
            )
            return None
        logger.info(
            "JPush sent to %d devices: title=%r",
            len(registration_ids), title,
        )
        return resp.json()
    except httpx.HTTPError as e:
        logger.warning("JPush HTTP error: %s", e)
        return None
    except Exception as e:  # noqa: BLE001 - never propagate from a push send
        logger.exception("Unexpected JPush error: %s", e)
        return None
