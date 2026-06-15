"""Season-aggregate rule filter — cross-phase / cross-week coherence (Stage-3b T3).

The per-week :mod:`coach.graphs.generation.rule_filter` only sees one week at a
time (with at most a ``prev_week_km`` baseline that resets at every phase
boundary). It therefore *cannot* catch problems that only appear when the whole
generated season is laid end-to-end: a volume spike that straddles a
phase boundary, a taper that doesn't actually drop below the peak, a speed phase
that schedules no speed work, or a season that silently shed half its weeks to
the per-week filter's blocked-week budget.

``run_season_rule_filter`` runs five deterministic checks over a
:class:`coach.schemas.SeasonPlanBundle` + its :class:`stride_core.master_plan.MasterPlan`
and aggregates the result into a :class:`SeasonRuleReport`.

This module is intentionally LLM-free and DB-free (coach-core import-linter
contract): allowed deps are ``stride_core.{master_plan,plan_spec}`` and
``coach.*`` only. Per-week run-km summation is single-sourced by importing
``rule_filter._total_run_distance_m`` rather than re-deriving it here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from stride_core.master_plan import MasterPlan, Milestone, MilestoneType, PhaseType
from stride_core.plan_spec import WeeklyPlan

from coach.schemas import PhaseWeeks, SeasonPlanBundle

from .rule_filter import _total_run_distance_m

# ---------------------------------------------------------------------------
# Tunable constants (named so thresholds are reviewable in one place)
# ---------------------------------------------------------------------------

#: Max allowed week-over-week UP-step in run km (deload/taper down-steps are
#: always fine). Same 1.10x cap the per-week ``check_weekly_progression`` uses.
UP_STEP_RATIO_CAP = 1.10

#: Blocked-week budget thresholds (fraction of total planned weeks excluded).
BLOCKED_WARN_FRACTION = 0.15
BLOCKED_ERROR_FRACTION = 0.40

#: Phase types whose volume is allowed (expected) to fall — a down-step on the
#: boundary into one of these is never a spike concern.
_DELOAD_PHASE_TYPES = {PhaseType.TAPER, PhaseType.RECOVERY}

#: Milestone-coverage keyword map. Small + documented on purpose: each entry maps
#: a quantifiable-milestone *metric prefix* (matched as a lowercase substring of
#: the milestone's ``metric`` field, falling back to its ``target`` text) to the
#: keyword tokens we expect to see in at least one of the phase's session
#: ``summary``/``notes_md`` strings. Stage-3a sessions are aspirational
#: (``spec=None``), so this is necessarily a lenient keyword heuristic and only
#: ever emits warnings.
MILESTONE_COVERAGE_KEYWORDS: dict[str, tuple[str, ...]] = {
    # short-distance speed / VO2max metrics
    "race_time_s_5k": ("interval", "vo2", "5k", "5公里", "间歇", "速度", "track"),
    "race_time_s_10k": ("interval", "vo2", "10k", "10公里", "间歇", "tempo", "threshold", "节奏"),
    # threshold / half work
    "race_time_s_hm": ("tempo", "threshold", "节奏", "marathon pace", "mp", "race pace", "half"),
    # marathon — race-pace long runs
    "race_time_s_fm": ("marathon pace", "mp", "race pace", "long", "长距离", "比赛配速"),
    # body-composition phases — heuristic on strength / S&C presence
    "body_fat_pct": ("strength", "力量", "s&c", "core", "核心", "lift"),
    "skeletal_muscle": ("strength", "力量", "s&c", "lift", "核心"),
    "weight": ("strength", "力量", "s&c", "easy", "有氧", "aerobic"),
}

#: Taper "new hard stimulus" keyword heuristic (warning-level). A taper week
#: whose summaries newly introduce one of these is suspicious — taper should
#: sharpen with familiar race-pace touches, not bolt on a novel hard session.
_TAPER_NEW_STIMULUS_KEYWORDS = (
    "vo2",
    "max effort",
    "all-out",
    "time trial",
    "tt",
    "hill repeat",
    "新",
    "测试",
)


# ---------------------------------------------------------------------------
# Report dataclasses (mirror rule_filter.RuleViolation / RuleFilterReport)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SeasonRuleViolation:
    """One season-level rule failure with enough context to act on."""

    rule: str
    severity: str  # 'error' | 'warning'
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SeasonRuleReport:
    violations: list[SeasonRuleViolation]

    @property
    def ok(self) -> bool:
        return not any(v.severity == "error" for v in self.violations)

    def errors(self) -> list[SeasonRuleViolation]:
        return [v for v in self.violations if v.severity == "error"]

    def warnings(self) -> list[SeasonRuleViolation]:
        return [v for v in self.violations if v.severity == "warning"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _week_km(week_dict: dict) -> float | None:
    """Run km for one WeeklyPlan dict, or ``None`` if it won't parse.

    Single-sources the per-week summation via ``rule_filter._total_run_distance_m``;
    an unparseable week dict is treated as absent (``None``) so a structurally
    broken week degrades gracefully instead of crashing the season pass.
    """
    try:
        plan = WeeklyPlan.from_dict(week_dict)
    except Exception:  # noqa: BLE001 — parse boundary, degrade to "absent"
        return None
    return _total_run_distance_m(plan) / 1000.0


def _phase_week_kms(phase: PhaseWeeks) -> list[float]:
    """Present (parseable) per-week run km for a phase, in order."""
    out: list[float] = []
    for w in phase.weeks:
        km = _week_km(w)
        if km is not None:
            out.append(km)
    return out


def _phase_session_texts(phase: PhaseWeeks) -> list[str]:
    """Lowercased summary + notes_md text of every session in a phase."""
    texts: list[str] = []
    for w in phase.weeks:
        for s in w.get("sessions", []) or []:
            if not isinstance(s, dict):
                continue
            for key in ("summary", "notes_md"):
                val = s.get(key)
                if val:
                    texts.append(str(val).lower())
    return texts


def _quantifiable_milestones_for_phase(
    phase_id: str, master_plan: MasterPlan
) -> list[Milestone]:
    """Milestones owned by ``phase_id`` that carry a quantifiable signal.

    A milestone is "quantifiable" for coverage purposes when it has a structured
    ``metric`` OR is a perf/body-comp type (race / test_run / body_composition)
    whose ``target`` text we can keyword against.
    """
    out: list[Milestone] = []
    quant_types = {
        MilestoneType.RACE,
        MilestoneType.TEST_RUN,
        MilestoneType.BODY_COMPOSITION,
    }
    for m in master_plan.milestones:
        if m.phase_id != phase_id:
            continue
        if m.metric or m.type in quant_types:
            out.append(m)
    return out


def _coverage_keywords_for_milestone(m: Milestone) -> tuple[str, ...] | None:
    """Resolve the keyword token set we expect for a milestone, or None.

    Match the milestone's structured ``metric`` (lowercased substring) against
    :data:`MILESTONE_COVERAGE_KEYWORDS`; if unset, fall back to scanning the
    free-text ``target`` for any mapped metric-prefix. Returns ``None`` when the
    milestone carries no recognizable quantifiable signal (→ no warning).
    """
    if m.metric:
        metric = m.metric.lower()
        for prefix, kws in MILESTONE_COVERAGE_KEYWORDS.items():
            if prefix in metric:
                return kws
    # Fall back to the natural-language target text.
    target = (m.target or "").lower()
    for prefix, kws in MILESTONE_COVERAGE_KEYWORDS.items():
        # the bare metric name rarely appears in target; instead probe its kws
        if any(tok in target for tok in kws):
            return kws
    return None


def _planned_weeks_for_phase(phase: PhaseWeeks) -> int:
    """Total weeks the phase was meant to have = present + blocked."""
    return len(phase.weeks) + int(phase.blocked_week_count)


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def check_volume_arc(bundle: SeasonPlanBundle) -> list[SeasonRuleViolation]:
    """Season-spanning week-over-week UP-step cap (≤ 1.10x).

    Flatten every present week across all phases in order and compare each week
    to the previous *present* week. An UP-step above the cap is an error; any
    down-step (deload / taper) is always fine.

    Gap handling: blocked / excluded weeks create gaps in the flattened series.
    We compare consecutive *present* weeks only, but to avoid a known-blocked gap
    manufacturing a false spike, the UP-step check is **skipped across a phase
    boundary whose owning phase reported ``blocked_week_count > 0``** (the
    boundary is handled with phase context by :func:`check_phase_transition`).
    Within a phase, gaps from blocked weeks are likewise not visible here because
    only present weeks are flattened — the ratio is between actually-generated
    adjacent weeks, which is the conservative reading (we don't invent the
    missing intermediate week's km).
    """
    violations: list[SeasonRuleViolation] = []
    # Build a flat list of (phase_index, week_km), only present weeks.
    flat: list[tuple[int, float]] = []
    for pi, phase in enumerate(bundle.phases):
        for km in _phase_week_kms(phase):
            flat.append((pi, km))

    for idx in range(1, len(flat)):
        prev_pi, prev_km = flat[idx - 1]
        cur_pi, cur_km = flat[idx]
        if prev_km <= 0:
            continue
        # Cross-phase steps are owned by check_phase_transition (richer context);
        # skip here to avoid double-reporting the exact same boundary spike.
        if cur_pi != prev_pi:
            continue
        ratio = cur_km / prev_km
        if ratio > UP_STEP_RATIO_CAP:
            phase = bundle.phases[cur_pi]
            violations.append(
                SeasonRuleViolation(
                    rule="volume_arc",
                    severity="error",
                    message=(
                        f"phase {phase.phase_id!r}: weekly run volume jumped "
                        f"{ratio:.2f}x ({prev_km:.1f}km → {cur_km:.1f}km); cap is "
                        f"{UP_STEP_RATIO_CAP:.2f}x"
                    ),
                    details={
                        "phase_id": phase.phase_id,
                        "previous_km": prev_km,
                        "current_km": cur_km,
                        "ratio": ratio,
                    },
                )
            )
    return violations


def check_phase_transition(bundle: SeasonPlanBundle) -> list[SeasonRuleViolation]:
    """First present week of phase N+1 vs last present week of phase N.

    An increase above the cap is an error reported *with phase context* (which
    transition spiked). A down-step (planned deload / taper drop) is fine. When
    the prior phase has no present weeks (all blocked) there is no baseline, so
    the transition is skipped — that gap is the blocked-week budget rule's job,
    not a manufactured spike here.
    """
    violations: list[SeasonRuleViolation] = []
    prev_phase: PhaseWeeks | None = None
    prev_last_km: float | None = None

    for phase in bundle.phases:
        kms = _phase_week_kms(phase)
        if not kms:
            # No present weeks in this phase — it can't anchor a transition, and
            # it shouldn't reset the baseline either (treat as a gap).
            continue
        first_km = kms[0]
        if prev_phase is not None and prev_last_km is not None and prev_last_km > 0:
            ratio = first_km / prev_last_km
            if ratio > UP_STEP_RATIO_CAP:
                violations.append(
                    SeasonRuleViolation(
                        rule="phase_transition",
                        severity="error",
                        message=(
                            f"phase transition {prev_phase.phase_id!r} → "
                            f"{phase.phase_id!r}: first week {first_km:.1f}km is "
                            f"{ratio:.2f}x the prior phase's last week "
                            f"{prev_last_km:.1f}km (cap {UP_STEP_RATIO_CAP:.2f}x)"
                        ),
                        details={
                            "from_phase_id": prev_phase.phase_id,
                            "to_phase_id": phase.phase_id,
                            "from_last_km": prev_last_km,
                            "to_first_km": first_km,
                            "ratio": ratio,
                        },
                    )
                )
        prev_phase = phase
        prev_last_km = kms[-1]
    return violations


def check_milestone_coverage(
    bundle: SeasonPlanBundle, master_plan: MasterPlan
) -> list[SeasonRuleViolation]:
    """Warn when a phase owns a quantifiable milestone but schedules no matching work.

    Lenient keyword heuristic over session ``summary``/``notes_md`` text (Stage-3a
    sessions are aspirational ``spec=None``). A missing signal is a *warning*
    ("phase X has a 5k milestone but no visible speed work"), never an error.
    """
    violations: list[SeasonRuleViolation] = []
    phase_by_id = {p.phase_id: p for p in bundle.phases}

    for phase_id, phase in phase_by_id.items():
        milestones = _quantifiable_milestones_for_phase(phase_id, master_plan)
        if not milestones:
            continue
        texts = _phase_session_texts(phase)
        for m in milestones:
            kws = _coverage_keywords_for_milestone(m)
            if not kws:
                continue
            if any(any(tok in t for tok in kws) for t in texts):
                continue
            violations.append(
                SeasonRuleViolation(
                    rule="milestone_coverage",
                    severity="warning",
                    message=(
                        f"phase {phase_id!r} owns milestone "
                        f"{(m.metric or m.target)!r} but no week's sessions mention "
                        f"matching work (expected one of: {', '.join(kws)})"
                    ),
                    details={
                        "phase_id": phase_id,
                        "milestone_id": m.id,
                        "metric": m.metric,
                        "expected_keywords": list(kws),
                    },
                )
            )
    return violations


def check_taper_peak_sanity(
    bundle: SeasonPlanBundle, master_plan: MasterPlan
) -> list[SeasonRuleViolation]:
    """Taper volume must drop vs the preceding peak (error); no new taper stimulus (warning).

    Hard part: total run km of a TAPER phase must be strictly below the
    immediately-preceding PEAK phase (or BUILD/SPEED if no peak) — error if
    taper total ≥ that phase's total. Soft part: warn if a taper week's summaries
    introduce a hard *new* stimulus (heuristic keyword scan).
    """
    violations: list[SeasonRuleViolation] = []
    phases = bundle.phases

    for i, phase in enumerate(phases):
        if phase.phase_type != PhaseType.TAPER:
            continue
        taper_total = sum(_phase_week_kms(phase))

        # Find the closest preceding "loaded" phase (peak preferred, else the
        # nearest non-taper/non-recovery phase) to compare against.
        prev_total: float | None = None
        prev_id: str | None = None
        for j in range(i - 1, -1, -1):
            cand = phases[j]
            if cand.phase_type in _DELOAD_PHASE_TYPES:
                continue
            kms = _phase_week_kms(cand)
            if kms:
                prev_total = sum(kms)
                prev_id = cand.phase_id
                break

        if prev_total is not None and prev_total > 0 and taper_total >= prev_total:
            violations.append(
                SeasonRuleViolation(
                    rule="taper_peak_sanity",
                    severity="error",
                    message=(
                        f"taper phase {phase.phase_id!r} total volume "
                        f"{taper_total:.1f}km does not drop below the preceding "
                        f"phase {prev_id!r} ({prev_total:.1f}km)"
                    ),
                    details={
                        "taper_phase_id": phase.phase_id,
                        "taper_total_km": taper_total,
                        "prev_phase_id": prev_id,
                        "prev_total_km": prev_total,
                    },
                )
            )

        # Soft: scan taper sessions for a hard NEW stimulus.
        for t in _phase_session_texts(phase):
            hit = next((kw for kw in _TAPER_NEW_STIMULUS_KEYWORDS if kw in t), None)
            if hit:
                violations.append(
                    SeasonRuleViolation(
                        rule="taper_peak_sanity",
                        severity="warning",
                        message=(
                            f"taper phase {phase.phase_id!r} appears to introduce a "
                            f"hard new stimulus (matched {hit!r}); taper should "
                            f"sharpen with familiar work, not add novel hard sessions"
                        ),
                        details={"taper_phase_id": phase.phase_id, "matched": hit},
                    )
                )
                break  # one warning per taper phase is enough
    return violations


def check_blocked_week_budget(bundle: SeasonPlanBundle) -> list[SeasonRuleViolation]:
    """Sum blocked weeks across phases; warn at >15% blocked, error at >40%.

    A season silently missing a large chunk of its planned weeks should fail
    loudly rather than ship sparse. "Planned weeks" = present + blocked.
    """
    total_blocked = sum(int(p.blocked_week_count) for p in bundle.phases)
    total_planned = sum(_planned_weeks_for_phase(p) for p in bundle.phases)
    if total_planned <= 0 or total_blocked <= 0:
        return []
    fraction = total_blocked / total_planned
    if fraction > BLOCKED_ERROR_FRACTION:
        severity = "error"
    elif fraction > BLOCKED_WARN_FRACTION:
        severity = "warning"
    else:
        return []
    return [
        SeasonRuleViolation(
            rule="blocked_week_budget",
            severity=severity,
            message=(
                f"{total_blocked}/{total_planned} planned weeks were blocked "
                f"({fraction * 100:.0f}%); "
                + (
                    f"over the {BLOCKED_ERROR_FRACTION * 100:.0f}% hard budget"
                    if severity == "error"
                    else f"over the {BLOCKED_WARN_FRACTION * 100:.0f}% soft budget"
                )
            ),
            details={
                "total_blocked": total_blocked,
                "total_planned": total_planned,
                "fraction": fraction,
            },
        )
    ]


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_season_rule_filter(
    bundle: SeasonPlanBundle, master_plan: MasterPlan
) -> SeasonRuleReport:
    """Run all five season-aggregate checks and aggregate into one report.

    Ordered so a structurally-broken bundle degrades gracefully: each rule
    independently guards empty phases / unparseable weeks (treating them as
    absent) rather than raising. The cheapest structural check
    (blocked-week budget) and the volume/transition arc run regardless of
    milestone data; milestone/taper rules tolerate an empty milestone list.
    """
    violations: list[SeasonRuleViolation] = []
    violations.extend(check_volume_arc(bundle))
    violations.extend(check_phase_transition(bundle))
    violations.extend(check_milestone_coverage(bundle, master_plan))
    violations.extend(check_taper_peak_sanity(bundle, master_plan))
    violations.extend(check_blocked_week_budget(bundle))
    return SeasonRuleReport(violations=violations)
