"""Specialist-context inputs for the weekly generator — see spec §4.

``PaceTargets`` (athlete pace table) and ``VolumeTargets`` (weekly volume
budget) are **computed by the adapter layer** (needs DB + running calibration)
but **consumed by the coach-core weekly prompt composer**. Core cannot import
adapter, so the *types* live here in core and the dependency points
adapter → core (the correct direction). Task 3 populates these from the DB;
this module only defines the shape + rendering + trivial validation. No DB,
no LLM, no network — pure pydantic so it stays import-linter clean.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


def fmt_pace_s_km(seconds_per_km: float) -> str:
    """Format a seconds-per-km pace as ``m:ss`` (e.g. ``242`` -> ``4:02``)."""
    total = int(round(seconds_per_km))
    minutes, secs = divmod(total, 60)
    return f"{minutes}:{secs:02d}"


class PaceTargets(BaseModel):
    """The athlete's real pace table, injected into the weekly prompt.

    All paces are seconds-per-km. The specialist is instructed to use *these*
    numbers, never the hard-coded "300 reference" sample paces.
    """

    easy_pace_low_s_km: float = Field(..., description="易/z2 区间快端（s/km）")
    easy_pace_high_s_km: float = Field(..., description="易/z2 区间慢端（s/km）")
    marathon_pace_s_km: float = Field(..., description="MP 马拉松目标配速（s/km）")
    threshold_pace_s_km: float = Field(..., description="阈值/LTHR 配速（s/km）")
    interval_pace_s_km: float = Field(..., description="间歇/5k/VO2max 配速（s/km）")
    rep_1000m_s_km: float | None = Field(None, description="1km rep 配速（s/km）")
    rep_400m_s_km: float | None = Field(None, description="400m rep 配速（s/km）")

    def render(self) -> str:
        """One-line pace table, e.g.
        ``z2 5:25-5:50 · MP 4:02 · 阈值 3:48 · VO2max(5k) 3:32 · 1km rep 3:30 · 400m rep 3:20``.
        """
        parts = [
            f"z2 {fmt_pace_s_km(self.easy_pace_low_s_km)}-{fmt_pace_s_km(self.easy_pace_high_s_km)}",
            f"MP {fmt_pace_s_km(self.marathon_pace_s_km)}",
            f"阈值 {fmt_pace_s_km(self.threshold_pace_s_km)}",
            f"VO2max(5k) {fmt_pace_s_km(self.interval_pace_s_km)}",
        ]
        if self.rep_1000m_s_km is not None:
            parts.append(f"1km rep {fmt_pace_s_km(self.rep_1000m_s_km)}")
        if self.rep_400m_s_km is not None:
            parts.append(f"400m rep {fmt_pace_s_km(self.rep_400m_s_km)}")
        return " · ".join(parts)


class VolumeTargets(BaseModel):
    """The week's volume budget, injected into the weekly prompt.

    The specialist fills the calendar within these km budgets rather than
    inventing mileage.
    """

    weekly_km: float = Field(..., description="本周总周量目标（km）")
    long_run_km: float = Field(..., description="长跑距离（km）")
    quality_km_budget: float = Field(..., description="质量课总 km 预算（km）")
    easy_km: float = Field(..., description="easy/z2 km（km）")

    @staticmethod
    def _fmt_km(km: float) -> str:
        # Drop a trailing ".0" so 100.0 renders as "100".
        if float(km).is_integer():
            return f"{int(km)}km"
        return f"{km:g}km"

    def render(self) -> str:
        """One-line volume budget, e.g.
        ``周量 100km · 长跑 30km · 质量预算 18km · easy 52km``.
        """
        return " · ".join(
            [
                f"周量 {self._fmt_km(self.weekly_km)}",
                f"长跑 {self._fmt_km(self.long_run_km)}",
                f"质量预算 {self._fmt_km(self.quality_km_budget)}",
                f"easy {self._fmt_km(self.easy_km)}",
            ]
        )
