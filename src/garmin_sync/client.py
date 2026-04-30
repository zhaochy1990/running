"""High-level Garmin Connect client built on garth + garminconnect.

Why this composition: garminconnect 0.3.3's built-in login is broken for CN
accounts (Cloudflare bot detection + JWT_WEB cookie quirks). The
recon script proved that `garth.Client(domain="garmin.cn").login()` works
reliably and that the garminconnect convenience methods accept any
`garth.Client`-compatible object as their internal `client`. So:

  1. Login via garth directly → authenticated `garth.Client`
  2. Construct `garminconnect.Garmin` with dummy credentials (skip its login)
  3. Replace its `.client` with our authenticated garth client
  4. Use the garminconnect convenience methods normally

This module exposes a `GarminClient` class that hides the construction
detail from sync.py / adapter.py.
"""

from __future__ import annotations

import logging
from typing import Any

import garth
from garminconnect import Garmin

from .auth import GarminCredentials, domain_for_region

logger = logging.getLogger(__name__)


class GarminAuthError(Exception):
    """Raised when login or token-restore fails."""


class GarminClient:
    """Authenticated wrapper around the garminconnect API surface.

    Construct via `login()` (fresh credentials) or `from_stored(user)`
    (resume an existing session). Both return a ready-to-use client.
    """

    def __init__(self, region: str, garth_client: garth.Client) -> None:
        self._region = region
        self._garth = garth_client
        self._api = Garmin(email="x", password="x", is_cn=(region == "cn"))
        self._api.client = garth_client
        self._api.username = getattr(garth_client, "username", "") or ""
        try:
            profile = getattr(garth_client, "profile", {}) or {}
            self._api.display_name = profile.get("displayName")
            self._api.full_name = profile.get("fullName")
        except Exception:
            pass

    @property
    def region(self) -> str:
        return self._region

    @property
    def garth(self) -> garth.Client:
        return self._garth

    @property
    def api(self) -> Garmin:
        return self._api

    @property
    def username(self) -> str:
        return self._api.username or ""

    @property
    def profile(self) -> dict[str, Any]:
        return getattr(self._garth, "profile", {}) or {}

    # ── Construction ───────────────────────────────────────────────────────

    @classmethod
    def login(cls, email: str, password: str, *, region: str = "cn") -> GarminClient:
        """Authenticate via garth and return a ready client.

        Raises GarminAuthError on failure (caller is responsible for the
        single-message 400 to avoid email enumeration).
        """
        domain = domain_for_region(region)
        try:
            garth_client = garth.Client(domain=domain)
            garth_client.login(email, password)
        except Exception as exc:
            raise GarminAuthError(f"Garmin login failed: {exc}") from exc
        return cls(region, garth_client)

    @classmethod
    def from_stored(cls, creds: GarminCredentials) -> GarminClient:
        """Restore a session from saved tokens. Raises GarminAuthError if invalid."""
        if not creds.is_logged_in:
            raise GarminAuthError("No stored Garmin tokens for this user")
        domain = domain_for_region(creds.region)
        try:
            garth_client = garth.Client(domain=domain)
            garth_client.loads(creds.tokens_dump)
        except Exception as exc:
            raise GarminAuthError(f"Could not restore Garmin session: {exc}") from exc
        return cls(creds.region, garth_client)

    # ── Convenience pass-throughs (just enough for sync v1) ────────────────

    def get_activities(self, start: int = 0, limit: int = 25) -> list[dict[str, Any]]:
        return self._api.get_activities(start, limit) or []

    def get_activity(self, activity_id: int | str) -> dict[str, Any]:
        return self._api.get_activity(activity_id) or {}

    def get_activity_details(self, activity_id: int | str) -> dict[str, Any]:
        return self._api.get_activity_details(activity_id) or {}

    def get_activity_splits(self, activity_id: int | str) -> dict[str, Any]:
        return self._api.get_activity_splits(activity_id) or {}

    def get_activity_hr_in_timezones(
        self, activity_id: int | str
    ) -> list[dict[str, Any]]:
        return self._api.get_activity_hr_in_timezones(activity_id) or []

    def get_activity_weather(self, activity_id: int | str) -> dict[str, Any]:
        try:
            return self._api.get_activity_weather(activity_id) or {}
        except Exception:
            return {}

    def get_training_status(self, date_iso: str) -> dict[str, Any]:
        return self._api.get_training_status(date_iso) or {}

    def get_user_summary(self, date_iso: str) -> dict[str, Any]:
        return self._api.get_user_summary(date_iso) or {}

    def get_rhr_day(self, date_iso: str) -> dict[str, Any]:
        return self._api.get_rhr_day(date_iso) or {}

    def get_hrv_data(self, date_iso: str) -> dict[str, Any]:
        try:
            return self._api.get_hrv_data(date_iso) or {}
        except Exception:
            return {}

    def get_sleep_data(self, date_iso: str) -> dict[str, Any]:
        try:
            return self._api.get_sleep_data(date_iso) or {}
        except Exception:
            return {}

    def get_lactate_threshold(self) -> dict[str, Any]:
        try:
            return self._api.get_lactate_threshold() or {}
        except Exception:
            return {}

    def get_race_predictions(self) -> dict[str, Any]:
        try:
            return self._api.get_race_predictions() or {}
        except Exception:
            return {}

    def get_devices(self) -> list[dict[str, Any]]:
        try:
            return self._api.get_devices() or []
        except Exception:
            return []
