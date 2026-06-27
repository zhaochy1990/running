"""Training-environment awareness (altitude now, weather later).

Pure detection layer for the coach: classifies where + under what environmental
conditions the athlete is training, and how far along an acclimatization episode
they are — from altitude (and, later, weather) signals. No I/O; the adapter
layer gathers the series and calls :func:`build_training_environment`.
"""

from __future__ import annotations

from .training_environment import (
    Acclimatization,
    AltitudeBand,
    ChangePoint,
    TrainingEnvironment,
    assess_acclimatization,
    build_training_environment,
    classify_band,
    detect_change_point,
    per_run_altitude,
)

__all__ = [
    "Acclimatization",
    "AltitudeBand",
    "ChangePoint",
    "TrainingEnvironment",
    "assess_acclimatization",
    "build_training_environment",
    "classify_band",
    "detect_change_point",
    "per_run_altitude",
]
