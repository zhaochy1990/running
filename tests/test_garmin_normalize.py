"""Tests for garmin_sync.normalize: Garmin encoding ↔ stride_core enums."""

from __future__ import annotations

from garmin_sync.normalize import (
    GARMIN_SPORT_MAP,
    GARMIN_TRAIN_MAP,
    apply_to_detail,
    garmin_feel_to_level,
)
from stride_core.models import ActivityDetail
from stride_core.normalize import FeelLevel, NormalizedSport, TrainKind


def _empty_detail(**overrides) -> ActivityDetail:
    base = dict(
        label_id="x", name=None, sport_type=8001, sport_name="running",
        date=None, distance_m=10000, duration_s=3000,
        avg_pace_s_km=300, adjusted_pace=None, best_km_pace=None, max_pace=None,
        avg_hr=145, max_hr=170, avg_cadence=180, max_cadence=190,
        avg_power=None, max_power=None, avg_step_len_cm=None,
        ascent_m=None, descent_m=None, calories_kcal=None,
        aerobic_effect=None, anaerobic_effect=None,
        training_load=None, vo2max=None, performance=None, train_type=None,
        temperature=None, humidity=None, feels_like=None, wind_speed=None,
        feel_type=None,
    )
    base.update(overrides)
    return ActivityDetail(**base)


# ─────────────────────────────────────────────────────────────────────────────
# GARMIN_SPORT_MAP
# ─────────────────────────────────────────────────────────────────────────────


class TestSportMap:
    def test_running_family(self):
        assert GARMIN_SPORT_MAP.to_normalized("running") == NormalizedSport.RUN_OUTDOOR
        assert GARMIN_SPORT_MAP.to_normalized("indoor_running") == NormalizedSport.RUN_INDOOR
        assert GARMIN_SPORT_MAP.to_normalized("treadmill_running") == NormalizedSport.RUN_TREADMILL
        assert GARMIN_SPORT_MAP.to_normalized("track_running") == NormalizedSport.RUN_TRACK
        assert GARMIN_SPORT_MAP.to_normalized("trail_running") == NormalizedSport.RUN_TRAIL

    def test_strength(self):
        assert GARMIN_SPORT_MAP.to_normalized("strength_training") == NormalizedSport.STRENGTH

    def test_cycling(self):
        assert GARMIN_SPORT_MAP.to_normalized("cycling") == NormalizedSport.BIKE_OUTDOOR
        assert GARMIN_SPORT_MAP.to_normalized("indoor_cycling") == NormalizedSport.BIKE_INDOOR

    def test_swimming(self):
        assert GARMIN_SPORT_MAP.to_normalized("lap_swimming") == NormalizedSport.SWIM_POOL
        assert GARMIN_SPORT_MAP.to_normalized("open_water_swimming") == NormalizedSport.SWIM_OPEN

    def test_unknown_falls_back(self):
        assert GARMIN_SPORT_MAP.to_normalized("paragliding") == NormalizedSport.UNKNOWN
        assert GARMIN_SPORT_MAP.to_normalized("") == NormalizedSport.UNKNOWN


# ─────────────────────────────────────────────────────────────────────────────
# GARMIN_TRAIN_MAP
# ─────────────────────────────────────────────────────────────────────────────


