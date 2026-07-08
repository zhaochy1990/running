"""Deterministic S2 weekly-plan quality probes used by local experiments.

This module is dev-only under ``coach_eval``. It does not judge style or replace
the LLM reviewer; it extracts the training-quality signals the weekly-plan lab
needs to compare prompt iterations with the same yardstick.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Iterable

from coach.schemas import SeasonPlanBundle
from stride_core.master_plan import MasterPlan, Milestone, MilestoneType, Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan


@dataclass(frozen=True)
class WeeklyQualityIssue:
    rule: str
    severity: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class WeekQualitySummary:
    phase_id: str
    phase_type: str
    week_folder: str
    week_start: str | None
    run_km: float
    longest_run_km: float
    quality_types: tuple[str, ...]
    hardish_run_count: int
    key_summaries: tuple[str, ...]


@dataclass(frozen=True)
class WeeklyQualityReport:
    issues: list[WeeklyQualityIssue]
    weeks: list[WeekQualitySummary]

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)


_HIGH_INTENSITY_TYPES = {"interval", "vo2max", "rep", "hill"}
_QUALITY_TYPES = _HIGH_INTENSITY_TYPES | {
    "threshold",
    "tempo",
    "mp",
    "cv",
    "race_pace",
    "test_run",
}


def _milestone_metric_kind(milestone: Milestone) -> str:
    metric = (milestone.metric or "").lower()
    if metric == "race_pace_km" or metric.startswith("race_pace"):
        return "race_pace"
    if metric in {"long_run_km", "long_run_distance_km"} or metric.startswith("long_run"):
        return "long_run"
    return metric


def evaluate_season_quality(
    master_plan: MasterPlan,
    bundle: SeasonPlanBundle,
) -> WeeklyQualityReport:
    """Evaluate generated weeks against training-quality heuristics.

    The checks intentionally mirror the user's requested review dimensions:
    load progression, phase-specific intensity fit, milestone embedding,
    quality-session rotation, and milestone achievability. All checks are
    deterministic and conservative; they flag issues for comparison and manual
    review rather than blocking production.
    """
    phase_by_id = {phase.id: phase for phase in master_plan.phases}
    phase_weeks = _collect_weeks(bundle)
    summaries = [
        _summarize_week(phase_id, str(phase_type), week)
        for phase_id, phase_type, week in phase_weeks
    ]

    issues: list[WeeklyQualityIssue] = []
    issues.extend(_check_generation_coverage(master_plan, bundle, summaries))
    issues.extend(_check_master_volume_match(master_plan, summaries))
    issues.extend(_check_load_progression(summaries))
    issues.extend(_check_phase_intensity_fit(summaries))
    issues.extend(_check_quality_rotation(summaries))
    issues.extend(_check_milestone_embedding(master_plan, summaries))
    issues.extend(_check_milestone_achievability(master_plan, summaries, phase_by_id))

    return WeeklyQualityReport(issues=issues, weeks=summaries)


def _collect_weeks(bundle: SeasonPlanBundle) -> list[tuple[str, PhaseType, dict]]:
    out: list[tuple[str, PhaseType, dict]] = []
    for phase_weeks in bundle.phases:
        for week in phase_weeks.weeks:
            out.append((phase_weeks.phase_id, phase_weeks.phase_type.value, week))
    return out


def _check_generation_coverage(
    master_plan: MasterPlan,
    bundle: SeasonPlanBundle,
    weeks: list[WeekQualitySummary],
) -> list[WeeklyQualityIssue]:
    master_weeks = list(master_plan.weeks or master_plan.weekly_key_sessions or [])
    if not master_weeks:
        return []

    expected = len(master_weeks)
    generated = len(weeks)
    if generated >= expected:
        return []

    expected_phase_ids = {str(week.phase_id) for week in master_weeks}
    generated_phase_ids = {str(phase_weeks.phase_id) for phase_weeks in bundle.phases if phase_weeks.weeks}
    missing_phase_ids = sorted(expected_phase_ids - generated_phase_ids)
    rule = "weekly_generation_empty" if generated == 0 else "weekly_generation_incomplete"
    return [
        WeeklyQualityIssue(
            rule=rule,
            severity="error",
            message=(
                f"generated {generated}/{expected} weekly plans from the master weekly skeleton; "
                "S2 must produce concrete weeks before training quality can be evaluated."
            ),
            details={
                "expected_weeks": expected,
                "generated_weeks": generated,
                "missing_phase_ids": missing_phase_ids,
            },
        )
    ]


def _master_week_target_km(raw_week: Any) -> float:
    high = getattr(raw_week, "target_weekly_km_high", None)
    low = getattr(raw_week, "target_weekly_km_low", None)
    try:
        high_f = float(high or 0.0)
    except (TypeError, ValueError):
        high_f = 0.0
    if high_f > 0:
        return high_f
    try:
        return float(low or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _check_master_volume_match(
    master_plan: MasterPlan,
    weeks: list[WeekQualitySummary],
) -> list[WeeklyQualityIssue]:
    master_weeks = list(master_plan.weeks or master_plan.weekly_key_sessions or [])
    if not master_weeks or not weeks:
        return []
    issues: list[WeeklyQualityIssue] = []
    for idx, (master_week, generated_week) in enumerate(zip(master_weeks, weeks), start=1):
        target = _master_week_target_km(master_week)
        if target <= 0:
            continue
        diff = round(generated_week.run_km - target, 1)
        if abs(diff) <= 1.0:
            continue
        issues.append(
            WeeklyQualityIssue(
                rule="weekly_volume_target_match",
                severity="warning",
                message=(
                    f"{generated_week.week_folder} generated {generated_week.run_km:.1f}km "
                    f"against master target {target:.1f}km."
                ),
                details={
                    "week_index": idx,
                    "week_folder": generated_week.week_folder,
                    "target_km": round(target, 1),
                    "generated_km": generated_week.run_km,
                    "diff_km": diff,
                },
            )
        )
    return issues


def _summarize_week(
    phase_id: str,
    phase_type: str,
    week: dict,
) -> WeekQualitySummary:
    plan = WeeklyPlan.from_dict(week)
    runs = [s for s in plan.sessions if s.kind == "run"]
    run_kms = [float(s.total_distance_m or 0.0) / 1000.0 for s in runs]
    ordered_sessions = sorted(plan.sessions, key=lambda s: (s.date, s.session_index))
    summaries = tuple(
        _normal_text(" ".join(filter(None, [s.summary, s.notes_md or ""])))
        for s in ordered_sessions
        if (s.summary or s.notes_md)
    )
    quality_types: list[str] = []
    for session in sorted(runs, key=lambda s: (s.date, s.session_index)):
        # Use the visible run title as the positive signal. Notes often contain
        # negated guardrails such as "不做 VO2max", which should not be counted
        # as a VO2max session.
        qtype = _quality_type(session.summary or "")
        if qtype is not None:
            quality_types.append(qtype)
    return WeekQualitySummary(
        phase_id=phase_id,
        phase_type=phase_type,
        week_folder=plan.week_folder,
        week_start=_week_start(plan.week_folder, [s.date for s in plan.sessions]),
        run_km=round(sum(run_kms), 1),
        longest_run_km=round(max(run_kms), 1) if run_kms else 0.0,
        quality_types=tuple(quality_types),
        hardish_run_count=sum(1 for q in quality_types if q in _QUALITY_TYPES),
        key_summaries=summaries,
    )


def _normal_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _quality_type(text: str) -> str | None:
    t = _normal_text(text)
    if any(token in t for token in ("测试", "test", "time trial")):
        return "test_run"
    if any(token in t for token in ("400m", "200m", "短间歇", "strides", "rep")):
        return "rep"
    has_5k_signal = re.search(r"(?<!\d)5k(?!m)", t) is not None
    has_10k_signal = re.search(r"(?<!\d)10k(?!m)", t) is not None
    if "vo2" in t or has_5k_signal or any(token in t for token in ("间歇", "interval")):
        return "vo2max" if "vo2" in t or has_5k_signal else "interval"
    if any(token in t for token in ("坡", "hill")):
        return "hill"
    if "cv" in t or has_10k_signal:
        return "cv"
    if any(token in t for token in ("阈值", "lthr", "threshold")):
        return "threshold"
    if any(token in t for token in ("tempo", "节奏")):
        return "tempo"
    if any(token in t for token in ("@ mp", " mp", "马拉松配速", "目标马拉松配速")):
        return "mp"
    if any(token in t for token in ("race pace", "比赛配速")):
        return "race_pace"
    return None


def _week_start(folder: str, dates: Iterable[str]) -> str | None:
    match = re.match(r"^(\d{4}-\d{2}-\d{2})", folder or "")
    if match:
        return match.group(1)
    parsed = []
    for raw in dates:
        try:
            parsed.append(date.fromisoformat(raw))
        except ValueError:
            pass
    if not parsed:
        return None
    monday = min(parsed) - timedelta(days=min(parsed).weekday())
    return monday.isoformat()


def _is_deload(prev_km: float, current_km: float) -> bool:
    return prev_km > 0 and current_km < prev_km * 0.88


def _check_load_progression(
    weeks: list[WeekQualitySummary],
) -> list[WeeklyQualityIssue]:
    issues: list[WeeklyQualityIssue] = []
    last_load_week_km: float | None = None
    prev_km: float | None = None
    for week in weeks:
        current = week.run_km
        is_deload = prev_km is not None and _is_deload(prev_km, current)
        if is_deload:
            cut = 1 - current / prev_km if prev_km else 0.0
            if week.phase_type != PhaseType.TAPER.value and cut > 0.305:
                issues.append(
                    WeeklyQualityIssue(
                        rule="deload_depth",
                        severity="warning",
                        message=(
                            f"{week.week_folder} cuts {cut:.0%} from prior week; "
                            "ordinary recovery weeks should usually cut 20-30%."
                        ),
                        details={"week_folder": week.week_folder, "cut": cut},
                    )
                )
        else:
            base = last_load_week_km if last_load_week_km is not None else prev_km
            if base and base > 0 and current > base * 1.10 + 0.25:
                issues.append(
                    WeeklyQualityIssue(
                        rule="weekly_progression",
                        severity="error",
                        message=(
                            f"{week.week_folder} jumps from {base:.1f}km load week "
                            f"to {current:.1f}km (>10%)."
                        ),
                        details={"week_folder": week.week_folder, "previous_load_km": base, "current_km": current},
                    )
                )
            last_load_week_km = current
        prev_km = current
    return issues


def _check_phase_intensity_fit(
    weeks: list[WeekQualitySummary],
) -> list[WeeklyQualityIssue]:
    issues: list[WeeklyQualityIssue] = []
    by_phase: dict[tuple[str, str], list[WeekQualitySummary]] = {}
    for week in weeks:
        by_phase.setdefault((week.phase_id, week.phase_type), []).append(week)

    for (phase_id, phase_type), phase_weeks in by_phase.items():
        qtypes = [qt for w in phase_weeks for qt in w.quality_types]
        high_count = sum(1 for qt in qtypes if qt in _HIGH_INTENSITY_TYPES)
        total_weeks = max(len(phase_weeks), 1)
        if phase_type in {PhaseType.BASE.value, PhaseType.RECOVERY.value} and high_count >= 2:
            issues.append(
                WeeklyQualityIssue(
                    rule="phase_intensity_fit",
                    severity="error",
                    message=f"{phase_type} phase contains repeated high-intensity work ({high_count} sessions).",
                    details={"phase_id": phase_id, "phase_type": phase_type, "high_count": high_count},
                )
            )
        if phase_type == PhaseType.SPEED.value and high_count == 0:
            issues.append(
                WeeklyQualityIssue(
                    rule="phase_intensity_fit",
                    severity="error",
                    message="speed phase has no clear VO2max/interval/hill/rep stimulus.",
                    details={"phase_id": phase_id, "phase_type": phase_type},
                )
            )
        if phase_type == PhaseType.BUILD.value:
            load_weeks = _load_weeks_for_phase(phase_weeks)
            medium_or_mp_weeks = sum(
                1
                for week in load_weeks
                if any(qt in {"threshold", "tempo", "mp", "cv", "race_pace"} for qt in week.quality_types)
            )
            min_required = max(1, len(load_weeks) - 1)
            if medium_or_mp_weeks < min_required:
                issues.append(
                    WeeklyQualityIssue(
                        rule="phase_intensity_fit",
                        severity="warning",
                        message="build phase lacks enough threshold/tempo/MP/CV work across the phase.",
                        details={
                            "phase_id": phase_id,
                            "medium_or_mp_weeks": medium_or_mp_weeks,
                            "load_weeks": len(load_weeks),
                            "weeks": total_weeks,
                        },
                    )
                )
        if phase_type == PhaseType.PEAK.value:
            mp_count = sum(1 for qt in qtypes if qt in {"mp", "race_pace"})
            if mp_count < max(1, total_weeks - 1):
                issues.append(
                    WeeklyQualityIssue(
                        rule="phase_intensity_fit",
                        severity="warning",
                        message="peak phase is not clearly MP/race-pace dominated.",
                        details={"phase_id": phase_id, "mp_count": mp_count, "weeks": total_weeks},
                    )
                )
    return issues


def _load_weeks_for_phase(weeks: list[WeekQualitySummary]) -> list[WeekQualitySummary]:
    """Return non-deload weeks for phase-level intensity coverage checks."""
    load_weeks: list[WeekQualitySummary] = []
    prev_km: float | None = None
    for week in weeks:
        if prev_km is not None and _is_deload(prev_km, week.run_km):
            prev_km = week.run_km
            continue
        load_weeks.append(week)
        prev_km = week.run_km
    return load_weeks


def _check_quality_rotation(
    weeks: list[WeekQualitySummary],
) -> list[WeeklyQualityIssue]:
    issues: list[WeeklyQualityIssue] = []
    streak_type: str | None = None
    streak = 0
    streak_folders: list[str] = []
    for week in weeks:
        primary = week.quality_types[0] if week.quality_types else None
        if primary and primary == streak_type:
            streak += 1
            streak_folders.append(week.week_folder)
        else:
            if streak >= 3 and streak_type:
                issues.append(_rotation_issue(streak_type, streak_folders))
            streak_type = primary
            streak = 1 if primary else 0
            streak_folders = [week.week_folder] if primary else []
    if streak >= 3 and streak_type:
        issues.append(_rotation_issue(streak_type, streak_folders))
    return issues


def _rotation_issue(session_type: str, folders: list[str]) -> WeeklyQualityIssue:
    return WeeklyQualityIssue(
        rule="quality_rotation",
        severity="warning",
        message=f"quality stimulus repeats as {session_type} for {len(folders)} consecutive weeks.",
        details={"quality_type": session_type, "week_folders": folders},
    )


def _check_milestone_embedding(
    master_plan: MasterPlan,
    weeks: list[WeekQualitySummary],
) -> list[WeeklyQualityIssue]:
    issues: list[WeeklyQualityIssue] = []
    generated_phase_ids = {week.phase_id for week in weeks}
    for milestone in master_plan.milestones:
        if not _is_weekly_embeddable_milestone(milestone):
            continue
        if milestone.phase_id not in generated_phase_ids:
            continue
        week = _week_for_milestone(weeks, milestone)
        if week is None:
            issues.append(
                WeeklyQualityIssue(
                    rule="milestone_embedding",
                    severity="error",
                    message=f"milestone on {milestone.date} has no generated week.",
                    details={"milestone_id": milestone.id, "date": milestone.date},
                )
            )
            continue
        if not _week_satisfies_milestone(week, milestone):
            issues.append(
                WeeklyQualityIssue(
                    rule="milestone_embedding",
                    severity="error",
                    message=f"{week.week_folder} does not embed milestone target: {milestone.target}",
                    details={
                        "milestone_id": milestone.id,
                        "week_folder": week.week_folder,
                        "target": milestone.target,
                        "metric": milestone.metric,
                        "target_value": milestone.target_value,
                    },
                )
            )
    return issues


def _is_weekly_embeddable_milestone(milestone: Milestone) -> bool:
    metric_kind = _milestone_metric_kind(milestone)
    if metric_kind in {"long_run", "race_pace"}:
        return True
    metric = (milestone.metric or "").lower()
    if metric.startswith("race_time_s"):
        return False
    return milestone.type in {
        MilestoneType.LONG_RUN,
        MilestoneType.RACE,
        MilestoneType.STRENGTH_TEST,
        MilestoneType.TEST_RUN,
    }


def _check_milestone_achievability(
    master_plan: MasterPlan,
    weeks: list[WeekQualitySummary],
    phase_by_id: dict[str, Phase],
) -> list[WeeklyQualityIssue]:
    issues: list[WeeklyQualityIssue] = []
    weeks_by_phase: dict[str, list[WeekQualitySummary]] = {}
    for week in weeks:
        weeks_by_phase.setdefault(week.phase_id, []).append(week)
    for milestone in master_plan.milestones:
        phase = phase_by_id.get(milestone.phase_id)
        if phase is None:
            continue
        phase_weeks = weeks_by_phase.get(phase.id, [])
        if not phase_weeks:
            continue
        metric_kind = _milestone_metric_kind(milestone)
        if metric_kind in {"long_run", "race_pace"} and milestone.target_value:
            max_long = max(w.longest_run_km for w in phase_weeks)
            if max_long + 0.5 < float(milestone.target_value):
                issues.append(
                    WeeklyQualityIssue(
                        rule="milestone_achievability",
                        severity="error",
                        message=(
                            f"phase max long run {max_long:.1f}km does not prepare for "
                            f"milestone {milestone.target_value:g}km."
                        ),
                        details={"milestone_id": milestone.id, "phase_id": phase.id, "max_long_run_km": max_long},
                    )
                )
    return issues


def _week_for_milestone(
    weeks: list[WeekQualitySummary],
    milestone: Milestone,
) -> WeekQualitySummary | None:
    try:
        mdate = date.fromisoformat(milestone.date)
    except ValueError:
        return None
    for week in weeks:
        if week.phase_id != milestone.phase_id or week.week_start is None:
            continue
        try:
            start = date.fromisoformat(week.week_start)
        except ValueError:
            continue
        if start <= mdate <= start + timedelta(days=6):
            return week
    return None


def _week_satisfies_milestone(week: WeekQualitySummary, milestone: Milestone) -> bool:
    metric_kind = _milestone_metric_kind(milestone)
    target_value = milestone.target_value
    all_text = " ".join(week.key_summaries)
    if metric_kind in {"long_run", "race_pace"} and target_value is not None:
        required = float(target_value)
        if metric_kind == "long_run":
            return week.longest_run_km + 0.5 >= required
        # race_pace_km is often described inside the long-run summary as an MP
        # segment. Prefer an explicit nearby number in MP context; otherwise the
        # longest run alone is not enough evidence.
        return _has_mp_segment_at_least(all_text, required)
    if milestone.type.value == "race":
        return any(token in all_text for token in ("race", "比赛", "马拉松"))
    if milestone.type.value == "strength_test":
        return any(token in all_text for token in ("力量", "提踵", "臀桥", "strength"))
    if milestone.type.value == "test_run":
        return any(token in all_text for token in ("测试", "test", "5k", "10k", "time trial"))
    return True


def _has_mp_segment_at_least(text: str, required_km: float) -> bool:
    t = _normal_text(text)
    if "mp" not in t and "马拉松配速" not in t and "目标马拉松配速" not in t:
        return False
    for match in re.finditer(r"(\d+(?:\.\d+)?)\s*km", t):
        value = float(match.group(1))
        window = t[max(0, match.start() - 20): match.end() + 20]
        if value + 0.5 >= required_km and any(token in window for token in ("mp", "马拉松配速", "目标马拉松配速")):
            return True
    return False


def report_to_dict(report: WeeklyQualityReport) -> dict[str, Any]:
    """JSON-friendly representation for experiment artifacts."""
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
                "phase_id": week.phase_id,
                "phase_type": week.phase_type,
                "week_folder": week.week_folder,
                "week_start": week.week_start,
                "run_km": week.run_km,
                "longest_run_km": week.longest_run_km,
                "quality_types": list(week.quality_types),
                "hardish_run_count": week.hardish_run_count,
                "key_summaries": list(week.key_summaries),
            }
            for week in report.weeks
        ],
    }
