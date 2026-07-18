"""Deterministic request-fidelity checks for master-plan adjustments."""

from __future__ import annotations

from datetime import date as _date, timedelta as _timedelta
from decimal import Decimal, ROUND_HALF_UP
import math
import re
import unicodedata
from typing import Any, Literal

from stride_core.master_plan import MasterPlan
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOpKind,
    normalise_target_race_time,
)

WeeklyVolumeDirection = Literal["increase", "decrease"]
PhaseResizeDirection = Literal["extend", "compress"]

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
_KM_SINGLE_TARGET_RE = re.compile(
    r"(?:调整到|改到|设为|降到|降至|减到|加到|提高到|提升到|降低到|到|至|"
    r"set\s+to|target(?:\s+of)?|increase\s+to|decrease\s+to|reduce\s+to|lower\s+to)"
    r"\s*(?P<value>\d+(?:\.\d+)?)\s*(?:公里|km)\b",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(r"(?P<percentage>\d+(?:\.\d+)?)\s*%")
_RACE_DATE_RE = re.compile(
    r"(?:"
    r"(?:目标赛|目标比赛|target\s+race|race).{0,16}?"
    r"(?:延期|推迟|提前|挪到|改到|改为|改成|设为|调整到|到|至|postpone|move|shift|reschedule)"
    r"|(?:延期|推迟|提前|postpone|move|shift|reschedule).{0,16}?"
    r"(?:目标赛|目标比赛|target\s+race|race).{0,8}?(?:to|到|至)?"
    r").{0,16}?(?P<date>20\d{2}-\d{1,2}-\d{1,2})",
    re.IGNORECASE,
)
_RACE_TIME_TOKEN = (
    r"(?:\d{1,2}:[0-5]\d(?::[0-5]\d)?|"
    r"\d{1,2}\s*(?:小时|h)\s*[0-5]?\d\s*(?:分|m)"
    r"(?:\s*[0-5]?\d\s*(?:秒|s))?)"
)
_RACE_TIME_TRANSITION_RE = re.compile(
    rf"(?:调整到|调到|调整为|改到|改为|改成|设为|到|至|"
    rf"set\s+to|change\s+to|to|target(?:\s+of)?)\s*"
    rf"(?P<time>{_RACE_TIME_TOKEN})(?!\s*/\s*km)",
    re.IGNORECASE,
)
_RACE_TIME_RE = re.compile(
    r"(?:目标(?:成绩|时间)|完赛成绩|比赛成绩|target\s+time).{0,20}?"
    rf"(?P<time>{_RACE_TIME_TOKEN})",
    re.IGNORECASE,
)
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
_PHASE_RESIZE_CONTEXT_RE = re.compile(
    r"(?:基础期|基础阶段|专项期|专项阶段|强化期|高峰期|赛前期|"
    r"减量期|调整期|恢复期|恢复阶段|第\s*[一二三四五六七八九十0-9]+"
    r"\s*(?:个)?阶段|phase[-_ ]?[a-z0-9]+|(?:base|build|peak|taper|recovery)"
    r"\s*phase|阶段)",
    re.IGNORECASE,
)
_PHASE_EXTEND_RE = re.compile(
    r"(?:延长|拉长|多\s*(?:安排|加)|extend|lengthen)", re.IGNORECASE
)
_PHASE_COMPRESS_RE = re.compile(
    r"(?:缩短|压缩|少\s*(?:安排|减)|shorten|compress)", re.IGNORECASE
)
_COUNT_TOKEN = r"(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)"
_DURATION_RE = re.compile(
    rf"(?P<count>{_COUNT_TOKEN})\s*(?P<unit>周|星期|weeks?|天|days?)",
    re.IGNORECASE,
)
_FROM_TO_DURATION_RE = re.compile(
    rf"(?:从|由|from)\s*(?P<old>{_COUNT_TOKEN})\s*(?:周|星期|weeks?)"
    rf".{{0,16}}?(?:到|至|为|to)\s*(?P<new>{_COUNT_TOKEN})\s*(?:周|星期|weeks?)",
    re.IGNORECASE,
)
_CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3,
    "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}


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
    if not re.search(
        r"(?:加量|减量|周跑量|周量|跑量|训练量|里程|weekly\s+(?:distance|volume|mileage))",
        request,
        re.IGNORECASE,
    ):
        return None
    from_to = _FROM_TO_RANGE_RE.search(request)
    if from_to is not None:
        return float(from_to.group("new_low")), float(from_to.group("new_high"))

    range_matches = list(_KM_RANGE_RE.finditer(request))
    matches = {
        (float(match.group("low")), float(match.group("high")))
        for match in range_matches
    }
    range_spans = [match.span() for match in range_matches]
    single_targets = {
        float(match.group("value"))
        for match in _KM_SINGLE_TARGET_RE.finditer(request)
        if not any(start <= match.start() and match.end() <= end for start, end in range_spans)
    }
    matches.update((value, value) for value in single_targets)
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


def _count_value(raw: str) -> float | None:
    try:
        return float(raw)
    except ValueError:
        pass
    if raw == "十":
        return 10.0
    if "百" in raw:
        head, _, tail = raw.partition("百")
        hundreds = _CN_DIGITS.get(head, 1 if not head else -1)
        if hundreds < 0:
            return None
        remainder = _count_value(tail) if tail else 0.0
        return hundreds * 100.0 + remainder if remainder is not None else None
    if "十" in raw:
        head, _, tail = raw.partition("十")
        tens = _CN_DIGITS.get(head, 1 if not head else -1)
        ones = _CN_DIGITS.get(tail, 0 if not tail else -1)
        return float(tens * 10 + ones) if tens >= 0 and ones >= 0 else None
    if len(raw) == 1 and raw in _CN_DIGITS:
        return float(_CN_DIGITS[raw])
    return None


def _duration_weeks(count: str, unit: str = "周") -> int | None:
    value = _count_value(count)
    if value is None or not math.isfinite(value) or value <= 0:
        return None
    weeks = value / 7.0 if unit.lower() in {"天", "day", "days"} else value
    rounded = round(weeks)
    return int(rounded) if math.isclose(weeks, rounded, abs_tol=1e-9) else None


def requested_phase_resize_direction(request: str) -> PhaseResizeDirection | None:
    """Return one unambiguous phase-duration direction, excluding race moves."""
    if _PHASE_RESIZE_CONTEXT_RE.search(request) is None:
        return None
    extend = bool(_PHASE_EXTEND_RE.search(request))
    compress = bool(_PHASE_COMPRESS_RE.search(request))
    if extend == compress:
        from_to = _FROM_TO_DURATION_RE.search(request)
        if from_to is None:
            return None
        old = _count_value(from_to.group("old"))
        new = _count_value(from_to.group("new"))
        if old is None or new is None or old == new:
            return None
        return "extend" if new > old else "compress"
    return "extend" if extend else "compress"


def requested_phase_resize_weeks(request: str) -> int | None:
    """Return the exact whole-week delta requested for a phase resize."""
    direction = requested_phase_resize_direction(request)
    if direction is None:
        return None
    from_to = _FROM_TO_DURATION_RE.search(request)
    if from_to is not None:
        old = _count_value(from_to.group("old"))
        new = _count_value(from_to.group("new"))
        if old is None or new is None:
            return None
        delta = new - old
        if (direction == "extend" and delta <= 0) or (
            direction == "compress" and delta >= 0
        ):
            return None
        rounded = round(abs(delta))
        return int(rounded) if math.isclose(abs(delta), rounded, abs_tol=1e-9) else None

    direction_matches = list(
        (_PHASE_EXTEND_RE if direction == "extend" else _PHASE_COMPRESS_RE).finditer(
            request
        )
    )
    candidates: set[int] = set()
    for marker in direction_matches:
        nearby = request[marker.end() : marker.end() + 24]
        for match in _DURATION_RE.finditer(nearby):
            weeks = _duration_weeks(match.group("count"), match.group("unit"))
            if weeks is not None:
                candidates.add(weeks)
    if not candidates:
        all_durations = list(_DURATION_RE.finditer(request))
        if len(all_durations) == 1:
            match = all_durations[0]
            weeks = _duration_weeks(match.group("count"), match.group("unit"))
            if weeks is not None:
                candidates.add(weeks)
    return candidates.pop() if len(candidates) == 1 else None


def requested_phase_type_for_resize(request: str) -> str | None:
    """Return the single named phase closest to the resize direction."""
    markers = list(_PHASE_EXTEND_RE.finditer(request)) + list(
        _PHASE_COMPRESS_RE.finditer(request)
    )
    if len(markers) == 1:
        marker = markers[0]
        window = request[max(0, marker.start() - 24) : marker.end() + 24]
    elif not markers and _FROM_TO_DURATION_RE.search(request):
        window = request
    else:
        return None
    matches = {name for name, pattern in _FOCUS_PHASE_PATTERNS if pattern.search(window)}
    return matches.pop() if len(matches) == 1 else None


def _phase_type(phase: Any) -> str | None:
    phase_type = getattr(phase.phase_type, "value", phase.phase_type)
    if phase_type is not None:
        return str(phase_type)
    inferred = {
        name
        for name, pattern in _FOCUS_PHASE_PATTERNS
        if pattern.search(f"{phase.name} {phase.focus}")
    }
    return inferred.pop() if len(inferred) == 1 else None


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
    if (requested_range is not None or percentage is not None) and not range_ops:
        return False
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
        actual_type = _phase_type(phase)
        if actual_type != requested_phase_type:
            return False
    return True


def master_diff_matches_phase_resize_request(
    diff: MasterPlanDiff, request: str, *, plan: MasterPlan | None = None
) -> bool:
    """Require one atomic shared-boundary move with exact direction/magnitude."""
    direction = requested_phase_resize_direction(request)
    if direction is None:
        return True
    weeks = requested_phase_resize_weeks(request)
    requested_phase_type = requested_phase_type_for_resize(request)
    if weeks is None or requested_phase_type is None:
        return False
    ops = [
        op for op in diff.ops
        if op.op == MasterPlanDiffOpKind.SHIFT_PHASE_BOUNDARY
    ]
    if len(diff.ops) != 1 or len(ops) != 1:
        return False
    target_op = ops[0]
    if set(target_op.spec_patch or {}) != {
        "end_date", "following_phase_id", "following_start_date"
    }:
        return False
    following_phase_id = (target_op.spec_patch or {}).get("following_phase_id")
    if not target_op.phase_id or not isinstance(following_phase_id, str):
        return False

    def _date_value(mapping: dict[str, Any] | None, key: str) -> _date | None:
        value = (mapping or {}).get(key)
        try:
            return _date.fromisoformat(value) if isinstance(value, str) else None
        except ValueError:
            return None

    old_end = _date_value(target_op.old_value, "end_date")
    new_end = _date_value(target_op.new_value, "end_date")
    patch_end = _date_value(target_op.spec_patch, "end_date")
    old_start = _date_value(target_op.old_value, "following_start_date")
    new_start = _date_value(target_op.new_value, "following_start_date")
    patch_start = _date_value(target_op.spec_patch, "following_start_date")
    if None in {old_end, new_end, patch_end, old_start, new_start, patch_start}:
        return False
    signed_days = weeks * 7 * (1 if direction == "extend" else -1)
    if not (
        new_end == old_end + _timedelta(days=signed_days)
        and new_start == old_start + _timedelta(days=signed_days)
        and patch_end == new_end
        and patch_start == new_start
        and old_start == old_end + _timedelta(days=1)
        and new_start == new_end + _timedelta(days=1)
    ):
        return False

    if plan is not None:
        try:
            target_index = next(
                index for index, phase in enumerate(plan.phases)
                if phase.id == target_op.phase_id
            )
        except StopIteration:
            return False
        if target_index + 1 >= len(plan.phases):
            return False
        target = plan.phases[target_index]
        following = plan.phases[target_index + 1]
        actual_type = _phase_type(target)
        if actual_type != requested_phase_type or following.id != following_phase_id:
            return False
        if old_end.isoformat() != target.end_date or old_start.isoformat() != following.start_date:
            return False
    return True


def _requested_race_date(request: str) -> str | None:
    matches: set[str] = set()
    for match in _RACE_DATE_RE.finditer(request):
        try:
            year, month, day = (int(part) for part in match.group("date").split("-"))
            matches.add(_date(year, month, day).isoformat())
        except ValueError:
            return None
    return matches.pop() if len(matches) == 1 else None


def _normalise_requested_race_time(raw: str) -> str:
    raw = re.sub(r"\s+", "", raw.strip())
    chinese = re.fullmatch(
        r"(?P<hours>\d{1,2})(?:小时|h)(?P<minutes>[0-5]?\d)(?:分|m)"
        r"(?:(?P<seconds>[0-5]?\d)(?:秒|s))?",
        raw,
        re.IGNORECASE,
    )
    if chinese is not None:
        raw = (
            f"{int(chinese.group('hours'))}:"
            f"{int(chinese.group('minutes')):02d}:"
            f"{int(chinese.group('seconds') or 0):02d}"
        )
    elif raw.count(":") == 1:
        raw = f"{raw}:00"
    return normalise_target_race_time(raw)


def _requested_race_time(request: str) -> str | None:
    transition_matches = list(_RACE_TIME_TRANSITION_RE.finditer(request))
    source_matches = transition_matches or list(_RACE_TIME_RE.finditer(request))
    matches: set[str] = set()
    for match in source_matches:
        try:
            matches.add(_normalise_requested_race_time(match.group("time")))
        except ValueError:
            return None
    return matches.pop() if len(matches) == 1 else None


def master_diff_matches_target_race_request(diff: MasterPlanDiff, request: str) -> bool:
    """Require atomic target-race ops to preserve explicit date/time requests."""
    requested_date = _requested_race_date(request)
    requested_time = _requested_race_time(request)
    if requested_date is None and requested_time is None:
        return True

    if requested_date is not None and requested_time is not None:
        return False
    if len(diff.ops) != 1:
        return False

    if requested_date is not None:
        ops = [op for op in diff.ops if op.op == MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE]
        if len(ops) != 1:
            return False
        patch_date = (ops[0].spec_patch or {}).get("race_date")
        if patch_date != requested_date:
            return False

    if requested_time is not None:
        ops = [op for op in diff.ops if op.op == MasterPlanDiffOpKind.UPDATE_TARGET_RACE_TIME]
        if len(ops) != 1:
            return False
        patch_time = (ops[0].spec_patch or {}).get("target_time")
        if patch_time != requested_time:
            return False

    return True


def master_diff_matches_adjustment_request(
    diff: MasterPlanDiff, request: str, *, plan: MasterPlan | None = None
) -> bool:
    """Validate all deterministic request-fidelity contracts for one diff."""
    return (
        master_diff_matches_volume_request(diff, request)
        and master_diff_matches_focus_request(diff, request, plan=plan)
        and master_diff_matches_phase_resize_request(diff, request, plan=plan)
        and master_diff_matches_target_race_request(diff, request)
    )


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
