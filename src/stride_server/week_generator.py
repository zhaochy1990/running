"""Weekly-plan folder helper.

The former rule-based single-week template (``generate_week_plan``) has been
removed — executable weeks are now produced by the LLM specialist generator
(see ``stride_server.weekly_plan_generator.build_weekly_plan``). Only the
deterministic ``week_folder`` naming helper remains here, still imported by the
generator, the coach orchestrator, and the ``/plan/weeks/generate`` route.
"""

from __future__ import annotations

from datetime import date, timedelta


def week_folder(week_start: date) -> str:
    """Return the folder string for a Monday week_start.

    Format: ``YYYY-MM-DD_MM-DD``
    """
    week_end = week_start + timedelta(days=6)
    return f"{week_start.isoformat()}_{week_end.month:02d}-{week_end.day:02d}"
