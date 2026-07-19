"""Deterministic season-impact evaluation (pure, core layer).

Given a post-apply weekly plan and the active master plan, classify how the
change relates to the season intent. Kept small, explicit, and side-effect free
so it is fully unit-testable and never needs infrastructure. The adapter layer
(response enricher) supplies the master plan; core never imports storage.

Rules (§ backend contract):

* No active master, or the week maps to no phase → ``none``.
* Planned weekly volume below the phase's ``weekly_distance_km_low`` by more
  than ``MATERIAL_VOLUME_SHORTFALL`` (10%) → ``material``.
* A key session the phase depends on is deleted/replaced so the phase's key
  target can no longer be met (conservative rule: the phase is run-focused, the
  pre-apply week had run sessions, and the post-apply week has none) →
  ``material``.
* Below low but within the band → ``advisory``.
* Otherwise → ``none``.

The structural axis needs the pre-apply plan (``previous``); when the caller
can't supply it, only the volume axis runs. Both axes are pure; ``material``
wins over ``advisory`` wins over ``none``.
"""

from __future__ import annotations

from datetime import date

from coach.contracts import SeasonImpact
from stride_core.master_plan import MasterPlan, Phase
from stride_core.plan_spec import SessionKind, WeeklyPlan

# A weekly volume more than this fraction below the phase's low bound breaks the
# phase intent (material). Within the fraction is a tolerable deviation.
MATERIAL_VOLUME_SHORTFALL = 0.10

# Phase key-session labels that imply the phase's key target is delivered by
# running (long runs, quality/aerobic runs). If a phase leans on these and the
# apply strips every run out of a week that previously had one, the phase's key
# target for that week is unreachable — a material structural break.
_RUN_KEY_HINTS = ("跑", "run", "长距离", "有氧", "间歇", "节奏", "tempo", "interval")


def _folder_start_date(folder: str) -> date | None:
    """Parse the leading ``YYYY-MM-DD`` out of a week folder label."""
    head = folder[:10]
    try:
        return date.fromisoformat(head)
    except ValueError:
        return None


def _phase_for_week(master: MasterPlan, week_start: date) -> Phase | None:
    for phase in master.phases:
        try:
            start = date.fromisoformat(phase.start_date)
            end = date.fromisoformat(phase.end_date)
        except (ValueError, TypeError):
            continue
        if start <= week_start <= end:
            return phase
    return None


def _planned_distance_km(plan: WeeklyPlan) -> float:
    total_m = 0.0
    for session in plan.sessions:
        if session.total_distance_m:
            total_m += float(session.total_distance_m)
    return round(total_m / 1000.0, 3)


def _run_count(plan: WeeklyPlan) -> int:
    return sum(1 for s in plan.sessions if s.kind == SessionKind.RUN)


def _phase_is_run_focused(phase: Phase) -> bool:
    labels = " ".join(phase.key_session_types or []).lower()
    return any(hint.lower() in labels for hint in _RUN_KEY_HINTS)


# Keyword signatures for common phase key-session types. A phase's
# ``key_session_types`` label is matched to one of these buckets, then a weekly
# session is said to satisfy the key session when its kind + summary/notes text
# hit the same bucket's keywords.
_KEY_SESSION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "long_run": ("长距离", "长跑", "long run", "long", "lsd", "耐力跑"),
    "interval": ("间歇", "interval", "vo2", "重复跑", "reps", "yasso"),
    "tempo": ("节奏", "tempo", "threshold", "阈值", "乳酸"),
    "workout": ("专项", "workout", "quality", "配速", "pace", "马配"),
    "strength": ("力量", "strength", "核心", "core", "gym"),
    "aerobic": ("有氧", "aerobic", "easy", "轻松", "base", "恢复跑"),
}


def _session_text(session: Any) -> str:
    return f"{session.summary or ''} {session.notes_md or ''}".lower()


def _classify_key_session_type(label: str) -> str | None:
    """Map a phase ``key_session_types`` label to a keyword bucket."""
    low = label.lower()
    for bucket, keywords in _KEY_SESSION_KEYWORDS.items():
        if any(k in low for k in keywords):
            return bucket
    return None


