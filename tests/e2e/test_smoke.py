"""Read-only prod smoke suite. Opt-in via `pytest -m e2e`."""
from __future__ import annotations

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
