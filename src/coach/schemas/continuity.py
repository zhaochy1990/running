"""Deterministic continuity signals (Stage-0 context) — see spec §4.

Produced by the adapter-layer continuity_analyzer from structured DB +
running_profile; consumed by the structure_planner. Pure pydantic so it stays
import-linter clean in coach core.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ContinuitySignals(BaseModel):
    days_since_last_race: int | None = None
    post_race_recovery_status: Literal["recovering", "recovered", "no_recent_race"] = "no_recent_race"
    recent_aerobic_weeks: int = 0
    recent_volume_trend: Literal["rising", "flat", "falling", "unknown"] = "unknown"
    recent_longest_run_km: float | None = None
    recent_quality_sessions_per_week: float = 0.0
    current_form_zone: str | None = None
    current_chronic_load: float | None = None
    return_from_layoff: bool = False
    macro_cycle: Literal["summer", "winter", "unknown"] = "unknown"
    season_context: str = ""
    injuries: list[str] = []
