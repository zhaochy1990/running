"""Per-activity time-in-zone, computed from STRIDE calibration zones.

This replaces ingestion of a provider's own zone buckets (COROS `zoneList`,
Garmin's HR-zone API). We classify each timeseries sample into a STRIDE pace
zone and HR zone — boundaries from `running_calibration` — and accumulate the
dwell time, so the activity page's zones match the Training Status page's zones
and never depend on a provider's (churning) zone encoding.

Pure compute: no DB access. The DB-facing orchestration that loads samples and
calibration zones, then persists the rows, lives in the post-sync handler.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .models import Zone
from .running_calibration.types import HeartRateZone, PaceZone

# Physiological order → 1-based index, matching the watch's zone numbering and
# the fixed Z1..Z6 labels the frontend renders by position.
ZONE_INDEX: dict[str, int] = {
    "recovery": 1,
    "easy": 2,
    "marathon": 3,
    "threshold": 4,
    "interval": 5,
    "repetition": 6,
}


@dataclass(frozen=True)
class ZoneSample:
    """One timeseries point reduced to what zone classification needs."""

    dwell_s: float
    speed_mps: float | None
    hr_bpm: float | None


def _pace_zone_for_speed(speed_mps: float, zones: Sequence[PaceZone]) -> PaceZone | None:
    # Zone bounds are speeds: min_speed_mps (slow edge) .. max_speed_mps (fast
    # edge); None = open. Contiguous half-open [min, max) so each speed lands in
    # exactly one zone.
    for zone in zones:
        lo, hi = zone.min_speed_mps, zone.max_speed_mps
        if (lo is None or speed_mps >= lo) and (hi is None or speed_mps < hi):
            return zone
    return None


def _hr_zone_for_bpm(hr_bpm: float, zones: Sequence[HeartRateZone]) -> HeartRateZone | None:
    for zone in zones:
        lo, hi = zone.min_bpm, zone.max_bpm
        if (lo is None or hr_bpm >= lo) and (hi is None or hr_bpm < hi):
            return zone
    return None


def _pace_ms_per_km(speed_s_per_km: float | None) -> float | None:
    # The `zones` table stores pace bounds in milliseconds-per-km (the frontend
    # divides by 1000); calibration carries seconds-per-km.
    if speed_s_per_km is None:
        return None
    return round(speed_s_per_km * 1000)


def compute_activity_time_in_zone(
    samples: Sequence[ZoneSample],
    pace_zones: Sequence[PaceZone],
    hr_zones: Sequence[HeartRateZone],
) -> list[Zone]:
    """Build `zones`-table rows from samples + STRIDE zone boundaries.

    Emits every defined zone (0-duration ones included, as the providers did) so
    the activity card shows the full ladder. Percent is each zone's share of the
    metric's total classified dwell, so pace percents and HR percents each sum to
    ~100 independently (a treadmill run with no GPS yields HR rows only).
    """

    pace_dwell: dict[str, float] = {z.name: 0.0 for z in pace_zones}
    hr_dwell: dict[str, float] = {z.name: 0.0 for z in hr_zones}

    for sample in samples:
        if sample.speed_mps is not None and pace_zones:
            zone = _pace_zone_for_speed(sample.speed_mps, pace_zones)
            if zone is not None:
                pace_dwell[zone.name] += sample.dwell_s
        if sample.hr_bpm is not None and hr_zones:
            zone = _hr_zone_for_bpm(sample.hr_bpm, hr_zones)
            if zone is not None:
                hr_dwell[zone.name] += sample.dwell_s

    rows: list[Zone] = []

    pace_total = sum(pace_dwell.values())
    for zone in pace_zones:
        seconds = pace_dwell[zone.name]
        rows.append(
            Zone(
                zone_type="pace",
                zone_index=ZONE_INDEX[zone.name],
                range_min=_pace_ms_per_km(zone.min_pace_s_per_km),
                range_max=_pace_ms_per_km(zone.max_pace_s_per_km),
                range_unit="pace",
                duration_s=round(seconds),
                percent=round(100.0 * seconds / pace_total, 1) if pace_total > 0 else 0.0,
            )
        )

    hr_total = sum(hr_dwell.values())
    for zone in hr_zones:
        seconds = hr_dwell[zone.name]
        rows.append(
            Zone(
                zone_type="heartRate",
                zone_index=ZONE_INDEX[zone.name],
                range_min=round(zone.min_bpm) if zone.min_bpm is not None else None,
                range_max=round(zone.max_bpm) if zone.max_bpm is not None else None,
                range_unit="bpm",
                duration_s=round(seconds),
                percent=round(100.0 * seconds / hr_total, 1) if hr_total > 0 else 0.0,
            )
        )

    return rows


def dwell_seconds(elapsed_s: Sequence[float | None]) -> list[float]:
    """Per-sample dwell from monotonic elapsed seconds.

    Each sample's dwell is the gap to the next sample. Gaps far larger than the
    typical cadence (device paused / signal dropout) are clamped to the median
    cadence so a stop doesn't dump minutes into whatever zone preceded it. The
    final sample inherits the median cadence.
    """
    clean = [float(e) for e in elapsed_s if e is not None]
    if len(clean) < 2:
        return [1.0] * len(clean)
    deltas = [b - a for a, b in zip(clean, clean[1:]) if b > a]
    if not deltas:
        return [1.0] * len(clean)
    ordered = sorted(deltas)
    median = ordered[len(ordered) // 2] or 1.0
    cap = median * 5
    # A gap far above the typical cadence is a pause / signal dropout — count it
    # as one nominal sample, not the whole stop. The last sample (no successor)
    # inherits the median cadence.
    dwell = [d if 0 < d <= cap else median for d in (deltas + [median])]
    return dwell
