"""plan.md ↔ plan.json — pure parsing, validation, and persistence.

Decoupled from the coach agent: this package does no LLM coaching work, only
the reverse-engineering of authored markdown into the structured
``WeeklyPlan`` schema. Persistence belongs to ``WeeklyPlanStore``.
"""

from .extraction import (
    JSON_BLOCK_RE,
    extract_last_json_block,
    strip_json_block,
)
from .llm import PlanParseResult, parse_plan_md
from .parser import parse_structured
from .persistence import apply_weekly_plan
from .prompts import (
    PARSE_PROMPT,
    PARSE_SYSTEM_PROMPT,
    STRUCTURED_SCHEMA_HINT,
)
from .validation import (
    validate_nutrition_macros,
    validate_session_dates,
)

__all__ = [
    "JSON_BLOCK_RE",
    "PARSE_PROMPT",
    "PARSE_SYSTEM_PROMPT",
    "PlanParseResult",
    "STRUCTURED_SCHEMA_HINT",
    "apply_weekly_plan",
    "extract_last_json_block",
    "parse_plan_md",
    "parse_structured",
    "strip_json_block",
    "validate_nutrition_macros",
    "validate_session_dates",
]
