"""Evaluation output schemas — see ``docs/coach-eval.md``.

Framework-level schemas shared by S1 / S2 / S3 judges. ``AxisScore.axis``
is a free-form ``str`` rather than a fixed Literal so each scope can
define its own axis set (S1 has 9, S2 has 8, S3 has 5) without forcing
the schema layer to know about them. Scope-specific judges are
responsible for validating the axis name against their own enum.

``score=None`` means the axis is **not applicable** to this fixture
(e.g. ``request_handling`` when ``user_intent_md`` is absent). Such
axes are skipped during ``per_axis_avg`` aggregation.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


Scope = Literal["s1", "s2", "s3"]
OverallVerdict = Literal["pass", "marginal", "fail"]


class AxisScore(BaseModel):
    """One judge dimension's score + reasoning."""

    axis: str
    score: int | None = Field(default=None, ge=1, le=5)
    rationale: str
    matches_expected: bool = True
    anti_patterns_hit: list[str] = Field(default_factory=list)


class JudgeScore(BaseModel):
    """A single fixture's evaluation result."""

    fixture_id: str
    scope: Scope
    axes: list[AxisScore]
    overall_verdict: OverallVerdict
    overall_rationale: str
    judge_model: str
    judge_prompt_version: str


class FixtureRunOutcome(BaseModel):
    """Per-fixture outcome bundling all 3 layers' results."""

    fixture_id: str
    scope: Scope
    l1_passed: bool
    l1_violations: list[dict] = Field(default_factory=list)
    generated_artifact: dict | None = None
    generation_iterations: int | None = None
    timings: dict[str, Any] = Field(default_factory=dict)
    judge_score: JudgeScore | None = None
    judge_samples: list[JudgeScore] = Field(default_factory=list)
    judge_summary: dict = Field(default_factory=dict)
    error: str | None = None
    debug: dict[str, Any] = Field(default_factory=dict)


class EvalReport(BaseModel):
    """One full eval-run summary.

    ``per_axis_avg`` aggregates only axes whose score is not None;
    the denominator equals the number of fixtures where the axis was
    applicable, not the total fixture count.
    """

    run_id: str
    git_sha: str
    scope: Scope | Literal["all"]
    mode: Literal["live_local_db", "frozen_fixture"]
    judge_prompt_version: str
    fixtures_total: int
    fixtures_passed: int
    fixtures_marginal: int
    fixtures_failed: int
    per_axis_avg: dict[str, float] = Field(default_factory=dict)
    per_fixture: list[FixtureRunOutcome] = Field(default_factory=list)


def aggregate_axis_avg(outcomes: list[FixtureRunOutcome]) -> dict[str, float]:
    """Compute per-axis mean score across outcomes, skipping ``score=None``.

    Args:
        outcomes: list of FixtureRunOutcome. Outcomes without a judge_score
            (e.g. L1 failed, or L2 errored) contribute nothing.

    Returns:
        ``{axis: mean_score}``. Empty dict when nothing scorable.
    """
    sums: dict[str, float] = {}
    counts: dict[str, int] = {}
    for outcome in outcomes:
        if outcome.judge_score is None:
            continue
        for axis_score in outcome.judge_score.axes:
            if axis_score.score is None:
                continue
            sums[axis_score.axis] = sums.get(axis_score.axis, 0.0) + axis_score.score
            counts[axis_score.axis] = counts.get(axis_score.axis, 0) + 1
    return {axis: sums[axis] / counts[axis] for axis in sums}
