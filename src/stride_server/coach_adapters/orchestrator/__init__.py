"""Orchestrator adapters — bridge the core orchestrator brain to infrastructure.

Holds the specialist runners (adapter side: DB + LLM) and the per-turn driver.
The core orchestration logic lives in ``coach.orchestrator``; this package
supplies the runners + wiring that the import boundary keeps out of core.
"""

from __future__ import annotations

from .master_plan_generation import (
    MASTER_PLAN_GENERATION_CARD,
    make_master_plan_generation_runner,
)
from .status_insight import STATUS_INSIGHT_CARD, make_status_insight_runner
from .runtime import build_specialist_registry, run_coach_turn

__all__ = [
    "MASTER_PLAN_GENERATION_CARD",
    "make_master_plan_generation_runner",
    "STATUS_INSIGHT_CARD",
    "make_status_insight_runner",
    "build_specialist_registry",
    "run_coach_turn",
]
