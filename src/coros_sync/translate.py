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

import re

from stride_core.workout_spec import (
    DurationKind,
    NormalizedRunWorkout,
    NormalizedStrengthWorkout,
    StepKind,
    StrengthExerciseSpec,
    StrengthTargetKind,
    TargetKind,
    WorkoutBlock,
    WorkoutStep,
)

from .workout import RunWorkout, StrengthWorkout


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


# ─────────────────────────────────────────────────────────────────────────────
# Strength translation
# ─────────────────────────────────────────────────────────────────────────────


# Strip trailing equipment / weight hints in parentheses so we can match
# `俯卧撑(自重)` against `俯卧撑` in the COROS catalog.
_PAREN_SUFFIX_RE = re.compile(r"[（(][^（()）]*[）)]\s*$")


def _core_keyword(display_name: str) -> str:
    """Strip trailing parenthetical hints (`(5kg)`, `(自重)`, …) from a name."""
    out = display_name.strip()
    while True:
        new = _PAREN_SUFFIX_RE.sub("", out).strip()
        if new == out:
            return out
        out = new


# Equipment / weight suffixes commonly appended to canonical_id but absent
# from the COROS catalog overview — strip before matching so e.g.
# `goblet_squat_db` matches catalog entry `goblet_squat`.
_EQUIP_SUFFIXES = ("_db", "_bw", "_kb", "_bb", "_cable", "_machine")


def _strip_equip(s: str) -> str:
    """Strip trailing equipment suffix (e.g. ``_db``, ``_bw``) and lowercase."""
    low = s.lower()
    for suf in _EQUIP_SUFFIXES:
        if low.endswith(suf):
            return low[: -len(suf)]
    return low


def _eng_tokens(s: str) -> set[str]:
    """Tokenize English snake_case names; drop short noise tokens (<=2 chars)."""
    return {t for t in _strip_equip(s).replace("-", "_").split("_") if len(t) > 2}


def _has_cjk(s: str) -> bool:
    """True iff ``s`` contains at least one CJK Unified Ideograph."""
    return any("一" <= c <= "鿿" for c in s)


def _has_ascii_alpha(s: str) -> bool:
    """True iff ``s`` contains at least one ASCII letter (English content)."""
    return any("a" <= c <= "z" or "A" <= c <= "Z" for c in s)


def _match_exercise(spec: StrengthExerciseSpec, library: list[dict]) -> dict | None:
    """Find a COROS library exercise matching ``spec``.

    The COROS catalog mostly uses English snake_case in ``overview`` (e.g.
    ``goblet_squat``, ``romanian_deadlift``) with a small number of Chinese
    entries (e.g. ``坐姿肩上哑铃推举``). Plan specs carry both a Chinese
    ``display_name`` and an English ``canonical_id``, so we try multiple
    matching strategies and return the first hit:

      1. Chinese bidirectional substring on ``display_name`` core keyword
         (handles ``侧卧平板撑`` ↔ ``侧平板``).
      2. English bidirectional substring on ``canonical_id`` after stripping
         equipment suffixes (handles ``goblet_squat_db`` → ``goblet_squat``).
      3. English token-overlap fallback ≥ 50% intersection-over-larger
         (handles word-order differences like ``goblet_squat_db`` ↔
         ``dumbbell_goblet_squat``). 50% is the lowest threshold that still
         requires sharing at least the main movement noun on 3-token names
         while rejecting accidental single-token overlaps on longer names.

    Returns the best match (highest token-overlap score among #3 candidates)
    or ``None`` if nothing reaches the threshold.
    """
    cn_keyword = _core_keyword(spec.display_name)
    cn_active = bool(cn_keyword) and _has_cjk(cn_keyword)
    eng_keyword = _strip_equip(spec.canonical_id)
    eng_active = bool(eng_keyword) and _has_ascii_alpha(eng_keyword)
    eng_tokens = _eng_tokens(spec.canonical_id)

    best_overlap: tuple[float, dict | None] = (0.0, None)
    for ex in library:
        overview = str(ex.get("overview", "")).strip()
        if not overview:
            continue
        # 1. Chinese bidirectional substring (only when both sides have CJK)
        if cn_active and _has_cjk(overview):
            if cn_keyword in overview:
                return ex
            # Reverse: short catalog overview inside long display keyword
            # (e.g. catalog "侧平板" ⊂ display "哥本哈根侧平板"). Require
            # overview length ≥ 2 to avoid spurious 1-char hits.
            if len(overview) >= 2 and overview in cn_keyword:
                return ex
        # 2. English bidirectional substring on canonical_id (only when both
        # sides have ASCII letters — skips Chinese overview entries).
        if eng_active and _has_ascii_alpha(overview):
            overview_low = overview.lower()
            if eng_keyword in overview_low:
                return ex
            if len(overview_low) >= 4 and overview_low in eng_keyword:
                return ex
        # 3. English token overlap fallback
        ex_tokens = _eng_tokens(overview)
        if not eng_tokens or not ex_tokens:
            continue
        overlap = eng_tokens & ex_tokens
        if not overlap:
            continue
        score = len(overlap) / max(len(eng_tokens), len(ex_tokens))
        if score >= 0.5 and score > best_overlap[0]:
            best_overlap = (score, ex)
    return best_overlap[1]


