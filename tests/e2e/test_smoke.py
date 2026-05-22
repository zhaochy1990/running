"""Read-only prod smoke suite. Opt-in via `pytest -m e2e`."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest


@pytest.mark.e2e
def test_liveness(prod_client_anon) -> None:
    """Case 1: /api/health is unauthenticated and returns {"status": "ok"}."""
    resp = prod_client_anon.get("/api/health")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok"}


@pytest.mark.e2e
def test_unauthenticated_is_401(prod_client_anon) -> None:
    """Case 2: a protected route returns 401 when called without a Bearer.

    Proves the auth middleware is wired — a deploy that accidentally
    disabled require_bearer (e.g. by losing the public key env var)
    would let this slip through with a 200.
    """
    resp = prod_client_anon.get("/api/users")
    assert resp.status_code == 401, f"expected 401, got {resp.status_code}: {resp.text[:200]}"


@pytest.mark.e2e
def test_users_returns_current_user(prod_client, e2e_user_id) -> None:
    """Case 3: GET /api/users with a valid Bearer includes the e2e user UUID.

    Proves: auth verification succeeds end-to-end (public key env var set on
    prod), AND the Azure Files share is mounted with the e2e user's data dir
    present (the route lists subdirectories of /app/data).
    """
    resp = prod_client.get("/api/users")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "users" in payload, f"missing 'users' key: {payload}"
    assert isinstance(payload["users"], list), payload
    assert e2e_user_id in payload["users"], (
        f"e2e user {e2e_user_id} not present in /api/users response "
        f"(got {len(payload['users'])} users) — was the test user seeded?"
    )


HOME_REQUIRED_KEYS = frozenset({
    "status_ring", "recent_activities", "weekly_stats",
    "lifetime_stats", "plan_state", "watch",
})


@pytest.mark.e2e
def test_home_dashboard(prod_client, e2e_user_id) -> None:
    """Case 4: /api/{user}/home returns all HomeResponse top-level keys.

    Asserts schema-shape, not values — daily content varies; missing keys
    indicate a real backend regression.
    """
    resp = prod_client.get(f"/api/{e2e_user_id}/home")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert isinstance(payload, dict), f"expected object, got {type(payload).__name__}"
    missing = HOME_REQUIRED_KEYS - payload.keys()
    assert not missing, f"home response missing keys: {sorted(missing)} (got {sorted(payload.keys())})"


@pytest.mark.e2e
def test_weeks_list(prod_client, e2e_user_id) -> None:
    """Case 5: /api/{user}/weeks returns at least one folder.

    Proves Azure Files mount + week-folder discovery. The e2e user must
    have at least one `data/{uuid}/logs/<date-folder>/plan.md` synced.
    """
    resp = prod_client.get(f"/api/{e2e_user_id}/weeks")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "weeks" in payload and isinstance(payload["weeks"], list), payload
    assert len(payload["weeks"]) > 0, (
        "weeks list is empty — did sync-data.yml push the seed plan.md to Azure Files?"
    )
    first = payload["weeks"][0]
    assert "folder" in first and isinstance(first["folder"], str), first


SHANGHAI_UTCOFFSET = timedelta(hours=8)


@pytest.mark.e2e
def test_activities_list_and_timezone(prod_client, e2e_user_id) -> None:
    """Case 6: /api/{user}/activities returns rows with Shanghai-offset dates.

    Proves: SQLite read works, the route applied utc_iso_to_shanghai_iso
    (so every `date` ends in `+08:00`), and the seed activity was synced.
    """
    resp = prod_client.get(f"/api/{e2e_user_id}/activities", params={"limit": 5})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "activities" in payload and isinstance(payload["activities"], list), payload
    assert len(payload["activities"]) > 0, (
        "activities list is empty — did the e2e user sync at least one activity?"
    )
    for row in payload["activities"]:
        date_str = row.get("date")
        assert isinstance(date_str, str) and date_str, f"row missing `date`: {row}"
        try:
            dt = datetime.fromisoformat(date_str)
        except ValueError as e:
            pytest.fail(f"row `date` not ISO-parseable: {date_str!r} ({e})")
        assert dt.utcoffset() == SHANGHAI_UTCOFFSET, (
            f"row `date` offset is {dt.utcoffset()}, expected +08:00 — "
            f"the route may have dropped utc_iso_to_shanghai_iso. Row: {row}"
        )
