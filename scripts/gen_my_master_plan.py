#!/usr/bin/env python3
"""Generate a master plan (赛季备战总纲) locally from your own coros.db.

Invokes the coach generation graph DIRECTLY (no job_runner) against
``data/{user_id}/coros.db``. The graph runs
``load_context → generator → rule_filter → reviewer → verdict``: it queries
your 36-month running history + latest fitness state (CTL/ATL/TSB) and asks
gpt-5.5 to produce a MasterPlan, then validates it against the 10 S1 L1
safety rules.

Prerequisites
-------------
1. Sync the DB so history is fresh::

       $env:PYTHONIOENCODING="utf-8"; python -m coros_sync -P zhaochaoyi sync

2. Azure login (generator is gpt-5.5 @ azureai4identity; auth chains
   AzureCliCredential → DefaultAzureCredential)::

       az login

   Config comes from config/coach.local.toml (checked in) automatically.

Run
---
    # normal (quiet)
    $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_master_plan.py

    # debug: node transitions + every LLM prompt/response + raw HTTP
    $env:COACH_DEBUG="1"; $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_master_plan.py

Output
------
Each draft MasterPlan is written to ``data/{user_id}/master_plan_draft.json``
for inspection. Nothing is persisted to the master-plan store and no job row
is created — this is a pure agent invocation.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

# Allow running as `python scripts/gen_my_master_plan.py` (no -m): inject src/.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from langchain_core.callbacks import BaseCallbackHandler
from coach.graphs.generation.graph import build_generation_graph
from coach.graphs.generation.master_rule_filter import run_master_rule_filter
from coach.graphs.generation.state import GenState
from stride_core.master_plan import MasterPlan
from stride_core.timefmt import SHANGHAI_TZ
from stride_server.coach_adapters.master_plan_adapter import (
    apply_master_patches,
    generate_master_plan,
    load_master_context,
    master_reviewer,
)
from stride_server.llm_client import LLMError, LLMUnavailable
from stride_server.master_plan_generator import _normalize_for_prompt


# ---------------------------------------------------------------------------
# EDIT ME — users + season goals
# ---------------------------------------------------------------------------

# Each user entry needs its own goal. Do not copy a race target across athletes
# unless that is intentionally the same target for that athlete.
#
# Local runs accept the friendly slug; strict/prod paths use the JWT `sub` UUID.
# Goal field names match routes/training_goal.py::TrainingGoal — the generator
# normalises target_finish_time / race_distance internally, so keep these exact
# key names.
#
# Optional profile: leave as None to let the generator infer ability from
# coros.db history + race_predictions. Provide a dict to override, e.g.:
#   "profile": {
#       "pbs": [{"distance": "FM", "time": "3:40:00"},
#               {"distance": "HM", "time": "1:45:00"}],
#       "weekly_training_days": 5,
#   }
users: list[dict[str, Any]] = [
    {
        "user_id": "f10bc353-01ab-4db1-af9f-d9305ea9a532",
        "goal": {
            "goal_id": "my-2026-fall",        # stable source training-goal id; stored in plan.goal.goal_id
            "race_distance": "FM",            # one of: 5K | 10K | HM | FM | trail
            "target_finish_time": "2:50:00",  # "H:MM:SS"; set to None for finish-only
            "race_date": "2026-10-18",        # YYYY-MM-DD; plan end_date won't exceed this
            "weekly_training_days": 5,        # max run days/week — caps key-session density
        },
        "profile": None,
        # Optional per-user output override. Defaults to
        # data/{user_id}/master_plan_draft.json.
        # "master_plan_out": "data/f10bc353-01ab-4db1-af9f-d9305ea9a532/master_plan_draft.json",
    },
]


# ---------------------------------------------------------------------------
# Debug / tracing — set COACH_DEBUG=1 to turn on (default off)
# ---------------------------------------------------------------------------

DEBUG = os.environ.get("COACH_DEBUG") == "1"
logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"Ignoring invalid {name}={raw!r}; using {default}")
        return default


MAX_WORKERS = max(1, _env_int("MASTER_PLAN_MAX_WORKERS", 2))

class _LLMTap(BaseCallbackHandler):
    """Clean framed view of each LLM request + response as the graph runs."""

    def on_chat_model_start(self, serialized, messages, **kwargs):  # noqa: ANN001
        print("\n========== LLM REQUEST ==========", flush=True)
        for msg in messages[0]:
            print(f"--- [{msg.type}] ---\n{msg.content}\n", flush=True)

    def on_llm_end(self, response, **kwargs):  # noqa: ANN001
        gen = response.generations[0][0]
        text = getattr(gen, "text", "") or getattr(getattr(gen, "message", None), "content", "")
        print("========== LLM RESPONSE ==========", flush=True)
        print(text, flush=True)
        usage = (response.llm_output or {}).get("token_usage") if response.llm_output else None
        if usage:
            print(f"---------- token_usage: {usage} ----------", flush=True)

    def on_llm_error(self, error, **kwargs):  # noqa: ANN001
        print(f"========== LLM ERROR ==========\n{error!r}", flush=True)


def _enable_debug() -> list:
    """Wire up verbose tracing. Returns callbacks to pass to graph.invoke/stream.

    Three independent levers so at least one always produces output regardless
    of langchain/langgraph version quirks:

    * ``logging`` (force=True) — DEBUG on httpx/openai shows the raw HTTP POST
      to Azure OpenAI; on coach/stride_server shows the adapter's own debug
      lines. ``force=True`` is essential: basicConfig is a NO-OP if the root
      logger was already configured (azure SDK / langchain often do), which is
      the usual reason "I enabled logging but see nothing".
    * ``set_debug(True)`` — global flag the callback manager always consults,
      so every LLM ``.invoke()`` prints even if config propagation is flaky.
    * ``_LLMTap`` — clean framed request/response, attached at graph level.
    """
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        force=True,
    )
    # Quiet the loggers we don't care about; keep the ones that matter at DEBUG.
    logging.getLogger("azure").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    for name in ("coach", "stride_server", "httpx", "openai", "httpcore"):
        logging.getLogger(name).setLevel(logging.DEBUG)

    from langchain_core.globals import set_debug
    set_debug(True)  # global ConsoleCallbackHandler — most reliable LLM dump

    return [_LLMTap()]


def _build_rule_filter_kwargs(goal: dict, profile: dict | None) -> dict:
    """Mirror routes' rfk construction so input-aware L1 rules actually fire.

    season_window_fits is fixture-only (eval framework); prod/local trusts
    goal.race_date as the implicit upper bound, so we omit it here.
    """
    norm_goal, norm_profile = _normalize_for_prompt(goal, profile)
    rfk: dict = {
        "target_race": {
            "distance": norm_goal.get("distance"),
            "goal_time_s": norm_goal.get("goal_time_s"),
            "race_date": norm_goal.get("race_date"),
        },
    }
    if norm_profile and norm_profile.get("prs"):
        rfk["prs"] = norm_profile["prs"]
    if norm_profile and norm_profile.get("weekly_run_days_max") is not None:
        rfk["weekly_run_days_max"] = norm_profile["weekly_run_days_max"]
    return rfk


def _output_path_for_user(user_id: str, user_config: dict[str, Any]) -> Path:
    """Resolve the draft output path for a user.

    Per-user ``master_plan_out`` wins. ``MASTER_PLAN_OUT`` is kept for backward
    compatibility with one-user model sweeps; it is rejected for multi-user runs
    in ``main`` to avoid every user clobbering the same file.
    """
    configured = user_config.get("master_plan_out") or os.environ.get("MASTER_PLAN_OUT")
    if configured:
        return Path(str(configured)).resolve()
    return _REPO_ROOT / "data" / user_id / "master_plan_draft.json"


def _generate_for_user(user_config: dict[str, Any], *, callbacks: list) -> int:
    user_id = str(user_config["user_id"])
    goal = user_config["goal"]
    profile = user_config.get("profile")

    print(f"Generating master plan for user={user_id!r} ...")
    print(f"  goal: {json.dumps(goal, ensure_ascii=False)}\n------------------------------")
    

    config: dict | None = {"callbacks": callbacks} if callbacks else None
    # Empty job_id → the adapter's `if job_id:` stage-update calls are skipped,
    # so no job_runner row is created or mutated.
    state: dict = {
        "job_id": "",
        "user_id": user_id,
        "plan_type": "master",
        "input_payload": {"goal": goal, "profile": profile},
    }
    _t0 = time.perf_counter()
    print(f"[gen] starting generation graph at {datetime.now(tz=SHANGHAI_TZ).isoformat(timespec='seconds')}", flush=True)
    
    ctx = load_master_context(state)
    _t1 = time.perf_counter()
    print(f"[gen] loaded context in {_t1 - _t0:.1f}s", flush=True)
    fitness_state = ctx.get("fitness_state") or {}
    logger.info(
        "[gen] loaded context keys=%s, history_summary=%d chars, "
        "CTL=%s, ATL=%s, TSB=%s",
        sorted(ctx.keys()),
        len(ctx.get("history_summary") or ""),
        fitness_state.get("ctl"),
        fitness_state.get("atl"),
        fitness_state.get("tsb"),
    )
    print(f"{json.dumps(ctx, ensure_ascii=False, indent=2)}", flush=True)
    # return 0
    
    # state["context"] = ctx
    # master_plan = generate_master_plan(state)
    # _t2 = time.perf_counter()
    # print(f"[gen] generated master plan in {_t2 - _t1:.1f}s", flush=True)
    # print(f"[gen] master plan draft: {json.dumps(master_plan, ensure_ascii=False, indent=2)}", flush=True)
    # return 0  # early exit to skip the graph and rule filter for now

    graph = build_generation_graph(
        load_context=load_master_context,
        generator=generate_master_plan,
        reviewer=master_reviewer,
        apply_patches=apply_master_patches,
        rule_filter=run_master_rule_filter,
        rule_filter_kwargs=_build_rule_filter_kwargs(goal, profile),
    )

    try:
        print("Invoking generation graph ...")
        if DEBUG:
            # stream_mode=["updates","values"] yields (mode, chunk) tuples:
            # "updates" = per-node delta (shows node execution order),
            # "values"  = full accumulated state (last one = final_state).
            final_state: dict = {}
            for mode, chunk in graph.stream(
                state, stream_mode=["updates", "values"], config=config
            ):
                if mode == "updates":
                    for node, delta in (chunk or {}).items():
                        keys = list((delta or {}).keys())
                        print(f"\n>>> node `{node}` → updated {keys}", flush=True)
                else:  # values
                    final_state = chunk
        else:
            final_state = graph.invoke(state)
        
        _t3 = time.perf_counter()
        logger.info(f"[gen] generation graph completed in {_t3 - _t0:.1f}s")
    except LLMUnavailable as exc:
        print(f"\n  LLM unavailable: {exc}")
        print("  → run `az login`; check config/coach.local.toml")
        return 1
    except LLMError as exc:
        print(f"\n  LLM error (retryable={getattr(exc, 'retryable', '?')}): {exc}")
        return 1
    except ValueError as exc:
        # generate_master_plan raises "parse_failed: ..." or "bad_schema: ..."
        print(f"\n  Generation failed: {exc}")
        raw = getattr(exc, "raw_output", None)
        if raw:
            print(f"  raw (head): {raw[:500]}")
        return 1

    verdict = final_state.get("final_verdict")
    logger.info(f"[gen] final verdict: {verdict}")
    if verdict == "block":
        violations = final_state.get("rule_violations") or []
        print("\n  verdict=block — L1 safety rules rejected the draft:")
        for v in violations:
            print(f"    - {v.get('rule', '?')} ({v.get('severity', '?')}): "
                  f"{v.get('message', '')}")
        return 1

    parsed = final_state.get("final_artifact")
    if not isinstance(parsed, dict):
        print("\n  No final_artifact in graph state — nothing generated.")
        return 1

    # Round-trip validate + reconstruct the typed instance (safety net).
    plan = MasterPlan.model_validate(parsed)

    out_path = _output_path_for_user(user_id, user_config)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(plan.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        _shown = out_path.relative_to(_REPO_ROOT)
    except ValueError:
        _shown = out_path
    print(f"\n  verdict: {verdict}")
    print(f"  generated_by: {plan.generated_by}")
    print(f"  Wrote draft → {_shown}")
    print(f"  {plan.start_date} ~ {plan.end_date} | "
          f"{len(plan.phases)} phases, {len(plan.milestones)} milestones, "
          f"{len(plan.weekly_key_sessions)} weekly skeletons")
    for ph in plan.phases:
        print(f"    [{ph.name}] {ph.start_date}~{ph.end_date}  "
              f"{ph.weekly_distance_km_low}-{ph.weekly_distance_km_high} km/wk")
    return 0


def _run_user_config(user_config: dict[str, Any], *, callbacks: list) -> tuple[str, int]:
    """Run one configured user and normalize expected/unexpected failures."""
    user_label = str(user_config.get("user_id") or "unknown")
    try:
        return user_label, _generate_for_user(user_config, callbacks=callbacks)
    except KeyError as exc:
        print(f"\n  Bad users entry for {user_label}: missing key {exc!s}")
        return user_label, 1
    except Exception as exc:
        print(f"\n  Unexpected error for {user_label}: {type(exc).__name__}: {exc}")
        logger.exception("master-plan generation failed for %s", user_label)
        return user_label, 1


def main() -> int:
    if not users:
        print("No users configured. Add entries to the users list.")
        return 1

    if len(users) > 1 and os.environ.get("MASTER_PLAN_OUT"):
        print("MASTER_PLAN_OUT cannot be used with multiple users; set per-user master_plan_out instead.")
        return 1

    failures: list[str] = []

    # Debug tracing is intentionally serial: LangChain's global debug flag and
    # prompt/response dumps are process-wide, so parallel debug output becomes
    # unreadable and can interleave one athlete's prompts with another's.
    if DEBUG or MAX_WORKERS == 1 or len(users) == 1:
        callbacks = _enable_debug() if DEBUG else []
        for index, user_config in enumerate(users, start=1):
            print(f"\n========== USER {index}/{len(users)} ==========")
            user_label, rc = _run_user_config(user_config, callbacks=callbacks)
            if rc != 0:
                failures.append(user_label)
    else:
        worker_count = min(MAX_WORKERS, len(users))
        print(f"Running {len(users)} user(s) with max_workers={worker_count}")
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            future_to_index = {
                pool.submit(_run_user_config, user_config, callbacks=[]): index
                for index, user_config in enumerate(users, start=1)
            }
            for future in as_completed(future_to_index):
                index = future_to_index[future]
                try:
                    user_label, rc = future.result()
                except Exception as exc:
                    user_label = f"index={index}"
                    print(f"\n  Unexpected worker error for {user_label}: {type(exc).__name__}: {exc}")
                    logger.exception("master-plan worker failed for %s", user_label)
                    rc = 1
                if rc != 0:
                    failures.append(user_label)

    if failures:
        print(f"\nCompleted with {len(failures)} failure(s): {', '.join(failures)}")
        return 1

    print(f"\nCompleted successfully for {len(users)} user(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
