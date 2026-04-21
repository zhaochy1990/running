"""Overall training plan markdown + phase timeline."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from stride_core.db import USER_DATA_DIR

from ..deps import PROJECT_ROOT

router = APIRouter()


@router.get("/api/{user}/training-plan")
def get_training_plan(user: str):
    """Return the overall training plan markdown and parsed phase timeline."""
    plan_path = USER_DATA_DIR / user / "TRAINING_PLAN.md"
    if not plan_path.exists():
        plan_path = PROJECT_ROOT / "TRAINING_PLAN.md"
    if not plan_path.exists():
        return {"content": None, "phases": [], "current_phase": None}

    with open(plan_path, "r", encoding="utf-8") as f:
        content = f.read()

    phases: list[dict] = []
    today = date.today()
    current_phase = None

    # Hard-coded phase definitions matching training plan structure
    # (more reliable than regex parsing of complex markdown tables)
    PHASE_DEFS = [
        ("第0周", 2026, 4, 20, 4, 26),
        ("Phase 1：基础期", 2026, 4, 27, 6, 21),
        ("Phase 2：专项期", 2026, 6, 22, 8, 16),
        ("Phase 3：马拉松期", 2026, 8, 17, 10, 25),
        ("Phase 4：减量期", 2026, 10, 26, 11, 15),
        ("比赛窗口", 2026, 11, 15, 11, 16),
    ]

    for name, y, sm, sd, em, ed in PHASE_DEFS:
        start_date = date(y, sm, sd)
        end_date = date(y, em, ed)
        phases.append({"name": name, "start": str(start_date), "end": str(end_date)})
        if start_date <= today <= end_date:
            current_phase = name

    if not current_phase and phases:
        first_start = date.fromisoformat(phases[0]["start"])
        if today < first_start:
            current_phase = "赛后恢复"

    return {"content": content, "phases": phases, "current_phase": current_phase}
