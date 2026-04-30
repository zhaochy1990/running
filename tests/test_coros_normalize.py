"""Tests for coros_sync.normalize: COROS encoding ↔ stride_core enums."""

from __future__ import annotations

from coros_sync.normalize import (
    COROS_FEEL_MAP,
    COROS_SPORT_MAP,
    COROS_TRAIN_MAP,
    apply_to_detail,
)
from stride_core.models import ActivityDetail
from stride_core.normalize import FeelLevel, NormalizedSport, TrainKind


def _empty_detail(**overrides) -> ActivityDetail:
    """Build an ActivityDetail with the bare minimum fields plus overrides.

    Defaults to a running activity (sport_type=100); tests vary the COROS
    encoding values to exercise the mapping.
    """
    base = dict(
        label_id="x", name=None, sport_type=100, sport_name="Run",
        date="2026-04-30", distance_m=10000, duration_s=3000,
        avg_pace_s_km=300, adjusted_pace=None, best_km_pace=None, max_pace=None,
        avg_hr=145, max_hr=170, avg_cadence=180, max_cadence=190,
        avg_power=None, max_power=None, avg_step_len_cm=None,
        ascent_m=None, descent_m=None, calories_kcal=500,
        aerobic_effect=None, anaerobic_effect=None,
        training_load=None, vo2max=None, performance=None, train_type=None,
        temperature=None, humidity=None, feels_like=None, wind_speed=None,
        feel_type=None,
    )
    base.update(overrides)
    return ActivityDetail(**base)


# ─────────────────────────────────────────────────────────────────────────────
# COROS_SPORT_MAP
# ─────────────────────────────────────────────────────────────────────────────


class TestSportMap:
    def test_running_codes(self):
        assert COROS_SPORT_MAP.to_normalized(100) == NormalizedSport.RUN_OUTDOOR
        assert COROS_SPORT_MAP.to_normalized(101) == NormalizedSport.RUN_INDOOR
        assert COROS_SPORT_MAP.to_normalized(102) == NormalizedSport.RUN_TRAIL
        assert COROS_SPORT_MAP.to_normalized(103) == NormalizedSport.RUN_TRACK
        assert COROS_SPORT_MAP.to_normalized(104) == NormalizedSport.RUN_TREADMILL

    def test_strength_both_codes_resolve(self):
        # COROS uses both 402 and 800 historically. Both must map to STRENGTH.
        assert COROS_SPORT_MAP.to_normalized(402) == NormalizedSport.STRENGTH
        assert COROS_SPORT_MAP.to_normalized(800) == NormalizedSport.STRENGTH

    def test_swim_codes(self):
        assert COROS_SPORT_MAP.to_normalized(300) == NormalizedSport.SWIM_POOL
        assert COROS_SPORT_MAP.to_normalized(301) == NormalizedSport.SWIM_OPEN

    def test_unknown_sport_falls_back_to_unknown(self):
        assert COROS_SPORT_MAP.to_normalized(99999) == NormalizedSport.UNKNOWN


# ─────────────────────────────────────────────────────────────────────────────
# COROS_TRAIN_MAP
# ─────────────────────────────────────────────────────────────────────────────


class TestTrainMap:
    def test_all_known_codes(self):
        expected = {
            1: TrainKind.BASE,
            2: TrainKind.AEROBIC,
            3: TrainKind.THRESHOLD,
            4: TrainKind.INTERVAL,
            5: TrainKind.VO2MAX,
            6: TrainKind.ANAEROBIC,
            7: TrainKind.SPRINT,
            8: TrainKind.RECOVERY,
        }
        for code, kind in expected.items():
            assert COROS_TRAIN_MAP.to_normalized(code) == kind

    def test_unknown_code(self):
        assert COROS_TRAIN_MAP.to_normalized(99) == TrainKind.UNKNOWN


# ─────────────────────────────────────────────────────────────────────────────
# COROS_FEEL_MAP
# ─────────────────────────────────────────────────────────────────────────────


