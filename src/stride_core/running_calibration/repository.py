"""Repository protocol and orchestration for running calibration."""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
from typing import Protocol

from stride_core.timefmt import today_shanghai

from .core import estimate_running_calibration
from .types import RunningActivity, RunningCalibrationRunSummary, RunningCalibrationSnapshot
from .zones import compute_training_zones


class RunningCalibrationRepository(Protocol):
    def fetch_history(self, start: date, end: date) -> list[RunningActivity]: ...

    def save_snapshot(self, snapshot: RunningCalibrationSnapshot) -> str | int: ...

    def fetch_latest(self, as_of_date: date | None = None) -> RunningCalibrationSnapshot | None: ...


def recompute_running_calibration(
    repo: RunningCalibrationRepository,
    *,
    as_of_date: date | None = None,
    lookback_days: int = 180,
    persist: bool = True,
) -> RunningCalibrationRunSummary:
    end = as_of_date or today_shanghai()
    start = end - timedelta(days=lookback_days)
    history = repo.fetch_history(start, end)
    snapshot = estimate_running_calibration(history, end)
    snapshot_id: str | int | None = None
    if persist:
        snapshot_id = repo.save_snapshot(snapshot)
        snapshot = replace(snapshot, id=snapshot_id)
    zones = compute_training_zones(snapshot)
    return RunningCalibrationRunSummary(
        snapshot=snapshot,
        zones=zones,
        activities_considered=len(history),
        snapshot_id=snapshot_id,
        start=start,
        end=end,
        persist=persist,
    )
