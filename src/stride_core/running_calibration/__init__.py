"""Running threshold calibration algorithms and repository orchestration."""

from .core import estimate_critical_power, estimate_hrmax_profile, estimate_rhr_baseline, estimate_running_calibration
from .repository import RunningCalibrationRepository, recompute_running_calibration
from .types import (
    RUNNING_CALIBRATION_MODEL_VERSION,
    CalibrationConfidence,
    CalibrationEvidence,
    HrMaxProfile,
    HeartRateZone,
    PaceZone,
    RunningActivity,
    RunningCalibrationRunSummary,
    RunningCalibrationSnapshot,
    RunningHealthRow,
    RunningLap,
    RunningSample,
    RunningZoneSet,
)
from .zones import compute_training_zones

__all__ = [
    "RUNNING_CALIBRATION_MODEL_VERSION",
    "CalibrationConfidence",
    "CalibrationEvidence",
    "HrMaxProfile",
    "HeartRateZone",
    "PaceZone",
    "RunningActivity",
    "RunningCalibrationRepository",
    "RunningCalibrationRunSummary",
    "RunningCalibrationSnapshot",
    "RunningHealthRow",
    "RunningLap",
    "RunningSample",
    "RunningZoneSet",
    "compute_training_zones",
    "estimate_critical_power",
    "estimate_hrmax_profile",
    "estimate_rhr_baseline",
    "estimate_running_calibration",
    "recompute_running_calibration",
]
