# Embedded Segment PB Detection — Design

**Date**: 2026-06-01
**Status**: Spec — pending plan + implementation
**Author**: Zhao Chaoyi + Claude

## Problem

`vo2max_pb` enrollment only inspects an activity's TOTAL distance against
`RACE_TYPE_BANDS` (5K=4800–5500m, 10K=9500–10500m, half=20500–21500m,
full=41000–43500m). A long run with an embedded 5K tempo block —
e.g., 13.36 km activity on 2026-05-27 containing a continuous 5000 m segment
in 19:30 — is invisible to the PB pipeline because 13360 m falls in no band.
The user's race predictions therefore don't update even when they've clearly
hit a new PB level inside a longer session.

Concrete instance verified from real data:
- Activity `477783793625760045`, 2026-05-27, 13.36 km
- Sliding-window scan over its 1 Hz timeseries finds the fastest continuous
  5000 m segment: starts 10.7 min into the run, duration **19:30.25**
  (3:54.05/km), 29.4 s faster than the stored PB (19:59.64 from 2026-04-24).

## Goal

Replace the current "whole-activity PB" path with a unified
**continuous-segment scan** that:

1. For each canonical race distance (5K / 10K / half / full), finds the
   fastest continuous segment matching that distance inside the activity's
   1 Hz timeseries.
2. Rejects candidate segments that overlap any pause interval.
3. Stores **every qualifying segment** as its own row in `vo2max_pb` so
   the table represents a history of PB-class efforts, not just the
   current best per distance.
4. Subsumes the existing whole-activity logic — a 5 km race activity is
   simply the degenerate case where the segment equals the whole activity.

## Non-Goals

- No stability gate (CV / HR-monotonicity). Per user decision, segment is
  enrolled purely on continuous distance + time, no pacing-quality check.
  This also means the previous marathon `_is_well_paced_marathon` gate is
  removed — crashed marathons over 42195 m will now enroll. Accepted as a
  deliberate behavior change.
- No fallback to lap-based scanning for activities without timeseries.
  Activities lacking a usable timeseries are skipped silently.
- No new column to distinguish "whole-activity PB" vs "segment PB". Source
  inference is not a required capability.

## Settled Design Decisions

