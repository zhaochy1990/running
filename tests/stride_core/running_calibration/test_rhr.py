from __future__ import annotations

from datetime import date

import pytest

from stride_core.running_calibration.core import estimate_rhr_baseline
from stride_core.running_calibration.types import RunningHealthRow


def _rows(values: list[tuple[str, float | None]]) -> tuple[RunningHealthRow, ...]:
    return tuple(
        RunningHealthRow(date=date.fromisoformat(d), rhr=v) for d, v in values
    )


def test_returns_none_when_too_few_samples():
    rows = _rows([(f"2026-05-{i:02d}", 50.0) for i in range(1, 14)])  # 13 samples
    assert estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 20)) is None


def test_returns_p10_index_round():
    # Canonical p10 definition: round((N-1)*0.10) index of sorted asc.
    # N=20 → idx=round(1.9)=2 → 3rd smallest. Values 41..60 → idx 2 = 43.0
    rows = _rows([(f"2026-05-{i:02d}", float(40 + i)) for i in range(1, 21)])
    result = estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 25))
    assert result == 43.0


def test_excludes_rows_outside_90d_window():
    rows = _rows([
        ("2025-12-01", 30.0),  # outside window
        *((f"2026-05-{i:02d}", 50.0) for i in range(1, 21)),
    ])
    result = estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 25))
    assert result == 50.0  # outlier excluded


def test_ignores_none_and_nonpositive_rhr():
    rows = _rows([
        *((f"2026-05-{i:02d}", float(40 + i)) for i in range(1, 21)),
        ("2026-05-22", None),
        ("2026-05-23", 0.0),
        ("2026-05-24", -5.0),
    ])
    result = estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 25))
    assert result == 43.0  # same as canonical case
