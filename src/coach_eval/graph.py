"""Evaluation pipeline — coordinates generation + L2 judge for one fixture.

Per ``docs/coach-eval.md`` § L2 Judge graph 设计, the eval pipeline is:

    fixture_input
        → (gen graph already wraps load_context → generator → rule_filter → reviewer → verdict)
        → final_artifact + rule_violations + verdict
        → judge_node (calls LLM with fixture.expected)
        → JudgeScore
        → aggregate

This module is intentionally **not** a langgraph — eval is a linear batch
pipeline with no iteration / branching, so a plain function is clearer
than a StateGraph wrapper. The doc's "graph" naming is preserved for
familiarity with the gen-side graph layout.

Caller responsibilities (in :mod:`coach_eval.runner`):

* Build the gen graph via :func:`coach.graphs.generation.build_generation_graph`
  with appropriate adapter callables (live mode = real DB queries;
  frozen_fixture mode = fixture-injection load_context).
* Provide a ``judge`` callable that wraps the LLM call.
* Provide an ``initial_state_builder`` that maps fixture → ``GenState``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from .schemas import FixtureRunOutcome, JudgeScore

logger = logging.getLogger(__name__)


# A judge callable: receives (generated_plan_dict, fixture_dict) and returns
# a JudgeScore. Implementations live in judge_s{1,2,3}.py and bind a LLM
# at construction time.
JudgeFn = Callable[[dict, dict], JudgeScore]

# Builds the initial GenState from a fixture. Implementations are
# scope-specific because S1 / S2 / S3 have different input shapes.
InitialStateBuilderFn = Callable[[dict], dict]


def run_evaluation_for_fixture(
    *,
    fixture: dict,
    gen_graph: Any,
    judge: JudgeFn,
    initial_state_builder: InitialStateBuilderFn,
) -> FixtureRunOutcome:
    """Run one fixture end-to-end → ``FixtureRunOutcome``.

    Flow:
        1. ``initial_state_builder(fixture)`` → initial GenState
        2. ``gen_graph.invoke(state)`` → runs L1 rule_filter inside
        3. If gen verdict == "block" → skip judge, return with l1_passed=False
        4. Otherwise → invoke ``judge(final_artifact, fixture)`` → JudgeScore
        5. Wrap into FixtureRunOutcome

    Exceptions during generation or judging are captured into
    ``FixtureRunOutcome.error`` rather than re-raised, so a single bad
    fixture doesn't poison a whole eval suite.
    """
    fixture_id = fixture.get("fixture_id", "<unknown>")
    scope = fixture.get("scope", "s1")

    initial_state = initial_state_builder(fixture)

    try:
        final_state = gen_graph.invoke(initial_state)
    except Exception as exc:  # noqa: BLE001 — eval boundary
        logger.warning("eval fixture=%s generation failed: %s", fixture_id, exc)
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=False,
            error=f"generation_failed: {type(exc).__name__}: {exc}",
        )

    verdict = final_state.get("final_verdict")
    rule_violations = final_state.get("rule_violations") or []
    l1_passed = verdict != "block"

    if not l1_passed:
        logger.info(
            "eval fixture=%s L1 blocked (skipping judge): %s",
            fixture_id,
            "; ".join(v.get("rule", "?") for v in rule_violations),
        )
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=False,
            l1_violations=rule_violations,
        )

    final_artifact = final_state.get("final_artifact") or {}
    if not isinstance(final_artifact, dict) or not final_artifact:
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=True,
            l1_violations=rule_violations,
            error="no_final_artifact",
        )

    try:
        judge_score = judge(final_artifact, fixture)
    except Exception as exc:  # noqa: BLE001 — eval boundary
        logger.warning("eval fixture=%s judge failed: %s", fixture_id, exc)
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=True,
            l1_violations=rule_violations,
            error=f"judge_failed: {type(exc).__name__}: {exc}",
        )

    return FixtureRunOutcome(
        fixture_id=fixture_id,
        scope=scope,
        l1_passed=True,
        l1_violations=rule_violations,
        judge_score=judge_score,
    )


def run_evaluation_suite(
    *,
    fixtures: list[dict],
    gen_graph: Any,
    judge: JudgeFn,
    initial_state_builder: InitialStateBuilderFn,
) -> list[FixtureRunOutcome]:
    """Run a batch of fixtures through the eval pipeline.

    Sequential (not parallelised) — judges are LLM calls and Azure rate
    limits would bite hard if we parallelised. Adapter layer can add
    ThreadPoolExecutor later if needed.
    """
    outcomes: list[FixtureRunOutcome] = []
    for i, fixture in enumerate(fixtures, start=1):
        fid = fixture.get("fixture_id", f"<idx={i}>")
        logger.info("eval [%d/%d] %s", i, len(fixtures), fid)
        outcomes.append(
            run_evaluation_for_fixture(
                fixture=fixture,
                gen_graph=gen_graph,
                judge=judge,
                initial_state_builder=initial_state_builder,
            )
        )
    return outcomes
