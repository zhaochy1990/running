"""CallPlan — the Supervisor's structured dispatch plan (§4.2).

The Supervisor (LLM for compound turns, deterministic template for single-intent
turns) emits a ``CallPlan``: an ordered/DAG list of specialist calls, each with a
fully-synthesised :class:`SpecialistTask`. A deterministic dispatcher executes
it; the LLM never inline-calls a specialist.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .specialist import SpecialistTask


class SpecialistCall(BaseModel):
    """One node in the dispatch DAG.

    ``depends_on`` holds indices into ``CallPlan.calls`` — upstream read results
    feed downstream write tasks. The dispatcher enforces hard constraints (writes
    serial, reads parallel) on top of these logical dependencies (§4.6).
    """

    specialist_id: str
    task: SpecialistTask
    depends_on: list[int] = Field(default_factory=list)


class CallPlan(BaseModel):
    """Ordered/DAG plan of specialist calls executed by the dispatcher."""

    calls: list[SpecialistCall] = Field(default_factory=list)