def _week_satisfies_key_session(plan: WeeklyPlan, bucket: str) -> bool:
    """Does the week contain a session that fulfils this key-session bucket?"""
    keywords = _KEY_SESSION_KEYWORDS.get(bucket, ())
    for session in plan.sessions:
        if bucket == "strength":
            if session.kind == SessionKind.STRENGTH:
                return True
        elif session.kind != SessionKind.RUN:
            continue
        text = _session_text(session)
        if any(k in text for k in keywords):
            return True
    return False


def _broken_key_session_types(
    phase: Phase, *, previous: WeeklyPlan, adjusted: WeeklyPlan
) -> list[str]:
    """Phase key-session types the pre-apply week satisfied but the post-apply
    week no longer does (a key course was deleted or replaced).

    This is finer-grained than "0 runs left": deleting the phase's key long run
    while keeping an easy run still flags material, because the *specific* key
    session the phase depends on is gone.
    """
    broken: list[str] = []
    seen: set[str] = set()
    for label in phase.key_session_types or []:
        bucket = _classify_key_session_type(label)
        if bucket is None or bucket in seen:
            continue
        seen.add(bucket)
        if _week_satisfies_key_session(previous, bucket) and not _week_satisfies_key_session(
            adjusted, bucket
        ):
            broken.append(label)
    return broken


def _key_run_structure_broken(
    phase: Phase, *, previous: WeeklyPlan | None, adjusted: WeeklyPlan
) -> bool:
    """True when the apply removes/replaces every run of a run-focused phase.

    Conservative coarse fallback: fires when the phase depends on running, the
    pre-apply week had runs, and the post-apply week has none.
    """
    if previous is None:
        return False
    if not _phase_is_run_focused(phase):
        return False
    return _run_count(previous) > 0 and _run_count(adjusted) == 0


def evaluate_weekly_season_impact(
    plan: WeeklyPlan,
    *,
    master: MasterPlan | None,
    previous: WeeklyPlan | None = None,
) -> SeasonImpact:
    """Classify a post-apply weekly plan against the active master plan.

    ``previous`` is the pre-apply weekly plan; when supplied it enables the
    structural (key-session removal) axis in addition to the volume axis.
    """
    if master is None:
        return SeasonImpact(level="none")

    week_start = _folder_start_date(plan.week_folder)
    if week_start is None:
        return SeasonImpact(level="none")

    phase = _phase_for_week(master, week_start)
    if phase is None:
        return SeasonImpact(level="none")

    planned_km = _planned_distance_km(plan)
    low = float(phase.weekly_distance_km_low or 0.0)
    metrics: dict[str, float] = {
        "planned_distance_km": planned_km,
        "phase_weekly_low_km": low,
        "phase_weekly_high_km": float(phase.weekly_distance_km_high or 0.0),
    }

    reasons: list[str] = []

    # Structural axis (needs the pre-apply plan). Two rules, material either way:
    #  1. Fine-grained: a phase key-session type the week used to satisfy is no
    #     longer satisfied (e.g. the key long run was deleted but an easy run
    #     remains) — the specific key course is gone.
    #  2. Coarse fallback: a run-focused phase week lost ALL its runs.
    if previous is not None:
        broken_types = _broken_key_session_types(phase, previous=previous, adjusted=plan)
        if broken_types:
            reasons.append(
                f"调整删除/替换了 {phase.name} 阶段的关键课（"
                + "、".join(broken_types)
                + "），阶段关键目标无法达成"
            )
            return SeasonImpact(level="material", reasons=reasons, metrics=metrics)
    if _key_run_structure_broken(phase, previous=previous, adjusted=plan):
        reasons.append(
            f"调整删除/替换了 {phase.name} 阶段依赖的关键跑步课，"
            f"该周已无任何跑步课，阶段关键目标无法达成"
        )
        return SeasonImpact(level="material", reasons=reasons, metrics=metrics)

    # Volume axis.
    if low <= 0 or planned_km >= low:
        return SeasonImpact(level="none", metrics=metrics)

    shortfall = (low - planned_km) / low
    if shortfall > MATERIAL_VOLUME_SHORTFALL:
        return SeasonImpact(
            level="material",
            reasons=[
                f"本周计划里程 {planned_km:g}km 低于 {phase.name} 阶段目标下限 "
                f"{low:g}km 超过 10%"
            ],
            metrics=metrics,
        )
    return SeasonImpact(
        level="advisory",
        reasons=[
            f"本周计划里程 {planned_km:g}km 略低于 {phase.name} 阶段目标下限 {low:g}km"
        ],
        metrics=metrics,
    )
