"""Translation tests for NormalizedRunWorkout → COROS / Garmin payloads."""

from __future__ import annotations

from coros_sync.translate import normalized_to_coros_run
from garmin_sync.translate import normalized_to_garmin_workout
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
    parse_pace_s_km,
)


# ─────────────────────────────────────────────────────────────────────────────
# Test fixtures: representative workouts users actually push
# ─────────────────────────────────────────────────────────────────────────────


def _easy_run_10km():
    """Linear easy run with one block, one work step."""
    return NormalizedRunWorkout(
        name="Easy 10K",
        date="2026-05-01",
        blocks=(
            WorkoutBlock(steps=(
                WorkoutStep(
                    StepKind.WORK,
                    Duration.of_distance_km(10),
                    Target.pace_range_s_km(parse_pace_s_km("5:40"), parse_pace_s_km("5:20")),
                ),
            )),
        ),
    )


def _intervals_6x800():
    """Warmup → 6x(800m work + 60s recovery) → cooldown."""
    return NormalizedRunWorkout(
        name="6x800m @ 3:30",
        date="2026-05-02",
        blocks=(
            WorkoutBlock(steps=(
                WorkoutStep(StepKind.WARMUP, Duration.of_time_min(10)),
            )),
            WorkoutBlock(repeat=6, steps=(
                WorkoutStep(
                    StepKind.WORK,
                    Duration.of_distance_m(800),
                    Target.pace_range_s_km(parse_pace_s_km("3:35"), parse_pace_s_km("3:25")),
                ),
                WorkoutStep(StepKind.RECOVERY, Duration.of_time_s(60)),
            )),
            WorkoutBlock(steps=(
                WorkoutStep(StepKind.COOLDOWN, Duration.of_time_min(5)),
            )),
        ),
    )