| # | Decision | Reasoning |
|---|----------|-----------|
| 1 | Algorithm: sliding window over 1 Hz timeseries, no stability gate | Highest precision; matches existing 5K/10K/half "no gate" behavior |
| 2 | Race distances scanned: 5K, 10K, half, full | Unified treatment per `RACE_TYPE_BANDS` |
| 3 | No source marking column; rely on `label_id` to look up activity if needed | YAGNI — no current consumer needs the distinction |
| 4 | Pause rule: only invalidates the candidate segment, not the whole activity | Auto-paused activities can still yield PBs from non-overlapping segments |
| 5 | Keep PB history (multiple rows per `race_type`) so 2nd-best, timeline queries are possible | User requirement |
| 6 | Use exact canonical distances (5000 / 10000 / 21097.5 / 42195) — not band bounds | Cleaner; more accurate VDOT. Activities under canonical distance don't enroll for that race_type. |
| 7 | No fallback if timeseries missing | User decision; existing activities have timeseries |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ src/stride_core/running_calibration/segments.py              │
│                                                              │
│   + best_distance_candidates(timeseries, pauses_s,           │
│                              canonical_distances)            │
│     → dict[race_type → DistanceCandidate]                    │
│   Pure function: in (t_s, dist_m) tuples → out segment       │
│   metadata. No DB, no units conversion, no domain knowledge. │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ src/stride_core/ability.py                                   │
│                                                              │
│   + compute_pb_vdot_for_segment(race_type, distance_m,       │
│                                 duration_s) → float | None   │
│   Wraps daniels_vdot (5K/10K/half) and                       │
│   _marathon_time_to_vdot_table (full).                       │
│                                                              │
│   – compute_pb_vdot_for_activity                  ← deleted  │
│   – classify_race_type                            ← deleted  │
│   – _is_well_paced_marathon                       ← deleted  │
│   – RACE_TYPE_BANDS                               ← deleted  │
│                                                              │
│   * compute_l3_vo2max reader query                ← updated  │
│     uses ROW_NUMBER() OVER (PARTITION BY race_type           │
│     ORDER BY vdot DESC, pb_date DESC)                        │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ src/stride_core/ability_hook.py                              │
│                                                              │
│   * run_ability_hook                              ← updated  │
│     For each new label_id:                                   │
│       1. fetch_timeseries(lid)                               │
│       2. parse pauses from activity row                      │
│       3. best_distance_candidates(...)                       │
│       4. for each (race_type, candidate):                    │
│            compute_pb_vdot_for_segment(...)                  │
│            db.upsert_vo2max_pb(...)                          │
│     Wrapped in per-label try/except (existing pattern).      │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ src/stride_core/db.py                                        │
│                                                              │
│   * vo2max_pb schema                              ← migrated │
│     id INTEGER PRIMARY KEY AUTOINCREMENT                     │
│     UNIQUE(race_type, label_id)                              │
│     CREATE INDEX idx_vo2max_pb_vdot                          │
│       ON vo2max_pb(race_type, vdot DESC)                     │
│                                                              │
│   * upsert_vo2max_pb                              ← updated  │
│     ON CONFLICT(race_type, label_id) DO UPDATE               │
│       WHERE excluded.vdot > vo2max_pb.vdot                   │
│                                                              │
│   + fetch_timeseries(label_id)                    ← new      │
│     SELECT timestamp, distance FROM timeseries               │
│     WHERE label_id=? AND distance IS NOT NULL                │
│     ORDER BY timestamp ASC                                   │
│                                                              │
│   + _migrate_vo2max_pb_to_v2()                    ← new      │
│     Idempotent table-rebuild migration.                      │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ scripts/backfill_vo2max_pbs.py                               │
│                                                              │
│   * Calls migration first (idempotent).                      │
│   * Loop over all running activities → run segment scan +    │
│     upsert. No separate whole-activity branch.               │
│   * --dry-run flag preserved.                                │
└──────────────────────────────────────────────────────────────┘
```

**Six sync entry points** (`run_post_sync_for_labels` callers) all converge
through `AbilityHandler → run_ability_hook`, so no wiring changes outside
the hook itself.

## Algorithm Detail

### Inputs (per activity)

- `timeseries`: ordered `[(t_s, dist_m), ...]` with `t_s` as seconds since
  activity start, `dist_m` as cumulative meters. Unit normalization happens
  in `ability_hook._normalize_ts_units` (COROS raw: `timestamp` in 0.01 s
  ticks, `distance` in cm → divide both by 100).
- `pauses_s`: `[(pause_start_s, pause_end_s), ...]` in the same time base.
  Format of `activities.pauses` JSON is **TBD verify** — assumed to use
  activity-start-relative seconds; if COROS stores epoch ms or raw ticks,
  the parser converts to the timeseries base.
- `canonical_distances`: `{"5K": 5000, "10K": 10000, "half": 21097.5, "full": 42195}`.

### Sliding Window (per race_type)

```python
def best_distance_candidate(ts, pauses, D):
    """Return fastest continuous D-distance segment that doesn't overlap any pause."""
    if ts[-1][1] - ts[0][1] < D:
        return None

    best = None  # (duration_s, start_t, end_t)
    j = 0
    for i in range(len(ts)):
        t_i, d_i = ts[i]
        while j < len(ts) and ts[j][1] - d_i < D:
            j += 1
        if j == len(ts):
            break

        # Linear interpolate exact time at distance d_i + D
        a_t, a_d = ts[j - 1]
        b_t, b_d = ts[j]
        end_t = a_t if b_d == a_d else a_t + (d_i + D - a_d) / (b_d - a_d) * (b_t - a_t)

        if _overlaps_any_pause(t_i, end_t, pauses):
            continue

        seg_dur = end_t - t_i
        if best is None or seg_dur < best[0]:
            best = (seg_dur, t_i, end_t)

    return best
