#!/usr/bin/env python3
"""Generate a FULL SEASON (every phase → weekly plans) locally from your own data.

Drives the Stage-3b season orchestrator DIRECTLY (no job_runner) against
``data/{USER_ID}/coros.db``. It takes a confirmed MasterPlan (phases +
milestones) and, per phase, runs:

    derive_phase_weeks (deterministic volume ramp)
      → generate_phase_weeks (Stage-3a per-phase specialist, real per-week graph
        + run_rule_filter, real strength_library / recent_training tools)
      → review_phase (per-phase doctrine reviewer, reviewer-role LLM)

then validates the whole season with run_season_rule_filter and assembles a
SeasonPlanBundle. Bounded regeneration; never crashes.

Input MasterPlan
----------------
By default this loads ``data/{USER_ID}/master_plan_draft.json`` (produced by
``scripts/gen_my_master_plan.py``). Regenerate that first if you want a fresh
plan, or point MASTER_PLAN_PATH elsewhere.

Prerequisites
-------------
1. Sync the DB so history is fresh::

       $env:PYTHONIOENCODING="utf-8"; python -m coros_sync -P zhaochaoyi sync

2. Azure login (generator + reviewer are azureai; auth chains
   AzureCliCredential → DefaultAzureCredential)::

       az login

   Config comes from config/coach.local.toml (checked in) automatically.

Run
---
    $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_season.py

    # verbose orchestrator logs (phase regen, season-rule rounds)
    $env:COACH_DEBUG="1"; $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_season.py

Output
------
A human-readable per-phase / per-week summary to stdout, plus the full
SeasonPlanBundle JSON written to ``data/{USER_ID}/season_bundle_draft.json``.
Nothing is persisted to any store and no job row is created.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from coach.graphs.generation.rule_filter import _total_run_distance_m
from stride_core.db import Database
from stride_core.master_plan import MasterPlan
from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import today_shanghai
from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
from stride_server.coach_adapters.season_orchestrator import generate_season
from stride_server.master_plan_generator import _normalize_for_prompt

# ---------------------------------------------------------------------------
# EDIT ME — your athlete id + the master plan to expand
# ---------------------------------------------------------------------------

USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

# Same goal you used to generate the master plan (drives MP / continuity).
GOAL = {
    "goal_id": "my-2026-fall",
    "race_distance": "FM",
    "target_finish_time": "2:50:00",
    "race_date": "2026-10-18",
    "weekly_training_days": 5,
}
PROFILE: dict | None = None

# Injury flags routed to every phase's generator + reviewer (e.g. ["achilles"]).
INJURIES: list[str] = []

MASTER_PLAN_PATH = _REPO_ROOT / "data" / USER_ID / "master_plan_draft.json"
OUTPUT_PATH = _REPO_ROOT / "data" / USER_ID / "testing" / "season_bundle_draft.json"

DEBUG = os.environ.get("COACH_DEBUG") == "1"
DEBUG = True


def _fmt_pace(km: float, secs: float | None) -> str:
    if not km or not secs:
        return ""
    p = secs / km
    return f"{int(p // 60)}:{int(p % 60):02d}/km"


def _week_km(week: dict) -> float:
    try:
        return _total_run_distance_m(WeeklyPlan.from_dict(week)) / 1000.0
    except Exception:  # noqa: BLE001
        return 0.0


def _print_summary(bundle, master_plan: MasterPlan) -> None:
    phase_band = {p.id: (p.weekly_distance_km_low, p.weekly_distance_km_high) for p in master_plan.phases}
    print("\n" + "=" * 72)
    print(f"SEASON BUNDLE — {len(bundle.phases)} phases · generated_by={bundle.generated_by}")
    print("=" * 72)
    total_weeks = 0
    for pw in bundle.phases:
        lo, hi = phase_band.get(pw.phase_id, (None, None))
        band = f"band [{lo:.0f}-{hi:.0f}]" if lo is not None else ""
        verdict = pw.review.verdict if pw.review else "—"
        kms = [_week_km(w) for w in pw.weeks]
        in_band = any(lo is not None and lo <= k <= hi for k in kms) if kms else False
        print(
            f"\n■ {pw.phase_type}  {band}  "
            f"weeks={len(pw.weeks)}  blocked={pw.blocked_week_count}  "
            f"review={verdict}  {'✓in-band' if in_band else '✗below-band' if kms else ''}"
        )
        if pw.review and pw.review.commentary_md:
            print(f"  review: {pw.review.commentary_md.strip()[:160]}")
        total_weeks += len(pw.weeks)
        for w in pw.weeks:
            km = _week_km(w)
            sessions = sorted(
                (s for s in (w.get("sessions") or [])),
                key=lambda s: (s.get("date") or "", s.get("session_index") or 0),
            )
            keys = [
                (s.get("summary") or "").strip()
                for s in sessions
                if s.get("kind") == "run" and (s.get("total_distance_m") or 0)
            ]
            head = " | ".join(k[:34] for k in keys[:3])
            print(f"    {w.get('week_folder','?'):<22} {km:5.1f}km  {head}")
    print("\n" + "-" * 72)
    print(f"TOTAL: {total_weeks} weeks across {len(bundle.phases)} phases")
    print("-" * 72)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO if DEBUG else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
        force=True,
    )

    if not MASTER_PLAN_PATH.exists():
        print(
            f"ERROR: no master plan at {MASTER_PLAN_PATH}\n"
            f"Run `python scripts/gen_my_master_plan.py` first.",
            file=sys.stderr,
        )
        return 2

    raw = json.loads(MASTER_PLAN_PATH.read_text(encoding="utf-8"))
    master_plan = MasterPlan.model_validate(raw)
    print(
        f"Loaded master plan {master_plan.plan_id} — "
        f"{len(master_plan.phases)} phases, {len(master_plan.milestones)} milestones "
        f"({master_plan.start_date} → {master_plan.end_date})"
    )

    goal, profile = _normalize_for_prompt(GOAL, PROFILE)

    db = Database(user=USER_ID)
    continuity = analyze_continuity(db, goal=goal, profile=profile, as_of=today_shanghai())
    level = continuity.current_chronic_load
    if not level:
        level = 50.0
        print("WARN: no chronic load in continuity — falling back to level=50.0")
    print(
        f"Athlete context — level(CTL)={level:.1f} · "
        f"form_zone={continuity.current_form_zone} · "
        f"macro={continuity.macro_cycle} · injuries={INJURIES or '—'}"
    )

    context = {
        "user_id": USER_ID,
        "goal": goal,
        "level": float(level),
        "continuity": continuity.model_dump(),
    }

    print("\nGenerating season (this calls the real generator + reviewer LLMs per phase)...")
    bundle = generate_season(master_plan, context, injuries=INJURIES)

    _print_summary(bundle, master_plan)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(bundle.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nFull bundle written to {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
