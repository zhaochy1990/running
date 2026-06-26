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

from dataclasses import dataclass

from coach.contracts import (
    CallPlan,
    SpecialistRegistry,
    SpecialistResult,
)


@dataclass(frozen=True)
class DispatchResult:
    """A specialist result paired with the id that produced it."""

    specialist_id: str
    result: SpecialistResult


def dispatch(call_plan: CallPlan, *, registry: SpecialistRegistry) -> list[DispatchResult]:
    """Execute each call and collect attributed results (§4.6)."""
    dispatched: list[DispatchResult] = []
    for call in call_plan.calls:
        try:
            runner = registry.get_runner(call.specialist_id)
            result = runner(call.task)
        except Exception as exc:  # noqa: BLE001 — contain one failure, keep the plan alive
            result = SpecialistResult(
                status="failed",
                reply_fragment=f"专家 {call.specialist_id} 处理失败：{exc}",
            )
        dispatched.append(DispatchResult(specialist_id=call.specialist_id, result=result))
    return dispatched
