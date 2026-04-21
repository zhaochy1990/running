"""User-profile listing."""

from __future__ import annotations

from fastapi import APIRouter

from stride_core.db import USER_DATA_DIR

router = APIRouter()


@router.get("/api/users")
def list_users():
    """List all available user profiles."""
    if not USER_DATA_DIR.exists():
        return {"users": []}
    users = sorted(
        d.name for d in USER_DATA_DIR.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    )
    return {"users": users}
