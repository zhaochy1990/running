"""Per-week specialist graph wrapper — Stage-3a Task 5.

A thin, named convenience constructor over :func:`build_generation_graph`
wired for the weekly-specialist case, so the per-phase loop (Task 6) doesn't
re-specify the same generation/rule_filter/reviewer plumbing for every week.

This module is coach **core**: it imports only from
``coach.graphs.generation.*`` + ``coach.schemas`` and takes the LLM-touching
functions (``generator`` / ``reviewer``) as injected callables. The adapter
(Task 6) passes the real per-week ``generate_specialist_week`` and a reviewer;
nothing here reaches into ``stride_server.*``.

The wrapper does NOT compute any rule inputs. ``rule_filter_kwargs`` flows
verbatim into :func:`run_rule_filter` (the S2 weekly rules) — this is where
the per-week S2 inputs go: ``prev_week_km``, ``injuries``, ``prev_ctl`` and
the athlete-relative ``z45_pace_threshold_s_km`` (the caller derives the last
from the week's ``PaceTargets.threshold_pace_s_km``).
"""

from __future__ import annotations

from typing import Any

from .graph import (
    ContextLoaderFn,
    GeneratorFn,
    ReviewerFn,
    build_generation_graph,
)
from .rule_filter import run_rule_filter
from .state import GenState


def _noop_loader(_state: GenState) -> dict:
    """Default context loader for the weekly case.

    The per-week ``generate_specialist_week`` computes its own context from
    ``state``, so the graph's ``load_ctx_node`` just needs *a* callable —
    return an empty dict and let the generator do the work.
    """
    return {}


def build_week_specialist_graph(
    *,
    generator: GeneratorFn,
    reviewer: ReviewerFn,
    rule_filter_kwargs: dict | None = None,
    load_context: ContextLoaderFn | None = None,
    max_iterations: int = 3,
) -> Any:
    """Build the compiled per-week specialist generation graph.

    Delegates entirely to :func:`build_generation_graph`; adds no graph logic
    of its own. Wires:

    * ``generator`` — injected per-week ``generate_specialist_week``.
    * ``reviewer`` — injected (a stub for 3a; the real per-phase reviewer is
      3b).
    * ``rule_filter=run_rule_filter`` — the S2 weekly rules (this is the
      builder default, but passed explicitly for clarity).
    * ``rule_filter_kwargs`` — forwarded verbatim to
      ``run_rule_filter(draft, **kwargs)`` (``prev_week_km`` / ``injuries`` /
      ``prev_ctl`` / ``z45_pace_threshold_s_km``).
    * ``load_context`` — defaults to a no-op returning ``{}`` when omitted.

    An ``error``-severity rule violation routes back to the generator (up to
    ``max_iterations``, then ``fallback`` with verdict ``block``).
    """
    return build_generation_graph(
        load_context=load_context or _noop_loader,
        generator=generator,
        reviewer=reviewer,
        rule_filter=run_rule_filter,
        rule_filter_kwargs=rule_filter_kwargs,
        max_iterations=max_iterations,
    )
