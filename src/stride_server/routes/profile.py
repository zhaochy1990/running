"""Profile and onboarding-status endpoints."""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from .. import auth_service_client as auth_client
from ..bearer import require_bearer
from ..config.models import ServerConfig
from ..content_store import read_json, write_json
from ..deps import get_server_config

router = APIRouter()
logger = logging.getLogger(__name__)

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_TARGET_TIME_RE = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)")
_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")

LEGACY_PROFILE_KEYS = (
    "姓名", "出生", "出生日期", "年龄", "性别",
    "身高_cm", "身高", "当前体重_kg", "体重_kg", "体重",
    "目标", "目标赛事", "目标赛事日期", "目标日期", "目标时间",
    "PB 5K", "PB 10K", "PB 半马", "PB 马拉松",
    "手表", "目标配速_km", "已知问题", "伤病史", "伤病",
    "职业", "训练时间窗", "最近赛事", "训练提示", "当前体能 2026-04",
)


def _validate_uuid(uuid: str) -> str:
    if not _UUID4_RE.match(uuid or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )
    return uuid


def _profile_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/profile.json"


def _onboarding_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/onboarding.json"


def _normalize_legacy_profile(data: dict[str, Any]) -> dict[str, Any]:
    """Map any legacy CJK keys onto the English schema and drop the CJK copies.

    Idempotent for already-migrated profiles. When legacy keys are detected
    a warning is logged so prod migration progress is observable; the
    permanent rewrite lives in ``scripts/migrate_profile_to_english_keys.py``.
    """
    profile = dict(data)
    legacy_hits: list[str] = []

    def _move(legacy_key: str, target_key: str, *, require_str: bool = False) -> None:
        if legacy_key not in profile:
            return
        legacy_hits.append(legacy_key)
        value = profile.pop(legacy_key)
        if require_str and not isinstance(value, str):
            return
        if value is None:
            return
        if not profile.get(target_key):
            profile[target_key] = value

    _move("姓名", "display_name", require_str=True)
    _move("出生", "dob", require_str=True)
    _move("身高_cm", "height_cm")
    _move("当前体重_kg", "weight_kg")
    _move("体重_kg", "weight_kg")
    _move("已知问题", "constraints", require_str=True)
    _move("伤病史", "constraints", require_str=True)
    _move("目标赛事日期", "target_race_date", require_str=True)

    pbs: dict[str, str] = dict(profile.get("pbs") or {}) if isinstance(profile.get("pbs"), dict) else {}
    for legacy_pb, eng_pb in (("PB 半马", "HM"), ("PB 马拉松", "FM"), ("PB 10K", "10K"), ("PB 5K", "5K")):
        if legacy_pb in profile:
            legacy_hits.append(legacy_pb)
            value = profile.pop(legacy_pb)
            if isinstance(value, str) and eng_pb not in pbs:
                pbs[eng_pb] = value
    if pbs:
        profile["pbs"] = pbs

    if "目标" in profile:
        legacy_hits.append("目标")
        goal = profile.pop("目标")
        if isinstance(goal, str):
            if not profile.get("target_race"):
                profile["target_race"] = goal
            if not profile.get("target_distance"):
                upper = goal.upper()
                if "马拉松" in goal or "FM" in upper:
                    profile["target_distance"] = "FM"
                elif "半马" in goal or "HM" in upper:
                    profile["target_distance"] = "HM"
                elif "10K" in upper or "10公里" in goal:
                    profile["target_distance"] = "10K"
                elif "5K" in upper or "5公里" in goal:
                    profile["target_distance"] = "5K"
            if not profile.get("target_time"):
                match = _TARGET_TIME_RE.search(goal)
                if match:
                    hours, minutes, seconds = match.groups()
                    profile["target_time"] = f"{int(hours)}:{minutes}:{seconds or '00'}"

    if legacy_hits:
        logger.warning(
            "profile contains legacy CJK keys %s — run scripts/migrate_profile_to_english_keys.py",
            legacy_hits,
        )

    return profile


def _read_profile(uuid: str) -> dict[str, Any]:
    item = read_json(_profile_path(uuid))
    if item is None:
        return {}
    data, source = item
    if isinstance(data, dict):
        logger.info("profile read user=%s source=%s", uuid, source)
        return _normalize_legacy_profile(data)
    logger.warning("profile read ignored non-object JSON for user=%s source=%s", uuid, source)
    return {}


