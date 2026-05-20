"""Running threshold calibration algorithms and repository orchestration."""

from .core import estimate_hrmax_profile, estimate_running_calibration
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
    "RunningLap",
    "RunningSample",
    "RunningZoneSet",
    "compute_training_zones",
    "estimate_running_calibration",
    "estimate_hrmax_profile",
    "recompute_running_calibration",
]
