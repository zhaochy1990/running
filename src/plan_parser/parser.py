"""Pure-Python WeeklyPlan extractor — text → ``(WeeklyPlan | None, error)``."""

from __future__ import annotations

import json

from stride_core.plan_spec import WeeklyPlan

from .extraction import extract_last_json_block
from .validation import validate_nutrition_macros, validate_session_dates


def parse_structured(
    raw: str, *, folder: str | None = None,
) -> tuple[WeeklyPlan | None, str | None]:
    """Pull the last ```json``` block out of ``raw`` and validate it.

    Returns ``(plan, None)`` on success or ``(None, reason)`` on any failure.
    Failure reasons cover: no JSON block found, malformed JSON, schema
    rejection by ``WeeklyPlan.from_dict`` (KeyError / ValueError /
    TypeError), or any session date falling outside the parent week's
    range (when ``folder`` is supplied).
    """
    blob = extract_last_json_block(raw)
    if blob is None:
        return None, "no JSON code block in model output"
    try:
        data = json.loads(blob)
    except json.JSONDecodeError as e:
        return None, f"invalid JSON: {e}"
    try:
        plan = WeeklyPlan.from_dict(data)
    except (KeyError, ValueError, TypeError) as e:
        return None, f"schema validation failed: {e}"
    date_violation = validate_session_dates(plan, folder)
    if date_violation is not None:
        return None, date_violation
    plan = validate_nutrition_macros(plan)
    return plan, None