def _read_onboarding(uuid: str) -> dict[str, Any]:
    item = read_json(_onboarding_path(uuid))
    if item is not None:
        data, source = item
        if isinstance(data, dict):
            logger.info("onboarding read user=%s source=%s", uuid, source)
            return data
        logger.warning("onboarding read ignored non-object JSON for user=%s source=%s", uuid, source)
    return {
        "coros_ready": False,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
    }


def _write_state(relative_path: str, data: dict[str, Any]) -> None:
    source = write_json(relative_path, data)
    logger.info("profile state write path=%s source=%s", relative_path, source)


class ProfileIn(BaseModel):
    display_name: str = Field(..., min_length=1)
    dob: date
    sex: Literal["male", "female", "other"]
    height_cm: float = Field(..., gt=0)
    weight_kg: float = Field(..., gt=0)
    # Race goal fields — optional during onboarding, filled later in training
    # plan setup when the user chooses a target race and triggers full sync.
    target_race: str | None = Field(default=None, min_length=1)
    target_distance: Literal["5K", "10K", "HM", "FM"] | None = None
    target_race_date: date | None = None
    target_time: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}:\d{2}$")
    pbs: dict[str, str] | None = None
    weekly_mileage_km: float | None = None
    constraints: str | None = None


class ProfilePatch(BaseModel):
    """All fields optional — used by PATCH for post-onboarding edits."""

    display_name: str | None = Field(default=None, min_length=1)
    dob: date | None = None
    sex: Literal["male", "female", "other"] | None = None
    height_cm: float | None = Field(default=None, gt=0)
    weight_kg: float | None = Field(default=None, gt=0)
    target_race: str | None = Field(default=None, min_length=1)
    target_distance: Literal["5K", "10K", "HM", "FM"] | None = None
    target_race_date: date | None = None
    target_time: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}:\d{2}$")
    pbs: dict[str, str] | None = None
    weekly_mileage_km: float | None = Field(default=None, ge=0)
    constraints: str | None = None


@router.get("/api/users/me/profile")
async def get_profile(
    payload: dict = Depends(require_bearer),
    authorization: str | None = Header(default=None),
    config: ServerConfig = Depends(get_server_config),
):
    uuid = payload["sub"]
    profile = _read_profile(uuid)
    onboarding = _read_onboarding(uuid)
    # Provider tag drives frontend capability gating (e.g. strength push
    # is only wired for COROS today). Returns None when the user has
    # never logged into a provider yet.
    from stride_core.registry import read_user_provider
    provider = read_user_provider(uuid)

    # Fetch display name from auth-service (primary source).
    # Falls back to local profile.json → UUID.
    bearer = authorization[len("Bearer "):].strip() if authorization and authorization.lower().startswith("bearer ") else None
    auth_user = await auth_client.get_me(bearer)
    auth_name = None
    if isinstance(auth_user, dict):
        auth_name = auth_user.get("display_name") or auth_user.get("name")

    display_name = auth_name or profile.get("display_name")

    return {
        "id": uuid,
        "display_name": display_name,
        "provider": provider,
        "profile": profile,
        "onboarding": onboarding,
        "features": {
            "coach_agent_weekly_plan": uuid in config.plan.coach_agent_weekly_plan_users,
        },
    }


@router.post("/api/users/me/profile")
def post_profile(body: ProfileIn, payload: dict = Depends(require_bearer)):
    uuid = payload["sub"]

    profile_data = body.model_dump()

    _write_state(_profile_path(uuid), profile_data)

    onboarding = _read_onboarding(uuid)
    onboarding["profile_ready"] = True
    _write_state(_onboarding_path(uuid), onboarding)

    return {"ok": True}


@router.patch("/api/users/me/profile")
def patch_profile(body: ProfilePatch, payload: dict = Depends(require_bearer)):
    """Partial profile update for post-onboarding edits.

    Reads the existing profile.json, merges any non-None fields from the
    request, and writes back. Unspecified fields are preserved.
    """
    uuid = payload["sub"]

    patch = body.model_dump(exclude_unset=True)
    if not patch:
        return {"ok": True, "profile": _read_profile(uuid)}

    existing = _read_profile(uuid)
    merged = {**existing, **patch}

    _write_state(_profile_path(uuid), merged)

    return {
        "ok": True,
        "id": uuid,
        "display_name": merged.get("display_name"),
        "profile": merged,
    }
