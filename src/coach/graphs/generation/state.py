"""Generation pipeline state — see plan §7.2."""

from __future__ import annotations

from typing import Literal, TypedDict

from coach.schemas import ReviewReport


class GenState(TypedDict, total=False):
    job_id: str
    user_id: str
    plan_type: Literal["master", "week", "commentary", "weekly_review"]
    input_payload: dict
    runtime_options: dict
    context: dict
    current_draft: dict | None
    master_plan_load_estimate: dict | None
    rule_violations: list[dict]
    review_history: list[ReviewReport]
    iteration: int
    timings: dict
    max_iterations: int
    final_verdict: Literal["pass", "auto_fix", "revise", "block"] | None
    final_artifact: dict | None