```

Pause overlap uses standard interval intersection. A pause whose endpoint
exactly equals the segment's startpoint (or vice versa) is **not** an
overlap — instant pauses at boundaries don't disqualify the segment.

Complexity: per race_type O(N + N·P) where P = # pauses, typically < 5.
Four race_types serial → < 1 ms per activity on real data.

### VDOT Mapping

| race_type | function | notes |
|-----------|----------|-------|
| 5K / 10K / half | `daniels_vdot(distance_m, duration_s)` | Existing Daniels formula |
| full | `_marathon_time_to_vdot_table(duration_s)` | Existing table reverse-lookup; `distance_m` is informational |

Returns `None` on degenerate input (negative / out-of-table / zero division)
→ hook skips that race_type, no `vo2max_pb` row written.

## Data Model

### Schema (after migration)

```sql
CREATE TABLE vo2max_pb (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    race_type    TEXT NOT NULL,              -- '5K' | '10K' | 'half' | 'full'
    distance_m   REAL NOT NULL,              -- canonical D for the race_type
    duration_s   REAL NOT NULL,              -- segment duration (0.1 s precision)
    vdot         REAL NOT NULL,
    pb_date      TEXT NOT NULL,              -- source activity Shanghai date
    label_id     TEXT NOT NULL,              -- source activity id
    even_paced   INTEGER NOT NULL DEFAULT 1, -- legacy; always 1; no consumer filters on it
    updated_at   TEXT NOT NULL,
    UNIQUE(race_type, label_id)
);
CREATE INDEX idx_vo2max_pb_vdot ON vo2max_pb(race_type, vdot DESC);
```

### Upsert

```sql
INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, pb_date,
                       label_id, even_paced, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(race_type, label_id) DO UPDATE SET
    distance_m = excluded.distance_m,
    duration_s = excluded.duration_s,
    vdot       = excluded.vdot,
    pb_date    = excluded.pb_date,
    even_paced = excluded.even_paced,
    updated_at = excluded.updated_at
  WHERE excluded.vdot > vo2max_pb.vdot
