"""Public types for running threshold and zone calibration."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Any

RUNNING_CALIBRATION_MODEL_VERSION = 2


class CalibrationConfidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    NONE = "none"


@dataclass(frozen=True)
class RunningSample:
    timestamp_s: float | None = None
    elapsed_s: float | None = None
    distance_m: float | None = None
    heart_rate_bpm: float | None = None
    speed_mps: float | None = None
    power_w: float | None = None
    altitude_m: float | None = None


@dataclass(frozen=True)
class RunningLap:
    lap_index: int
    duration_s: float | None = None
    distance_m: float | None = None
    avg_hr: float | None = None
    max_hr: float | None = None
    avg_speed_mps: float | None = None
    avg_power_w: float | None = None
    lap_type: str | None = None


@dataclass(frozen=True)
class RunningActivity:
    label_id: str
    activity_date: date
    sport: str
    duration_s: float | None = None
    distance_m: float | None = None
    avg_hr: float | None = None
    max_hr: float | None = None
    avg_power_w: float | None = None
    samples: tuple[RunningSample, ...] = ()
    laps: tuple[RunningLap, ...] = ()
    source: str | None = None


@dataclass(frozen=True)
class CalibrationEvidence:
    kind: str
    label_id: str
    activity_date: date
    start_s: float | None = None
    end_s: float | None = None
    duration_s: float | None = None
    avg_speed_mps: float | None = None
    avg_hr: float | None = None
    confidence: CalibrationConfidence = CalibrationConfidence.LOW
    source: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HrMaxProfile:
    observed_max_hr: float | None = None
    estimated_hrmax: float | None = None
    confidence: CalibrationConfidence = CalibrationConfidence.NONE
    high_hr_reference: float | None = None
    sample_count: int = 0
    evidence: tuple[CalibrationEvidence, ...] = ()
    source: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RunningCalibrationSnapshot:
    as_of_date: date
    threshold_hr: float | None = None
    threshold_speed_mps: float | None = None
    threshold_hr_confidence: CalibrationConfidence = CalibrationConfidence.NONE
    threshold_speed_confidence: CalibrationConfidence = CalibrationConfidence.NONE
    rhr_baseline: float | None = None
    observed_max_hr: float | None = None
    hrmax_estimate: float | None = None
    hrmax_confidence: CalibrationConfidence = CalibrationConfidence.NONE
    high_hr_reference: float | None = None
    source: dict[str, Any] = field(default_factory=dict)
    evidence: tuple[CalibrationEvidence, ...] = ()
    id: int | str | None = None
    algorithm_version: int = RUNNING_CALIBRATION_MODEL_VERSION


@dataclass(frozen=True)
class PaceZone:
    name: str
    min_pace_s_per_km: float | None
    max_pace_s_per_km: float | None
    min_speed_mps: float | None
    max_speed_mps: float | None
    confidence: CalibrationConfidence


@dataclass(frozen=True)
class HeartRateZone:
    name: str
    min_bpm: float | None
    max_bpm: float | None
    confidence: CalibrationConfidence


@dataclass(frozen=True)
class RunningZoneSet:
    as_of_date: date
    snapshot_id: int | str | None = None
    pace_zones: tuple[PaceZone, ...] = ()
    heart_rate_zones: tuple[HeartRateZone, ...] = ()


@dataclass(frozen=True)
class RunningCalibrationRunSummary:
    snapshot: RunningCalibrationSnapshot
    zones: RunningZoneSet
    activities_considered: int
    snapshot_id: int | str | None
    start: date
    end: date
    persist: bool
