"""S1 master plan adapter — bridges coach generation graph to STRIDE infra.

Provides the 4 callables that :func:`coach.graphs.generation.graph.build_generation_graph`
injects:

* :func:`load_master_context` — query training history + fitness state from
  the user's SQLite DB; emits READING_HISTORY → EVALUATING stage updates.
* :func:`generate_master_plan` — build system prompt, call LLM, parse output;
  emits PLANNING_PHASES stage update.
* :func:`master_reviewer` — v1 stub (always pass); future will wire Claude
  Opus reviewer.
* :func:`apply_master_patches` — v1 stub identity (no auto-fix patches yet).

All side effects (DB / LLM / job state mutation) happen here, **not** in
``coach.*`` — that is the whole point of the adapter layer (per
``.importlinter`` Contract 1).

Shared helpers (``_query_history`` / ``_query_fitness_state`` /
``_format_history_summary`` / ``_build_system_prompt`` / ``_parse_llm_output``)
are imported from :mod:`stride_server.master_plan_generator` to avoid code
duplication; they are pure functions with no shared mutable state.
"""

from __future__ import annotations

import logging

from uuid import uuid4

from coach.graphs.generation.state import GenState
from coach.schemas import ReviewReport
from stride_core.timefmt import today_shanghai

from ..job_runner import JobStage, update_job
from ..llm_client import LLMClient
from ..master_plan_generator import (
    _build_master_plan,
    _build_system_prompt,
    _format_history_summary,
    _parse_llm_output,
    _query_fitness_state,
    _query_history,
)

logger = logging.getLogger(__name__)


def load_master_context(state: GenState) -> dict:
    """Query DB for training history + fitness state, return as context dict.

    Emits two stage updates as side effect:
    * READING_HISTORY @ 10% — before history query
    * EVALUATING @ 30%       — before fitness-state query
    """
    user_id = state.get("user_id") or ""
    job_id = state.get("job_id") or ""

    if job_id:
        update_job(job_id, stage=JobStage.READING_HISTORY, progress=10)
    history = _query_history(user_id)
    history_summary = _format_history_summary(history)
    logger.debug(
        "load_master_context: user=%s history_loaded activities=%d",
        user_id,
        history.get("total_activities", 0),
    )

    if job_id:
        update_job(job_id, stage=JobStage.EVALUATING, progress=30)
    fitness_state = _query_fitness_state(user_id)
    logger.debug(
        "load_master_context: user=%s fitness_summary=%r",
        user_id,
        fitness_state.get("summary"),
    )

    return {
        "history": history,
        "history_summary": history_summary,
        "fitness_state": fitness_state,
    }


