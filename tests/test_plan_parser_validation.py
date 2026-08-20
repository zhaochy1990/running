from stride_core.plan_spec import Meal, PlannedNutrition, WeeklyPlan
from plan_parser.validation import validate_nutrition_macros


def test_nutrition_validation_preserves_coach_notes() -> None:
    plan = WeeklyPlan(
        week_folder="2026-07-13_07-19",
        coach_notes="summary note",
        nutrition=(
            PlannedNutrition(
                date="2026-07-13",
                kcal_target=2000,
                meals=(Meal(name="meal", kcal=100),),
            ),
        ),
    )

    updated = validate_nutrition_macros(plan)

    assert updated.coach_notes == "summary note"
