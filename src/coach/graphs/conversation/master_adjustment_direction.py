"""Deterministic request-fidelity checks for master-plan adjustments."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
import math
import re
import unicodedata
from typing import Any, Literal

from stride_core.master_plan import MasterPlan
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
_FOCUS_CUE_RE = re.compile(
    r"(?:训练重点|训练重心|重点)\s*(?:(?:调整|修改|改|设|换)?\s*(?:成|为|到)|是)\s*"
    r"|(?:更\s*)?(?:侧重|聚焦|专注(?:于)?|重点放在)\s*"
    r"|(?:focus\s+(?:to|toward|towards)|focus(?:es|ed|ing)?\s+on|"
    r"emphasi[sz]e(?:s|d|ing)?|"
    r"prioriti[sz]e(?:s|d|ing)?)\s+",
    re.IGNORECASE,
)
_FOCUS_REASON_SUFFIX_RE = re.compile(
    r"(?:，|,)\s*(?:因为|原因(?:是)?|考虑到|鉴于|但|不过|同时(?:不要|不|保持)|"
    r"不要|不改变|保持周跑量|because\b|without\s+changing\b).*$",
    re.IGNORECASE,
)
_FOCUS_PHASE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("base", re.compile(r"(?:基础期|基础阶段|base\s*(?:phase)?)", re.IGNORECASE)),
    ("build", re.compile(r"(?:专项期|专项阶段|强化期|build\s*(?:phase)?)", re.IGNORECASE)),
    ("peak", re.compile(r"(?:高峰期|赛前期|peak\s*(?:phase)?)", re.IGNORECASE)),
    ("taper", re.compile(r"(?:减量期|调整期|taper\s*(?:phase)?)", re.IGNORECASE)),
    ("recovery", re.compile(r"(?:恢复期|恢复阶段|recovery\s*(?:phase)?)", re.IGNORECASE)),
)


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


def _normalise_focus(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value.strip(" \t\r\n。.!！;；：:\\'\"“”‘’『』「」")


def requested_phase_focus(request: str) -> str | None:
    """Extract the exact phase-focus text explicitly supplied by the user.

    This intentionally returns ``None`` for a generic request such as "调整训练
    重点".  A proposal gate must not invent the missing focus on the user's
    behalf.  Explanatory suffixes (for example ``，因为比赛有爬升``) are not
    part of the requested replacement value.
    """
    cue = _FOCUS_CUE_RE.search(request)
    if cue is None:
        return None
    raw = request[cue.end() :].strip()
    if not raw:
        return None
    if raw[0] in "“\"'‘『「":
        closing = {
            "“": "”", '"': '"', "'": "'", "‘": "’",
            "『": "』", "「": "」",
        }[raw[0]]
        end = raw.find(closing, 1)
        if end > 1:
            raw = raw[1:end]
    raw = _FOCUS_REASON_SUFFIX_RE.sub("", raw)
    focus = _normalise_focus(raw)
    return focus or None


def requested_phase_type_for_focus(request: str) -> str | None:
    """Return one explicit canonical phase named before the focus cue."""
    cue = _FOCUS_CUE_RE.search(request)
    if cue is None:
        return None
    prefix = request[: cue.start()]
    matches = {name for name, pattern in _FOCUS_PHASE_PATTERNS if pattern.search(prefix)}
    return matches.pop() if len(matches) == 1 else None


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


def master_diff_matches_focus_request(
    diff: MasterPlanDiff, request: str, *, plan: MasterPlan | None = None
) -> bool:
    """Require a focus request to produce one exact, correctly-targeted op."""
    requested_focus = requested_phase_focus(request)
    if requested_focus is None:
        return True
    if len(diff.ops) != 1:
        return False
    op = diff.ops[0]
    if op.op != MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS or not op.phase_id:
        return False
    new_focus = (op.new_value or {}).get("focus")
    patch_focus = (op.spec_patch or {}).get("focus")
    if not isinstance(new_focus, str) or not isinstance(patch_focus, str):
        return False
    if not (
        _normalise_focus(new_focus) == requested_focus
        and _normalise_focus(patch_focus) == requested_focus
    ):
        return False

    requested_phase_type = requested_phase_type_for_focus(request)
    if requested_phase_type is not None and plan is not None:
        phase = next((item for item in plan.phases if item.id == op.phase_id), None)
        if phase is None:
            return False
        actual_type = getattr(phase.phase_type, "value", phase.phase_type)
        if actual_type is None:
            phase_label = f"{phase.name} {phase.focus}"
            inferred = {
                name
                for name, pattern in _FOCUS_PHASE_PATTERNS
                if pattern.search(phase_label)
            }
            actual_type = inferred.pop() if len(inferred) == 1 else None
        if actual_type != requested_phase_type:
            return False
    return True


def master_diff_matches_adjustment_request(
    diff: MasterPlanDiff, request: str, *, plan: MasterPlan | None = None
) -> bool:
    """Validate all deterministic request-fidelity contracts for one diff."""
    return master_diff_matches_volume_request(
        diff, request
    ) and master_diff_matches_focus_request(diff, request, plan=plan)


def proposal_payload_matches_adjustment_request(
    payload: Any, request: str
) -> bool:
    """Validate every proposal in a draft-tool payload against the request."""
    if not isinstance(payload, dict):
        return False
    raw_diffs = payload.get("alternatives", [payload])
    if not isinstance(raw_diffs, list) or not raw_diffs:
        return False
    try:
        diffs = [MasterPlanDiff.model_validate(item) for item in raw_diffs]
    except Exception:  # noqa: BLE001 - malformed payload fails closed
        return False
    return all(master_diff_matches_adjustment_request(diff, request) for diff in diffs)