def _long_run_25km():
    return NormalizedRunWorkout(
        name="Long Run 25K",
        date="2026-05-04",
        blocks=(
            WorkoutBlock(steps=(
                WorkoutStep(
                    StepKind.WORK,
                    Duration.of_distance_km(25),
                    Target.pace_range_s_km(parse_pace_s_km("5:30"), parse_pace_s_km("5:10")),
                ),
            )),
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# COROS translation
# ─────────────────────────────────────────────────────────────────────────────


class TestCorosTranslation:
    def test_easy_run_yields_one_training_segment(self):
        coros = normalized_to_coros_run(_easy_run_10km())
        assert coros.name == "Easy 10K"
        assert coros.date == "20260501"      # ISO -> COROS YYYYMMDD
        assert coros.workout_type == "easy"
        assert len(coros.segments) == 1
        seg = coros.segments[0]
        assert seg.segment_type == "training"
        assert seg.distance_km == 10.0
        assert seg.pace_low == "5:40"
        assert seg.pace_high == "5:20"

    def test_intervals_collapsed_to_interval_segment(self):
        coros = normalized_to_coros_run(_intervals_6x800())
        # Expect: warmup, interval (sets=6), cooldown
        types = [s.segment_type for s in coros.segments]
        assert types == ["warmup", "interval", "cooldown"]
        interval = coros.segments[1]
        assert interval.sets == 6
        assert interval.distance_km == 0.8
        assert interval.pace_low == "3:35"
        assert interval.pace_high == "3:25"
        assert interval.recovery_duration_s == 60
        assert coros.workout_type == "interval"

    def test_long_run_workout_type_inferred(self):
        coros = normalized_to_coros_run(_long_run_25km())
        assert coros.workout_type == "long"

    def test_pace_format_round_trip(self):
        # Confirm the s/km int → "M:SS" string conversion holds for a tempo run.
        wo = NormalizedRunWorkout(
            name="Tempo 8K", date="2026-05-03",
            blocks=(WorkoutBlock(steps=(
                WorkoutStep(StepKind.WORK, Duration.of_distance_km(8),
                            Target.pace_range_s_km(parse_pace_s_km("4:08"),
                                                    parse_pace_s_km("4:05"))),
            )),),
        )
        coros = normalized_to_coros_run(wo)
        seg = coros.segments[0]
        assert seg.pace_low == "4:08"
        assert seg.pace_high == "4:05"
        # workout_type heuristic: faster bound 245 s/km <= 270 → tempo
        assert coros.workout_type == "tempo"


# ─────────────────────────────────────────────────────────────────────────────
# Garmin translation
# ─────────────────────────────────────────────────────────────────────────────


class TestGarminTranslation:
    def test_envelope_shape(self):
        payload = normalized_to_garmin_workout(_easy_run_10km())
        assert payload["workoutName"] == "Easy 10K"
        assert payload["sportType"]["sportTypeKey"] == "running"
        assert payload["subSportType"] == "GENERIC"
        assert len(payload["workoutSegments"]) == 1
        seg = payload["workoutSegments"][0]
        assert seg["segmentOrder"] == 1
        assert seg["sportType"]["sportTypeKey"] == "running"
        assert isinstance(seg["workoutSteps"], list)

    def test_easy_run_emits_single_executable_step(self):
        payload = normalized_to_garmin_workout(_easy_run_10km())
        steps = payload["workoutSegments"][0]["workoutSteps"]
        assert len(steps) == 1
        s = steps[0]
        assert s["type"] == "ExecutableStepDTO"
        assert s["stepType"]["stepTypeKey"] == "interval"
        assert s["endCondition"]["conditionTypeKey"] == "distance"
        assert s["endConditionValue"] == 10000.0  # 10km in meters
        # Pace target: 5:40 (340 s/km) → 1000/340 ≈ 2.94 m/s (slow, valueOne)
        # Pace target: 5:20 (320 s/km) → 1000/320 ≈ 3.125 m/s (fast, valueTwo)
        assert s["targetType"]["workoutTargetTypeKey"] == "pace.zone"
        assert 2.93 < s["targetValueOne"] < 2.95
        assert 3.12 < s["targetValueTwo"] < 3.13
        # valueTwo (faster) must be > valueOne (slower) in m/s
        assert s["targetValueTwo"] > s["targetValueOne"]

    def test_intervals_emit_repeat_group(self):
        payload = normalized_to_garmin_workout(_intervals_6x800())
        steps = payload["workoutSegments"][0]["workoutSteps"]

        # warmup (executable), repeat group (repeat=6 with 2 nested), cooldown
        assert len(steps) == 3
        warmup, group, cooldown = steps
        assert warmup["type"] == "ExecutableStepDTO"
        assert warmup["stepType"]["stepTypeKey"] == "warmup"
        assert warmup["endCondition"]["conditionTypeKey"] == "time"
        assert warmup["endConditionValue"] == 600.0  # 10 min

        assert group["type"] == "RepeatGroupDTO"
        assert group["stepType"]["stepTypeKey"] == "repeat"
        assert group["numberOfIterations"] == 6
        assert len(group["workoutSteps"]) == 2
        work, recovery = group["workoutSteps"]
        assert work["stepType"]["stepTypeKey"] == "interval"
        assert work["endCondition"]["conditionTypeKey"] == "distance"
        assert work["endConditionValue"] == 800.0
        assert work["targetType"]["workoutTargetTypeKey"] == "pace.zone"
        assert recovery["stepType"]["stepTypeKey"] == "recovery"
        assert recovery["endCondition"]["conditionTypeKey"] == "time"
        assert recovery["endConditionValue"] == 60.0

        assert cooldown["stepType"]["stepTypeKey"] == "cooldown"

    def test_open_duration_uses_lap_button(self):
        wo = NormalizedRunWorkout(
            name="Open warmup",
            date="2026-05-05",
            blocks=(WorkoutBlock(steps=(
                WorkoutStep(StepKind.WARMUP, Duration.open()),
                WorkoutStep(StepKind.WORK, Duration.of_distance_km(5)),
            )),),
        )
        payload = normalized_to_garmin_workout(wo)
        steps = payload["workoutSegments"][0]["workoutSteps"]
        assert steps[0]["endCondition"]["conditionTypeKey"] == "lap.button"
        assert steps[0]["endConditionValue"] is None

    def test_no_target_when_step_has_no_target(self):
        wo = NormalizedRunWorkout(
            name="Easy", date="2026-05-06",
            blocks=(WorkoutBlock(steps=(
                WorkoutStep(StepKind.WORK, Duration.of_distance_km(8)),
            )),),
        )
        payload = normalized_to_garmin_workout(wo)
        s = payload["workoutSegments"][0]["workoutSteps"][0]
        assert s["targetType"]["workoutTargetTypeKey"] == "no.target"
        assert s["targetValueOne"] is None
        assert s["targetValueTwo"] is None

    def test_distance_estimate_aggregates_repeats(self):
        # 6 repeats × 800m = 4800m total in the interval block
        payload = normalized_to_garmin_workout(_intervals_6x800())
        # Includes only distance-based steps (the interval work). Warmup is
        # time-based, cooldown is time-based, recovery is time-based.
        assert payload["estimatedDistanceInMeters"] == 4800

    def test_pace_units_are_m_per_second(self):
        # Sanity: a 4:00/km pace (240 s/km) round-trips to 1000/240 ≈ 4.167 m/s.
        wo = NormalizedRunWorkout(
            name="Tempo", date="2026-05-07",
            blocks=(WorkoutBlock(steps=(
                WorkoutStep(StepKind.WORK, Duration.of_distance_km(8),
                            Target.pace_range_s_km(parse_pace_s_km("4:05"),
                                                    parse_pace_s_km("4:00"))),
            )),),
        )
        s = normalized_to_garmin_workout(wo)["workoutSegments"][0]["workoutSteps"][0]
        # 4:05 = 245 s/km → 1000/245 = 4.082 m/s (slower, valueOne)
        # 4:00 = 240 s/km → 1000/240 = 4.167 m/s (faster, valueTwo)
        assert 4.07 < s["targetValueOne"] < 4.09
        assert 4.16 < s["targetValueTwo"] < 4.17
