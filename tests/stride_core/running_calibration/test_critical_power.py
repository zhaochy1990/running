from __future__ import annotations

from datetime import date

from stride_core.running_calibration.core import estimate_critical_power
from stride_core.running_calibration.types import RunningActivity, RunningSample


def _activity(
    label_id: str,
    activity_date: date,
    sport: str = "run_outdoor",
    avg_power_w: float | None = None,
    sample_powers: tuple[float | None, ...] = (),
) -> RunningActivity:
    return RunningActivity(
        label_id=label_id,
        activity_date=activity_date,
        sport=sport,
        avg_power_w=avg_power_w,
        samples=tuple(
            RunningSample(elapsed_s=float(i * 10), power_w=p)
            for i, p in enumerate(sample_powers)
        ),
    )


def test_returns_none_when_no_power_data():
    history = (_activity("a", date(2026, 5, 1)),)
    assert estimate_critical_power(history, as_of_date=date(2026, 5, 20)) == (None, 0)


def test_median_of_avg_and_sample_power():
    history = (
        _activity("a", date(2026, 5, 1), avg_power_w=240.0, sample_powers=(230.0, 250.0)),
        _activity("b", date(2026, 5, 10), avg_power_w=260.0, sample_powers=(255.0, 270.0)),
    )
    result, count = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    # values: [240, 230, 250, 260, 255, 270] sorted → median = (250+255)/2 = 252.5
    assert result == 252.5
    assert count == 6


def test_excludes_non_running_sports():
    history = (
        _activity("a", date(2026, 5, 1), sport="cycle", avg_power_w=200.0),
        _activity("b", date(2026, 5, 2), sport="run_outdoor", avg_power_w=300.0),
    )
    result, _ = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    assert result == 300.0


def test_excludes_outside_180d_window():
    history = (
        _activity("old", date(2025, 1, 1), avg_power_w=100.0),
        _activity("recent", date(2026, 5, 1), avg_power_w=250.0),
    )
    result, _ = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    assert result == 250.0


def test_clamps_out_of_range_power():
    history = (
        _activity("a", date(2026, 5, 1), avg_power_w=30.0),  # below MIN_RUNNING_POWER_W
        _activity("b", date(2026, 5, 2), avg_power_w=1500.0),  # above MAX
        _activity("c", date(2026, 5, 3), avg_power_w=250.0),
    )
    result, count = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    assert result == 250.0
    assert count == 1
