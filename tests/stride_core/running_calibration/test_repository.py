from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta

from stride_core.running_calibration import recompute_running_calibration
from stride_core.running_calibration.types import RunningActivity, RunningCalibrationSnapshot, RunningSample


def _run(label_id: str, day: date) -> RunningActivity:
    return RunningActivity(
        label_id=label_id,
        activity_date=day,
        sport="run_outdoor",
        duration_s=3600,
        distance_m=14400,
        avg_hr=168,
        max_hr=184,
        samples=tuple(
            RunningSample(elapsed_s=float(t), distance_m=4.0 * t, heart_rate_bpm=168, speed_mps=4.0)
            for t in range(0, 3601, 60)
        ),
    )


class FakeRepository:
    def __init__(self, history: list[RunningActivity]) -> None:
        self.history = history
        self.fetch_calls: list[tuple[date, date]] = []
        self.saved: list[RunningCalibrationSnapshot] = []

    def fetch_history(self, start: date, end: date) -> list[RunningActivity]:
        self.fetch_calls.append((start, end))
        return [a for a in self.history if start <= a.activity_date <= end]

    def fetch_health_rows(self, start: date, end: date):
        return []

    def save_snapshot(self, snapshot: RunningCalibrationSnapshot) -> int:
        snapshot_id = len(self.saved) + 1
        self.saved.append(replace(snapshot, id=snapshot_id))
        return snapshot_id

    def fetch_latest(self, as_of_date: date | None = None) -> RunningCalibrationSnapshot | None:
        candidates = self.saved
        if as_of_date is not None:
            candidates = [s for s in candidates if s.as_of_date <= as_of_date]
        return candidates[-1] if candidates else None


def test_recompute_uses_repository_contract_without_sqlite():
    as_of = date(2026, 5, 1)
    repo = FakeRepository([_run("run1", as_of - timedelta(days=3))])

    summary = recompute_running_calibration(repo, as_of_date=as_of, lookback_days=30)

    assert repo.fetch_calls == [(as_of - timedelta(days=30), as_of)]
    assert len(repo.saved) == 1
    assert summary.activities_considered == 1
    assert summary.snapshot_id == 1
    assert summary.zones.heart_rate_zones
    assert summary.persist is True


def test_recompute_persist_false_does_not_save_snapshot():
    as_of = date(2026, 5, 1)
    repo = FakeRepository([_run("run1", as_of - timedelta(days=3))])

    summary = recompute_running_calibration(repo, as_of_date=as_of, lookback_days=30, persist=False)

    assert repo.saved == []
    assert summary.snapshot_id is None
    assert summary.snapshot.threshold_speed_mps is not None
    assert summary.persist is False


def test_recompute_passes_health_rows_to_estimator(monkeypatch):
    from datetime import date as _d
    from stride_core.running_calibration import recompute_running_calibration
    from stride_core.running_calibration.types import (
        RunningCalibrationSnapshot, RunningHealthRow, CalibrationConfidence,
    )

    captured: dict = {}

    def fake_estimate(history, as_of_date, *, health_rows=()):
        captured["health_rows"] = tuple(health_rows)
        captured["as_of_date"] = as_of_date
        return RunningCalibrationSnapshot(
            as_of_date=as_of_date,
            threshold_hr_confidence=CalibrationConfidence.NONE,
            threshold_speed_confidence=CalibrationConfidence.NONE,
            hrmax_confidence=CalibrationConfidence.NONE,
        )

    monkeypatch.setattr(
        "stride_core.running_calibration.repository.estimate_running_calibration",
        fake_estimate,
    )

    class FakeRepo:
        def fetch_history(self, start, end): return []
        def fetch_health_rows(self, start, end):
            return [RunningHealthRow(date=_d(2026, 5, 10), rhr=48.0)]
        def save_snapshot(self, snap): return 1
        def fetch_latest(self, as_of_date=None): return None

    repo = FakeRepo()
    summary = recompute_running_calibration(repo, as_of_date=_d(2026, 5, 20), persist=False)
    assert len(captured["health_rows"]) == 1
    assert captured["health_rows"][0].rhr == 48.0
