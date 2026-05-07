"""Routes for activity likes within a team.

Likes target an activity owned by a team member. The caller must be a member
of the team and the target user must also be a member; both are enforced by
re-asking the auth-service for the team's current member list, the same
pattern as ``team_activity_detail`` in ``routes/teams.py``.

Storage lives in Azure Table Storage (or a JSON file in dev) — see
``stride_server.likes_store``. SQLite is intentionally not used.

Note: we do NOT verify the activity exists in the owner's local SQLite DB.
Liking a deleted/missing activity is harmless — feed enrichment only surfaces
likes for activities currently in the feed, so orphaned rows stay invisible.
This also keeps the storage layer fully decoupled from the watch-data DB.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException

from .. import auth_service_client as auth_client
from .. import likes_store
from ..bearer import require_bearer
from ..notifications import jpush_client
from ..notifications import store as nstore
from .teams import _bearer, _stride_display_name, _UUID4_RE

logger = logging.getLogger(__name__)

router = APIRouter()


def _validate_label_id(label_id: str) -> None:
    if not isinstance(label_id, str) or not likes_store._LABEL_ID_RE.match(label_id):
        raise HTTPException(status_code=422, detail="invalid label_id")


def _validate_user_id_path(user_id: str) -> None:
    if not isinstance(user_id, str) or not _UUID4_RE.match(user_id):
        raise HTTPException(status_code=422, detail="invalid user_id")


def _validate_team_id_path(team_id: str) -> None:
    if not isinstance(team_id, str) or not likes_store._TEAM_ID_RE.match(team_id):
        raise HTTPException(status_code=422, detail="invalid team_id")


async def _membership_check(
    *,
    bearer: str | None,
    team_id: str,
    caller_id: str,
    target_user_id: str,
) -> tuple[set[str], dict[str, dict]]:
    """Verify both caller and target are in the team. Returns (member_ids, members_by_id)."""
    members = await auth_client.list_members(bearer, team_id)
    by_id: dict[str, dict] = {}
    member_ids: set[str] = set()
    for m in members:
        uid = m.get("user_id") if isinstance(m, dict) else None
        if uid:
            member_ids.add(uid)
            by_id[uid] = m
    if caller_id not in member_ids:
        raise HTTPException(status_code=403, detail="Caller is not a member of this team")
    if target_user_id not in member_ids:
        raise HTTPException(status_code=404, detail="User is not in this team")
    return member_ids, by_id


def _resolve_caller_display_name(
    caller_id: str, claims: dict, members_by_id: dict[str, dict],
) -> str:
    """Best-effort caller display name: STRIDE profile → auth-service member ``name``
    / ``display_name`` (from the membership list we already fetched) → JWT
    ``name`` claim → user_id slice."""
    name = _stride_display_name(caller_id)
    if name:
        return name
    member = members_by_id.get(caller_id) or {}
    for key in ("display_name", "name"):
        v = member.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    claim_name = claims.get("name") if isinstance(claims, dict) else None
    if isinstance(claim_name, str) and claim_name.strip():
        return claim_name.strip()
    return caller_id[:8]


def _build_likers_payload(
    likes: list[likes_store.LikeEntity],
    caller_id: str,
    members_by_id: dict[str, dict],
) -> dict:
    """Re-resolve display names from the latest STRIDE profile or auth-service
    member list if available, falling back to the snapshot stored at write
    time."""
    likers = []
    for like in likes:
        latest = _stride_display_name(like.liker_user_id)
        if not latest:
            member = members_by_id.get(like.liker_user_id) or {}
            for key in ("display_name", "name"):
                v = member.get(key)
                if isinstance(v, str) and v.strip():
                    latest = v.strip()
                    break
        likers.append({
            "user_id": like.liker_user_id,
            "display_name": latest or like.liker_display_name or like.liker_user_id[:8],
            "created_at": like.created_at,
        })
    return {
        "count": len(likers),
        "you_liked": any(l["user_id"] == caller_id for l in likers),
        "likers": likers,
    }


# ---------------------------------------------------------------------------


@router.post("/api/teams/{team_id}/activities/{user_id}/{label_id}/likes")
async def like_activity(
    team_id: str,
    user_id: str,
    label_id: str,
    authorization: str | None = Header(default=None),
    claims: dict = Depends(require_bearer),
):
    _validate_team_id_path(team_id)
    _validate_user_id_path(user_id)
    _validate_label_id(label_id)
    caller_id = claims.get("sub")
    if not isinstance(caller_id, str) or not _UUID4_RE.match(caller_id):
        raise HTTPException(status_code=401, detail="invalid token sub")

    _, members_by_id = await _membership_check(
        bearer=_bearer(authorization),
        team_id=team_id,
        caller_id=caller_id,
        target_user_id=user_id,
    )

    liker_name = _resolve_caller_display_name(
        caller_id, claims, members_by_id,
    )
    likes_store.put_like(
        team_id=team_id,
        owner_user_id=user_id,
        label_id=label_id,
        liker_user_id=caller_id,
        liker_display_name=liker_name,
    )

    likes = likes_store.list_likes(
        team_id=team_id, owner_user_id=user_id, label_id=label_id,
    )

    # Best-effort push to the activity owner (skip self-likes).
    if caller_id != user_id:
        _maybe_send_like_push(
            owner_user_id=user_id,
            liker_name=liker_name,
            team_id=team_id,
            label_id=label_id,
        )

    return {
        "liked": True,
        "count": len(likes),
        "you_liked": any(l.liker_user_id == caller_id for l in likes),
    }


def _maybe_send_like_push(
    *,
    owner_user_id: str,
    liker_name: str,
    team_id: str,
    label_id: str,
) -> None:
    """Send a like-event push to the activity owner. Best-effort: any
    failure is logged and swallowed so it can't break the like response."""
    try:
        if not jpush_client.is_enabled():
            return
        prefs = nstore.get_prefs(owner_user_id)
        if not prefs.get("likes_enabled"):
            return
        ids = nstore.list_device_ids(owner_user_id)
        if not ids:
            return
        jpush_client.push_to_registration_ids(
            ids,
            title="收到新点赞",
            body=f"{liker_name} 为你的训练点赞",
            extras={
                "type": "like",
                "team_id": team_id,
                "label_id": label_id,
                "owner_user_id": owner_user_id,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("like push hook failed: %s", e)


@router.delete("/api/teams/{team_id}/activities/{user_id}/{label_id}/likes")
async def unlike_activity(
    team_id: str,
    user_id: str,
    label_id: str,
    authorization: str | None = Header(default=None),
    claims: dict = Depends(require_bearer),
):
    _validate_team_id_path(team_id)
    _validate_user_id_path(user_id)
    _validate_label_id(label_id)
    caller_id = claims.get("sub")
    if not isinstance(caller_id, str) or not _UUID4_RE.match(caller_id):
        raise HTTPException(status_code=401, detail="invalid token sub")

    await _membership_check(
        bearer=_bearer(authorization),
        team_id=team_id,
        caller_id=caller_id,
        target_user_id=user_id,
    )

    likes_store.delete_like(
        team_id=team_id,
        owner_user_id=user_id,
        label_id=label_id,
        liker_user_id=caller_id,
    )

    likes = likes_store.list_likes(
        team_id=team_id, owner_user_id=user_id, label_id=label_id,
    )
    return {
        "liked": False,
        "count": len(likes),
        "you_liked": any(l.liker_user_id == caller_id for l in likes),
    }


@router.get("/api/teams/{team_id}/activities/{user_id}/{label_id}/likes")
async def get_activity_likes(
    team_id: str,
    user_id: str,
    label_id: str,
    authorization: str | None = Header(default=None),
    claims: dict = Depends(require_bearer),
):
    _validate_team_id_path(team_id)
    _validate_user_id_path(user_id)
    _validate_label_id(label_id)
    caller_id = claims.get("sub")
    if not isinstance(caller_id, str) or not _UUID4_RE.match(caller_id):
        raise HTTPException(status_code=401, detail="invalid token sub")

    _, members_by_id = await _membership_check(
        bearer=_bearer(authorization),
        team_id=team_id,
        caller_id=caller_id,
        target_user_id=user_id,
    )

    likes = likes_store.list_likes(
        team_id=team_id, owner_user_id=user_id, label_id=label_id,
    )
    return _build_likers_payload(likes, caller_id, members_by_id)
