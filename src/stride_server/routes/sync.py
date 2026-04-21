"""Full-user sync endpoint — delegates to the configured DataSource."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from stride_core.source import DataSource

from ..bearer import require_bearer
from ..deps import get_source

router = APIRouter()


@router.post("/api/{user}/sync")
def trigger_sync(
    user: str,
    source: DataSource = Depends(get_source),
    _claims: dict = Depends(require_bearer),
):
    """Trigger a data sync for the given user (via the configured adapter).

    Protected by Bearer auth when STRIDE_AUTH_PUBLIC_KEY_PEM/PATH is set.
    """
    try:
        if not source.is_logged_in(user):
            return {
                "success": False,
                "error": f"用户 {user} 未登录，请先运行: coros-sync --profile {user} login",
            }
        result = source.sync_user(user, full=False)
        return {
            "success": True,
            "output": f"同步完成: {result.activities} 条活动, {result.health} 条健康记录",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
