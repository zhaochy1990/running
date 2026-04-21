"""Public endpoints — no auth. Kept as a separate router so every other
router can have a router-level `require_bearer` dependency applied in the
app factory without breaking liveness probes.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/api/health")
def health():
    return {"status": "ok"}
