"""Deterministic current-phase context (S1 pre-generation) — see
docs/superpowers/plans/2026-06-16-coach-current-phase-detector.md.

Produced by the adapter-layer ``phase_detector`` BEFORE master-plan generation;
consumed by the planner prompt as an **authoritative** input. It answers two
questions the planner must not have to infer from raw signals:

* which training phase is the athlete *currently* in, and
* from which phase should the NEW plan begin (``recommended_entry_phase``),

so the periodization is designed **forward from the current position to race
day** — completed leading phases (e.g. a finished base block) are never
re-prescribed.

Pure pydantic so it stays import-linter clean in coach core (only depends on
``stride_core.master_plan`` for ``PhaseType``, which is allowed).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from stride_core.master_plan import PhaseType


class CurrentPhaseContext(BaseModel):
    """Where the athlete is in their periodization, computed deterministically.

    ``source`` records how it was derived:
    * ``existing_plan`` — read from the athlete's active master plan (the phase
      whose [start, end] contains today + weeks elapsed). Fully deterministic.
    * ``inferred`` — no prior plan; classified from recent activities by a
      deterministic heuristic cross-validated against an LLM analysis
      (deterministic wins on disagreement; see ``method_agreement`` / ``rationale``).
    * ``unknown`` — neither path produced a usable result (degrade: the planner
      falls back to its own judgement).
    """

    source: Literal["existing_plan", "inferred", "unknown"] = "unknown"

    # The phase the athlete is functionally in NOW (None when undeterminable).
    current_phase_type: PhaseType | None = None
    # Weeks already spent in ``current_phase_type`` (best-effort for inferred).
    weeks_in_phase: int | None = None
    # Recent aerobic-base evidence (passthrough of ContinuitySignals field) —
    # how many recent weeks cleared the aerobic-volume bar. Drives "base done?".
    completed_aerobic_weeks: int = 0

    # Where the NEW plan should BEGIN. Equals ``current_phase_type`` when the
    # athlete is mid-phase, or the NEXT phase when the current one is judged
    # complete (e.g. base done → entry = speed). The planner must start here.
    recommended_entry_phase: PhaseType | None = None

    confidence: Literal["high", "medium", "low"] = "low"
    # inferred case only: did the deterministic heuristic and the LLM agree?
    # None for existing_plan / unknown (no cross-validation performed).
    method_agreement: bool | None = None
    # Human-readable derivation note; includes any deterministic-vs-LLM divergence.
    rationale: str = ""
