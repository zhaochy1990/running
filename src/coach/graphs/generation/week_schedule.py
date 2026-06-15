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

from datetime import date, timedelta

from stride_core.master_plan import Phase, PhaseType

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
_MAX_RAMP_RATIO = 1.10


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
) -> list[float]:
    """Base/build/speed/None ramp: climb ~6%/week toward ``high`` with a 3:1
    deload every 4th week. Each up-step is clamped to ``high`` and to the
    ≤1.10× cap relative to the prior week; deload weeks step down (safe)."""
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
        # Keep volumes sane relative to the band (deload may dip below low).
        cur = max(cur, low * 0.65)
        vols.append(cur)
        prev = cur
    return vols


def _peak_volumes(n: int, *, high: float, start_km: float) -> list[float]:
    """Peak: hold near the top of the band with a tiny week-to-week drift."""
    vols: list[float] = []
    prev = min(start_km, high)
    for i in range(n):
        cur = prev if i == 0 else min(prev * _PEAK_STEP, high)
        vols.append(cur)
        prev = cur
    return vols


def _taper_volumes(n: int, *, start_km: float) -> list[float]:
    """Taper: step down across the phase from the peak-entry volume —
    ~−25% on the first taper week, deepening to ~−45% on the final week."""
    if n == 1:
        return [start_km * _TAPER_LAST_CUT]
    vols: list[float] = []
    for i in range(n):
        frac = i / (n - 1)  # 0 … 1
        cut = _TAPER_FIRST_CUT + (_TAPER_LAST_CUT - _TAPER_FIRST_CUT) * frac
        vols.append(start_km * cut)
    return vols


def _recovery_volumes(n: int, *, low: float, start_km: float) -> list[float]:
    """Recovery: cut from entry, then a gentle further step down each week.
    Chronic intentionally drops; floor at the band low."""
    vols: list[float] = []
    prev = start_km
    for i in range(n):
        cur = start_km * _RECOVERY_FIRST_CUT if i == 0 else prev * _RECOVERY_STEP
        cur = max(cur, low)
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
        # Continuity: start from the prior exit volume, clamped into a sane
        # relation to this phase's band (don't start absurdly above the high
        # band nor below a recovery floor).
        start_km = float(prev_phase_end_km)
    else:
        start_km = low

    if pt in (PhaseType.BASE, PhaseType.BUILD, PhaseType.SPEED, None):
        # Ramp-up: clamp the anchor into [low, high] so we climb within band.
        anchor = min(max(start_km, low), high)
        # Continuity cap: never start the phase >1.10× the prior exit volume.
        if prev_phase_end_km is not None and prev_phase_end_km > 0:
            anchor = min(anchor, float(prev_phase_end_km) * _MAX_RAMP_RATIO)
        vols = _rampup_volumes(n, low=low, high=high, start_km=anchor)
    elif pt is PhaseType.PEAK:
        anchor = min(max(start_km, low), high)
        vols = _peak_volumes(n, high=high, start_km=anchor)
    elif pt is PhaseType.TAPER:
        # Step down off the peak-entry volume (the prior exit, else the high
        # band as the implicit peak).
        entry = start_km if (prev_phase_end_km and prev_phase_end_km > 0) else high
        vols = _taper_volumes(n, start_km=entry)
    elif pt is PhaseType.RECOVERY:
        entry = start_km if (prev_phase_end_km and prev_phase_end_km > 0) else high
        vols = _recovery_volumes(n, low=low, start_km=entry)
    else:  # pragma: no cover — PhaseType is a closed enum; defensive only.
        anchor = min(max(start_km, low), high)
        vols = _rampup_volumes(n, low=low, high=high, start_km=anchor)

    label = _phase_label(phase)
    out: list[WeekMeta] = []
    for i, (mon, sun) in enumerate(spans):
        out.append(
            WeekMeta(
                phase_position=f"{label} week {i + 1}/{n}",
                week_folder=_week_folder(mon, sun, i + 1),
                target_weekly_km=round(vols[i], 1),
            )
        )
    return out
