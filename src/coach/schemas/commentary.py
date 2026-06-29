"""Render contract for the ``commentary`` skill's ``user_prompt.md``.

The S4 activity-commentary call splits like S1/S2/S3: the static doctrine lives
in ``coach/skills/commentary/SKILL.md`` (system prompt) and the per-activity
context fills ``user_prompt.md``. This model is that template's typed input —
all fields are pre-formatted markdown fragments assembled by the stride_server
adapter from the per-user DB (mirrors how master_plan passes formatted
``history_summary`` / ``fitness_summary`` strings rather than raw structures).

Lives in coach core (pure pydantic, no infra) so the skill's input contract is
defined alongside the prompt; the adapter populates it and ``.model_dump()``s
it into the skill renderer.
"""

from __future__ import annotations

from pydantic import BaseModel


class CommentaryPromptContext(BaseModel):
    """Typed context for the commentary skill's user prompt.

    Optional sections are ``""`` when absent (``string.Template`` substitution).
    """

    now_cst: str
    """Generation timestamp, Shanghai CST, e.g. ``2026-06-29 (Monday) 08:30 CST``."""

    days_ago_line: str = ""
    """One markdown line stating how long ago the activity happened (or ``""``)."""

    activity_block: str = ""
    """The activity's core metrics + HR zones + training laps + HR curve."""

    background_block: str = ""
    """Auxiliary context: profile, phase, daily-health, calibration baseline,
    body composition, 4-week volume, weekly plan excerpt, prior commentaries."""
