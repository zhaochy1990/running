"""Deterministic intent-to-diff direction checks for master-plan volume edits."""

from __future__ import annotations

import re
from typing import Any, Literal

from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOpKind

WeeklyVolumeDirection = Literal["increase", "decrease"]

_INCREASE_RE = re.compile(
    r"(?:加量|(?:增加|加大|提高|提升|调高).{0,12}(?:周跑量|周量|训练量)|"
    r"(?:周跑量|周量|训练量).{0,12}(?:增加|加大|提高|提升|调高)|"
    r"(?:增加|加大|提高|提升|调高|加到|涨到).{0,8}(?:"
    r"\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:公里|km)|"
    r"\d+(?:\.\d+)?\s*[–—\-~至到]\s*\d+(?:\.\d+)?\s*(?:公里|km))|"
    r"(?:increase|raise).{0,18}(?:weekly\s+)?(?:distance|volume|mileage))",
    re.IGNORECASE,
)
_DECREASE_RE = re.compile(
    r"(?:减量|(?:减少|降低|减轻|调低).{0,12}(?:周跑量|周量|训练量)|"
    r"(?:周跑量|周量|训练量).{0,12}(?:减少|降低|减轻|调低)|"
    r"(?:减少|降低|减轻|调低|降到|减到).{0,8}(?:"
    r"\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:公里|km)|"
    r"\d+(?:\.\d+)?\s*[–—\-~至到]\s*\d+(?:\.\d+)?\s*(?:公里|km))|"
    r"(?:decrease|reduce|lower).{0,18}(?:weekly\s+)?(?:distance|volume|mileage))",
    re.IGNORECASE,
)
_FROM_TO_RANGE_RE = re.compile(
    r"从\s*(?P<old_low>\d+(?:\.\d+)?)\s*[–—\-~至到]\s*"
    r"(?P<old_high>\d+(?:\.\d+)?)\s*(?:公里|km)?"
    r".{0,20}?(?:调整|改|变|设)?\s*到\s*"
    r"(?P<new_low>\d+(?:\.\d+)?)\s*[–—\-~至到]\s*"
    r"(?P<new_high>\d+(?:\.\d+)?)\s*(?:公里|km)",
    re.IGNORECASE,
)


def requested_weekly_volume_direction(
    request: str,
) -> WeeklyVolumeDirection | None:
    """Return one unambiguous weekly-volume direction from the user request."""
    increase = bool(_INCREASE_RE.search(request))
    decrease = bool(_DECREASE_RE.search(request))
    if increase == decrease:
        match = _FROM_TO_RANGE_RE.search(request)
        if match is None:
            return None
        old_low = float(match.group("old_low"))
        old_high = float(match.group("old_high"))
        new_low = float(match.group("new_low"))
        new_high = float(match.group("new_high"))
        if new_low >= old_low and new_high >= old_high and (
            new_low > old_low or new_high > old_high
        ):
            return "increase"
        if new_low <= old_low and new_high <= old_high and (
            new_low < old_low or new_high < old_high
        ):
            return "decrease"
        return None
    return "increase" if increase else "decrease"


def _number(mapping: dict[str, Any] | None, key: str) -> float | None:
    value = (mapping or {}).get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def master_diff_matches_volume_direction(
    diff: MasterPlanDiff, direction: WeeklyVolumeDirection | None
) -> bool:
    """Require every weekly-range op to move both bounds in the requested direction."""
    if direction is None:
        return True

    range_ops = [
        op for op in diff.ops if op.op == MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE
    ]
    if not range_ops:
        return False

    for op in range_ops:
        old_low = _number(op.old_value, "weekly_distance_km_low")
        old_high = _number(op.old_value, "weekly_distance_km_high")
        new_low = _number(op.new_value, "weekly_distance_km_low")
        new_high = _number(op.new_value, "weekly_distance_km_high")
        if None in {old_low, old_high, new_low, new_high}:
            return False
        if direction == "increase":
            if not (new_low >= old_low and new_high >= old_high):
                return False
            if new_low == old_low and new_high == old_high:
                return False
        else:
            if not (new_low <= old_low and new_high <= old_high):
                return False
            if new_low == old_low and new_high == old_high:
                return False
    return True


def proposal_payload_matches_volume_direction(
    payload: Any, request: str
) -> bool:
    """Validate a draft-tool payload containing one diff or alternatives."""
    direction = requested_weekly_volume_direction(request)
    if direction is None:
        return True
    if not isinstance(payload, dict):
        return False
    raw_diffs = payload.get("alternatives", [payload])
    if not isinstance(raw_diffs, list) or not raw_diffs:
        return False
    try:
        diffs = [MasterPlanDiff.model_validate(item) for item in raw_diffs]
    except Exception:  # noqa: BLE001 - malformed payload fails closed
        return False
    return all(master_diff_matches_volume_direction(diff, direction) for diff in diffs)
