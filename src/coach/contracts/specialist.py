"""SpecialistContract — Card / Task / Result (§3).

The contract has three pieces, each a separate concern:

* :class:`SpecialistCard` — *static* capability descriptor read by the router
  (Resolver/Supervisor) to decide "when to route to me". Registered once; the
  expert is never invoked to route.
* :class:`SpecialistTask` — the *rich brief* the Supervisor synthesises per turn
  (objective + scoped data + boundaries + filtered conversation window). Thin
  one-line tasks cause experts to redo work (Anthropic), so the brief is rich.
* :class:`SpecialistResult` — the *output* every expert returns. Carries only the
  compressed ``reply_fragment`` + optional proposal(s) back to the orchestrator
  (context isolation — raw tool returns / reasoning never flow back).

``proposal`` / ``proposals`` reuse the existing ``PlanDiff`` /
``MasterPlanDiff`` domain primitives (Pattern Y): the expert never persists;
the diffs ride the HTTP response and ``/apply`` lands the one the user selects.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from stride_core.plan_diff import PlanDiff
from stride_core.master_plan_diff import MasterPlanDiff

from .target import TargetRef
from .turn import Turn


# ---------------------------------------------------------------------------
# Task inputs
# ---------------------------------------------------------------------------


class ScopedContext(BaseModel):
    """The scoped data a specialist needs — NOT the full history.

    Prefetched by the Supervisor per ``SpecialistCard.data_needs`` (§4.2) so the
    expert produces a result in one pass instead of multiple tool round-trips.
    ``data`` is an open bag keyed by data-need name (e.g. ``"fatigue"``); a
    specialist reads what it declared and ignores the rest.
    """

    data: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None


class SpecialistTask(BaseModel):
    """Rich per-turn brief synthesised by the Supervisor (§3.2)."""

    objective: str
    active_target: TargetRef | None = None
    context: ScopedContext = Field(default_factory=ScopedContext)
    boundaries: str = ""
    conversation_window: list[Turn] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Result outputs
# ---------------------------------------------------------------------------


class ArtifactRef(BaseModel):
    """Reference to heavy output kept out of the orchestrator context (§3.3)."""

    id: str
    kind: str
    uri: str | None = None
    summary: str | None = None


class UsageStats(BaseModel):
    """Optional per-specialist metering (§3.3)."""

    llm_calls: int = 0
    tool_calls: int = 0
    tokens: int | None = None


SpecialistStatus = Literal["completed", "needs_clarification", "failed", "rejected"]


class SpecialistResult(BaseModel):
    """What every specialist returns (§3.3).

    ``status`` follows an A2A-style lifecycle; ``needs_clarification`` is a
    first-class state the orchestrator transmits back to the user, resuming on
    the next turn.
    """

    status: SpecialistStatus
    reply_fragment: str = ""
    # ``proposal`` is retained for the common single-diff path.  A specialist
    # that intentionally offers mutually exclusive choices (for example, a
    # conservative and an aggressive season adjustment) uses ``proposals``.
    proposal: PlanDiff | MasterPlanDiff | None = None
    proposals: list[PlanDiff | MasterPlanDiff] = Field(default_factory=list)
    clarification: str | None = None
    artifacts: list[ArtifactRef] | None = None
    handoff_hint: str | None = None
    usage: UsageStats | None = None

    @model_validator(mode="after")
    def _proposal_shape_is_unambiguous(self) -> "SpecialistResult":
        if self.proposal is not None and self.proposals:
            raise ValueError("use either proposal or proposals, not both")
        return self


# ---------------------------------------------------------------------------
# Card — static capability descriptor
# ---------------------------------------------------------------------------


class SpecialistCard(BaseModel):
    """Static capability descriptor (§3.1) — the routing menu entry.

    The router reads ``description`` / ``tags`` / ``examples`` to decide *when to
    route to me*; it never calls the expert to route. Adding a new specialist =
    registering a Card, after which Resolver/Supervisor derive routing
    automatically (§6) without an orchestrator edit.

    Kept fully JSON-serialisable on purpose (routing menus get logged / rendered
    into prompts). Per-expert typed-handoff schemas — when they land — belong on
    ``SpecialistEntry`` (programmatic only), not here as ``type`` fields, which
    would break ``model_dump()``.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    description: str
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)
    writes: bool = False
    data_needs: list[str] = Field(default_factory=list)
