"""Dispatcher — execute a CallPlan against the registry's runners (§4.6).

S1 runs the plan's calls **sequentially** and pairs each result with the
specialist id that produced it (so the Aggregator can attribute proposals /
handoff hints). A runner that raises is contained as a ``failed`` result — one
specialist failing never crashes the whole plan.

Deferred to S2 (compound turns): parallel read fan-out (asyncio), write
serialisation, ``depends_on`` wiring (upstream results into downstream
``task.context``), and ``needs_clarification`` suspension of transitive
dependents. S1 plans are single-call, so none of that is exercised yet.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from coach.contracts import (
    CallPlan,
    SpecialistRegistry,
    SpecialistResult,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DispatchResult:
    """A specialist result paired with the id that produced it."""

    specialist_id: str
    result: SpecialistResult


def dispatch(call_plan: CallPlan, *, registry: SpecialistRegistry) -> list[DispatchResult]:
    """Execute each call and collect attributed results (§4.6)."""
    dispatched: list[DispatchResult] = []
    for call in call_plan.calls:
        t = time.perf_counter()
        logger.debug(
            "→ %s start | objective_chars=%d",
            call.specialist_id,
            len(call.task.objective),
        )
        try:
            runner = registry.get_runner(call.specialist_id)
            result = runner(call.task)
        except Exception as exc:  # noqa: BLE001 — contain one failure, keep the plan alive
            logger.debug(
                "✗ %s raised | error_type=%s",
                call.specialist_id,
                type(exc).__name__,
            )
            result = SpecialistResult(
                status="failed",
                reply_fragment=f"专家 {call.specialist_id} 处理失败：{exc}",
            )
        logger.debug(
            "← %s %s %.0fms | %dc proposals=%d",
            call.specialist_id,
            result.status,
            (time.perf_counter() - t) * 1000.0,
            len(result.reply_fragment),
            len(result.proposals),
        )
        dispatched.append(DispatchResult(specialist_id=call.specialist_id, result=result))
    return dispatched
