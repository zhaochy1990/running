"""Shared helpers for scope-specific coach-eval judges."""

from __future__ import annotations

import json
import re

from langchain_core.language_models import BaseChatModel


def parse_judge_output(raw: str) -> dict | None:
    """Parse judge JSON from sentinel, fenced JSON, or balanced braces."""
    m = re.search(r"---BEGIN_JUDGE---(.*?)---END_JUDGE---", raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    first = raw.find("{")
    last = raw.rfind("}")
    if first != -1 and last > first:
        try:
            return json.loads(raw[first : last + 1])
        except json.JSONDecodeError:
            pass
    return None


def model_name(llm: BaseChatModel) -> str:
    """Best-effort model label for reports."""
    for attr in ("deployment_name", "model_name", "model"):
        value = getattr(llm, attr, None)
        if value:
            return str(value)
    return type(llm).__name__


def matches_expected(axis: str, score: int | None, expected: dict) -> bool:
    """True iff score meets expected.soft_rubric[axis].min_score, or N/A."""
    if score is None:
        return True
    rubric = (expected.get("soft_rubric") or {}).get(axis)
    if not isinstance(rubric, dict):
        return True
    min_score = rubric.get("min_score")
    if not isinstance(min_score, (int, float)):
        return True
    return score >= min_score


def clean_compact(value: object) -> object:
    """Drop empty/null/default noise from judge prompt compact views."""
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, val in value.items():
            cleaned = clean_compact(val)
            if cleaned is None or cleaned == [] or cleaned == {}:
                continue
            out[str(key)] = cleaned
        return out
    if isinstance(value, list):
        return [cleaned for item in value if (cleaned := clean_compact(item)) is not None]
    return value


def json_compact(obj: object) -> str:
    """Render compact UTF-8 JSON exactly as judge user prompts expect."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
