"""Evaluation pipeline — see ``docs/coach-eval.md`` § L2 Judge graph 设计."""

from .graph import JudgeFn, run_evaluation_for_fixture, run_evaluation_suite

__all__ = ["JudgeFn", "run_evaluation_for_fixture", "run_evaluation_suite"]
