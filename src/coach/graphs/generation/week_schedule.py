"""Deterministic per-phase volume ramp — ``derive_phase_weeks`` (Stage-3b T2).

Turns one master-plan :class:`~stride_core.master_plan.Phase` into the ordered
list of per-week descriptors (:class:`~coach.graphs.generation.weekly_prompt.WeekMeta`)
that the Stage-3a per-phase generator (``generate_phase_weeks``) consumes. This
is the periodization volume-arc the Stage-3a loop assumed but nobody built.

**Pure / core**: no DB, no LLM, no network. Only ``stride_core.{master_plan,
timefmt}`` + ``coach.*`` imports (``.importlinter`` coach-core-isolation).

The ramp character per phase is the codebase's authoritative spec — see the
"训练负荷分布约束 (HARD)" and "Phase 与 Form 分布对应关系" tables in the project
``CLAUDE.md``:

* **base / build / speed** (ramp-up): climb ``target_weekly_km`` ~6%/week toward
  ``weekly_distance_km_high``, with a **3:1 deload** — every 4th week drops to
  ~0.75× the prior week, then climbing resumes. Never exceed the high band.
* **peak**: hold near ``high`` with a tiny micro-drift (chronic plateaus).
* **taper**: step **down** across the phase, ~−25% front → ~−45% by the final
  week off the peak-entry volume.
* **recovery**: deload — step down from entry to low volume (chronic drops).
* ``phase_type is None``: neutral ramp-up, treated base-like (documented fallback).

**≤1.10×-safe (HARD invariant)**: consecutive ramp-UP weeks satisfy
``week[i] <= 1.10 * week[i-1]`` so Stage-3a's
``run_rule_filter.check_weekly_progression`` (cap 1.10×) never pre-fails on the
descriptors emitted here. Deload / taper / recovery weeks step DOWN (always
safe). When continuity applies, the first week is also held ≤1.10× of
``prev_phase_end_km`` — no phase-boundary spike.

**Short-phase resolution** (the ≤1.10× vs 3:1-deload tension): the 3:1 deload
fires only on a phase's 4th, 8th, … week (1-based index a multiple of 4). A
phase shorter than 4 weeks therefore never deloads — it just ramps within the
1.10× cap. So a 2-week phase has no ramp-vs-deload conflict to resolve: it
ramps, full stop. This keeps both invariants simultaneously satisfiable for
every phase length.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

from stride_core.master_plan import Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan

from .rule_filter import MAX_WEEKLY_RAMP_RATIO, _total_run_distance_m
from .weekly_prompt import WeekMeta

# Shanghai weeks are Monday→Sunday (matches ``WeeklyKeySessions.week_start``
# = "the Monday of the week"). Phase ``start_date`` / ``end_date`` are already
# Shanghai-local ``YYYY-MM-DD`` calendar strings (not UTC instants), so week
# alignment is pure calendar arithmetic on local dates — no UTC conversion
# needed (the timezone-discipline HARD rule governs UTC-stored DB columns, not
# already-local plan dates).

# Per-week climb rate for ramp-up phases. 6% sits inside the 5-8%/week band and
# safely under the 1.10× progression cap.
_RAMPUP_STEP = 1.06

# 3:1 deload: every 4th week drops to this fraction of the prior week.
_DELOAD_FACTOR = 0.75
_DELOAD_CADENCE = 4  # 1-based week index multiple that triggers a deload

# Peak: micro-drift down each week (chronic plateaus / slightly drops).
_PEAK_STEP = 0.985

# Taper: front weeks ~−25%, deepening to ~−45% by the final week.
_TAPER_FIRST_CUT = 0.75
_TAPER_LAST_CUT = 0.55

# Recovery: entry cut, then a gentle further step down.
_RECOVERY_FIRST_CUT = 0.80
_RECOVERY_STEP = 0.92

# Hard cap the Stage-3a rule filter enforces on consecutive load weeks.
# Single-sourced from the per-week ``rule_filter`` gate (M1, Stage-3b I1) so the
# derive ramp can never drift from the gate it must satisfy.
_MAX_RAMP_RATIO = MAX_WEEKLY_RAMP_RATIO


def representative_working_km(week_dicts: list[dict]) -> float | None:
    """The phase's *established working load* — the MAX per-week run km across
    its generated weeks (Stage-3b I1).

    The working peak is the right inter-phase continuity signal: a phase's LAST
    week is frequently a planned deload trough (or a still-climbing sub-band
    week), so threading it forward anchors the next phase from a trough and the
    ≤1.10× ramp cap then suppresses volume that compounds across phases — the
    season never reaches its prescribed bands. ``max`` naturally ignores deload
    troughs and returns what the athlete actually trained at. Resuming a
    previously-tolerated working volume after a planned deload is physiologically
    safe (NOT a dangerous progression), so it is the correct baseline for both
    forward threading (``derive_phase_weeks``) and the cross-phase boundary check
    (``season_rule_filter.check_phase_transition``).

    Per-week run km is single-sourced via ``rule_filter._total_run_distance_m``
    on each parsed ``WeeklyPlan`` (no hand-rolled summation). An unparseable week
    is skipped. Returns ``None`` for an empty / all-unparseable phase so callers
    can fall back to the carried prior value rather than resetting.
    """
    kms: list[float] = []
    for wd in week_dicts:
        try:
            plan = WeeklyPlan.from_dict(wd)
        except Exception:  # noqa: BLE001 — parse boundary, skip the broken week
            continue
        kms.append(_total_run_distance_m(plan) / 1000.0)
    if not kms:
        return None
    return max(kms)


def _floor_1dp(x: float) -> float:
    """Round ``x`` DOWN to 1 decimal place. Used to clamp an emitted week to a
    value whose 1-decimal representation is guaranteed ≤ the cap (plain
    ``round`` could round up across the ≤1.10× boundary)."""
    return math.floor(x * 10) / 10


def _parse(d: str) -> date:
    return date.fromisoformat(d)


def _monday_of(d: date) -> date:
    """Shanghai Monday of the week containing ``d`` (Mon=0 … Sun=6)."""
    return d - timedelta(days=d.weekday())


def _week_spans(start_date: str, end_date: str) -> list[tuple[date, date]]:
    """Ordered (Mon, Sun) spans for every Shanghai week the phase touches.

    Aligned to Shanghai week boundaries: the first span is the Monday→Sunday
    week containing ``start_date``; the last is the week containing
    ``end_date``. A partial leading or trailing week counts as a full week
    span (the descriptor still covers Mon→Sun).
    """
    first_mon = _monday_of(_parse(start_date))
    last_mon = _monday_of(_parse(end_date))
    spans: list[tuple[date, date]] = []
    cur = first_mon
    while cur <= last_mon:
        spans.append((cur, cur + timedelta(days=6)))
        cur += timedelta(days=7)
    return spans


def _week_folder(mon: date, sun: date, week_index: int) -> str:
    """Repo convention ``YYYY-MM-DD_MM-DD(Wn)`` for the Mon→Sun span."""
    return f"{mon.isoformat()}_{sun.strftime('%m-%d')}(W{week_index})"


def _phase_label(phase: Phase) -> str:
    """Human label for ``phase_position`` — prefer the Chinese phase name,
    fall back to the phase_type value, then a neutral default."""
    if phase.name:
        return phase.name
    if phase.phase_type is not None:
        return phase.phase_type.value
    return "训练"


def _rampup_volumes(
    n: int,
    *,
    low: float,
    high: float,
    start_km: float,
    first_week_cap: float | None = None,
) -> list[float]:
    """Base/build/speed/None ramp: climb ~6%/week toward ``high`` with a 3:1
    deload every 4th week. Each up-step is clamped to ``high`` and to the
    ≤1.10× cap relative to the prior week; deload weeks step down (safe).

    ``first_week_cap`` (continuity ≤1.10× of the prior phase exit) is a HARD
    ceiling on week 1 that WINS over the band floor — see ``derive_phase_weeks``
    for the precedence rationale. Subsequent weeks then ramp from that
    (possibly sub-floor) first week under the same 1.10× cap, climbing back
    toward the band rather than jumping into it."""
    vols: list[float] = []
    prev = start_km
    for i in range(n):
        idx = i + 1  # 1-based
        if i == 0:
            cur = start_km
        elif idx % _DELOAD_CADENCE == 0:
            # 3:1 deload — drop to ~0.75× the prior (climbing) week.
            cur = prev * _DELOAD_FACTOR
        else:
            cur = prev * _RAMPUP_STEP
            cur = min(cur, high)
            # Belt-and-braces: never let a climb exceed the 1.10× cap.
            cur = min(cur, prev * _MAX_RAMP_RATIO)
        # Keep volumes sane relative to the band (deload may dip below low) —
        # but the HARD ≤1.10× first-week cap (below) overrides this soft floor.
        cur = max(cur, low * 0.65)
        if i == 0 and first_week_cap is not None:
            cur = min(cur, first_week_cap)
        vols.append(cur)
        prev = cur
    return vols


def _peak_volumes(
    n: int, *, low: float, high: float, start_km: float
) -> list[float]:
    """Peak volume arc.

    Two regimes, picked by where the (continuity-capped) entry volume lands:

    * **At/above the band low** (the normal case — the prior build phase
      established a working load already in the peak band): hold near the top of
      the band with a tiny week-to-week micro-drift down (chronic plateaus).
    * **Below the band low** (Stage-3b I1 — the working volume threaded in still
      sits under the peak floor because volume was suppressed upstream): the peak
      must *climb* into its band under the same ≤1.10× cap rather than holding
      sub-floor forever. Each week steps up ~6% (clamped to ``high`` and to
      ≤1.10× of the prior week) until it reaches the band, then the band ceiling
      caps it. This is what lets a peak phase actually reach its prescribed band
      after a deloaded build (see the I1 fix); holding at a sub-floor entry would
      defeat the whole point of the working-volume threading.

    Either way every up-step honors the ≤1.10× invariant and no week exceeds
    ``high``; ``low`` is used only to pick the regime (it is never a hard floor —
    the HARD continuity cap on week 1 still wins, exactly as for ramp-up phases).
    """
    vols: list[float] = []
    prev = min(start_km, high)
    climbing = prev < low  # entered below the band → ramp up toward it
    for i in range(n):
        if i == 0:
            cur = prev
        elif climbing:
            cur = min(prev * _RAMPUP_STEP, high)
            cur = min(cur, prev * _MAX_RAMP_RATIO)
        else:
            cur = min(prev * _PEAK_STEP, high)
        vols.append(cur)
        prev = cur
    return vols


def _taper_volumes(n: int, *, low: float, high: float, start_km: float) -> list[float]:
    """Taper: step down across the phase from the peak-entry volume —
    ~−25% on the first taper week, deepening to ~−45% on the final week.
    Each week is clamped into ``[low, high]`` so a high prior-phase exit can't
    leave the early taper weeks above this phase's own ceiling."""
    if n == 1:
        return [min(max(start_km * _TAPER_LAST_CUT, low), high)]
    vols: list[float] = []
    for i in range(n):
        frac = i / (n - 1)  # 0 … 1
        cut = _TAPER_FIRST_CUT + (_TAPER_LAST_CUT - _TAPER_FIRST_CUT) * frac
        vols.append(min(max(start_km * cut, low), high))
    return vols


