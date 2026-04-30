"""Translate stride_core.NormalizedRunWorkout → coros_sync.RunWorkout.

The COROS push protocol is wrapped by the existing `coros_sync.workout`
module — it owns the warmup/training/cooldown/interval segment vocabulary,
the centisecond unit conversions, and the calculate→update flow. This
file is the thin adapter that converts a provider-agnostic
`NormalizedRunWorkout` into the COROS-shaped builder so we can keep
push_workout() as the single push entry point.

Translation rules:
- Single-step blocks (repeat=1) → one matching segment per step.
- Multi-step blocks (repeat>1) → one COROS interval group per block.
  The group expects (work, recovery) or (work,) sub-steps; anything
  else falls back to a best-effort flatten (each repeat emitted as
  separate training segments).
- Pace targets: Target(PACE_S_KM, low=slow_s_km, high=fast_s_km) becomes
  COROS's pace_low (slower 'M:SS') / pace_high (faster 'M:SS') strings.
- Open / HR / power targets: COROS RunWorkout doesn't accept these per
  segment, so they're dropped (segment runs without a pace target).
- Duration: DISTANCE_M → distance_km, TIME_S → duration_min,
  OPEN → 5 min default for warmup/cooldown, 30 min for training.
"""

from __future__ import annotations

from stride_core.workout_spec import (
    DurationKind,
    NormalizedRunWorkout,
    StepKind,
    TargetKind,
    WorkoutBlock,
    WorkoutStep,
)

from .workout import RunWorkout


def _iso_to_yyyymmdd(iso_date: str) -> str:
    """`'2026-05-01'` → `'20260501'` (COROS API date format)."""
    return iso_date.replace("-", "")


def _seconds_to_pace_str(seconds_per_km: float) -> str:
    """`280` → `'4:40'` for COROS's pace string format."""
    s = int(round(seconds_per_km))
    return f"{s // 60}:{s % 60:02d}"


def _step_duration(step: WorkoutStep, *, default_min: float) -> tuple[float | None, float | None]:
    """Return `(distance_km, duration_min)` — at most one is non-None."""
    d = step.duration
    if d.kind == DurationKind.DISTANCE_M and d.value is not None:
        return (d.value / 1000.0, None)
    if d.kind == DurationKind.TIME_S and d.value is not None:
        return (None, d.value / 60.0)
    # OPEN duration → use default minutes (COROS doesn't support open-ended steps)
    return (None, default_min)


def _pace_bounds(step: WorkoutStep) -> tuple[str | None, str | None]:
    """Return COROS-formatted (`pace_low`, `pace_high`) strings — slow/fast bounds."""
    t = step.target
    if t.kind != TargetKind.PACE_S_KM or t.low is None or t.high is None:
        return (None, None)
    # NormalizedRunWorkout.Target convention: low = slower (larger s/km),
    # high = faster (smaller s/km). COROS expects the same labels.
    return (_seconds_to_pace_str(t.low), _seconds_to_pace_str(t.high))


def _emit_single_step(out: RunWorkout, step: WorkoutStep) -> None:
    """Convert one WorkoutStep to one COROS segment via the RunWorkout builder."""
    pace_low, pace_high = _pace_bounds(step)

    if step.step_kind == StepKind.WARMUP:
        dist, dur = _step_duration(step, default_min=5)
        out.add_warmup(duration_min=dur, distance_km=dist,
                       pace_low=pace_low, pace_high=pace_high)
    elif step.step_kind == StepKind.COOLDOWN:
        dist, dur = _step_duration(step, default_min=5)
        out.add_cooldown(duration_min=dur, distance_km=dist,
                         pace_low=pace_low, pace_high=pace_high)
    elif step.step_kind == StepKind.RECOVERY or step.step_kind == StepKind.REST:
        dist, dur = _step_duration(step, default_min=3)
        out.add_recovery(duration_min=dur, distance_km=dist,
                         pace_low=pace_low, pace_high=pace_high)
    else:  # WORK (or anything else) → training segment
        dist, dur = _step_duration(step, default_min=30)
        out.add_training(distance_km=dist, duration_min=dur,
                         pace_low=pace_low, pace_high=pace_high)


def _emit_repeat_block(out: RunWorkout, block: WorkoutBlock) -> None:
    """Translate a repeat>1 block into a COROS interval group when possible.

    Two-step (work + recovery) blocks map cleanly to `add_interval(sets=N, ...)`.
    Other shapes are emitted as N flat copies of the steps — less elegant
    but preserves intent. Same fallback for blocks with non-standard step
    layouts (e.g. work + recovery + cooldown all under one repeat).
    """
    steps = block.steps
    work, recovery = (steps + (None, None))[:2]
    if (
        work is not None
        and work.step_kind in (StepKind.WORK, StepKind.RECOVERY)
        and recovery is not None
        and recovery.step_kind in (StepKind.RECOVERY, StepKind.REST)
        and len(steps) == 2
    ):
        # Pick the work pace as the interval target; recovery uses time.
        pace_low, pace_high = _pace_bounds(work)
        dist_km, dur_min = _step_duration(work, default_min=5)
        recovery_d = recovery.duration
        recovery_s = (
            int(recovery_d.value) if recovery_d.kind == DurationKind.TIME_S
                                   and recovery_d.value is not None
            else 60
        )
        out.add_interval(
            sets=block.repeat,
            distance_km=dist_km,
            duration_min=dur_min,
            pace_low=pace_low,
            pace_high=pace_high,
            recovery_duration_s=recovery_s,
        )
        return

    # Fallback: just emit each step `repeat` times as flat segments.
    for _ in range(block.repeat):
        for step in steps:
            _emit_single_step(out, step)


def normalized_to_coros_run(workout: NormalizedRunWorkout) -> RunWorkout:
    """Translate NormalizedRunWorkout → coros_sync.RunWorkout (preserves order).

    Workout type heuristic for COROS's `workout_type` (used for image asset):
      - any block has repeat>1 → 'interval'
      - any work step >= 16km → 'long'
      - any work step has pace target faster than 4:30/km → 'tempo'
      - else 'easy'
    """
    out = RunWorkout(
        name=workout.name,
        date=_iso_to_yyyymmdd(workout.date),
        workout_type=_infer_coros_workout_type(workout),
    )
    for block in workout.blocks:
        if block.repeat > 1:
            _emit_repeat_block(out, block)
        else:
            for step in block.steps:
                _emit_single_step(out, step)
    return out


def _infer_coros_workout_type(workout: NormalizedRunWorkout) -> str:
    has_interval = any(b.repeat > 1 for b in workout.blocks)
    if has_interval:
        return "interval"
    for block in workout.blocks:
        for step in block.steps:
            if step.step_kind != StepKind.WORK:
                continue
            d = step.duration
            if d.kind == DurationKind.DISTANCE_M and d.value is not None and d.value >= 16000:
                return "long"
            t = step.target
            if t.kind == TargetKind.PACE_S_KM and t.high is not None and t.high <= 270:
                return "tempo"
    return "easy"
