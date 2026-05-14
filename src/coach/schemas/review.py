"""Reviewer output schema — see plan §7.4.

The Claude reviewer (Anthropic Sonnet 4.5) emits a structured ``ReviewReport``
after evaluating a generator draft against rule_filter results and 8 review
classes (safety_load, progression, injury_risk, phase_fit, pace_consistency,
nutrition_timing, rest_distribution, schema_validity).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


Verdict = Literal["pass", "auto_fix", "revise", "block"]
ReviewClass = Literal[
    "safety_load",
    "progression",
    "injury_risk",
    "phase_fit",
    "pace_consistency",
    "nutrition_timing",
    "rest_distribution",
    "schema_validity",
]
Severity = Literal["info", "warning", "error"]


class ReviewIssue(BaseModel):
    """One concrete problem the reviewer flagged on the draft."""

    review_class: ReviewClass
    severity: Severity
    message: str
    target_path: str | None = None
    suggested_action: str | None = None


class ReviewReport(BaseModel):
    """Structured reviewer output. ``suggested_patches`` is intentionally loose
    (``list[dict]``) — the graph's apply node casts to the scope-appropriate
    typed op (``DiffOp`` for week, ``MasterPlanDiffOp`` for master) after the
    fact, so the reviewer LLM can produce either without an extra discriminator.
    """

    verdict: Verdict
    reviewer_model: str
    iteration: int = Field(ge=0)
    issues: list[ReviewIssue] = Field(default_factory=list)
    suggested_patches: list[dict] = Field(default_factory=list)
    commentary_md: str = ""
