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
``_format_history_summary`` / ``build_master_prompts`` / ``_parse_llm_output``)
are imported from :mod:`stride_server.master_plan_generator` to avoid code
duplication; they are pure functions with no shared mutable state.
"""

from __future__ import annotations

import logging
import time
from datetime import date as date_cls

from coach.graphs.generation.state import GenState
from coach.schemas import ReviewReport
from stride_core.timefmt import today_shanghai

from .continuity_analyzer import analyze_continuity
from .phase_detector import detect_current_phase
from ..job_runner import JobStage, update_job
from ..llm_client import LLMClient
from ..master_plan_generator import (
    _build_master_plan,
    _format_history_summary,
    _normalise_pb_seconds,
    _parse_master_plan_output,
    _query_fitness_state,
    _query_history,
    build_master_prompts,
)
from .master_plan_load import format_training_load_anchor_for_prompt
from .tool_impls.read_impls import EstimateMasterPlanLoadImpl

logger = logging.getLogger(__name__)

# S1 master plans are compact season skeletons, not phase-at-once weekly plans.
# Recent real raw model outputs are ~13-16k chars, so 24k visible-output tokens
# leaves headroom for larger fixtures while avoiding the 128k generator-role
# default that can encourage long reasoning/output budgets on gpt-5.x. Keep this
# S1-specific; phase-at-once weekly generation still uses config max_tokens.
MASTER_PLAN_MAX_TOKENS = 24576


def _compute_bmi(weight_kg: float | None, height_cm: float | None) -> float | None:
    """BMI = weight_kg / height_m². Returns ``None`` when either input is
    missing or non-positive (never fabricate a height)."""
    if not weight_kg or not height_cm or height_cm <= 0:
        return None
    height_m = height_cm / 100.0
    return round(weight_kg / (height_m * height_m), 2)


def _load_body_composition(
    db,
    profile: dict | None,
    *,
    as_of: date_cls | None = None,
) -> dict | None:
    """Read the latest body-composition scan via the canonical Database reader
    (no inline SQL) and assemble the planner baseline block.

    Height for BMI comes from the onboarding/profile payload (``height_cm``);
    when it's absent BMI is ``None`` and the block carries weight/fat/smm only,
    so the planner can still set body-comp-aware milestones without a fabricated
    height. ``scan_date`` is a Shanghai-local calendar date (YYYY-MM-DD) and is
    passed through unchanged — consistent with the rest of the codebase, which
    never UTC-converts this column.

    Returns ``None`` when there is no scan (graceful degrade — performance-only
    milestones remain possible).
    """
    if as_of is None:
        row = db.latest_body_composition_scan()
    else:
        row = db.body_composition_scan_at_or_before(as_of.isoformat())
    if row is None:
        return None
    weight_kg = row["weight_kg"]
    height_cm = None
    if profile and isinstance(profile, dict):
        raw_h = profile.get("height_cm")
        if isinstance(raw_h, (int, float)) and raw_h > 0:
            height_cm = float(raw_h)
    return {
        "scan_date": row["scan_date"],
        "weight_kg": weight_kg,
        "body_fat_pct": row["body_fat_pct"],
        "smm_kg": row["smm_kg"],
        "fat_mass_kg": row["fat_mass_kg"],
        "bmr_kcal": row["bmr_kcal"],
        "bmi": _compute_bmi(weight_kg, height_cm),
    }


def _format_body_composition_summary(bc: dict) -> str:
    """One-line human-visible prose for the body-comp baseline (sits next to
    ``history_summary`` in the context)."""
    parts = [f"体重 {bc['weight_kg']}kg"]
    if bc.get("body_fat_pct") is not None:
        parts.append(f"体脂 {bc['body_fat_pct']}%")
    if bc.get("smm_kg") is not None:
        parts.append(f"骨骼肌 {bc['smm_kg']}kg")
    if bc.get("bmi") is not None:
        parts.append(f"BMI {bc['bmi']}")
    return f"最新体测（{bc.get('scan_date', '?')}）— " + "，".join(parts)


_PB_HISTORY_KEYS = {
    "5k": "best_5k_s",
    "10k": "best_10k_s",
    "hm": "best_hm_s",
    "fm": "best_fm_s",
}


def _load_pb_seconds(db) -> dict[str, float]:
    """Load achieved PB seconds from personal_bests, self-healing via the
    canonical PB reader when needed."""
    from stride_core.pb_records import load_personal_bests

    pb_map = load_personal_bests(db)
    raw = {}
    for display, key in (("5K", "5k"), ("10K", "10k"), ("HM", "hm"), ("FM", "fm")):
        entry = pb_map.get(display)
        if isinstance(entry, dict) and entry.get("pb_time_sec") is not None:
            raw[key] = entry.get("pb_time_sec")
    return _normalise_pb_seconds(raw)


def _history_with_pb_seconds(history: dict, pb_seconds: dict[str, float]) -> dict:
    if not pb_seconds:
        return history
    out = dict(history)
    for key, history_key in _PB_HISTORY_KEYS.items():
        if pb_seconds.get(key) is not None:
            out[history_key] = round(pb_seconds[key])
    return out


def _build_context_snippets(
    history: dict, fitness_state: dict, goal: dict, *, as_of: date_cls | None = None
) -> dict[str, Any]:
    """Assemble the live-data snippets shown on the generating screen (screen-2):
    avg/max weekly km, weeks-to-race, CTL/ATL/form. Best-effort — every field is
    optional and silently omitted when its source data is absent, so this never
    blocks generation."""
    snippets: dict[str, Any] = {}
    race_date = (goal or {}).get("race_date")
    if race_date:
        try:
            snippets["weeks_to_race"] = max(
                0, (date_cls.fromisoformat(race_date) - (as_of or today_shanghai())).days // 7
            )
        except (ValueError, TypeError):
            pass
    if history:
        if history.get("max_weekly_km") is not None:
            snippets["max_weekly_km"] = round(float(history["max_weekly_km"]), 1)
        active = [
            w.get("distance_km")
            for w in (history.get("weekly_profile") or [])
            if isinstance(w, dict) and w.get("distance_km")
        ]
        if active:
            snippets["avg_weekly_km"] = round(sum(active) / len(active), 1)
    for key in ("chronic_load", "acute_load", "form"):
        val = (fitness_state or {}).get(key)
        if isinstance(val, (int, float)):
            snippets[key] = round(float(val), 1)
    summary = (fitness_state or {}).get("summary")
    if summary:
        snippets["fitness_summary"] = summary
    return snippets


def load_master_context(state: GenState) -> dict:
    """Query DB for training history + fitness state, return as context dict.

    Emits two stage updates as side effect:
    * READING_HISTORY @ 10% — before history query
    * EVALUATING @ 30%       — before fitness-state query
    """
    user_id = state.get("user_id") or ""
    job_id = state.get("job_id") or ""
    payload = state.get("input_payload") or {}
    goal = payload.get("goal") or {}
    profile = payload.get("profile")

    as_of = today_shanghai()
    raw_as_of = goal.get("as_of_date")
    if raw_as_of:
        try:
            as_of = date_cls.fromisoformat(str(raw_as_of))
        except (ValueError, TypeError):
            logger.warning("load_master_context: ignoring invalid as_of_date=%r", raw_as_of)

    if job_id:
        update_job(job_id, stage=JobStage.READING_HISTORY, progress=10)
    history = _query_history(user_id, as_of=as_of)
    logger.debug(
        "load_master_context: user=%s history_loaded activities=%d",
        user_id,
        history.get("total_activities", 0),
    )
    if job_id:
        update_job(job_id, stage=JobStage.EVALUATING, progress=30)
    logger.debug("load_master_context: user=%s querying fitness state...", user_id)
    fitness_state = _query_fitness_state(user_id, as_of=as_of)
    logger.debug(
        "load_master_context: user=%s fitness_summary=%r",
        user_id,
        fitness_state.get("summary"),
    )

    continuity = None
    body_composition: dict | None = None
    current_phase = None
    pb_seconds: dict[str, float] = {}
    try:
        from stride_storage.sqlite.database import Database
        db = Database(user=user_id)
        try:
            pb_seconds = _load_pb_seconds(db)
        except Exception as exc:  # noqa: BLE001 — PB read must not block gen
            logger.warning("load_master_context: PB read failed for %s: %s", user_id, exc)
        continuity = analyze_continuity(db, goal=goal, profile=profile, as_of=as_of)
        # Authoritative current-phase position. Deterministic-only here
        # (cross_validate_with_llm=False): the LLM cross-check is a reviewer
        # gpt-5.5 round-trip that dominates context-load latency yet never
        # changes the verdict (deterministic always wins), so the generation
        # path skips it. Reuse the continuity we just computed to avoid a second
        # DB pass.
        try:
            current_phase = detect_current_phase(
                db, user_id=user_id, goal=goal, profile=profile,
                as_of=as_of, continuity=continuity,
                cross_validate_with_llm=False,
            )
        except Exception as exc:  # noqa: BLE001 — detection must not hard-fail gen
            logger.warning("load_master_context: phase detection failed: %s", exc)
        # Body-composition baseline. Reuse the same db handle as the explicit
        # PB/continuity context load above.
        try:
            body_composition = _load_body_composition(db, profile, as_of=as_of)
        except Exception as exc:  # noqa: BLE001 — degrade to perf-only milestones
            logger.warning("load_master_context: body_composition failed: %s", exc)
    except Exception as exc:  # noqa: BLE001 — context load must never hard-fail
        logger.warning("load_master_context: continuity failed: %s", exc)

    history_summary = _format_history_summary(_history_with_pb_seconds(history, pb_seconds))
    load_tool_result = EstimateMasterPlanLoadImpl(user_id)()
    training_load_tool: dict = {}
    training_load_tool_summary = "Training-load estimator tool: unavailable."
    if load_tool_result.ok and isinstance(load_tool_result.data, dict):
        training_load_tool = load_tool_result.data
        training_load_tool_summary = format_training_load_anchor_for_prompt(
            training_load_tool.get("history_anchor")
        )
        history_summary = history_summary + "\n" + training_load_tool_summary
    else:
        logger.warning(
            "load_master_context: estimate_master_plan_load anchor failed user=%s errors=%s",
            user_id,
            load_tool_result.errors,
        )
    logger.debug(
        "load_master_context: user=%s history_summary_chars=%d weekly_profile_weeks=%d pb_keys=%s",
        user_id,
        len(history_summary),
        len(history.get("weekly_profile") or []),
        sorted(pb_seconds),
    )

    # Surface live-data snippets to the generating UI (screen-2). Best-effort:
    # a failure here must never block context load.
    if job_id:
        try:
            update_job(
                job_id,
                context_snippets=_build_context_snippets(
                    history, fitness_state, goal, as_of=as_of
                ),
            )
        except Exception as exc:  # noqa: BLE001 — snippets are cosmetic
            logger.warning("load_master_context: snippet stash failed: %s", exc)

    return {
        "history_summary": history_summary,
        "pb_seconds": pb_seconds,
        "fitness_state": fitness_state,
        "training_load_tool": training_load_tool,
        "training_load_tool_summary": training_load_tool_summary,
        "continuity": continuity.model_dump() if continuity is not None else None,
        "current_phase": current_phase.model_dump() if current_phase is not None else None,
        "body_composition": body_composition,
        "body_composition_summary": (
            _format_body_composition_summary(body_composition)
            if body_composition is not None
            else None
        ),
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
    runtime_options = state.get("runtime_options") or {}
    goal = payload.get("goal") or {}
    profile = payload.get("profile")

    ctx = state.get("context") or {}
    history_summary = ctx.get("history_summary", "")
    fitness_state = ctx.get("fitness_state") or {}
    pb_seconds = ctx.get("pb_seconds") or {}

    if job_id:
        update_job(job_id, stage=JobStage.PLANNING_PHASES, progress=60)

    continuity_raw = ctx.get("continuity")
    continuity = None
    if continuity_raw:
        from coach.schemas import ContinuitySignals
        continuity = ContinuitySignals.model_validate(continuity_raw)

    current_phase_raw = ctx.get("current_phase")
    current_phase = None
    if current_phase_raw:
        from coach.schemas import CurrentPhaseContext
        current_phase = CurrentPhaseContext.model_validate(current_phase_raw)

    today = today_shanghai().isoformat()
    # Long-term athlete memory (A4): user-stated facts (injuries / relocation to
    # altitude / preferences …) injected as soft constraints so the plan adapts.
    athlete_memories: list = []
    if user_id:
        try:
            from stride_server.coach_runtime import get_athlete_memory_store

            athlete_memories = get_athlete_memory_store().fetch_active(user_id)
        except Exception:  # noqa: BLE001 — memory is supplementary, never block generation
            logger.warning("master_plan: athlete-memory fetch failed", exc_info=True)
    # System = static doctrine (cacheable prefix); user = this athlete's data +
    # task. See master_plan_generator.build_master_prompts / CLAUDE.md
    # "Prompt role discipline".
    system_prompt, user_text = build_master_prompts(
        goal, profile, history_summary, fitness_state, today,
        continuity=continuity,
        body_composition=ctx.get("body_composition"),
        body_composition_summary=ctx.get("body_composition_summary"),
        current_phase=current_phase,
        athlete_memories=athlete_memories,
        training_load_tool_summary=ctx.get("training_load_tool_summary"),
    )
    prompt_chars = {
        "generator_system_prompt_chars": len(system_prompt),
        "generator_user_prompt_chars": len(user_text),
    }
    logger.debug(
        "generate_master_plan: system_prompt=%d chars, user_prompt=%d chars, goal=%r, profile=%r",
        len(system_prompt),
        len(user_text),
        goal,
        profile,
    )

    # If rule_filter blocked a previous iteration's draft, the graph routes
    # back here with `state.rule_violations` populated. Without feeding them
    # to the next prompt we'd retry with identical input — wasted tokens on
    # deterministic L1 failures. Inject a corrective postscript into the *user*
    # turn (the athlete-data turn — the system doctrine stays invariant) so the
    # LLM can fix the specific issues (e.g. add a 赛前期 phase, push race date
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
        prompt_chars["generator_user_prompt_chars"] = len(user_text)
    user_message = [{"role": "user", "content": user_text}]

    master_max_tokens = MASTER_PLAN_MAX_TOKENS
    if runtime_options.get("master_max_tokens") is not None:
        try:
            master_max_tokens = int(runtime_options["master_max_tokens"])
        except (TypeError, ValueError):
            logger.warning(
                "generate_master_plan: ignoring invalid master_max_tokens=%r",
                runtime_options.get("master_max_tokens"),
            )
            master_max_tokens = MASTER_PLAN_MAX_TOKENS
        else:
            if master_max_tokens <= 0:
                logger.warning(
                    "generate_master_plan: ignoring non-positive master_max_tokens=%r",
                    runtime_options.get("master_max_tokens"),
                )
                master_max_tokens = MASTER_PLAN_MAX_TOKENS

    client = LLMClient()
    # max_tokens + reasoning_effort flow from ``config/coach.toml [generator]``
    # via ModelSpec → llm_factory → the langchain AzureChatOpenAI client.
    # Passing None here means "use the construction-time defaults"; this
    # keeps the budget tunable from the config file alone — no code edit
    # required to bump output size for S1 master plan generation.
    logger.info(
        "generate_master_plan: LLM call starting (iteration=%d, system=%d chars, user=%d chars%s)",
        iteration,
        len(system_prompt),
        len(user_text),
        ", with rule-violation feedback" if (iteration > 0 and violations) else "",
    )
    _t0 = time.monotonic()
    raw = client.chat_sync(
        system_prompt,
        user_message,
        max_tokens=master_max_tokens,
    )
    raw_response_chars = len(raw)
    logger.info(
        "generate_master_plan: LLM call returned in %.1fs (raw=%d chars)",
        time.monotonic() - _t0,
        raw_response_chars,
    )

    parsed = _parse_master_plan_output(raw)
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
        raw_retry = client.chat_sync(
            system_prompt,
            user_message,
            max_tokens=master_max_tokens,
        )
        parsed = _parse_master_plan_output(raw_retry)
        if parsed is None:
            err = ValueError(
                f"parse_failed: all 3 tiers failed twice "
                f"(raw1 len={len(raw)}, raw2 len={len(raw_retry)})"
            )
            err.raw_output = (  # type: ignore[attr-defined]
                "---RAW_ATTEMPT_1---\n"
                f"{raw[:2000]}\n"
                "---RAW_ATTEMPT_2---\n"
                f"{raw_retry[:2000]}"
            )
            raise err
        raw = raw_retry  # for downstream logging consistency
        raw_response_chars = len(raw_retry)

    # Stamp the actual configured generator model (config/coach.toml
    # [generator].model) rather than a hardcoded literal, so generated_by
    # tracks the real model across config changes. The structured goal dict
    # is passed through so _build_goal_snapshot can embed the full goal.
    from ..coach_runtime import get_generator_model

    generated_by = get_generator_model()
    try:
        plan = _build_master_plan(
            parsed,
            user_id,
            goal,
            profile=profile,
            generated_by=generated_by,
            pb_seconds=pb_seconds,
        )
    except ValueError as exc:
        # Re-raise with bad_schema prefix so caller can distinguish from
        # parse_failed (both are ValueError historically).
        new_err = ValueError(f"bad_schema: {exc}")
        raise new_err from exc

    # Draft is built; the graph's rule_filter node runs next. Surface it as a
    # job stage so the generating UI shows the 校验安全规则 step (screen-2).
    if job_id:
        update_job(job_id, stage=JobStage.RULE_FILTER, progress=75)

    load_estimate: dict | None = None
    load_tool_result = EstimateMasterPlanLoadImpl(user_id)(
        plan=plan.model_dump(mode="json"),
        target_race={
            "distance": goal.get("distance") or goal.get("race_distance"),
            "goal_time_s": goal.get("goal_time_s"),
            "race_date": goal.get("race_date"),
        },
        weekly_run_days_max=(profile or {}).get("weekly_run_days_max")
        or (profile or {}).get("weekly_training_days")
        or goal.get("weekly_training_days"),
        injuries=(profile or {}).get("injuries") or goal.get("injuries"),
    )
    if load_tool_result.ok and isinstance(load_tool_result.data, dict):
        load_estimate = load_tool_result.data.get("plan_estimate")
    else:
        logger.warning(
            "generate_master_plan: estimate_master_plan_load draft failed user=%s errors=%s",
            user_id,
            load_tool_result.errors,
        )

    out = {
        "current_draft": plan.model_dump(mode="json"),
        "timing_metadata": {
            **prompt_chars,
            "generator_max_tokens": master_max_tokens,
            "generator_raw_response_chars": raw_response_chars,
        },
    }
    if load_estimate is not None:
        out["master_plan_load_estimate"] = load_estimate
    return out


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
