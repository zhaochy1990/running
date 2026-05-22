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
