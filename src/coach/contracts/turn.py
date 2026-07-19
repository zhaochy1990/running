"""TurnResponse — the orchestrator's final per-turn output (§4.4).

The Aggregator collapses ``list[SpecialistResult]`` into one coherent reply plus
assembled proposal cards. Proposals ride the HTTP response (Pattern Y) and are
landed only when the user confirms via ``/apply``. The Memory Writer (§4.5) may
append a receipt suffix to ``reply`` *after* the Aggregator — producing a new
``TurnResponse`` value, not mutating this one in place.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from stride_core.plan_diff import PlanDiff
from stride_core.master_plan_diff import MasterPlanDiff
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal

from .season_impact import SeasonImpact
from .target import TargetRef


class Turn(BaseModel):
    """One filtered conversation turn projected into a specialist brief (§3.2).

    A lossy projection of the message history — only ``role`` + text, never the
    full ``BaseMessage`` (tool calls, reasoning blocks) which would bloat the
    expert prompt.
    """

    role: Literal["user", "assistant"]
    content: str


class ProposalCard(BaseModel):
    """A write proposal surfaced to the user, confirmed via ``/apply`` (§4.4).

    ``base_revision`` pins the plan snapshot the diff was proposed against
    (weekly content fingerprint or ``str(master.version)``) so ``/apply`` can
    reject a stale proposal (409). ``season_impact`` is a deterministic,
    adapter-computed assessment of how landing this proposal touches the active
    season plan — the core never imports storage, so an enricher fills it in.
    """

    specialist_id: str
    proposal: PlanDiff | MasterPlanDiff | WeeklyPlanCreateProposal
    target: TargetRef | None = None
    base_revision: str | None = None
    season_impact: SeasonImpact | None = None
    summary: str = ""


class TurnResponse(BaseModel):
    """Final response body for one user turn.

    Invariant (§4.4): ``clarification`` non-None ⟹ ``proposals`` empty (a
    clarify turn never emits a proposal). ``reply`` and ``proposals`` must agree
    (no "已降强度" with an empty proposal).
    """

    reply: str
    proposals: list[ProposalCard] = Field(default_factory=list)
    clarification: str | None = None
    active_target: TargetRef | None = None
