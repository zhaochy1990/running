"""Golden fixtures shared with the TypeScript structured-load estimator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from stride_core.training_load.core import estimate_planned_run_load_details
from stride_core.workout_spec import NormalizedRunWorkout


FIXTURE_PATH = (
    Path(__file__).parents[3]
    / "src/coach_agent/src/graph/master_plan/structuredLoadFixtures.json"
)


def test_shared_structured_load_fixtures_are_python_oracle_outputs():
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    for case in fixture["cases"]:
        estimate = estimate_planned_run_load_details(
            NormalizedRunWorkout.from_dict(case["workout_structure"]),
            threshold_speed_mps=fixture["threshold_speed_mps"],
            threshold_hr=fixture["threshold_hr"],
            rhr=fixture["rhr"],
        )
        expected = case["expected"]
        assert estimate.low_dose == pytest.approx(expected["low_dose"], abs=1e-4)
        assert estimate.expected_dose == pytest.approx(
            expected["expected_dose"], abs=1e-4
        )
        assert estimate.high_dose == pytest.approx(expected["high_dose"], abs=1e-4)
        assert estimate.estimated_distance_km == pytest.approx(
            expected["estimated_distance_km"], abs=1e-4
        )
        assert estimate.estimated_duration_minutes == pytest.approx(
            expected["estimated_duration_minutes"], abs=1e-4
        )
        assert estimate.unestimated_steps == expected["unestimated_steps"]
