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
import time
from collections.abc import Callable
from typing import Any

from .schemas import FixtureRunOutcome, JudgeScore

logger = logging.getLogger(__name__)

_JUDGE_RETRY_DELAYS_S = (30.0, 90.0, 180.0)
_RETRYABLE_JUDGE_ERROR_MARKERS = (
    "429",
    "500 internal server error",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "no_capacity",
    "too many requests",
    "rate limit",
    "temporarily unavailable",
)


# A judge callable: receives (generated_plan_dict, fixture_dict) and returns
# a JudgeScore. Implementations live in judge_s{1,2,3}.py and bind a LLM
# at construction time.
JudgeFn = Callable[[dict, dict], JudgeScore]
JudgePromptMetadataFn = Callable[[dict, dict], dict[str, Any]]

# Builds the initial GenState from a fixture. Implementations are
# scope-specific because S1 / S2 / S3 have different input shapes.
InitialStateBuilderFn = Callable[[dict], dict]


def _is_retryable_judge_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(marker in msg for marker in _RETRYABLE_JUDGE_ERROR_MARKERS)


def call_judge_with_retries(
    judge: JudgeFn,
    generated_plan: dict,
    fixture: dict,
    *,
    fixture_id: str | None = None,
) -> tuple[JudgeScore, dict[str, Any]]:
    """Call L2 judge, retrying only transient capacity/service errors."""
    fid = fixture_id or fixture.get("fixture_id", "<unknown>")
    attempt_s: list[float] = []
    attempts_total = len(_JUDGE_RETRY_DELAYS_S) + 1

    for attempt_idx in range(1, attempts_total + 1):
        judge_t0 = time.monotonic()
        try:
            score = judge(generated_plan, fixture)
            attempt_s.append(time.monotonic() - judge_t0)
            return score, {
                "judge_attempt_s": attempt_s,
                "judge_retries": attempt_idx - 1,
                "judge_s": sum(attempt_s),
            }
        except Exception as exc:  # noqa: BLE001 — retry boundary
            attempt_s.append(time.monotonic() - judge_t0)
            if attempt_idx >= attempts_total or not _is_retryable_judge_error(exc):
                raise
            delay_s = _JUDGE_RETRY_DELAYS_S[attempt_idx - 1]
            logger.warning(
                "eval fixture=%s judge transient failure attempt %d/%d; "
                "retrying in %.0fs: %s",
                fid,
                attempt_idx,
                attempts_total,
                delay_s,
                exc,
            )
            time.sleep(delay_s)

    raise RuntimeError("judge retry loop exited unexpectedly")


def run_evaluation_for_fixture(
    *,
    fixture: dict,
    gen_graph: Any,
    judge: JudgeFn,
    initial_state_builder: InitialStateBuilderFn,
    judge_prompt_metadata_builder: JudgePromptMetadataFn | None = None,
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
        gen_t0 = time.monotonic()
        final_state = gen_graph.invoke(initial_state)
        generation_elapsed = time.monotonic() - gen_t0
    except Exception as exc:  # noqa: BLE001 — eval boundary
        logger.warning("eval fixture=%s generation failed: %s", fixture_id, exc)
        raw_output = getattr(exc, "raw_output", None)
        debug: dict[str, Any] = {
            "exception_type": type(exc).__name__,
        }
        if isinstance(raw_output, str):
            debug["raw_output_excerpt"] = raw_output[:4000]
            debug["raw_output_excerpt_chars"] = len(raw_output[:4000])
        elif raw_output is not None:
            debug["raw_output_repr"] = repr(raw_output)[:4000]
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=False,
            error=f"generation_failed: {type(exc).__name__}: {exc}",
            debug=debug,
        )

    verdict = final_state.get("final_verdict")
    rule_violations = final_state.get("rule_violations") or []
    l1_passed = verdict != "block"
    final_artifact = final_state.get("final_artifact") or {}
    timings = dict(final_state.get("timings") or {})
    timings["generation_total_s"] = generation_elapsed

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
            generated_artifact=final_artifact if isinstance(final_artifact, dict) else None,
            generation_iterations=final_state.get("iteration"),
            timings=timings,
        )

    if not isinstance(final_artifact, dict) or not final_artifact:
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=True,
            l1_violations=rule_violations,
            generation_iterations=final_state.get("iteration"),
            timings=timings,
            error="no_final_artifact",
        )

    try:
        if judge_prompt_metadata_builder is not None:
            timings.update(judge_prompt_metadata_builder(final_artifact, fixture))
        judge_score, judge_timings = call_judge_with_retries(
            judge,
            final_artifact,
            fixture,
            fixture_id=fixture_id,
        )
        timings.update(judge_timings)
        timings["total_s"] = generation_elapsed + float(timings["judge_s"])
    except Exception as exc:  # noqa: BLE001 — eval boundary
        logger.warning("eval fixture=%s judge failed: %s", fixture_id, exc)
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope=scope,
            l1_passed=True,
            l1_violations=rule_violations,
            generated_artifact=final_artifact,
            generation_iterations=final_state.get("iteration"),
            timings=timings,
            error=f"judge_failed: {type(exc).__name__}: {exc}",
        )

    return FixtureRunOutcome(
        fixture_id=fixture_id,
        scope=scope,
        l1_passed=True,
        l1_violations=rule_violations,
        generated_artifact=final_artifact,
        generation_iterations=final_state.get("iteration"),
        timings=timings,
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
