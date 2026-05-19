"""Offline evaluation framework for the STRIDE coach agent.

This package is **dev-time only** — it never runs in production. The
``.importlinter`` contract pins this: ``coach.*`` and ``stride_server.*``
must NOT import from ``coach_eval.*``; the dependency direction is one-way
(eval reuses production code, but production never touches eval). The
Dockerfile also strips ``src/coach_eval/`` out of the prod image.

Layout:

* :mod:`coach_eval.schemas` — framework schemas (``AxisScore`` /
  ``JudgeScore`` / ``FixtureRunOutcome`` / ``EvalReport``).
* :mod:`coach_eval.graph` — pipeline (``run_evaluation_for_fixture`` /
  ``run_evaluation_suite``). Deliberately function-based, not langgraph.
* :mod:`coach_eval.judge_s1` — S1 judge prompt v1 + ``make_s1_judge``
  factory bound to a langchain ``BaseChatModel``.
* :mod:`coach_eval.runner` — fixture loader, mode handling
  (``live_local_db`` vs ``frozen_fixture``), report I/O, scope-specific
  ``run_s1_evaluation`` / ``run_s2_evaluation`` / ``run_s3_evaluation``.

Entry points:

* ``python scripts/eval_coach.py --scope s1`` — CLI runner.
* ``coach_eval.runner.run_s1_evaluation(...)`` — programmatic API.

See ``docs/coach-eval.md`` for the full framework spec.
"""

from .schemas import (
    AxisScore,
    EvalReport,
    FixtureRunOutcome,
    JudgeScore,
    OverallVerdict,
    aggregate_axis_avg,
)

__all__ = [
    "AxisScore",
    "EvalReport",
    "FixtureRunOutcome",
    "JudgeScore",
    "OverallVerdict",
    "aggregate_axis_avg",
]