def generate_master_plan(state: GenState) -> dict:
    """Build system prompt → LLM call → parse → transform to MasterPlan dict.

    Returns ``{"current_draft": <MasterPlan-shaped dict>}``. The transform via
    :func:`_build_master_plan` happens here (not in the caller) so that
    downstream rule_filter / reviewer see a structured ``MasterPlan`` dict
    rather than the raw LLM envelope (``{schema:..., plan:...}``).

    Side effect: emits PLANNING_PHASES @ 60% stage update.

    Raises:
        LLMUnavailable / LLMError: propagated to caller
            (mapped to ``llm_unavailable`` / ``llm_error: ...``).
        ValueError starting with ``"parse_failed"``: all 3 parse tiers failed
            (caller maps to ``parse_failed`` with truncated raw output).
        ValueError starting with ``"bad_schema"``: ``_build_master_plan``
            rejected the parsed JSON (unexpected schema / missing plan field
            / missing dates). Caller maps to ``bad_schema: ...``.
    """
    job_id = state.get("job_id") or ""
    user_id = state.get("user_id") or ""
    payload = state.get("input_payload") or {}
    goal = payload.get("goal") or {}
    profile = payload.get("profile")

    ctx = state.get("context") or {}
    history_summary = ctx.get("history_summary", "")
    fitness_state = ctx.get("fitness_state") or {}

    if job_id:
        update_job(job_id, stage=JobStage.PLANNING_PHASES, progress=60)

    today = today_shanghai().isoformat()
    system_prompt = _build_system_prompt(
        goal, profile, history_summary, fitness_state, today
    )

    user_text = "请基于上述信息生成训练总纲"
    # If rule_filter blocked a previous iteration's draft, the graph routes
    # back here with `state.rule_violations` populated. Without feeding them
    # to the next prompt we'd retry with identical input — wasted tokens on
    # deterministic L1 failures. Inject a corrective postscript so the LLM
    # can fix the specific issues (e.g. add a 赛前期 phase, push race date
    # forward, etc.). iteration > 0 guards against the first call.
    violations = state.get("rule_violations") or []
    iteration = int(state.get("iteration") or 0)
    if iteration > 0 and violations:
        violations_text = "\n".join(
            f"- {v.get('rule', '?')}: {v.get('message', '')}" for v in violations
        )
        user_text += (
            "\n\n上一次生成违反了以下 L1 硬性规则（rule_filter），请在本次重新生成时"
            "**显式修复**这些问题，不要重复同样的错误：\n"
            f"{violations_text}"
        )
    user_message = [{"role": "user", "content": user_text}]

    client = LLMClient()
    # max_tokens + reasoning_effort flow from ``config/coach.toml [generator]``
    # via ModelSpec → llm_factory → the langchain AzureChatOpenAI client.
    # Passing None here means "use the construction-time defaults"; this
    # keeps the budget tunable from the config file alone — no code edit
    # required to bump output size for S1 master plan generation.
    raw = client.chat_sync(system_prompt, user_message)

    parsed = _parse_llm_output(raw)
    if parsed is None:
        # parse_failed is non-deterministic — gpt-5.5 occasionally returns a
        # truncated / empty body. Retry once with the same prompt before
        # giving up. The 2026-05-20 probe showed that all 3 baseline failures
        # parsed cleanly on the very next call. One retry is cheap and
        # eliminates ~99% of these flakes; >1 retries hide real prompt bugs.
        logger.warning(
            "generate_master_plan: parse_failed on first attempt "
            "(raw_len=%d) — retrying once",
            len(raw),
        )
        raw_retry = client.chat_sync(system_prompt, user_message)
        parsed = _parse_llm_output(raw_retry)
        if parsed is None:
            err = ValueError(
                f"parse_failed: all 3 tiers failed twice "
                f"(raw1 len={len(raw)}, raw2 len={len(raw_retry)})"
            )
            err.raw_output = raw_retry[:2000]  # type: ignore[attr-defined]
            raise err
        raw = raw_retry  # for downstream logging consistency

    goal_id = goal.get("id") or goal.get("goal_id") or str(uuid4())
    try:
        plan = _build_master_plan(parsed, user_id, goal_id, goal)
    except ValueError as exc:
        # Re-raise with bad_schema prefix so caller can distinguish from
        # parse_failed (both are ValueError historically).
        new_err = ValueError(f"bad_schema: {exc}")
        raise new_err from exc

    return {"current_draft": plan.model_dump(mode="json")}


def master_reviewer(state: GenState) -> ReviewReport:
    """v1 stub reviewer — always passes.

    The pre-refactor ``run_generate_job`` had no reviewer step; this stub
    preserves that behavior. Follow-up: wire Claude Opus 4.7 with the 8 S1
    judge axes (see docs/coach-eval_S1.md § S1 L2 Judge Axes).
    """
    return ReviewReport(
        verdict="pass",
        reviewer_model="stub-v1",
        iteration=int(state.get("iteration") or 0),
        issues=[],
        suggested_patches=[],
        commentary_md="(stub reviewer — pass-through; Claude Opus wiring pending)",
    )


def apply_master_patches(draft: dict, _patches: list[dict]) -> dict:
    """v1 stub: identity. No auto-fix patches yet — reviewer always passes."""
    return draft
