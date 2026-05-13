"""Semantic validators for ``WeeklyPlan`` instances parsed from markdown."""

from __future__ import annotations

from stride_core.plan_spec import PlannedNutrition, WeeklyPlan


def validate_nutrition_macros(plan: WeeklyPlan) -> WeeklyPlan:
    """Annotate any PlannedNutrition where meals.kcal totals deviate >10% from
    kcal_target. The row is *not* dropped; structured_status still reflects
    schema validation only.
    """
    if not plan.nutrition:
        return plan
    new_nutrition = []
    changed = False
    for n in plan.nutrition:
        if n.kcal_target is None or not n.meals:
            new_nutrition.append(n)
            continue
        meal_kcals = [m.kcal for m in n.meals if m.kcal is not None]
        if not meal_kcals:
            new_nutrition.append(n)
            continue
        total = sum(meal_kcals)
        target = max(n.kcal_target, 1.0)
        if abs(total - n.kcal_target) / target > 0.10:
            warning = (
                f"[parse_warning] meals 总和 {total:.0f} kcal 与 daily "
                f"kcal_target {n.kcal_target:.0f} 偏离 >10%"
            )
            existing = (n.notes_md or "").rstrip()
            new_notes = f"{existing}\n{warning}".strip() if existing else warning
            new_nutrition.append(
                PlannedNutrition(
                    date=n.date,
                    kcal_target=n.kcal_target,
                    carbs_g=n.carbs_g,
                    protein_g=n.protein_g,
                    fat_g=n.fat_g,
                    water_ml=n.water_ml,
                    meals=n.meals,
                    notes_md=new_notes,
                )
            )
            changed = True
        else:
            new_nutrition.append(n)
    if not changed:
        return plan
    return WeeklyPlan(
        week_folder=plan.week_folder,
        sessions=plan.sessions,
        nutrition=tuple(new_nutrition),
        notes_md=plan.notes_md,
    )


def validate_session_dates(
    plan: WeeklyPlan, folder: str | None,
) -> str | None:
    """Reject plans whose session dates fall outside the week's date range.

    Why: the LLM occasionally hallucinates dates from outside the week (e.g.
    placing a session in next week's Sunday); without this guard, a prompt
    injection could also coerce sessions onto far-future dates and starve
    the calendar UI. Returns ``None`` if all dates are within bounds, or a
    human-readable reason on the first violation.

    When ``folder`` is ``None`` or unparseable we skip the check — same
    failure-tolerant posture as ``parse_week_dates`` callers elsewhere.
    """
    if not folder:
        return None
    # Lazy import: stride_server.__init__ eagerly loads the FastAPI app which
    # pulls in routes.plan → plan_parser, so a top-level import here creates a
    # cycle. The function-local form is initialized once per first call.
    from stride_server.deps import parse_week_dates
    bounds = parse_week_dates(folder)
    if bounds is None:
        return None
    d_from, d_to = bounds
    for s in plan.sessions:
        if not (d_from <= s.date <= d_to):
            return (
                f"session date {s.date!r} outside week {folder!r} "
                f"({d_from} .. {d_to})"
            )
    return None
