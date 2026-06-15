"""Aggregate season schema — the full generated season (Stage-3b T1).

``SeasonPlanBundle`` is the output of the Stage-3b orchestrator: it drives the
Stage-3a per-phase generator across every master-plan phase and assembles the
results here. One ``PhaseWeeks`` per master-plan phase, in order; each holds the
phase's generated weeks (as ``WeeklyPlan`` dicts) plus an optional per-phase
hybrid-reviewer summary.

Weeks are stored as plain ``dict`` (each a ``WeeklyPlan.to_dict()`` from
:mod:`stride_core.plan_spec`), NOT typed objects, so the bundle stays
serialization-friendly and round-trips through ``model_dump``/``model_validate``
without custom coercion.

The ``review`` field uses a slim :class:`PhaseReview` rather than the
generation-loop :class:`~coach.schemas.review.ReviewReport`: a stored season
summary wants only the verdict / commentary / issues, not the per-iteration
generation state (``iteration``, ``reviewer_model``, ``suggested_patches``)
that ``ReviewReport`` carries for the in-flight revise loop.

Pure pydantic — no DB, no LLM, no network — so it stays import-linter clean in
coach core.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from stride_core.master_plan import PhaseType

from .review import ReviewIssue, Verdict


class PhaseReview(BaseModel):
    """Slim per-phase reviewer summary stored in a season bundle.

    Distinct from :class:`~coach.schemas.review.ReviewReport`: it keeps only the
    season-facing fields (verdict / commentary / issues) and drops the
    in-flight generation-loop state (``iteration``, ``reviewer_model``,
    ``suggested_patches``).
    """

    verdict: Verdict
    commentary_md: str = ""
    issues: list[ReviewIssue] = Field(default_factory=list)


class PhaseWeeks(BaseModel):
    """One master-plan phase's generated weeks + optional review."""

    phase_id: str
    phase_type: PhaseType
    weeks: list[dict] = Field(default_factory=list)  # WeeklyPlan dicts, in order
    review: PhaseReview | None = None
    blocked_week_count: int = Field(default=0, ge=0)  # weeks excluded (failed rule_filter)


class SeasonPlanBundle(BaseModel):
    """A full generated season: every phase's weeks + per-phase review."""

    schema_version: str = Field(default="season-plan-bundle/v1", alias="schema")
    master_plan_id: str
    generated_by: str  # configured generator model (same provenance as MasterPlan.generated_by)
    phases: list[PhaseWeeks] = Field(default_factory=list)  # one per master-plan phase, in order

    model_config = {"populate_by_name": True}
