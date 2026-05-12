"""Unit tests for stride_core.timeseries.downsample_series."""

from __future__ import annotations

from stride_core.timeseries import downsample_series


def test_downsample_equal_length_mean():
    # 10 points, target 5 → 2 per bucket; means = (1+2)/2, (3+4)/2, ...
    out = downsample_series([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0], 5)
    assert out == [1.5, 3.5, 5.5, 7.5, 9.5]


def test_downsample_shorter_than_target_returns_input():
    out = downsample_series([1.0, 2.0, 3.0], 10)
    assert out == [1.0, 2.0, 3.0]


def test_downsample_preserves_none():
    out = downsample_series([None, None, 4.0, 6.0], 2)
    # Bucket 0 = [None, None] → None; bucket 1 = [4,6] → 5
    assert out == [None, 5.0]


def test_downsample_target_one_overall_mean():
    out = downsample_series([2.0, 4.0, None, 6.0], 1)
    assert out == [4.0]


def test_downsample_empty_input():
    assert downsample_series([], 5) == []
