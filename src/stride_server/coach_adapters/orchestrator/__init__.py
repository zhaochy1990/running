"""Orchestrator adapters — bridge the core orchestrator brain to infrastructure.

Holds the specialist runners (adapter side: DB + LLM) and the per-turn driver.
The core orchestration logic lives in ``coach.orchestrator``; this package
supplies the runners + wiring that the import boundary keeps out of core.
"""

from __future__ import annotations

from .status_insight import STATUS_INSIGHT_CARD, make_status_insight_runner
from .runtime import (
    CoachTurnResult,
    build_specialist_registry,
    record_coach_event,
    run_coach_turn,
)

__all__ = [
    "STATUS_INSIGHT_CARD",
    "make_status_insight_runner",
    "build_specialist_registry",
    "run_coach_turn",
    "record_coach_event",
    "CoachTurnResult",
]