class TestFeelMap:
    def test_all_codes_in_order(self):
        assert COROS_FEEL_MAP.to_normalized(1) == FeelLevel.EXCELLENT
        assert COROS_FEEL_MAP.to_normalized(2) == FeelLevel.GOOD
        assert COROS_FEEL_MAP.to_normalized(3) == FeelLevel.NORMAL
        assert COROS_FEEL_MAP.to_normalized(4) == FeelLevel.BAD
        assert COROS_FEEL_MAP.to_normalized(5) == FeelLevel.AWFUL

    def test_unknown_feel(self):
        assert COROS_FEEL_MAP.to_normalized(99) == FeelLevel.UNKNOWN


# ─────────────────────────────────────────────────────────────────────────────
# apply_to_detail integration
# ─────────────────────────────────────────────────────────────────────────────


class TestApplyToDetail:
    def test_running_with_threshold_and_feel(self):
        detail = _empty_detail(sport_type=100, feel_type=2)
        raw = {"data": {"summary": {"trainType": 3}}}
        apply_to_detail(detail, raw)
        assert detail.sport == "run_outdoor"
        assert detail.train_kind == "threshold"
        assert detail.feel == "good"

    def test_strength_no_train_no_feel(self):
        detail = _empty_detail(sport_type=800)
        apply_to_detail(detail, {})
        assert detail.sport == "strength"
        assert detail.train_kind is None
        assert detail.feel is None

    def test_unknown_sport_emits_unknown_value(self):
        detail = _empty_detail(sport_type=99999)
        apply_to_detail(detail, {})
        assert detail.sport == "unknown"

    def test_idempotent(self):
        detail = _empty_detail(sport_type=100, feel_type=1)
        raw = {"data": {"summary": {"trainType": 4}}}
        apply_to_detail(detail, raw)
        first = (detail.sport, detail.train_kind, detail.feel)
        apply_to_detail(detail, raw)
        assert (detail.sport, detail.train_kind, detail.feel) == first

    def test_missing_summary_keys_safe(self):
        detail = _empty_detail(sport_type=100, feel_type=3)
        # No "data" / "summary" — apply still works, just leaves train_kind None
        apply_to_detail(detail, {})
        assert detail.sport == "run_outdoor"
        assert detail.train_kind is None
        assert detail.feel == "normal"

    def test_zero_feel_type_treated_as_no_rating(self):
        # COROS sometimes returns 0 for "no feel rating"; should NOT map to a value.
        detail = _empty_detail(sport_type=100, feel_type=0)
        apply_to_detail(detail, {})
        assert detail.feel is None

    def test_zero_train_type_treated_as_no_kind(self):
        detail = _empty_detail(sport_type=100)
        raw = {"data": {"summary": {"trainType": 0}}}
        apply_to_detail(detail, raw)
        assert detail.train_kind is None


# ─────────────────────────────────────────────────────────────────────────────
# Roundtrip: apply_to_detail → upsert_activity → DB column values
# ─────────────────────────────────────────────────────────────────────────────


class TestUpsertWritesNormalizedColumns:
    def test_normalized_columns_written(self, db):
        detail = _empty_detail(label_id="r1", sport_type=100, feel_type=2)
        apply_to_detail(detail, {"data": {"summary": {"trainType": 3}}})
        db.upsert_activity(detail)

        row = db.query(
            "SELECT sport, train_kind, feel, sport_type, feel_type "
            "FROM activities WHERE label_id = 'r1'"
        )[0]
        # Normalized values
        assert row["sport"] == "run_outdoor"
        assert row["train_kind"] == "threshold"
        assert row["feel"] == "good"
        # Original COROS values still present (unchanged)
        assert row["sport_type"] == 100
        assert row["feel_type"] == 2

    def test_normalized_columns_null_when_not_applied(self, db):
        # If a caller doesn't run apply_to_detail (e.g. legacy path), the
        # columns should be NULL rather than 'unknown' — caller is responsible
        # for opting in to normalization.
        detail = _empty_detail(label_id="legacy1", sport_type=100)
        db.upsert_activity(detail)

        row = db.query(
            "SELECT sport, train_kind, feel FROM activities WHERE label_id = 'legacy1'"
        )[0]
        assert row["sport"] is None
        assert row["train_kind"] is None
        assert row["feel"] is None
