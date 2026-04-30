"""Translate stride_core.NormalizedRunWorkout → Garmin Workout API payload.

Reverse-engineered from `garminconnect.Garmin.get_workout_by_id()` response
on the friend's account (see evaluation/garmin/SUMMARY.md §3.7.1). The
shape Garmin's upload_running_workout endpoint expects is:

    {
      workoutName, sportType, subSportType,
      estimatedDurationInSecs, estimatedDistanceInMeters,
      workoutSegments: [{
        segmentOrder: 1,
        sportType: {...},
        workoutSteps: [
          # repeat group:
          {type: "RepeatGroupDTO", stepOrder, stepType: {key:"repeat"},
           numberOfIterations: N, workoutSteps: [...]},
          # executable step:
          {type: "ExecutableStepDTO", stepOrder, stepType: {...},
           endCondition: {key:"time"|"distance"|"lap.button"},
           endConditionValue: float,
           preferredEndConditionUnit: {key:"meter"|"kilometer"|...},
           targetType: {key:"no.target"|"pace.zone"|"heart.rate.zone"|...},
           targetValueOne: float, targetValueTwo: float},
        ],
      }]
    }

Critical unit gotcha: Garmin's pace.zone target values are stored as **m/s**
(not s/km). For Target(PACE_S_KM, low=slow, high=fast):
  targetValueOne = 1000/slow  (slower bound = smaller m/s)
  targetValueTwo = 1000/fast  (faster bound = larger m/s)
"""

from __future__ import annotations

from typing import Any

from stride_core.workout_spec import (
    DurationKind,
    NormalizedRunWorkout,
    StepKind,
    TargetKind,
    WorkoutBlock,
    WorkoutStep,
)


_RUN_SPORT_TYPE = {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}


# StepKind → Garmin stepType
_STEP_TYPE_BY_KIND: dict[StepKind, dict[str, Any]] = {
    StepKind.WARMUP:   {"stepTypeId": 1, "stepTypeKey": "warmup",   "displayOrder": 1},
    StepKind.COOLDOWN: {"stepTypeId": 2, "stepTypeKey": "cooldown", "displayOrder": 2},
    StepKind.WORK:     {"stepTypeId": 3, "stepTypeKey": "interval", "displayOrder": 3},
    StepKind.RECOVERY: {"stepTypeId": 4, "stepTypeKey": "recovery", "displayOrder": 4},
    StepKind.REST:     {"stepTypeId": 5, "stepTypeKey": "rest",     "displayOrder": 5},
}

