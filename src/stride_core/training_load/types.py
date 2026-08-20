"""Types for objective training-load computation."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Any

TRAINING_LOAD_MODEL_VERSION = 2


class SessionClass(str, Enum):
    EASY = "easy"
    LONG = "long"
    TEMPO = "tempo"
    INTERVAL = "interval"
    RACE = "race"
    STRENGTH = "strength"
    CROSS = "cross"
    MOBILITY = "mobility"
    UNKNOWN = "unknown"


class LoadConfidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    NONE = "none"


class LoadCoverageStatus(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    UNKNOWN = "unknown"
    REST_CONFIRMED = "rest_confirmed"


@dataclass(frozen=True)
class ActivitySample:
    timestamp_s: float | None = None
    elapsed_s: float | None = None
    distance_m: float | None = None
    heart_rate_bpm: float | None = None
    speed_mps: float | None = None
    power_w: float | None = None
    altitude_m: float | None = None


@dataclass(frozen=True)
class ActivityLoadInput:
    label_id: str
    activity_date: date
    sport: str
    session_class: SessionClass = SessionClass.UNKNOWN
    duration_s: float | None = None
    distance_m: float | None = None
    ascent_m: float | None = None
    descent_m: float | None = None
    avg_hr: float | None = None
    max_hr: float | None = None
    avg_power: float | None = None
    calories_kcal: float | None = None
    samples: tuple[ActivitySample, ...] = ()
    rpe: int | None = None


@dataclass(frozen=True)
class CalibrationSnapshot:
    as_of_date: date
    rhr_baseline: float | None = None
    hrmax_estimate: float | None = None
    threshold_hr: float | None = None
    threshold_speed_mps: float | None = None
    critical_power_w: float | None = None
    source: dict[str, Any] = field(default_factory=dict)
    id: int | None = None
    algorithm_version: int = TRAINING_LOAD_MODEL_VERSION


@dataclass(frozen=True)
class ActivityLoadResult:
    label_id: str
    activity_date: date
    sport: str
    session_class: SessionClass
    duration_minutes: float | None = None
    algorithm_version: int = TRAINING_LOAD_MODEL_VERSION
    calibration_id: int | None = None
    cardio_load_raw: float | None = None
    cardio_tss: float | None = None
    external_tss: float | None = None
    high_intensity_tss: float | None = None
    mechanical_load: float | None = None
    subjective_internal_load: float | None = None
    training_dose: float | None = None
    training_dose_source: str | None = None
    cardio_coverage: float = 0.0
    external_coverage: float = 0.0
    high_intensity_coverage: float = 0.0
    coverage_status: LoadCoverageStatus = LoadCoverageStatus.UNKNOWN
    load_confidence: LoadConfidence = LoadConfidence.NONE
    excluded_from_pmc: bool = True
    reasons: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class HealthRow:
    date: date
    rhr: float | None = None
    sleep_total_s: float | None = None
    sleep_score: float | None = None


@dataclass(frozen=True)
class HrvRow:
    date: date
    last_night_avg: float | None = None
    status: str | None = None


@dataclass(frozen=True)
class FeedbackRow:
    label_id: str
    activity_date: date
    rpe: int | None
    duration_minutes: float | None


@dataclass(frozen=True)
class ReadinessLoadHistory:
    activity_date: date
    sport: str
    session_class: SessionClass
    subjective_internal_load: float
    training_dose: float


@dataclass(frozen=True)
class DailyLoadResult:
    date: date
    algorithm_version: int = TRAINING_LOAD_MODEL_VERSION
    calibration_id: int | None = None
    training_dose: float = 0.0
    acute_load: float = 0.0
    chronic_load: float = 0.0
    form: float = 0.0
    load_ratio: float | None = None
    coverage_status: LoadCoverageStatus = LoadCoverageStatus.UNKNOWN
    readiness_gate: str = "green"
    readiness_reasons: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PriorLoadState:
    acute_load: float = 0.0
    chronic_load: float = 0.0


@dataclass(frozen=True)
class TrainingLoadRunSummary:
    activities_processed: int
    activity_rows_written: int
    daily_rows_written: int
    calibration_id: int | None
    start: date | None
    end: date | None
    persist: bool
    final_state: PriorLoadState | None = None


@dataclass(frozen=True)
class TrainingLoadBackfillSummary:
    calibration: CalibrationSnapshot
    load: TrainingLoadRunSummary
    calibration_lookback_days: int
    load_lookback_days: int


@dataclass(frozen=True)
class PlannedLoadEstimate:
    """TSS-scaled estimate for a structured planned run.

    Planned targets are ranges, so the estimator keeps the expected value and
    lower/upper bounds instead of presenting false single-number precision.
    ``coverage`` is the share of finite-duration/distance steps whose target and
    athlete calibration were sufficient to estimate.
    """

    expected_dose: float | None = None
    low_dose: float | None = None
    high_dose: float | None = None
    estimated_duration_minutes: float | None = None
    estimated_distance_km: float | None = None
    coverage: float = 0.0
    confidence: LoadConfidence = LoadConfidence.NONE
    assumptions: tuple[str, ...] = ()
    unestimated_steps: int = 0


CalibrationSample = ActivitySample


@dataclass(frozen=True)
class CalibrationActivity:
    label_id: str
    activity_date: date
    sport: str
    duration_s: float | None = None
    distance_m: float | None = None
    avg_hr: float | None = None
    max_hr: float | None = None
    avg_power: float | None = None
    samples: tuple[CalibrationSample, ...] = ()


@dataclass(frozen=True)
class CalibrationHealthRow:
    date: date
    rhr: float | None = None
