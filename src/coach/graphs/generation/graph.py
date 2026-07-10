"""Generation pipeline graph — see plan §7.

Flow (simplified for the v1 MVP)::

    load_context → generator → rule_filter
                                 │
                                 ├ pass  → reviewer → verdict
                                 │                     ├ pass     → output
                                 │                     ├ auto_fix → apply_patches → output
                                 │                     ├ revise   → revise_loop (≤3) → generator
                                 │                     └ block    → fallback → output
                                 └ fail  → revise_loop (≤3) → generator

The state carries a counter so we never spin more than ``max_iterations``
total times around generator → reviewer.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from coach.schemas import ReviewReport

from .rule_filter import RuleFilterReport, run_rule_filter
from .state import GenState

logger = logging.getLogger(__name__)


GeneratorFn = Callable[[GenState], dict]
ReviewerFn = Callable[[GenState], ReviewReport]
ContextLoaderFn = Callable[[GenState], dict]
PatchApplierFn = Callable[[dict, list[dict]], dict]
RuleFilterFn = Callable[..., RuleFilterReport]


def build_generation_graph(
    *,
    load_context: ContextLoaderFn,
    generator: GeneratorFn,
    reviewer: ReviewerFn,
    apply_patches: PatchApplierFn | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
    rule_filter: RuleFilterFn | None = None,
    rule_filter_kwargs: dict | None = None,
    max_iterations: int = 3,
) -> Any:
    """Build the compiled generation graph.

    Injected functions:

    * ``load_context(state)`` returns the context dict (read tool output).
    * ``generator(state)`` returns ``{"current_draft": <plan dict>}``.
    * ``reviewer(state)`` returns a ``ReviewReport``.
    * ``apply_patches(draft, patches)`` applies ``auto_fix`` patches; defaults
      to a no-op identity.
    * ``rule_filter(plan_dict, **kwargs)`` runs deterministic rules; defaults
      to :func:`run_rule_filter` (WeeklyPlan / S2 rules). S1 master plan
      callers inject ``run_master_rule_filter`` from
      ``coach.graphs.generation.master_rule_filter`` instead.

    ``rule_filter_kwargs`` flows through to the rule_filter callable
    (e.g. ``prev_week_km`` / ``injuries`` for S2, or ``target_race`` /
    ``season_window`` for S1).
    """
    rfk = dict(rule_filter_kwargs or {})

    def _patch_default(draft: dict, _patches: list[dict]) -> dict:
        return draft

    apply_patches_fn = apply_patches or _patch_default
    rule_filter_fn = rule_filter or run_rule_filter

    # ------------------------------------------------------------------
    # Nodes
    # ------------------------------------------------------------------

    def load_ctx_node(state: GenState) -> dict:
        t0 = time.monotonic()
        ctx = load_context(state)
        elapsed = time.monotonic() - t0
        cp = (ctx or {}).get("current_phase") or {}
        cont = (ctx or {}).get("continuity") or {}
        logger.info(
            "gen[load_context] done in %.1fs — current_phase: source=%s entry=%s "
            "weeks_in=%s conf=%s | continuity: aerobic_weeks=%s form=%s",
            elapsed,
            cp.get("source"),
            cp.get("recommended_entry_phase"),
            cp.get("weeks_in_phase"),
            cp.get("confidence"),
            cont.get("recent_aerobic_weeks"),
            cont.get("current_form_zone"),
        )
        return {"context": ctx, "iteration": 0, "timings": {"load_context_s": elapsed}}

    def generator_node(state: GenState) -> dict:
        attempt = int(state.get("iteration") or 0) + 1
        prior_violations = state.get("rule_violations") or []
        logger.info(
            "gen[generator] attempt %d/%d starting%s",
            attempt,
            max_iterations,
            f" (retry — fixing {len(prior_violations)} rule violation(s))" if attempt > 1 else "",
        )
        t0 = time.monotonic()
        out = generator(state)
        elapsed = time.monotonic() - t0
        # generator MUST return current_draft; ensure shape
        draft = out.get("current_draft")
        phases = (draft or {}).get("phases") or []
        phase_seq = "→".join(str(p.get("phase_type") or p.get("name", "?")) for p in phases)
        logger.info(
            "gen[generator] attempt %d done in %.1fs — %d phase(s): %s",
            attempt,
            elapsed,
            len(phases),
            phase_seq or "(none)",
        )
        timings = dict(state.get("timings") or {})
        timings.setdefault("generator_attempt_s", []).append(elapsed)
        timings["generator_total_s"] = sum(timings.get("generator_attempt_s", []))
        metadata = out.get("timing_metadata") or {}
        if isinstance(metadata, dict):
            timings.update(metadata)
        state_update = {
            "current_draft": draft,
            "iteration": attempt,
            "timings": timings,
        }
        for key in ("master_plan_load_estimate",):
            if key in out:
                state_update[key] = out[key]
        return state_update

    def rule_filter_node(state: GenState) -> dict:
        draft = state.get("current_draft") or {}
        t0 = time.monotonic()
        report: RuleFilterReport = rule_filter_fn(draft, state=state, **rfk)
        elapsed = time.monotonic() - t0
        errors = [v for v in report.violations if v.severity == "error"]
        warns = [v for v in report.violations if v.severity != "error"]
        logger.info(
            "gen[rule_filter] iter %s done in %.1fs — %d error(s), %d warning(s)%s",
            state.get("iteration"),
            elapsed,
            len(errors),
            len(warns),
            "" if not report.violations else ": " + "; ".join(
                f"{v.rule}({v.severity})" for v in report.violations
            ),
        )
        timings = dict(state.get("timings") or {})
        timings.setdefault("rule_filter_s", []).append(elapsed)
        violations_payload = [
            {
                "rule": v.rule,
                "severity": v.severity,
                "message": v.message,
                "details": v.details,
            }
            for v in report.violations
        ]
        timings.setdefault("rule_filter_history", []).append({
            "iteration": state.get("iteration"),
            "violations": violations_payload,
        })
        return {
            "rule_violations": violations_payload,
            "timings": timings,
        }

    def reviewer_node(state: GenState) -> dict:
        t0 = time.monotonic()
        report = reviewer(state)
        elapsed = time.monotonic() - t0
        history = list(state.get("review_history") or [])
        history.append(report)
        logger.info(
            "gen[reviewer] iter %s done in %.1fs — verdict=%s",
            state.get("iteration"),
            elapsed,
            report.verdict,
        )
        timings = dict(state.get("timings") or {})
        timings["reviewer_s"] = elapsed
        return {"review_history": history, "final_verdict": report.verdict, "timings": timings}

    def apply_patches_node(state: GenState) -> dict:
        draft = state.get("current_draft") or {}
        history = state.get("review_history") or []
        if not history:
            return {}
        latest = history[-1]
        patched = apply_patches_fn(draft, latest.suggested_patches)
        return {"current_draft": patched}

    def finalize_node(state: GenState) -> dict:
        logger.info(
            "gen[finalize] ✓ accepted after %s iteration(s) — verdict=%s",
            state.get("iteration"),
            state.get("final_verdict") or "pass",
        )
        return {"final_artifact": state.get("current_draft")}

    def fallback_node(state: GenState) -> dict:
        # The generation pipeline ran out of confidence; surface the latest
        # draft with verdict=block so the route can flag the job as failed
        # (or downgrade to a rule-engine baseline in a future iteration).
        logger.warning(
            "gen[fallback] ✗ exhausted %s iteration(s) without passing — emitting "
            "latest draft with verdict=block",
            state.get("iteration"),
        )
        return {
            "final_artifact": state.get("current_draft"),
            "final_verdict": "block",
        }

    # ------------------------------------------------------------------
    # Branches
    # ------------------------------------------------------------------

    def after_rule_filter(state: GenState) -> str:
        violations = state.get("rule_violations") or []
        has_error = any(v["severity"] == "error" for v in violations)
        if not has_error:
            dest = "reviewer"
        elif int(state.get("iteration") or 0) >= max_iterations:
            dest = "fallback"
        else:
            dest = "generator"
        logger.info(
            "gen[route] after rule_filter (iter %s) → %s%s",
            state.get("iteration"),
            dest,
            " (rule errors, regenerating)" if dest == "generator" else
            " (max iterations, giving up)" if dest == "fallback" else "",
        )
        return dest

    def after_reviewer(state: GenState) -> str:
        verdict = state.get("final_verdict")
        if verdict == "pass":
            dest = "finalize"
        elif verdict == "auto_fix":
            dest = "apply_patches"
        elif int(state.get("iteration") or 0) >= max_iterations:
            dest = "fallback"
        elif verdict == "revise":
            dest = "generator"
        else:
            dest = "fallback"  # 'block' or unknown verdict
        logger.info(
            "gen[route] after reviewer (iter %s, verdict=%s) → %s",
            state.get("iteration"),
            verdict,
            dest,
        )
        return dest

    # ------------------------------------------------------------------
    # Graph wiring
    # ------------------------------------------------------------------

    graph: StateGraph = StateGraph(GenState)
    graph.add_node("load_context", load_ctx_node)
    graph.add_node("generator", generator_node)
    graph.add_node("rule_filter", rule_filter_node)
    graph.add_node("reviewer", reviewer_node)
    graph.add_node("apply_patches", apply_patches_node)
    graph.add_node("finalize", finalize_node)
    graph.add_node("fallback", fallback_node)

    graph.add_edge(START, "load_context")
    graph.add_edge("load_context", "generator")
    graph.add_edge("generator", "rule_filter")
    graph.add_conditional_edges(
        "rule_filter",
        after_rule_filter,
        {"reviewer": "reviewer", "generator": "generator", "fallback": "fallback"},
    )
    graph.add_conditional_edges(
        "reviewer",
        after_reviewer,
        {
            "finalize": "finalize",
            "apply_patches": "apply_patches",
            "generator": "generator",
            "fallback": "fallback",
        },
    )
    graph.add_edge("apply_patches", "finalize")
    graph.add_edge("finalize", END)
    graph.add_edge("fallback", END)

    return graph.compile(checkpointer=checkpointer)


def parse_reviewer_xml(raw: str) -> ReviewReport:
    """Best-effort parser for Claude's XML-flavoured review output.

    The reviewer prompt asks Claude to emit::

        <review>
          <verdict>pass|auto_fix|revise|block</verdict>
          <reviewer_model>...</reviewer_model>
          <iteration>N</iteration>
          <commentary>...</commentary>
          <issues>...JSON list...</issues>
          <suggested_patches>...JSON list...</suggested_patches>
        </review>

    Falls back to ``verdict='block'`` if the structure can't be parsed —
    the verdict branch then routes to ``fallback`` and the job fails loudly
    instead of silently shipping a malformed plan.
    """
    def _tag(name: str) -> str | None:
        import re

        m = re.search(rf"<{name}>(.*?)</{name}>", raw, re.DOTALL)
        if not m:
            return None
        return m.group(1).strip()

    verdict = _tag("verdict") or "block"
    if verdict not in ("pass", "auto_fix", "revise", "block"):
        verdict = "block"
    iter_str = _tag("iteration") or "0"
    try:
        iteration = int(iter_str)
    except ValueError:
        iteration = 0

    def _parse_json_list(blob: str | None) -> list:
        if not blob:
            return []
        try:
            data = json.loads(blob)
        except (ValueError, json.JSONDecodeError):
            return []
        return data if isinstance(data, list) else []

    issues_raw = _parse_json_list(_tag("issues"))
    # Drop entries that don't match the ReviewIssue shape — Claude sometimes
    # emits free-form objects when asked for "issues", and the graph survives
    # better when we silently skip malformed items than when we 500.
    from coach.schemas import ReviewIssue

    issues: list[ReviewIssue] = []
    for raw_item in issues_raw:
        if not isinstance(raw_item, dict):
            continue
        try:
            issues.append(ReviewIssue.model_validate(raw_item))
        except Exception:  # noqa: BLE001 — best-effort parse
            continue
    patches = _parse_json_list(_tag("suggested_patches"))

    return ReviewReport(
        verdict=verdict,
        reviewer_model=_tag("reviewer_model") or "claude-sonnet-4-5",
        iteration=iteration,
        issues=issues,
        suggested_patches=patches,
        commentary_md=_tag("commentary") or "",
    )
