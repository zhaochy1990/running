"""Deterministic parsing for Coach CLI proposal confirmations."""

from __future__ import annotations

import re

_CHINESE_NUMBERS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}
_OUT_OF_RANGE_INDEX = 1_000_000_000
_CHAT_APPLY_PATTERNS = (
    re.compile(
        r"^(?:(?:好|好的)[，, ]*)?(?:(?:那就|就)\s*)?(?:请\s*)?"
        r"(?:应用|采用|接受|确认|执行)(?:一下)?(?:第\s*)?"
        r"(?P<index>-?\d+|[零〇一二两三四五六七八九十])\s*"
        r"(?:个|条|项)?(?:方案|提案)(?:吧)?[。！!]?$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:(?:yes|ok|okay)[, ]+)?(?:please[, ]+)?"
        r"(?:apply|accept|use)\s+(?:(?:proposal|option|choice)\s*)"
        r"(?P<index>-?\d+)[.!！。]?$",
        re.IGNORECASE,
    ),
)
_CHAT_APPLY_WITHOUT_INDEX = re.compile(
    r"(?:"
    r"^(?:(?:好|好的)[，, ]*)?(?:(?:那就|就)\s*)?(?:请\s*)?"
    r"(?:应用|采用|接受|确认|执行)(?:一下)?"
    r"(?:这个|该|当前|上面|刚才|它)?(?:方案|提案)(?:吧)?"
    r"|"
    r"^(?:(?:yes|ok|okay)[, ]+)?(?:please[, ]+)?"
    r"(?:apply\s+it|(?:apply|accept|use)\s+(?:"
    r"(?:this|that|the)\s+)?(?:proposal|option|choice))"
    r")[.!！。]?$",
    re.IGNORECASE,
)


def chat_apply_selection(message: str) -> tuple[bool, int | None]:
    """Return whether the complete message explicitly confirms a proposal."""
    if re.search(
        r"(?:不要|不许|别|取消|don't|do not|not)", message, re.IGNORECASE
    ):
        return False, None

    normalized = message.strip()
    for pattern in _CHAT_APPLY_PATTERNS:
        match = pattern.fullmatch(normalized)
        if match:
            raw_index = match.group("index")
            if raw_index in _CHINESE_NUMBERS:
                return True, _CHINESE_NUMBERS[raw_index]
            signless_index = raw_index.removeprefix("-").lstrip("0") or "0"
            if len(signless_index) > 9:
                return True, _OUT_OF_RANGE_INDEX
            selected = int(signless_index)
            return True, -selected if raw_index.startswith("-") else selected
    if _CHAT_APPLY_WITHOUT_INDEX.fullmatch(normalized):
        return True, None
    return False, None