def _recovery_volumes(n: int, *, low: float, high: float, start_km: float) -> list[float]:
    """Recovery: cut from entry, then a gentle further step down each week.
    Chronic intentionally drops; each week is clamped into ``[low, high]`` —
    floor at the band low, and ceiling at the band high so a high prior-phase
    exit can't leave the early recovery weeks above this phase's own ceiling."""
    vols: list[float] = []
    prev = start_km
    for i in range(n):
        cur = start_km * _RECOVERY_FIRST_CUT if i == 0 else prev * _RECOVERY_STEP
        cur = min(max(cur, low), high)
        vols.append(cur)
        prev = cur
    return vols


def derive_phase_weeks(
    phase: Phase, *, prev_phase_end_km: float | None = None
) -> list[WeekMeta]:
    """Expand one master-plan ``Phase`` into ordered per-week ``WeekMeta``.

    Deterministic, pure. Walks the Shanghai weeks the phase spans (inclusive,
    partial trailing/leading weeks counted), assigns a ramped
    ``target_weekly_km`` per the phase's ``phase_type`` character, and emits a
    ``week_folder`` (``YYYY-MM-DD_MM-DD(Wn)``) + ``phase_position``
    (``"<label> week i/n"``) for each.

    ``prev_phase_end_km`` threads the prior phase's exit volume in for
    cross-phase continuity: ramp-up phases start climbing from it (clamped into
    band) rather than resetting to the floor, and the first week is held
    ≤1.10× of it (no boundary spike). When ``None``, ramp-up phases anchor at
    ``weekly_distance_km_low``.

    See the module docstring for the per-phase ramp spec and the short-phase
    (≤1.10× vs 3:1-deload) resolution.
    """
    spans = _week_spans(phase.start_date, phase.end_date)
    n = len(spans)
    if n == 0:
        return []

    low = float(phase.weekly_distance_km_low)
    high = float(phase.weekly_distance_km_high)
    pt = phase.phase_type

    # --- Starting volume (continuity vs band floor) --------------------------
    if prev_phase_end_km is not None and prev_phase_end_km > 0:
        # Continuity: thread the prior phase's exit volume in as the raw start.
        # It is NOT band-clamped here — each phase branch below clamps it into a
        # sane relation to this phase's band where appropriate: ramp-up / peak
        # clamp the anchor into ``[low, high]`` inline (``min(max(start_km, low),
        # high)``); taper / recovery clamp every emitted week into ``[low, high]``
        # inside ``_taper_volumes`` / ``_recovery_volumes``. So a prior exit far
        # above this phase's high band never leaks an above-ceiling week through.
        start_km = float(prev_phase_end_km)
    else:
        start_km = low

    # HARD continuity cap on the FIRST emitted week: when the prior phase's
    # exit volume is known, no phase may open >1.10× of it — that's exactly
    # what Stage-3a's ``run_rule_filter.check_weekly_progression`` enforces
    # week-over-week, so a boundary spike here would pre-fail. This cap is HARD
    # and OVERRIDES the band floor (a soft target): when ``prev_phase_end_km <
    # low``, honoring ≤1.10× means the first week may open BELOW the band floor
    # (or below a peak/recovery floor) and ramp toward the band over the
    # following weeks — you can't safely jump volume in one step. Subsequent
    # weeks then climb from that (possibly sub-floor) first week under the same
    # 1.10× cap. Computed once here and applied uniformly across all branches.
    first_week_cap: float | None = None
    if prev_phase_end_km is not None and prev_phase_end_km > 0:
        first_week_cap = float(prev_phase_end_km) * _MAX_RAMP_RATIO

    if pt in (PhaseType.BASE, PhaseType.BUILD, PhaseType.SPEED, None):
        # Ramp-up: clamp the anchor into [low, high] so we climb within band.
        anchor = min(max(start_km, low), high)
        # Continuity cap: never start the phase >1.10× the prior exit volume.
        if first_week_cap is not None:
            anchor = min(anchor, first_week_cap)
        # ``first_week_cap`` also threads into the ramp so its band floor can't
        # push week 1 back above the cap; weeks 2+ ramp from the capped week 1.
        vols = _rampup_volumes(
            n, low=low, high=high, start_km=anchor, first_week_cap=first_week_cap
        )
    elif pt is PhaseType.PEAK:
        # Do NOT lift the anchor to ``low`` here: when the threaded working volume
        # sits below the peak floor, the HARD ≤1.10× continuity cap must win
        # (lifting to ``low`` would re-introduce a boundary spike). Keep the raw
        # (capped) entry and let ``_peak_volumes`` climb into the band.
        anchor = min(start_km, high)
        if first_week_cap is not None:
            anchor = min(anchor, first_week_cap)
        vols = _peak_volumes(n, low=low, high=high, start_km=anchor)
    elif pt is PhaseType.TAPER:
        # Step down off the peak-entry volume (the prior exit, else the high
        # band as the implicit peak).
        entry = start_km if (prev_phase_end_km and prev_phase_end_km > 0) else high
        vols = _taper_volumes(n, low=low, high=high, start_km=entry)
    elif pt is PhaseType.RECOVERY:
        entry = start_km if (prev_phase_end_km and prev_phase_end_km > 0) else high
        vols = _recovery_volumes(n, low=low, high=high, start_km=entry)
    else:  # pragma: no cover — PhaseType is a closed enum; defensive only.
        anchor = min(max(start_km, low), high)
        if first_week_cap is not None:
            anchor = min(anchor, first_week_cap)
        vols = _rampup_volumes(
            n, low=low, high=high, start_km=anchor, first_week_cap=first_week_cap
        )

    # Uniform last-step HARD ≤1.10× enforcement across ALL phase types. Two
    # things can leave a residual violation after the per-phase shaping above:
    #   1. A floor (band ``low*0.65`` for ramp-up, band ``low`` for recovery,
    #      ``low``-clamped anchor for peak) lifting week 1 above the continuity
    #      cap — fixed by clamping ``vols[0]`` to ``first_week_cap``.
    #   2. The SAME floor lifting a LATER week so it jumps >1.10× off a
    #      sub-floor predecessor: when ``prev_phase_end_km`` sits far below the
    #      band, week 1 opens sub-floor (HARD ≤1.10× wins over the soft band
    #      floor), and the next week's floor would otherwise snap volume
    #      straight up into the band — a >1.10× step. We instead let it climb
    #      under the cap, week by week, toward the band.
    # This forward pass only ever LOWERS values, so it never disturbs the
    # intended down-steps (deload / taper / recovery) and guarantees the HARD
    # invariant that ``run_rule_filter.check_weekly_progression`` checks.
    #
    # The cap is enforced on the ROUNDED (1-decimal) values that are actually
    # emitted as ``target_weekly_km`` — and that the rule filter sees — not on
    # full-precision intermediates. Rounding the larger of a ≤1.10× pair UP can
    # otherwise push the emitted ratio just over 1.10× (e.g. 26.6 → 29.3 =
    # 1.1015×). We therefore round first, then clamp each up-week to a value
    # whose 1-decimal rounding is guaranteed ≤1.10× of the prior emitted week.
    emitted: list[float] = [round(v, 1) for v in vols]
    if emitted:
        if first_week_cap is not None:
            emitted[0] = min(emitted[0], _floor_1dp(first_week_cap))
        for i in range(1, len(emitted)):
            ceiling = _floor_1dp(emitted[i - 1] * _MAX_RAMP_RATIO)
            emitted[i] = min(emitted[i], ceiling)

    label = _phase_label(phase)
    out: list[WeekMeta] = []
    for i, (mon, sun) in enumerate(spans):
        out.append(
            WeekMeta(
                phase_position=f"{label} week {i + 1}/{n}",
                week_folder=_week_folder(mon, sun, i + 1),
                target_weekly_km=emitted[i],
            )
        )
    return out