def _custom_exercise_payload(spec: StrengthExerciseSpec) -> dict:
    """Build an `add_exercise` request body for a missing library exercise.

    Mirrors the canonical example in CLAUDE.md: sportType=4, exerciseType=2,
    name + overview = display_name, generic part/muscle/equipment defaults.
    """
    target_type = 2 if spec.target_kind == StrengthTargetKind.TIME_S else 3
    name = spec.display_name.strip() or spec.canonical_id
    return {
        "sportType": 4,
        "exerciseType": 2,
        "name": name,
        "overview": name,
        "part": ["4"],
        "muscle": ["6"],
        "muscleRelevance": [],
        "equipment": ["1"],
        "access": 1,
        "intensityCustom": 0,
        "intensityMultiplier": 0,
        "intensityType": 1,
        "intensityValue": 0,
        "intensityValueExtend": 0,
        "restType": 1,
        "restValue": spec.rest_seconds,
        "targetType": target_type,
        "targetValue": spec.target_value,
    }


def normalized_to_coros_strength(
    workout: NormalizedStrengthWorkout,
    available_exercises: list[dict],
) -> tuple[StrengthWorkout, list[dict]]:
    """Translate NormalizedStrengthWorkout → coros_sync.StrengthWorkout.

    Args:
        workout: The provider-agnostic strength workout to translate.
        available_exercises: The COROS exercise library
            (``client.query_exercises(sport_type=4)`` result). Each entry is
            a dict containing at minimum ``id`` and ``overview``.

    Returns:
        ``(coros_workout, missing_specs)`` where ``missing_specs`` is a list
        of `add_exercise` request bodies that the caller should POST to
        create custom exercises before the strength workout can be pushed.
        When ``missing_specs`` is non-empty the returned ``coros_workout``
        is incomplete (missing exercises are silently dropped) and the
        caller should re-translate after creating the missing exercises.
    """
    out = StrengthWorkout(
        name=workout.name,
        date=_iso_to_yyyymmdd(workout.date),
    )
    missing: list[dict] = []
    for spec in workout.exercises:
        match = _match_exercise(spec, available_exercises)
        if match is None:
            missing.append(_custom_exercise_payload(spec))
            continue
        target_type = 2 if spec.target_kind == StrengthTargetKind.TIME_S else 3
        out.add_exercise(
            exercise_data=match,
            sets=spec.sets,
            target_type=target_type,
            target_value=spec.target_value,
            rest_value=spec.rest_seconds,
        )
    return out, missing