```

→ One row per `(race_type, source_activity)`. Re-running segment scan on
the same activity is idempotent (same VDOT → conflict → not-higher → no-op).
A faster recompute (e.g., algorithm tweak) overwrites the row.

### Reader Queries

| Use case | Query |
|----------|-------|
| Current PB per race_type (for `compute_l3_vo2max`) | `SELECT … FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY race_type ORDER BY vdot DESC, pb_date DESC) AS rn FROM vo2max_pb) WHERE rn = 1` |
| Nth-best for a race_type | `SELECT … WHERE race_type=? ORDER BY vdot DESC LIMIT 1 OFFSET ?` |
| Progression timeline | `SELECT pb_date, vdot, duration_s FROM vo2max_pb WHERE race_type=? ORDER BY pb_date ASC` |

`compute_l3_vo2max` downstream contract unchanged — still receives one row
per race_type. Internal blending logic untouched.

### Migration

`_migrate_vo2max_pb_to_v2` wrapped in a single transaction:

1. Detect via `PRAGMA table_info(vo2max_pb)` whether `id` column exists.
   If yes → already v2, no-op.
2. `CREATE TABLE vo2max_pb_new (...)` with the v2 schema.
3. `INSERT INTO vo2max_pb_new (race_type, distance_m, duration_s, vdot,
    pb_date, label_id, even_paced, updated_at) SELECT … FROM vo2max_pb`.
   Old rows have race_type unique → label_id also unique → satisfies new
   UNIQUE constraint.
4. `DROP TABLE vo2max_pb` then `ALTER TABLE vo2max_pb_new RENAME TO vo2max_pb`.
5. `CREATE INDEX idx_vo2max_pb_vdot ON vo2max_pb(race_type, vdot DESC)`.

Failure rolls back automatically; old table preserved. Called from
`Database._ensure_columns()` on first connection after deploy and from
the backfill script as belt-and-braces.

## Behavior Changes from Old Path

| # | Change | Direction |
|---|--------|-----------|
| 1 | Activities with embedded fast segments now enroll PBs | Improvement — fixes the original bug |
| 2 | 5K / 10K / half VDOT computed on canonical distance (5000 / 10000 / 21097.5), not the activity's actual distance | Improvement — more accurate; a 5.2 km race gets its fastest 5000 m time, not the full-distance average |
| 3 | Short-course "marathons" (41.0 – 42.194 km activities) no longer enroll as `full` PBs | Tightening — the canonical full marathon is 42195 m; sub-distance activities don't qualify |
| 4 | Marathon `_is_well_paced_marathon` gate removed; a 42 195+ m activity always enrolls regardless of second-half breakdown | Regression on crashed marathons — accepted as a consequence of the "no gate" decision |
| 5 | `vo2max_pb` keeps history (potentially many rows per race_type) instead of one current-best row | Schema change — enables 2nd-best queries, PB timelines |

## Edge Cases & Error Handling

| Situation | Behavior |
|-----------|----------|
| `fetch_timeseries` returns `[]` | `best_distance_candidates` returns `{}`; no PB rows written; no log noise (common for older activities) |
| Timeseries row count < 2 | Same — empty result |
| `timestamp` or `distance` is NULL on a row | Filtered by SQL (`WHERE distance IS NOT NULL`) and again in `_normalize_ts_units` |
| Non-monotonic distance (GPS noise) | Two-pointer advance still progresses on `d[j] - d_i ≥ D`; worst case is no candidate found, no crash |
| Repeated timestamp at interpolation boundary | `end_t = b_t` fallback to avoid division by zero |
| `activities.pauses` is NULL / empty string | `_parse_pauses` → `[]`; no overlap rejections |
| `pauses` JSON parse error | `_parse_pauses` catches → returns `[]` and logs a warning |
| Inverted pause `(end < start)` | Dropped during normalization with warning |
| Pause time-base unclear | TBD: implementation step 1 is to verify the actual format in `activities.pauses` for COROS sync (epoch ms vs activity-start seconds vs raw tick). Parser converts to activity-start seconds. |
| `compute_pb_vdot_for_segment` returns None | Skip that race_type; continue with others |
| Single label_id fails | Existing per-label `try/except` in `run_ability_hook` swallows + logs warning; other labels unaffected |
| Migration error mid-transaction | Auto rollback; old table intact; user can retry |
| Concurrent writers | SQLite per-user DB + single connection serializes naturally; even with future concurrent writes, the `vdot >` guard on upsert prevents stale overwrites |

## Testing Strategy

### Pure functions — `tests/test_segments.py` (new)

`best_distance_candidates` and `compute_pb_vdot_for_segment` are pure
functions with no IO; ~10–15 unit tests:

- `test_total_distance_below_target` → `{}`
- `test_exact_distance_match` → degenerate-case segment = whole activity
- `test_embedded_fast_block_in_long_run` → fastest segment found, time matches manual calc
- `test_pause_overlaps_fastest_segment` → returns next-fastest non-overlapping segment
- `test_pause_at_segment_boundary` → not an overlap; segment valid
- `test_multiple_pauses_chopping_activity` → finds best in longest unbroken sub-interval
- `test_all_segments_blocked_by_pauses` → `{}` for that race_type
- `test_non_monotonic_distance_does_not_crash` → returns a sensible value
- `test_marathon_embedded_in_ultra` → `full` key present
- `test_short_marathon_under_canonical_dropped` → `full` key absent
- `test_linear_interp_precision` → end_t accurate within 0.01 s
- `test_vdot_for_segment_5k_known_pace` → matches Daniels expected value
- `test_vdot_for_segment_marathon_uses_table` → goes through table lookup
- `test_vdot_for_segment_degenerate_input_returns_none`

### Hook wiring — `tests/test_ability_hook.py` (new)

In-memory SQLite + schema + fixture activity + timeseries, call
`run_ability_hook(db, [label_id])`, assert `vo2max_pb` rows:

- `test_hook_writes_segment_pb_from_long_run`
- `test_hook_idempotent_on_resync`
- `test_hook_writes_multiple_race_types_from_same_activity`
- `test_hook_skips_activity_without_timeseries`
- `test_hook_skips_non_running_sport`
- `test_hook_isolates_failure_per_label`

### Migration — `tests/test_db_migration.py` (extend)

- `test_migrate_vo2max_pb_v1_to_v2` — populated v1 → v2 lossless
- `test_migrate_handles_empty_table`
- `test_migrate_is_idempotent` — running twice equals running once
- `test_migrate_rollback_on_error` — injected failure restores v1

### Existing test cleanup — `tests/test_ability.py`

| Original | Action |
|----------|--------|
| `test_compute_pb_vdot_for_5k` | Delete (function removed) |
| `test_compute_pb_vdot_for_marathon_uses_table` | Rewrite against `compute_pb_vdot_for_segment("full", 42195, T)` |
| `test_compute_pb_vdot_rejects_dnf_marathon` | Delete (behavior change #4 — no longer rejected) |
| `test_db_upsert_vo2max_pb_keeps_higher_vdot` | Rewrite against new conflict target `(race_type, label_id)` |
| `test_db_upsert_vo2max_pb_atomic_on_conflict` | Same — new conflict target |
| `test_compute_l3_vo2max_pb_floor_lifts_estimate` | Keep — consumer contract unchanged |

### Integration regression — `tests/test_integration_segment_pb.py` (new)

Fixture-based test using a captured snapshot of activity `477783793625760045`
and its timeseries:

- Run `run_ability_hook` against this label_id
- Assert: `vo2max_pb` row appears with `race_type='5K'`, `duration_s ≈ 1170`,
  `vdot ≈ 51`
- Assert: when querying "current 5K PB", this row is selected over the
  2026-04-24 row

This locks in today's manual verification as a regression guard.

### Backfill smoke test

`scripts/backfill_vo2max_pbs.py --dry-run -P zhaochaoyi` — manual review
of the projected writes before merging. Not part of CI (depends on real
user data). Listed in the spec as a pre-merge checklist item.

### Not tested

- Internal correctness of `daniels_vdot` / `_marathon_time_to_vdot_table`
  (already covered in existing tests)
- SQLite UNIQUE / ON CONFLICT semantics (DB-guaranteed)
- `compute_l3_vo2max` internal blending (consumer contract unchanged;
  only the query upstream of it changes)

## Implementation Sequencing (high level)

Implementation plan will be written separately by `writing-plans`. Rough
ordering:

1. **Verify pauses format** — confirm the time base of `activities.pauses`
   JSON via real data inspection before writing the parser.
2. **Pure `best_distance_candidates`** in `running_calibration/segments.py`
   + unit tests.
3. **`compute_pb_vdot_for_segment`** in `ability.py` + tests; delete old
   `compute_pb_vdot_for_activity`, `classify_race_type`, `RACE_TYPE_BANDS`,
   `_is_well_paced_marathon`.
4. **DB layer**: schema migration, new `fetch_timeseries`, updated
   `upsert_vo2max_pb`, updated `compute_l3_vo2max` reader query.
5. **Hook wiring** in `ability_hook.py` + hook tests + integration test
   for `477783793625760045`.
6. **Backfill script** update + dry-run.
7. **Run real backfill** on each user, spot-check PB rows.

## Open Items (resolve at implementation time)

- Time-base format of `activities.pauses` JSON (epoch ms vs activity-start
  seconds vs raw COROS ticks). Inspect data, document in code comment.
- Confirm all current `vo2max_pb` rows migrate cleanly (no NULL `label_id`,
  no inconsistencies that would violate the new UNIQUE constraint).
