"""Deterministic S1 master-plan weekly-volume quality checks.

This module is dev-only under ``coach_eval``. It evaluates the week-level
``MasterPlan.weeks`` skeleton so local experiments can compare master-plan
prompt iterations without invoking an LLM judge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from stride_core.master_plan import MasterPlan, MasterPlanWeek


@dataclass(frozen=True)
class MasterWeeklyQualityIssue:
    rule: str
    severity: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MasterWeekSummary:
    week_index: int
    week_start: str
    phase_id: str
    target_weekly_km_high: float
    is_recovery_week: bool
    is_taper_week: bool


@dataclass(frozen=True)
class MasterWeeklyQualityReport:
    issues: list[MasterWeeklyQualityIssue]
    weeks: list[MasterWeekSummary]

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)


def evaluate_master_weekly_quality(plan: MasterPlan) -> MasterWeeklyQualityReport:
    weeks = _summarize_weeks(plan.weeks or plan.weekly_key_sessions or [])
    issues: list[MasterWeeklyQualityIssue] = []
    if not weeks:
        issues.append(
            MasterWeeklyQualityIssue(
                rule="weekly_skeleton_present",
                severity="error",
                message="master plan has no week-level skeleton; S2 cannot consume weekly mileage targets.",
            )
        )
        return MasterWeeklyQualityReport(issues=issues, weeks=[])

    issues.extend(_check_load_week_ramp(weeks))
    issues.extend(_check_recovery_cut_depth(weeks))
    issues.extend(_check_post_recovery_rebound(weeks))
    return MasterWeeklyQualityReport(issues=issues, weeks=weeks)


def _summarize_weeks(weeks: list[MasterPlanWeek]) -> list[MasterWeekSummary]:
    ordered = sorted(weeks, key=lambda w: (w.week_index, w.week_start))
    out: list[MasterWeekSummary] = []
    for week in ordered:
        high = float(week.target_weekly_km_high or week.target_weekly_km_low or 0.0)
        out.append(
            MasterWeekSummary(
                week_index=int(week.week_index),
                week_start=str(week.week_start),
                phase_id=str(week.phase_id),
                target_weekly_km_high=round(high, 1),
                is_recovery_week=bool(week.is_recovery_week),
                is_taper_week=bool(week.is_taper_week),
            )
        )
    return out


def _is_recovery_like(week: MasterWeekSummary) -> bool:
    return week.is_recovery_week or week.is_taper_week


def _check_load_week_ramp(
    weeks: list[MasterWeekSummary], *, max_ratio: float = 1.10
) -> list[MasterWeeklyQualityIssue]:
    issues: list[MasterWeeklyQualityIssue] = []
    last_load: MasterWeekSummary | None = None
    last_recovery: MasterWeekSummary | None = None
    for week in weeks:
        if _is_recovery_like(week):
            last_recovery = week
            continue
        if last_load is not None and last_load.target_weekly_km_high > 0:
            ratio = week.target_weekly_km_high / last_load.target_weekly_km_high
            allowed = round(last_load.target_weekly_km_high * max_ratio, 1)
            if week.target_weekly_km_high > allowed + 0.25:
                details = {
                    "week_index": week.week_index,
                    "previous_load_week_index": last_load.week_index,
                    "previous_load_km": last_load.target_weekly_km_high,
                    "current_km": week.target_weekly_km_high,
                    "ratio": round(ratio, 3),
                    "allowed_km": allowed,
                }
                if last_recovery is not None:
                    details["recovery_trough_km"] = last_recovery.target_weekly_km_high
                issues.append(
                    MasterWeeklyQualityIssue(
                        rule="weekly_volume_ramp",
                        severity="error",
                        message=(
                            f"week {week.week_index} jumps from prior load week "
                            f"{last_load.target_weekly_km_high:.1f}km to "
                            f"{week.target_weekly_km_high:.1f}km (>10%)."
                        ),
                        details=details,
                    )
                )
        last_load = week
        last_recovery = None
    return issues


def _check_recovery_cut_depth(
    weeks: list[MasterWeekSummary], *, min_cut: float = 0.20, max_cut: float = 0.30
) -> list[MasterWeeklyQualityIssue]:
    issues: list[MasterWeeklyQualityIssue] = []
    last_load: MasterWeekSummary | None = None
    for week in weeks:
        if not _is_recovery_like(week):
            last_load = week
            continue
        if week.is_taper_week:
            continue
        if last_load is None or last_load.target_weekly_km_high <= 0:
            continue
        cut = 1.0 - week.target_weekly_km_high / last_load.target_weekly_km_high
        min_recovery_km = round(last_load.target_weekly_km_high * (1.0 - max_cut), 1)
        max_recovery_km = round(last_load.target_weekly_km_high * (1.0 - min_cut), 1)
        if week.target_weekly_km_high < min_recovery_km - 0.5 or week.target_weekly_km_high > max_recovery_km + 0.5:
            issues.append(
                MasterWeeklyQualityIssue(
                    rule="recovery_cut_depth",
                    severity="warning",
                    message=(
                        f"week {week.week_index} recovery cut is {cut:.0%}; "
                        "ordinary recovery weeks should usually cut 20-30%."
                    ),
                    details={
                        "week_index": week.week_index,
                        "previous_load_week_index": last_load.week_index,
                        "previous_load_km": last_load.target_weekly_km_high,
                        "recovery_km": week.target_weekly_km_high,
                        "cut": round(cut, 3),
                        "expected_recovery_km_range": [min_recovery_km, max_recovery_km],
                    },
                )
            )
    return issues


def _check_post_recovery_rebound(
    weeks: list[MasterWeekSummary], *, min_rebound_ratio: float = 0.90
) -> list[MasterWeeklyQualityIssue]:
    issues: list[MasterWeeklyQualityIssue] = []
    last_load_before_recovery: MasterWeekSummary | None = None
    pending_recovery: MasterWeekSummary | None = None
    current_load: MasterWeekSummary | None = None
    for week in weeks:
        if _is_recovery_like(week):
            if current_load is not None:
                last_load_before_recovery = current_load
                pending_recovery = week
            continue

        if pending_recovery is not None and last_load_before_recovery is not None:
            prior = last_load_before_recovery.target_weekly_km_high
            min_expected = round(prior * min_rebound_ratio, 1)
            if prior > 0 and week.target_weekly_km_high < min_expected - 1e-9:
                issues.append(
                    MasterWeeklyQualityIssue(
                        rule="post_recovery_rebound_suppressed",
                        severity="warning",
                        message=(
                            f"week {week.week_index} rebounds to only "
                            f"{week.target_weekly_km_high:.1f}km after recovery; "
                            f"compare with prior load {prior:.1f}km, not the trough."
                        ),
                        details={
                            "week_index": week.week_index,
                            "prior_load_week_index": last_load_before_recovery.week_index,
                            "prior_load_km": prior,
                            "recovery_week_index": pending_recovery.week_index,
                            "recovery_trough_km": pending_recovery.target_weekly_km_high,
                            "current_km": week.target_weekly_km_high,
                            "min_expected_km": min_expected,
                        },
                    )
                )
            pending_recovery = None
            last_load_before_recovery = None
        current_load = week
    return issues


def report_to_dict(report: MasterWeeklyQualityReport) -> dict[str, Any]:
    return {
        "ok": report.ok,
        "issues": [
            {
                "rule": issue.rule,
                "severity": issue.severity,
                "message": issue.message,
                "details": issue.details,
            }
            for issue in report.issues
        ],
        "weeks": [
            {
                "week_index": week.week_index,
                "week_start": week.week_start,
                "phase_id": week.phase_id,
                "target_weekly_km_high": week.target_weekly_km_high,
                "is_recovery_week": week.is_recovery_week,
                "is_taper_week": week.is_taper_week,
            }
            for week in report.weeks
        ],
    }
