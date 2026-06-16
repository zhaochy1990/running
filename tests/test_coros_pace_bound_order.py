"""Regression: COROS pace-target bounds must not be reversed on the watch.

COROS renders ``intensityValue`` first, so it must carry the FASTER bound
(smaller ms/km). A workout authored as "4:20-4:30/km" must show "4:20-4:30",
not the reversed "4:30-4:20". The mapping is normalized by numeric value, so
it stays correct even when authored plan.json is inconsistent about which of
target.low/high is the faster bound.
"""

from __future__ import annotations

from coros_sync.translate import normalized_to_coros_run
from coros_sync.workout import TRAINING, _make_exercise, pace_to_ms
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
    parse_pace_s_km,
)

FAST = "4:20"   # 260_000 ms/km
SLOW = "4:30"   # 270_000 ms/km


class TestMakeExercisePaceOrder:
    def test_faster_bound_lands_in_intensity_value(self):
        ex = _make_exercise(2, 1, 5, 100, TRAINING, pace_low=SLOW, pace_high=FAST)
        assert ex["intensityValue"] == pace_to_ms(FAST)        # 260_000 shown first
        assert ex["intensityValueExtend"] == pace_to_ms(SLOW)  # 270_000

    def test_order_independent_of_caller_argument_order(self):
        """Even if a caller passes the bounds the 'wrong' way round (which has
        happened in authored plan.json), the watch ordering is identical."""
        a = _make_exercise(2, 1, 5, 100, TRAINING, pace_low=SLOW, pace_high=FAST)
        b = _make_exercise(2, 1, 5, 100, TRAINING, pace_low=FAST, pace_high=SLOW)
        assert a["intensityValue"] == b["intensityValue"] == pace_to_ms(FAST)
        assert a["intensityValueExtend"] == b["intensityValueExtend"] == pace_to_ms(SLOW)

    def test_intensity_value_is_always_the_smaller_ms(self):
        ex = _make_exercise(2, 1, 5, 100, TRAINING, pace_low=SLOW, pace_high=FAST)
        assert ex["intensityValue"] < ex["intensityValueExtend"]
        assert ex["intensityPercent"] == ex["intensityValue"] // 5
        assert ex["intensityPercentExtend"] == ex["intensityValueExtend"] // 5

    def test_no_pace_leaves_intensity_untouched(self):
        ex = _make_exercise(2, 1, 5, 100, TRAINING)
        assert ex["intensityType"] == 0
        assert ex["intensityValue"] == 0
        assert ex["intensityValueExtend"] == 0


class TestEndToEndPaceOrder:
    def _easy_run(self):
        return NormalizedRunWorkout(
            name="Easy 10K",
            date="2026-05-01",
            blocks=(
                WorkoutBlock(steps=(
                    WorkoutStep(
                        StepKind.WORK,
                        Duration.of_distance_km(10),
                        # 5:40 slow, 5:20 fast
                        Target.pace_range_s_km(parse_pace_s_km("5:40"), parse_pace_s_km("5:20")),
                    ),
                )),
            ),
        )

    def test_built_payload_shows_faster_pace_first(self):
        coros = normalized_to_coros_run(self._easy_run())
        exercises = coros._build_exercises()
        training = [e for e in exercises if e["exerciseType"] == 2][0]
        assert training["intensityValue"] == pace_to_ms("5:20")        # fast first
        assert training["intensityValueExtend"] == pace_to_ms("5:40")  # slow second
        assert training["intensityValue"] < training["intensityValueExtend"]
