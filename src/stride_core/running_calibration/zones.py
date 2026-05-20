"""Training-zone generation from running calibration snapshots."""

from __future__ import annotations

from .types import (
    CalibrationConfidence,
    HeartRateZone,
    PaceZone,
    RunningCalibrationSnapshot,
    RunningZoneSet,
)

ZONE_NAMES = ("recovery", "easy", "marathon", "threshold", "interval", "repetition")

# Expressed as speed ranges relative to threshold speed. Pace bounds are the
# inverse of these speed bounds, so faster zones have smaller s/km values.
PACE_ZONE_SPEED_RATIOS: dict[str, tuple[float | None, float | None]] = {
    "recovery": (None, 0.72),
    "easy": (0.72, 0.84),
    "marathon": (0.84, 0.97),
    "threshold": (0.97, 1.03),
    "interval": (1.03, 1.11),
    "repetition": (1.11, None),
}

HR_ZONE_RATIOS: dict[str, tuple[float | None, float | None]] = {
    "recovery": (None, 0.80),
    "easy": (0.80, 0.88),
    "marathon": (0.88, 0.94),
    "threshold": (0.94, 1.01),
    "interval": (1.01, 1.06),
    "repetition": (1.06, None),
}


def _pace_s_per_km(speed_mps: float | None) -> float | None:
    if speed_mps is None or speed_mps <= 0:
        return None
    return 1000.0 / speed_mps


def compute_training_zones(snapshot: RunningCalibrationSnapshot) -> RunningZoneSet:
    pace_zones: list[PaceZone] = []
    if snapshot.threshold_speed_mps is not None and snapshot.threshold_speed_mps > 0:
        threshold = float(snapshot.threshold_speed_mps)
        for name in ZONE_NAMES:
            low_ratio, high_ratio = PACE_ZONE_SPEED_RATIOS[name]
            low_speed = threshold * low_ratio if low_ratio is not None else None
            high_speed = threshold * high_ratio if high_ratio is not None else None
            pace_zones.append(
                PaceZone(
                    name=name,
                    min_pace_s_per_km=_pace_s_per_km(high_speed),
                    max_pace_s_per_km=_pace_s_per_km(low_speed),
                    min_speed_mps=low_speed,
                    max_speed_mps=high_speed,
                    confidence=snapshot.threshold_speed_confidence,
                )
            )

    hr_zones: list[HeartRateZone] = []
    if snapshot.threshold_hr is not None and snapshot.threshold_hr > 0:
        threshold_hr = float(snapshot.threshold_hr)
        for name in ZONE_NAMES:
            low_ratio, high_ratio = HR_ZONE_RATIOS[name]
            hr_zones.append(
                HeartRateZone(
                    name=name,
                    min_bpm=threshold_hr * low_ratio if low_ratio is not None else None,
                    max_bpm=threshold_hr * high_ratio if high_ratio is not None else None,
                    confidence=snapshot.threshold_hr_confidence,
                )
            )
    elif snapshot.rhr_baseline is not None and snapshot.hrmax_estimate is not None:
        rhr = float(snapshot.rhr_baseline)
        hrmax = float(snapshot.hrmax_estimate)
        if hrmax > rhr:
            hrr_ranges = {
                "recovery": (0.55, 0.65),
                "easy": (0.65, 0.75),
                "marathon": (0.75, 0.82),
                "threshold": (0.82, 0.88),
                "interval": (0.88, 0.94),
                "repetition": (0.94, 1.0),
            }
            for name in ZONE_NAMES:
                low, high = hrr_ranges[name]
                hr_zones.append(
                    HeartRateZone(
                        name=name,
                        min_bpm=rhr + (hrmax - rhr) * low,
                        max_bpm=rhr + (hrmax - rhr) * high,
                        confidence=CalibrationConfidence.LOW,
                    )
                )

    return RunningZoneSet(
        as_of_date=snapshot.as_of_date,
        snapshot_id=snapshot.id,
        pace_zones=tuple(pace_zones),
        heart_rate_zones=tuple(hr_zones),
    )