class TestTrainMap:
    def test_aerobic_base(self):
        assert GARMIN_TRAIN_MAP.to_normalized("AEROBIC_BASE") == TrainKind.BASE
        assert GARMIN_TRAIN_MAP.to_normalized("BASE") == TrainKind.BASE

    def test_threshold_family(self):
        assert GARMIN_TRAIN_MAP.to_normalized("THRESHOLD") == TrainKind.THRESHOLD
        assert GARMIN_TRAIN_MAP.to_normalized("LACTATE_THRESHOLD") == TrainKind.THRESHOLD

    def test_tempo_distinct_from_threshold(self):
        # COROS doesn't have TEMPO; we synthesize it in the enum and Garmin
        # uses it directly.
        assert GARMIN_TRAIN_MAP.to_normalized("TEMPO") == TrainKind.TEMPO

    def test_anaerobic_variants(self):
        assert GARMIN_TRAIN_MAP.to_normalized("ANAEROBIC") == TrainKind.ANAEROBIC
        assert GARMIN_TRAIN_MAP.to_normalized("ANAEROBIC_CAPACITY") == TrainKind.ANAEROBIC

    def test_recovery_and_vo2(self):
        assert GARMIN_TRAIN_MAP.to_normalized("RECOVERY") == TrainKind.RECOVERY
        assert GARMIN_TRAIN_MAP.to_normalized("VO2MAX") == TrainKind.VO2MAX

    def test_unknown_label(self):
        assert GARMIN_TRAIN_MAP.to_normalized("NEW_GARMIN_LABEL") == TrainKind.UNKNOWN


# ─────────────────────────────────────────────────────────────────────────────
# garmin_feel_to_level — bucket the 0-100 score
# ─────────────────────────────────────────────────────────────────────────────


class TestFeelBucketing:
    def test_excellent_top(self):
        assert garmin_feel_to_level(100) == FeelLevel.EXCELLENT
        assert garmin_feel_to_level(80) == FeelLevel.EXCELLENT

    def test_good(self):
        assert garmin_feel_to_level(75) == FeelLevel.GOOD
        assert garmin_feel_to_level(60) == FeelLevel.GOOD

    def test_normal(self):
        assert garmin_feel_to_level(50) == FeelLevel.NORMAL

    def test_bad(self):
        assert garmin_feel_to_level(30) == FeelLevel.BAD

    def test_awful(self):
        assert garmin_feel_to_level(10) == FeelLevel.AWFUL
        assert garmin_feel_to_level(1) == FeelLevel.AWFUL

    def test_zero_means_no_rating(self):
        assert garmin_feel_to_level(0) is None

    def test_none_passthrough(self):
        assert garmin_feel_to_level(None) is None

    def test_invalid_returns_none(self):
        assert garmin_feel_to_level("not a number") is None


# ─────────────────────────────────────────────────────────────────────────────
# apply_to_detail end-to-end
# ─────────────────────────────────────────────────────────────────────────────


class TestApplyToDetail:
    def test_running_with_label_and_feel(self):
        detail = _empty_detail()
        apply_to_detail(detail, {
            "activityType": {"typeKey": "running"},
            "trainingEffectLabel": "AEROBIC_BASE",
            "feel": 75,
        })
        assert detail.sport == "run_outdoor"
        assert detail.train_kind == "base"
        assert detail.feel == "good"

    def test_strength_no_train_label(self):
        detail = _empty_detail()
        apply_to_detail(detail, {
            "activityType": {"typeKey": "strength_training"},
        })
        assert detail.sport == "strength"
        assert detail.train_kind is None
        assert detail.feel is None

    def test_unknown_sport_emits_unknown(self):
        detail = _empty_detail()
        apply_to_detail(detail, {"activityType": {"typeKey": "paragliding"}})
        assert detail.sport == "unknown"

    def test_missing_keys_safe(self):
        detail = _empty_detail()
        apply_to_detail(detail, {})
        assert detail.sport is None
        assert detail.train_kind is None
        assert detail.feel is None

    def test_zero_feel_treated_as_no_rating(self):
        detail = _empty_detail()
        apply_to_detail(detail, {
            "activityType": {"typeKey": "running"},
            "feel": 0,
        })
        assert detail.feel is None

    def test_idempotent(self):
        detail = _empty_detail()
        raw = {
            "activityType": {"typeKey": "running"},
            "trainingEffectLabel": "TEMPO",
            "feel": 65,
        }
        apply_to_detail(detail, raw)
        first = (detail.sport, detail.train_kind, detail.feel)
        apply_to_detail(detail, raw)
        assert (detail.sport, detail.train_kind, detail.feel) == first
