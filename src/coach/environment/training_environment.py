"""Training-environment detector — pure, no I/O.

Detects the athlete's current training **altitude band** and whether they are in
an acute **acclimatization** episode after a significant altitude gain. The
acclimatization state is **signal-informed** (RHR / HRV trajectory vs the
pre-altitude baseline), not a fixed calendar — individuals adapt at different
rates. Code provides structured facts only; the LLM supplies the physiology.

Source-agnostic: consumes plain `(date, value)` series, so v1 can feed it from
the watch `timeseries`/`daily_*` tables and a future mobile app can feed phone
GPS without touching this module. The `weather` slot on
:class:`TrainingEnvironment` is reserved for that later extension.

See `spec/STRIDE_COACH_AGENT_ARCHITECTURE.md` and CLAUDE.md training-load doctrine.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel

# --- thresholds (detection logic; physiology lives in the LLM) ---------------
ALTITUDE_FLOOR_M = 1500.0     # below this, no altitude stress regardless of Δ
SIGNIFICANT_GAIN_M = 300.0    # a gain this large (into the stress zone) needs acclimatization
CHANGE_POINT_LOOKBACK_DAYS = 45  # older than this → treated as adapted, not an acute episode
RHR_DISTURBED_BPM = 4.0       # RHR this far above baseline = still perturbed
HRV_DISTURBED_FRAC = 0.10     # HRV this far (fraction) below baseline = still perturbed
_RECENT_SIGNAL_DAYS = 5       # window for "current" RHR/HRV
ACUTE_DAYS = 7                # calendar fallback when signal data is sparse
ADAPTING_DAYS = 21

AltitudeBand = Literal["sea_level", "low", "moderate", "high", "very_high"]
AcclimatizationStatus = Literal["disturbed", "recovering", "stabilized"]

# (date "YYYY-MM-DD" or ISO timestamp, value)
Point = tuple[str, float]


# ---------------------------------------------------------------------------
# Output models
# ---------------------------------------------------------------------------


class ChangePoint(BaseModel):
    """The most recent significant altitude gain (the 'you relocated' event)."""

    date: str
    from_altitude_m: float
    to_altitude_m: float
    gain_m: float
    days_since: int


class Acclimatization(BaseModel):
    """Signal-informed acclimatization state for an acute altitude-gain episode."""

    active: bool
    status: AcclimatizationStatus
    from_altitude_m: float
    to_altitude_m: float
    days_since: int
    rhr_baseline: float | None = None
    rhr_current: float | None = None
    rhr_delta_bpm: float | None = None
    hrv_baseline: float | None = None
    hrv_current: float | None = None
    hrv_delta_pct: float | None = None
    signal_based: bool = True  # False → status fell back to the calendar (sparse signals)


class TrainingEnvironment(BaseModel):
    """What the coach sees: where you train + acclimatization (+ weather later)."""

    current_altitude_m: float | None
    altitude_band: AltitudeBand
    at_altitude: bool
    acclimatization: Acclimatization | None = None
    weather: None = None  # reserved — populated by a future weather signal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_date(s: str) -> date:
    return date.fromisoformat(s[:10])


def _median(values: list[float]) -> float | None:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    mid = n // 2
    return vals[mid] if n % 2 else (vals[mid - 1] + vals[mid]) / 2.0


def per_run_altitude(samples: list[float | None]) -> float | None:
    """Representative altitude for one run = mean of its non-null samples."""
    vals = [float(s) for s in samples if s is not None]
    return sum(vals) / len(vals) if vals else None


def classify_band(altitude_m: float | None) -> AltitudeBand:
    if altitude_m is None or altitude_m < 1000:
        return "sea_level"
    if altitude_m < 1500:
        return "low"
    if altitude_m < 2500:
        return "moderate"
    if altitude_m < 3500:
        return "high"
    return "very_high"


def _recent_value(series: list[Point], as_of: date, days: int) -> float | None:
    """Median of a signal series within the last `days` before `as_of`."""
    cutoff_ordinal = as_of.toordinal() - days
    recent = [v for d, v in series if _to_date(d).toordinal() >= cutoff_ordinal]
    return _median(recent)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def detect_change_point(
    altitude_series: list[Point], *, as_of: date
) -> ChangePoint | None:
    """Most recent *significant altitude gain* into the stress zone.

    Robust to either a sharp move (one flight → next run jumps) or a stepped
    climb: finds the most recent run where the athlete was ≥``SIGNIFICANT_GAIN``
    *lower* than where they are now, and reports the transition right after it.
    Returns ``None`` when the athlete is below the floor, or has been at altitude
    longer than the lookback window (→ adapted, no acute episode).
    """
    series = sorted(altitude_series, key=lambda p: _to_date(p[0]))
    if not series:
        return None
    current = series[-1][1]
    if current is None or current < ALTITUDE_FLOOR_M:
        return None

    threshold = current - SIGNIFICANT_GAIN_M
    # Most recent run that sits significantly BELOW the current altitude.
    low_idx = None
    for i in range(len(series) - 1, -1, -1):
        if series[i][1] is not None and series[i][1] <= threshold:
            low_idx = i
            break
    if low_idx is None or low_idx == len(series) - 1:
        return None  # been at altitude the whole window → adapted

    from_alt = series[low_idx][1]
    arrival = series[low_idx + 1]  # first run after the low point
    to_alt = arrival[1]
    days_since = as_of.toordinal() - _to_date(arrival[0]).toordinal()
    if days_since > CHANGE_POINT_LOOKBACK_DAYS:
        return None  # the gain is old → treat as adapted

    return ChangePoint(
        date=_to_date(arrival[0]).isoformat(),
        from_altitude_m=round(from_alt, 1),
        to_altitude_m=round(to_alt, 1),
        gain_m=round(to_alt - from_alt, 1),
        days_since=days_since,
    )


def assess_acclimatization(
    change_point: ChangePoint | None,
    *,
    rhr_series: list[Point],
    hrv_series: list[Point],
    rhr_baseline: float | None,
    as_of: date,
) -> Acclimatization | None:
    """Classify acclimatization from RHR/HRV trajectory vs pre-altitude baseline.

    ``rhr_baseline`` comes from running_calibration (single source). The HRV
    baseline is the median HRV in the window *before* the change-point. When
    signal data is too sparse, falls back to a calendar phase from
    ``days_since``.
    """
    if change_point is None:
        return None

    cp_ordinal = _to_date(change_point.date).toordinal()

    def _baseline(series: list[Point]) -> float | None:
        before = [v for d, v in series if _to_date(d).toordinal() < cp_ordinal]
        return _median(before)

    rhr_base = rhr_baseline if rhr_baseline is not None else _baseline(rhr_series)
    hrv_base = _baseline(hrv_series)
    rhr_cur = _recent_value(rhr_series, as_of, _RECENT_SIGNAL_DAYS)
    hrv_cur = _recent_value(hrv_series, as_of, _RECENT_SIGNAL_DAYS)

    rhr_delta = round(rhr_cur - rhr_base, 1) if (rhr_cur is not None and rhr_base) else None
    hrv_delta_pct = (
        round((hrv_cur - hrv_base) / hrv_base * 100, 1)
        if (hrv_cur is not None and hrv_base)
        else None
    )

    status, signal_based = _classify_status(
        rhr_delta, hrv_delta_pct, days_since=change_point.days_since
    )
    return Acclimatization(
        active=status != "stabilized",
        status=status,
        from_altitude_m=change_point.from_altitude_m,
        to_altitude_m=change_point.to_altitude_m,
        days_since=change_point.days_since,
        rhr_baseline=round(rhr_base, 1) if rhr_base is not None else None,
        rhr_current=round(rhr_cur, 1) if rhr_cur is not None else None,
        rhr_delta_bpm=rhr_delta,
        hrv_baseline=round(hrv_base, 1) if hrv_base is not None else None,
        hrv_current=round(hrv_cur, 1) if hrv_cur is not None else None,
        hrv_delta_pct=hrv_delta_pct,
        signal_based=signal_based,
    )


def _classify_status(
    rhr_delta: float | None, hrv_delta_pct: float | None, *, days_since: int
) -> tuple[AcclimatizationStatus, bool]:
    """Signal-driven status; calendar fallback when no signals available."""
    have_signal = rhr_delta is not None or hrv_delta_pct is not None
    if not have_signal:
        if days_since <= ACUTE_DAYS:
            return "disturbed", False
        if days_since <= ADAPTING_DAYS:
            return "recovering", False
        return "stabilized", False

    disturbed = (rhr_delta is not None and rhr_delta >= RHR_DISTURBED_BPM) or (
        hrv_delta_pct is not None and hrv_delta_pct <= -HRV_DISTURBED_FRAC * 100
    )
    if disturbed:
        return "disturbed", True
    # Not perturbed on any signal we have → adapted. The check is **one-sided**,
    # mirroring `disturbed`: only an *elevated* RHR / *suppressed* HRV blocks
    # `stabilized`. A better-than-baseline athlete (RHR below, HRV above
    # baseline — common once adapted/fitter) is stabilized, not stuck recovering.
    rhr_ok = rhr_delta is None or rhr_delta < RHR_DISTURBED_BPM
    hrv_ok = hrv_delta_pct is None or hrv_delta_pct > -HRV_DISTURBED_FRAC * 100
    if rhr_ok and hrv_ok:
        return "stabilized", True
    return "recovering", True


def build_training_environment(
    *,
    altitude_series: list[Point],
    rhr_series: list[Point] | None = None,
    hrv_series: list[Point] | None = None,
    rhr_baseline: float | None = None,
    as_of: date,
) -> TrainingEnvironment:
    """Assemble the full training-environment view for the coach."""
    series = sorted(altitude_series, key=lambda p: _to_date(p[0]))
    current = series[-1][1] if series else None
    change_point = detect_change_point(series, as_of=as_of)
    acclimatization = assess_acclimatization(
        change_point,
        rhr_series=rhr_series or [],
        hrv_series=hrv_series or [],
        rhr_baseline=rhr_baseline,
        as_of=as_of,
    )
    return TrainingEnvironment(
        current_altitude_m=round(current, 1) if current is not None else None,
        altitude_band=classify_band(current),
        at_altitude=current is not None and current >= ALTITUDE_FLOOR_M,
        acclimatization=acclimatization,
    )