_REPEAT_STEP_TYPE = {"stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6}


def _end_condition(step: WorkoutStep) -> tuple[dict[str, Any], float | None, dict[str, Any] | None]:
    """Return `(endCondition, endConditionValue, preferredEndConditionUnit)`."""
    d = step.duration
    if d.kind == DurationKind.TIME_S and d.value is not None:
        return (
            {"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2, "displayable": True},
            float(d.value),
            None,
        )
    if d.kind == DurationKind.DISTANCE_M and d.value is not None:
        return (
            {"conditionTypeId": 3, "conditionTypeKey": "distance", "displayOrder": 3, "displayable": True},
            float(d.value),
            {"unitId": 1, "unitKey": "meter", "factor": 100.0},
        )
    # OPEN — user presses lap button to end the step manually.
    return (
        {"conditionTypeId": 1, "conditionTypeKey": "lap.button", "displayOrder": 1, "displayable": True},
        None,
        None,
    )


def _target_block(step: WorkoutStep) -> dict[str, Any]:
    """Return the targetType + targetValueOne/Two slice of the executable step."""
    t = step.target
    if t.kind == TargetKind.PACE_S_KM and t.low is not None and t.high is not None:
        # NormalizedRunWorkout: low = slower s/km (larger), high = faster (smaller)
        # Garmin pace.zone: stored as m/s. Slower = smaller m/s, faster = larger m/s.
        return {
            "targetType": {"workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone", "displayOrder": 6},
            "targetValueOne": 1000.0 / float(t.low),    # slower bound, smaller m/s
            "targetValueTwo": 1000.0 / float(t.high),   # faster bound, larger m/s
            "targetValueUnit": None,
            "zoneNumber": None,
        }
    if t.kind == TargetKind.HR_BPM and t.low is not None and t.high is not None:
        return {
            "targetType": {"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone", "displayOrder": 4},
            "targetValueOne": float(t.low),
            "targetValueTwo": float(t.high),
            "targetValueUnit": None,
            "zoneNumber": None,
        }
    if t.kind == TargetKind.POWER_W and t.low is not None and t.high is not None:
        return {
            "targetType": {"workoutTargetTypeId": 2, "workoutTargetTypeKey": "power.zone", "displayOrder": 2},
            "targetValueOne": float(t.low),
            "targetValueTwo": float(t.high),
            "targetValueUnit": None,
            "zoneNumber": None,
        }
    # OPEN — no target.
    return {
        "targetType": {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1},
        "targetValueOne": None,
        "targetValueTwo": None,
        "targetValueUnit": None,
        "zoneNumber": None,
    }


def _executable_step(step: WorkoutStep, step_order: int) -> dict[str, Any]:
    end_cond, end_value, end_unit = _end_condition(step)
    payload: dict[str, Any] = {
        "type": "ExecutableStepDTO",
        "stepOrder": step_order,
        "stepType": _STEP_TYPE_BY_KIND[step.step_kind],
        "childStepId": 1,
        "description": step.note or "",
        "endCondition": end_cond,
        "endConditionValue": end_value,
        "preferredEndConditionUnit": end_unit,
    }
    payload.update(_target_block(step))
    return payload


def _repeat_block(block: WorkoutBlock, step_order: int, base_child_step_id: int) -> dict[str, Any]:
    nested: list[dict[str, Any]] = []
    for i, step in enumerate(block.steps, start=1):
        child = _executable_step(step, step_order + i)
        child["childStepId"] = base_child_step_id
        nested.append(child)
    return {
        "type": "RepeatGroupDTO",
        "stepOrder": step_order,
        "stepType": _REPEAT_STEP_TYPE,
        "childStepId": base_child_step_id,
        "numberOfIterations": block.repeat,
        "workoutSteps": nested,
    }


def _build_steps(workout: NormalizedRunWorkout) -> list[dict[str, Any]]:
    """Flatten blocks → workoutSteps; one RepeatGroupDTO per repeat>1 block."""
    out: list[dict[str, Any]] = []
    step_order = 0
    child_step_id = 0
    for block in workout.blocks:
        step_order += 1
        if block.repeat > 1:
            child_step_id += 1
            group = _repeat_block(block, step_order, child_step_id)
            out.append(group)
            # The nested executables consume their own stepOrder slots; bump.
            step_order += len(block.steps)
        else:
            for step in block.steps:
                out.append(_executable_step(step, step_order))
                step_order += 1
            step_order -= 1  # we incremented once at top of loop already
    return out


def _estimate_duration_seconds(workout: NormalizedRunWorkout) -> int:
    """Best-effort total duration estimate (Garmin uses this for the workout
    summary — exact match isn't required, the watch recomputes on push)."""
    total = 0.0
    for block in workout.blocks:
        for step in block.steps:
            d = step.duration
            if d.kind == DurationKind.TIME_S and d.value is not None:
                total += d.value * block.repeat
            elif d.kind == DurationKind.DISTANCE_M and d.value is not None:
                # rough: 5 min/km if no target pace
                pace = 300.0
                t = step.target
                if t.kind == TargetKind.PACE_S_KM and t.low is not None and t.high is not None:
                    pace = (t.low + t.high) / 2.0
                total += (d.value / 1000.0) * pace * block.repeat
    return int(total)


def _estimate_distance_meters(workout: NormalizedRunWorkout) -> int:
    total = 0.0
    for block in workout.blocks:
        for step in block.steps:
            d = step.duration
            if d.kind == DurationKind.DISTANCE_M and d.value is not None:
                total += d.value * block.repeat
    return int(total)


def normalized_to_garmin_workout(workout: NormalizedRunWorkout) -> dict[str, Any]:
    """Build the Garmin upload_running_workout payload for `workout`.

    Returns a JSON-serializable dict. Caller is responsible for actually
    posting it via the authenticated GarminClient.
    """
    return {
        "workoutName": workout.name,
        "description": workout.note or "",
        "sportType": _RUN_SPORT_TYPE,
        "subSportType": "GENERIC",
        "estimatedDurationInSecs": _estimate_duration_seconds(workout),
        "estimatedDistanceInMeters": _estimate_distance_meters(workout),
        "estimateType": "DISTANCE_ESTIMATED",
        "workoutSegments": [{
            "segmentOrder": 1,
            "sportType": _RUN_SPORT_TYPE,
            "poolLengthUnit": None,
            "poolLength": None,
            "workoutSteps": _build_steps(workout),
        }],
    }
