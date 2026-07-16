"""Deterministic intent-to-diff direction checks for master-plan volume edits."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
import math
import re
from typing import Any, Literal

from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOpKind

WeeklyVolumeDirection = Literal["increase", "decrease"]

_INCREASE_RE = re.compile(
    r"(?:加量|(?:增加|加大|提高|提升|调高).{0,12}(?:周跑量|周量|跑量|训练量|里程)|"
    r"(?:周跑量|周量|跑量|训练量|里程).{0,12}(?:增加|加大|提高|提升|调高)|"
    r"(?:增加|加大|提高|提升|调高|加到|涨到).{0,8}(?:"
    r"\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:公里|km)|"
    r"\d+(?:\.\d+)?\s*[–—\-~至到]\s*\d+(?:\.\d+)?\s*(?:公里|km))|"
    r"(?:increase|raise).{0,18}(?:weekly\s+)?(?:distance|volume|mileage))",
    re.IGNORECASE,
)
_DECREASE_RE = re.compile(
    r"(?:减量|(?:减少|降低|减轻|调低).{0,12}(?:周跑量|周量|跑量|训练量|里程)|"
    r"(?:周跑量|周量|跑量|训练量|里程).{0,12}(?:减少|降低|减轻|调低)|"
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
_KM_RANGE_RE = re.compile(
    r"(?P<low>\d+(?:\.\d+)?)\s*[–—\-~至到]\s*"
    r"(?P<high>\d+(?:\.\d+)?)\s*(?:公里|km)",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(r"(?P<percentage>\d+(?:\.\d+)?)\s*%")


def _percentage_bound(
    value: float, percentage: float, direction: WeeklyVolumeDirection
) -> float:
    signed = Decimal(str(percentage)) / Decimal("100")
    factor = Decimal("1") + (signed if direction == "increase" else -signed)
    return float(
        (Decimal(str(value)) * factor).quantize(
            Decimal("0.1"), rounding=ROUND_HALF_UP
        )
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


def requested_weekly_volume_range(request: str) -> tuple[float, float] | None:
    """Return the exact requested kilometre range, if one is unambiguous."""
    from_to = _FROM_TO_RANGE_RE.search(request)
    if from_to is not None:
        return float(from_to.group("new_low")), float(from_to.group("new_high"))

    matches = {
        (float(match.group("low")), float(match.group("high")))
        for match in _KM_RANGE_RE.finditer(request)
    }
    if len(matches) != 1:
        return None
    return matches.pop()


def requested_weekly_volume_percentage(request: str) -> float | None:
    """Return one explicit percentage attached to a volume direction."""
    if requested_weekly_volume_direction(request) is None:
        return None
    values = {float(match.group("percentage")) for match in _PERCENT_RE.finditer(request)}
    if len(values) != 1:
        return None
    percentage = values.pop()
    return percentage if math.isfinite(percentage) and percentage > 0 else None


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


def master_diff_matches_volume_request(diff: MasterPlanDiff, request: str) -> bool:
    """Require weekly-range ops to preserve direction and any exact magnitude."""
    direction = requested_weekly_volume_direction(request)
    requested_range = requested_weekly_volume_range(request)
    percentage = requested_weekly_volume_percentage(request)
    has_range_syntax = bool(_KM_RANGE_RE.search(request))
    has_percentage_syntax = bool(_PERCENT_RE.search(request))
    if (has_range_syntax and requested_range is None) or (
        has_percentage_syntax and percentage is None
    ):
        return False
    if direction is None and requested_range is None and percentage is None:
        return True
    if not master_diff_matches_volume_direction(diff, direction):
        return False

    range_ops = [
        op for op in diff.ops if op.op == MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE
    ]
    for op in range_ops:
        old_low = _number(op.old_value, "weekly_distance_km_low")
        old_high = _number(op.old_value, "weekly_distance_km_high")
        new_low = _number(op.new_value, "weekly_distance_km_low")
        new_high = _number(op.new_value, "weekly_distance_km_high")
        if None in {old_low, old_high, new_low, new_high}:
            return False
        if requested_range is not None and not (
            math.isclose(new_low, requested_range[0], abs_tol=0.05)
            and math.isclose(new_high, requested_range[1], abs_tol=0.05)
        ):
            return False
        if percentage is not None:
            expected_low = _percentage_bound(old_low, percentage, direction)
            expected_high = _percentage_bound(old_high, percentage, direction)
            if not (
                math.isclose(new_low, expected_low, abs_tol=0.05)
                and math.isclose(new_high, expected_high, abs_tol=0.05)
            ):
                return False
    return True


def proposal_payload_matches_volume_request(
    payload: Any, request: str
) -> bool:
    """Validate a draft payload against requested direction and magnitude."""
    if not isinstance(payload, dict):
        return False
    raw_diffs = payload.get("alternatives", [payload])
    if not isinstance(raw_diffs, list) or not raw_diffs:
        return False
    try:
        diffs = [MasterPlanDiff.model_validate(item) for item in raw_diffs]
    except Exception:  # noqa: BLE001 - malformed payload fails closed
        return False
    return all(master_diff_matches_volume_request(diff, request) for diff in diffs)
