# Workout intensity dimensions: absolute, relative, and zone targets

Status: accepted

> Renumbered from the `0036` referenced by issue #329: ADR 0035 is
> `0035-race-calendar-admin-surface-and-sync-merge.md`.

## Context

The canonical workout spec (`internal/provider`) could express only four target
kinds: `pace_s_km`, `hr_bpm`, `power_w`, and `open`. Watch platforms express
intensity relatively — "70–80% of max HR", "75–84% of heart-rate reserve",
"87–93% of threshold pace", "HR zone 3". Without a relative/zone family, a
pulled or coach-authored relative target is either lost or silently converted
into a fabricated absolute value.

The tension: a percentage is only meaningful against *this athlete's* baseline,
and baselines live in the calibration domain (HRmax, RHR, threshold HR, threshold
pace, race goal, zone tables). Storing a resolved absolute value at authoring
time would freeze a stale threshold and make the spec unportable; storing a
percentage with no resolution rule would invite silent defaults.

## Decisions

1. **`TargetKind` expands to twelve kinds in three families.** Absolute:
   `pace_s_km`, `hr_bpm`, `power_w`, `open`. Relative: `pct_max_hr`, `pct_hrr`,
   `pct_lt_hr`, `pct_lt_pace`, `pct_race_pace`, `pct_ftp`. Zone: `pace_zone`,
   `hr_zone`. The set is closed: an unknown kind is a parse error, never a
   silent degrade to `open`.

2. **Percentages are stored as plain fractions** (`0.70`–`0.80`). All ×100 /
   ×1000 scaling belongs to adapters at their protocol boundary. A fraction is
   validated to be in `(0, 2]`; anything else is a scaling bug.

3. **`Low` is the easier end and `High` the harder end**, preserving the existing
   convention. Ranges, single points (`Low == High`), and one-sided caps (one
   side nil) are all valid.

4. **`pct_lt_pace` (and `pct_race_pace`) is contractually a speed ratio**
   `v / v_reference`: `87%` means *slower* than threshold, and absolute pace is
   `reference_pace ÷ fraction`. For a speed ratio `Low <= High`, and the resolved
   pace keeps `Low > High`. The direction is pinned in validation so no consumer
   can invert it and emit a dangerously fast target.

5. **A pure resolution function turns relative/zone into absolute.**
   `provider.ResolveTarget(target, baselines) → Target | error` performs no I/O;
   baselines are injected from the calibration domain. A baseline required by a
   target's kind that is missing is a hard error — a default is never invented.
   `pct_ftp` resolves from an injected FTP baseline; the baseline plumbing itself
   is a later, separate concern.

6. **Dual-track precedence: absolute wins.** When a source step carries both an
   absolute and a relative expression, the adapter keeps the absolute track,
   deterministically. Relative-only intake is permitted but must be marked in
   sync metadata as based on the source platform's own threshold estimate.

7. **Backward compatibility.** The existing four kinds and existing stored plan
   JSON keep parsing unchanged; step-level `hr_cap_bpm` remains a first-class
   field that survives parsing and resolution. `DurationKind` is unchanged.
   Candidate kinds (`cadence_spm`, `rpe`, and a per-100m swim pace unit) are
   recorded here but not added.

8. **Go is the canonical owner.** The Python `stride_core.workout_spec` mirror is
   not updated and will drift by design (ADR 0006/0024).

## Consequences

- A coach can express intensity the way training literature does, and a pulled
  watch schedule can be normalized without loss.
- Historical percentage-based schedules automatically pick up a new threshold:
  resolution happens at consumption time from the current calibration, so it is
  never rewritten in storage.
- Consumers that switch on `TargetKind` must handle the new kinds explicitly;
  the schema gate guarantees they can never receive an unknown one.
- Resolving without a baseline fails loudly, so a missing calibration surfaces
  as an error instead of a plausible-looking wrong workout.
- Push-direction fixes for COROS `intensityPercent` and the dropped
  `hr_cap_bpm` (#325, #326) are built on this resolution function but land
  separately.
