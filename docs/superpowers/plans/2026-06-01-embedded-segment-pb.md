# Embedded Segment PB Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `vo2max_pb` whole-activity enrollment with a continuous-segment scan over the 1 Hz timeseries so a fast 5K/10K/half/full block embedded in a longer activity (e.g., 5K tempo inside a long run) lifts the PB and downstream race predictions. Also convert `vo2max_pb` from one-row-per-distance to a per-(race_type, source-activity) history.

**Architecture:** Single sliding-window algorithm in `running_calibration/segments.py` (pure function over `[(t_s, dist_m)]`), VDOT wrapper in `ability.py`, called from `ability_hook.run_ability_hook` after timeseries fetch + pause normalization. `vo2max_pb` schema gains autoincrement `id` and `UNIQUE(race_type, label_id)`; `compute_l3_vo2max` reader uses a `ROW_NUMBER() OVER (PARTITION BY race_type ORDER BY vdot DESC)` query to pick current best per distance.

**Tech Stack:** Python 3.12, SQLite (per-user `data/{user_id}/coros.db`), pytest. Existing helpers: `daniels_vdot`, `_marathon_time_to_vdot_table`.

**Spec:** `docs/superpowers/specs/2026-06-01-embedded-segment-pb-design.md`

---

## File Map

**Create:**
- `tests/test_segments_distance.py` — pure-function tests for `best_distance_candidates` + `compute_pb_vdot_for_segment`
- `tests/test_ability_hook_segment_pb.py` — hook wiring tests (in-memory DB)
- `tests/test_integration_segment_pb.py` — regression test on captured 2026-05-27 activity fixture
- `tests/fixtures/segment_pb/activity_477783793625760045.json` — captured activity + timeseries + pauses
- `tests/test_db_migration_vo2max_pb_v2.py` — schema migration test

**Modify:**
- `src/stride_core/running_calibration/segments.py` — add `DistanceCandidate` + `best_distance_candidates`
- `src/stride_core/running_calibration/__init__.py` — export the new symbols
- `src/stride_core/ability.py` — add `compute_pb_vdot_for_segment`; update `compute_l3_vo2max` reader query; delete `compute_pb_vdot_for_activity`, `classify_race_type`, `_is_well_paced_marathon`, `RACE_TYPE_BANDS`
- `src/stride_core/db.py` — update `vo2max_pb` `SCHEMA` constant; add `_migrate_vo2max_pb_to_v2`; update `upsert_vo2max_pb` conflict target; add `fetch_timeseries`; call migration from `_ensure_columns`
- `src/stride_core/ability_hook.py` — replace whole-activity PB call with segment scan; add `_parse_pauses`, `_normalize_ts_units` helpers; load `pauses` column
- `scripts/backfill_vo2max_pbs.py` — single segment-scan path; call migration first
- `tests/test_ability.py` — delete 3 obsolete tests, rewrite 3

---

## Task 1: `DistanceCandidate` + `best_distance_candidates` skeleton (failing test)

**Files:**
- Create: `tests/test_segments_distance.py`
- Modify: `src/stride_core/running_calibration/segments.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_segments_distance.py`:

```python
"""Tests for distance-based segment scan in running_calibration.segments."""
from __future__ import annotations

import pytest

from stride_core.running_calibration.segments import (
    DistanceCandidate,
    best_distance_candidates,
)


CANONICAL = {"5K": 5000.0, "10K": 10000.0, "half": 21097.5, "full": 42195.0}


def _flat_ts(total_dist_m: float, total_dur_s: float, hz: float = 1.0):
    """Build an even-paced timeseries: (t_s, dist_m) tuples at given rate."""
    n = max(2, int(total_dur_s * hz) + 1)
    return [(i / hz, total_dist_m * (i / (n - 1))) for i in range(n)]


def test_total_distance_below_target_returns_empty():
    ts = _flat_ts(total_dist_m=3000.0, total_dur_s=900.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances=CANONICAL)
    assert out == {}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py::test_total_distance_below_target_returns_empty -v
```

Expected: `ImportError: cannot import name 'DistanceCandidate' from 'stride_core.running_calibration.segments'`

- [ ] **Step 3: Write minimal implementation**

Append to `src/stride_core/running_calibration/segments.py` (after the existing `SpeedCandidate` dataclass):

```python
@dataclass(frozen=True)
class DistanceCandidate:
    """A continuous segment of an activity that covered a target distance.

    Times are in seconds relative to the activity's first timeseries point.
    `distance_m` is the canonical target distance (not the actual cumulative
    distance traveled in the segment, which equals the target by definition).
    """

    race_type: str
    distance_m: float
    duration_s: float
    start_t_s: float
    end_t_s: float


def best_distance_candidates(
    timeseries: Sequence[tuple[float, float]],
    pauses_s: Sequence[tuple[float, float]],
    canonical_distances: dict[str, float],
) -> dict[str, DistanceCandidate]:
    """For each race_type, find the fastest continuous segment of the given
    target distance whose [start, end] does NOT overlap any pause interval.

    Returns a dict keyed by race_type. Missing key = no qualifying segment
    (either total distance < target, or every candidate overlaps a pause).
    """
    if len(timeseries) < 2:
        return {}
    total_dist = timeseries[-1][1] - timeseries[0][1]
    out: dict[str, DistanceCandidate] = {}
    for race_type, target in canonical_distances.items():
        if total_dist < target:
            continue
        # Placeholder — Task 2 implements the sliding window.
    return out
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py::test_total_distance_below_target_returns_empty -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/test_segments_distance.py src/stride_core/running_calibration/segments.py
git commit -m "feat(segments): scaffold DistanceCandidate + best_distance_candidates"
```

---

## Task 2: Sliding-window algorithm (no pauses yet)

**Files:**
- Modify: `tests/test_segments_distance.py`
- Modify: `src/stride_core/running_calibration/segments.py`

- [ ] **Step 1: Write failing tests for exact match + embedded fast block**

Append to `tests/test_segments_distance.py`:

```python
def test_exact_distance_match_returns_whole_activity():
    """5.0 km even-paced run for 19:30 → segment IS the whole activity."""
    ts = _flat_ts(total_dist_m=5000.0, total_dur_s=1170.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"5K": 5000.0})
    assert "5K" in out
    cand = out["5K"]
    assert cand.race_type == "5K"
    assert cand.distance_m == 5000.0
    assert cand.duration_s == pytest.approx(1170.0, abs=0.5)
    assert cand.start_t_s == pytest.approx(0.0, abs=0.5)


def test_embedded_fast_block_in_long_run():
    """13 km run; the middle 5 km between t=600s and t=1770s is at 3:54/km
    pace (1170s). Surrounding pace is slower. Sliding window should locate
    the embedded fast block."""
    points = []
    # 0-600s: 1.84 km at 5:25/km (4.84 km - 5 = leftover... use 600s @ slow pace 5.45m/s? Easier: build by sections.)
    # Build by three sections joined.
    # Warmup: 0..600s, 0..1840m (3.07 m/s, ≈5:26/km)
    # Tempo:  600..1770s, 1840..6840m (3:54/km exact = 4.27 m/s)
    # Cooldown: 1770..4171s, 6840..13358m (2.71 m/s, ≈6:09/km)
    sections = [
        (0.0, 600.0, 0.0, 1840.0),
        (600.0, 1770.0, 1840.0, 6840.0),
        (1770.0, 4171.0, 6840.0, 13358.0),
    ]
    for (t0, t1, d0, d1) in sections:
        n = int(t1 - t0)
        for i in range(n):
            f = i / n
            points.append((t0 + i, d0 + (d1 - d0) * f))
    points.append((4171.0, 13358.0))

    out = best_distance_candidates(points, pauses_s=[], canonical_distances={"5K": 5000.0})
    assert "5K" in out
    cand = out["5K"]
    # Allow ±5s slop for interpolation
    assert cand.duration_s == pytest.approx(1170.0, abs=5.0)
    assert cand.start_t_s == pytest.approx(600.0, abs=5.0)
    assert cand.end_t_s == pytest.approx(1770.0, abs=5.0)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py -v
```

Expected: 2 tests FAIL (`"5K" in out` assertion fails because placeholder loop body is empty).

- [ ] **Step 3: Implement the sliding window**

Replace the placeholder body in `best_distance_candidates` (in `src/stride_core/running_calibration/segments.py`) with the real algorithm:

```python
def best_distance_candidates(
    timeseries: Sequence[tuple[float, float]],
    pauses_s: Sequence[tuple[float, float]],
    canonical_distances: dict[str, float],
) -> dict[str, DistanceCandidate]:
    """For each race_type, find the fastest continuous segment of the given
    target distance whose [start, end] does NOT overlap any pause interval.

    Two-pointer sliding window on the cumulative-distance series.
    Linear interpolation gives sub-tick precision on segment endpoints.
    """
    if len(timeseries) < 2:
        return {}
    total_dist = timeseries[-1][1] - timeseries[0][1]
    out: dict[str, DistanceCandidate] = {}

    for race_type, target in canonical_distances.items():
        if total_dist < target:
            continue
        best: tuple[float, float, float] | None = None  # (duration, start_t, end_t)
        j = 0
        for i in range(len(timeseries)):
            t_i, d_i = timeseries[i]
            while j < len(timeseries) and timeseries[j][1] - d_i < target:
                j += 1
            if j == len(timeseries):
                break

            a_t, a_d = timeseries[j - 1]
            b_t, b_d = timeseries[j]
            if b_d == a_d:
                end_t = b_t
            else:
                end_t = a_t + (d_i + target - a_d) / (b_d - a_d) * (b_t - a_t)

            if _overlaps_any_pause(t_i, end_t, pauses_s):
                continue

            seg_dur = end_t - t_i
            if best is None or seg_dur < best[0]:
                best = (seg_dur, t_i, end_t)

        if best is not None:
            out[race_type] = DistanceCandidate(
                race_type=race_type,
                distance_m=target,
                duration_s=best[0],
                start_t_s=best[1],
                end_t_s=best[2],
            )
    return out


def _overlaps_any_pause(
    seg_start_s: float, seg_end_s: float, pauses_s: Sequence[tuple[float, float]]
) -> bool:
    """Half-open intersection: pause ending exactly at seg_start (or pause
    starting exactly at seg_end) is NOT an overlap — boundary pauses don't
    disqualify."""
    for ps, pe in pauses_s:
        if pe > seg_start_s and ps < seg_end_s:
            return True
    return False
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py -v
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_segments_distance.py src/stride_core/running_calibration/segments.py
git commit -m "feat(segments): sliding-window distance-target segment scan"
```

---

## Task 3: Pause rejection + edge cases

**Files:**
- Modify: `tests/test_segments_distance.py`

- [ ] **Step 1: Write failing tests for pause behavior + edges**

Append to `tests/test_segments_distance.py`:

```python
def test_pause_overlaps_fastest_segment_returns_next_best():
    """13 km activity with embedded fast 5K at 600..1770s.
    Pause inserted at 1000..1100s (inside the fast block) → algorithm picks
    the next-best non-overlapping 5K window (somewhere in cooldown)."""
    points = []
    sections = [
        (0.0, 600.0, 0.0, 1840.0),
        (600.0, 1770.0, 1840.0, 6840.0),
        (1770.0, 4171.0, 6840.0, 13358.0),
    ]
    for (t0, t1, d0, d1) in sections:
        n = int(t1 - t0)
        for i in range(n):
            f = i / n
            points.append((t0 + i, d0 + (d1 - d0) * f))
    points.append((4171.0, 13358.0))

    out = best_distance_candidates(
        points,
        pauses_s=[(1000.0, 1100.0)],
        canonical_distances={"5K": 5000.0},
    )
    assert "5K" in out
    # Picked segment must NOT contain the pause window
    cand = out["5K"]
    assert not (cand.start_t_s < 1100.0 and cand.end_t_s > 1000.0)
    # Cooldown is slower → duration > 1170s
    assert cand.duration_s > 1170.0


def test_pause_at_segment_boundary_is_not_overlap():
    """Pause ending exactly at the fast-segment start should NOT disqualify."""
    ts = _flat_ts(total_dist_m=5000.0, total_dur_s=1170.0)
    out = best_distance_candidates(
        ts,
        pauses_s=[(-100.0, 0.0)],  # ends exactly at segment start
        canonical_distances={"5K": 5000.0},
    )
    assert "5K" in out


def test_all_segments_blocked_by_pauses_returns_empty():
    """Pauses chop the activity so no continuous 5km segment survives."""
    ts = _flat_ts(total_dist_m=8000.0, total_dur_s=1800.0)
    out = best_distance_candidates(
        ts,
        pauses_s=[(300.0, 400.0), (700.0, 800.0), (1100.0, 1200.0), (1500.0, 1600.0)],
        canonical_distances={"5K": 5000.0},
    )
    # Each unbroken sub-interval is shorter than what 5km needs at this pace
    # (~4.44 m/s, 5km would take ~1125s; longest unbroken slice is 400s).
    assert "5K" not in out


def test_non_monotonic_distance_does_not_crash():
    """GPS noise: distance occasionally regresses. Algorithm must not raise."""
    ts = [(0.0, 0.0), (60.0, 200.0), (120.0, 190.0), (180.0, 400.0), (240.0, 600.0)]
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"5K": 5000.0})
    assert out == {}


def test_marathon_in_ultra_finds_full():
    """50 km activity at constant pace contains a 42195 m segment."""
    ts = _flat_ts(total_dist_m=50000.0, total_dur_s=18000.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"full": 42195.0})
    assert "full" in out
    assert out["full"].distance_m == 42195.0


def test_short_marathon_under_canonical_dropped():
    """41.5 km activity does NOT yield a `full` candidate."""
    ts = _flat_ts(total_dist_m=41500.0, total_dur_s=15000.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"full": 42195.0})
    assert "full" not in out


def test_multiple_race_types_one_pass():
    """13 km activity should yield candidates for both 5K and 10K."""
    ts = _flat_ts(total_dist_m=13000.0, total_dur_s=4000.0)
    out = best_distance_candidates(
        ts,
        pauses_s=[],
        canonical_distances={"5K": 5000.0, "10K": 10000.0, "half": 21097.5},
    )
    assert "5K" in out and "10K" in out
    assert "half" not in out  # 13 km < 21097.5 m
```

- [ ] **Step 2: Run tests to verify they fail or pass appropriately**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py -v
```

Expected: previously-passing tests still PASS, new tests likely all PASS because Task 2's implementation already handles pauses. If any new test fails, fix the implementation.

- [ ] **Step 3: If any tests fail, fix the implementation; otherwise no code change**

If `test_pause_at_segment_boundary_is_not_overlap` fails (because `_overlaps_any_pause` mistakenly counts boundary touches), revisit the inequality in `_overlaps_any_pause`. The implementation `pe > seg_start_s and ps < seg_end_s` uses strict inequalities specifically so boundary touches don't count.

- [ ] **Step 4: Run all segments tests**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_segments_distance.py
git commit -m "test(segments): pause rejection + GPS noise + multi-race-type cases"
```

---

## Task 4: `compute_pb_vdot_for_segment` VDOT wrapper

**Files:**
- Modify: `tests/test_segments_distance.py`
- Modify: `src/stride_core/ability.py`

- [ ] **Step 1: Write failing tests for VDOT computation**

Append to `tests/test_segments_distance.py`:

```python
from stride_core.ability import compute_pb_vdot_for_segment


def test_vdot_for_segment_5k_known_pace():
    """19:30 over 5000 m via Daniels — VDOT in mid-50s ballpark."""
    vdot = compute_pb_vdot_for_segment("5K", 5000.0, 1170.0)
    assert vdot is not None
    assert 48.0 < vdot < 55.0


def test_vdot_for_segment_marathon_uses_table():
    """2:59:22 marathon — goes via the table, not Daniels formula."""
    vdot = compute_pb_vdot_for_segment("full", 42195.0, 10762.0)
    assert vdot is not None
    assert 50.0 < vdot < 60.0


def test_vdot_for_segment_invalid_distance_or_time_is_none():
    assert compute_pb_vdot_for_segment("5K", 0.0, 1170.0) is None
    assert compute_pb_vdot_for_segment("5K", 5000.0, 0.0) is None
    assert compute_pb_vdot_for_segment("5K", -1.0, 1170.0) is None


def test_vdot_for_segment_marathon_time_out_of_table_returns_none():
    """An impossibly fast marathon (60 minutes) returns None from the table."""
    vdot = compute_pb_vdot_for_segment("full", 42195.0, 3600.0)
    assert vdot is None
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py -v -k vdot
```

Expected: 4 tests FAIL with `ImportError: cannot import name 'compute_pb_vdot_for_segment'`.

- [ ] **Step 3: Implement `compute_pb_vdot_for_segment`**

Add to `src/stride_core/ability.py` (place near `daniels_vdot`, before the deletion targets — `compute_pb_vdot_for_activity` etc., which will be removed in Task 11):

```python
def compute_pb_vdot_for_segment(
    race_type: str, distance_m: float, duration_s: float
) -> float | None:
    """Compute VDOT for a continuous race-distance segment.

    Used by the segment-scan PB path. For 5K/10K/half this uses the Daniels
    formula directly; for `full` it uses the table reverse-lookup, which is
    more reliable than the formula for marathon-scale durations.

    Returns None on degenerate input.
    """
    if distance_m <= 0 or duration_s <= 0:
        return None
    if race_type == "full":
        vdot = _marathon_time_to_vdot_table(float(duration_s))
        if vdot is None:
            return None
        return float(vdot)
    vdot = daniels_vdot(float(distance_m), float(duration_s))
    if vdot <= 0:
        return None
    return float(vdot)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_segments_distance.py src/stride_core/ability.py
git commit -m "feat(ability): compute_pb_vdot_for_segment wrapping daniels + marathon table"
```

---

## Task 5: Schema migration `_migrate_vo2max_pb_to_v2`

**Files:**
- Create: `tests/test_db_migration_vo2max_pb_v2.py`
- Modify: `src/stride_core/db.py`

- [ ] **Step 1: Write failing migration tests**

Create `tests/test_db_migration_vo2max_pb_v2.py`:

```python
"""Tests for the vo2max_pb v1→v2 schema migration."""
from __future__ import annotations

import sqlite3
import pytest

from stride_core.db import Database


V1_SCHEMA = """
CREATE TABLE vo2max_pb (
    race_type       TEXT PRIMARY KEY,
    distance_m      REAL NOT NULL,
    duration_s      REAL NOT NULL,
    vdot            REAL NOT NULL,
    pb_date         TEXT NOT NULL,
    label_id        TEXT NOT NULL,
    even_paced      INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)
"""


def _open_with_v1(tmp_path):
    """Create a DB with the v1 schema and return a raw sqlite3 connection."""
    db_path = tmp_path / "coros.db"
    con = sqlite3.connect(db_path)
    con.execute(V1_SCHEMA)
    con.commit()
    return db_path, con


def test_migrate_populated_table_v1_to_v2(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    rows = [
        ("5K", 5000, 1199.64, 49.8, "2026-04-24", "477029282768519567", 1),
        ("10K", 10060, 2453, 51.0, "2026-04-25", "477053397399273475", 1),
    ]
    con.executemany(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
        rows,
    )
    con.commit()
    con.close()

    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()

    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols

    out = list(db._conn.execute(
        "SELECT race_type, label_id, vdot FROM vo2max_pb ORDER BY race_type"
    ))
    assert len(out) == 2
    assert out[0]["race_type"] == "10K"
    assert out[1]["race_type"] == "5K"


def test_migrate_is_idempotent(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    con.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id) VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'X')"
    )
    con.commit()
    con.close()

    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()
    db._migrate_vo2max_pb_to_v2()  # second call is a no-op

    rows = list(db._conn.execute("SELECT race_type, label_id FROM vo2max_pb"))
    assert len(rows) == 1
    assert rows[0]["race_type"] == "5K"


def test_migrate_empty_table_v1_to_v2(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    con.close()

    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()

    rows = list(db._conn.execute("SELECT * FROM vo2max_pb"))
    assert rows == []
    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols


def test_migrate_creates_unique_index_and_constraint(tmp_path):
    db_path, con = _open_with_v1(tmp_path)
    con.close()
    db = Database(db_path=db_path)
    db._migrate_vo2max_pb_to_v2()
    # UNIQUE(race_type, label_id) → duplicate insert raises
    db._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
            "pb_date, label_id, even_paced, updated_at) "
            "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
        )
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_db_migration_vo2max_pb_v2.py -v
```

Expected: 4 tests FAIL with `AttributeError: 'Database' object has no attribute '_migrate_vo2max_pb_to_v2'`.

- [ ] **Step 3: Implement the migration**

Add to `src/stride_core/db.py` inside the `Database` class (near other `_ensure_*` / migration methods — search for `_ensure_columns` to find the location):

```python
def _migrate_vo2max_pb_to_v2(self) -> None:
    """Migrate `vo2max_pb` from v1 (race_type PRIMARY KEY) to v2 (autoinc
    id + UNIQUE(race_type, label_id) + index on vdot DESC).

    Idempotent: detects v2 via presence of the `id` column.
    Atomic: full table rebuild inside a single transaction.
    """
    cols = [r[1] for r in self._conn.execute("PRAGMA table_info(vo2max_pb)")]
    if not cols:
        return  # table doesn't exist yet; the SCHEMA CREATE will produce v2
    if "id" in cols:
        return  # already v2

    with self._conn:
        self._conn.execute(
            """CREATE TABLE vo2max_pb_new (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                race_type    TEXT NOT NULL,
                distance_m   REAL NOT NULL,
                duration_s   REAL NOT NULL,
                vdot         REAL NOT NULL,
                pb_date      TEXT NOT NULL,
                label_id     TEXT NOT NULL,
                even_paced   INTEGER NOT NULL DEFAULT 1,
                updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(race_type, label_id)
            )"""
        )
        self._conn.execute(
            """INSERT INTO vo2max_pb_new
               (race_type, distance_m, duration_s, vdot, pb_date,
                label_id, even_paced, updated_at)
               SELECT race_type, distance_m, duration_s, vdot, pb_date,
                      label_id, even_paced, updated_at
               FROM vo2max_pb"""
        )
        self._conn.execute("DROP TABLE vo2max_pb")
        self._conn.execute("ALTER TABLE vo2max_pb_new RENAME TO vo2max_pb")
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_vo2max_pb_vdot "
            "ON vo2max_pb(race_type, vdot DESC)"
        )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_db_migration_vo2max_pb_v2.py -v
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_db_migration_vo2max_pb_v2.py src/stride_core/db.py
git commit -m "feat(db): vo2max_pb v1→v2 migration (autoinc id + (race_type,label_id) UNIQUE)"
```

---

## Task 6: Update v2 SCHEMA constant + call migration from `_ensure_columns`

**Files:**
- Modify: `src/stride_core/db.py`
- Modify: `tests/test_db_migration_vo2max_pb_v2.py`

- [ ] **Step 1: Write failing test for fresh-DB v2 schema**

Append to `tests/test_db_migration_vo2max_pb_v2.py`:

```python
def test_fresh_database_creates_v2_schema(tmp_path):
    """A brand-new DB (no v1) should already be on v2 — no migration needed."""
    db_path = tmp_path / "fresh_coros.db"
    db = Database(db_path=db_path)
    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols
    # UNIQUE constraint check
    db._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
    )
    import sqlite3 as _s
    with pytest.raises(_s.IntegrityError):
        db._conn.execute(
            "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
            "pb_date, label_id, even_paced, updated_at) "
            "VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A', 1, datetime('now'))"
        )


def test_existing_v1_db_auto_migrates_on_open(tmp_path):
    """Opening a v1 DB via Database(...) should auto-migrate to v2."""
    db_path, con = _open_with_v1(tmp_path)
    con.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id) VALUES ('5K', 5000, 1200, 49.8, '2026-04-24', 'A')"
    )
    con.commit()
    con.close()

    db = Database(db_path=db_path)  # _ensure_columns should run migration
    cols = [r[1] for r in db._conn.execute("PRAGMA table_info(vo2max_pb)")]
    assert "id" in cols
    rows = list(db._conn.execute("SELECT race_type, label_id FROM vo2max_pb"))
    assert len(rows) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_db_migration_vo2max_pb_v2.py::test_fresh_database_creates_v2_schema tests/test_db_migration_vo2max_pb_v2.py::test_existing_v1_db_auto_migrates_on_open -v
```

Expected: `test_fresh_database_creates_v2_schema` FAILS (SCHEMA constant still v1); `test_existing_v1_db_auto_migrates_on_open` FAILS (migration not wired into open).

- [ ] **Step 3: Update the SCHEMA constant + wire migration into `_ensure_columns`**

In `src/stride_core/db.py`, find the `vo2max_pb` CREATE TABLE block in the `SCHEMA` constant (around line 298) and replace it with v2:

```python
-- v7 PB-memory channel for VO2max. One row per (race_type × source
-- activity); current PB per race_type is `MAX(vdot)`. Read by
-- stride_core.ability when computing the L3 VO2max dimension.
CREATE TABLE IF NOT EXISTS vo2max_pb (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    race_type       TEXT NOT NULL,                 -- '5K' | '10K' | 'half' | 'full'
    distance_m      REAL NOT NULL,
    duration_s      REAL NOT NULL,
    vdot            REAL NOT NULL,
    pb_date         TEXT NOT NULL,                 -- ISO YYYY-MM-DD (Shanghai)
    label_id        TEXT NOT NULL,                 -- source activity id
    even_paced      INTEGER NOT NULL DEFAULT 1,    -- legacy; always 1
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(race_type, label_id)
);
CREATE INDEX IF NOT EXISTS idx_vo2max_pb_vdot ON vo2max_pb(race_type, vdot DESC);
```

Then find `_ensure_columns` (the method that runs schema migrations on connection open) and add a call:

```python
def _ensure_columns(self) -> None:
    # ... existing code ...
    self._migrate_vo2max_pb_to_v2()
```

(If you can't locate `_ensure_columns`, grep for `_ensure_columns` in `src/stride_core/db.py` and add the call at the end of that method.)

- [ ] **Step 4: Run tests to verify**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_db_migration_vo2max_pb_v2.py -v
```

Expected: all 6 tests PASS.

Also run the full DB test suite to confirm no regressions:

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/ -v -k "db or migration" 2>&1 | tail -40
```

Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/db.py tests/test_db_migration_vo2max_pb_v2.py
git commit -m "feat(db): vo2max_pb SCHEMA → v2; auto-migrate on Database open"
```

---

## Task 7: Update `upsert_vo2max_pb` to new conflict target

**Files:**
- Modify: `src/stride_core/db.py`
- Create: `tests/test_db_upsert_vo2max_pb_v2.py`

- [ ] **Step 1: Write failing tests for new upsert semantics**

Create `tests/test_db_upsert_vo2max_pb_v2.py`:

```python
"""Tests for the v2 upsert: keyed on (race_type, label_id), vdot-monotonic."""
from __future__ import annotations

import pytest

from stride_core.db import Database


@pytest.fixture
def db(tmp_path):
    return Database(db_path=tmp_path / "coros.db")


def _upsert(db, *, race_type, label_id, vdot, distance_m=5000.0,
            duration_s=1200.0, pb_date="2026-04-24"):
    return db.upsert_vo2max_pb(
        race_type=race_type, distance_m=distance_m, duration_s=duration_s,
        vdot=vdot, pb_date=pb_date, label_id=label_id, even_paced=True,
    )


def test_two_activities_same_race_type_both_persist(db):
    """Two different activities for 5K → two rows (PB history)."""
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0)
    assert _upsert(db, race_type="5K", label_id="B", vdot=50.0)
    rows = list(db._conn.execute(
        "SELECT label_id, vdot FROM vo2max_pb WHERE race_type='5K' "
        "ORDER BY vdot DESC"
    ))
    assert [r["label_id"] for r in rows] == ["B", "A"]


def test_resync_same_activity_idempotent(db):
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0)
    # Re-sync with same vdot → no change (returns False)
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0) is False
    rows = list(db._conn.execute("SELECT label_id, vdot FROM vo2max_pb"))
    assert len(rows) == 1


def test_recompute_higher_vdot_for_same_activity_updates(db):
    """If a recompute on the same activity yields a higher VDOT, the row
    updates (e.g., algorithm improvement)."""
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0)
    assert _upsert(db, race_type="5K", label_id="A", vdot=51.0) is True
    row = db._conn.execute(
        "SELECT vdot FROM vo2max_pb WHERE race_type='5K' AND label_id='A'"
    ).fetchone()
    assert row["vdot"] == pytest.approx(51.0)


def test_recompute_lower_vdot_for_same_activity_keeps_higher(db):
    assert _upsert(db, race_type="5K", label_id="A", vdot=51.0)
    assert _upsert(db, race_type="5K", label_id="A", vdot=49.0) is False
    row = db._conn.execute(
        "SELECT vdot FROM vo2max_pb WHERE race_type='5K' AND label_id='A'"
    ).fetchone()
    assert row["vdot"] == pytest.approx(51.0)


def test_different_race_types_same_activity_both_persist(db):
    """13km long run with embedded 5K and 10K segments → 2 rows under same
    label_id but different race_types."""
    assert _upsert(db, race_type="5K", label_id="A", vdot=50.0, distance_m=5000.0)
    assert _upsert(db, race_type="10K", label_id="A", vdot=51.0, distance_m=10000.0)
    rows = list(db._conn.execute("SELECT race_type FROM vo2max_pb WHERE label_id='A'"))
    assert sorted(r["race_type"] for r in rows) == ["10K", "5K"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_db_upsert_vo2max_pb_v2.py -v
```

Expected: most tests FAIL because the current upsert uses `ON CONFLICT(race_type)` (overwrites cross-activity), or `test_different_race_types_same_activity_both_persist` may pass while `test_two_activities_same_race_type_both_persist` FAILS.

- [ ] **Step 3: Update `upsert_vo2max_pb`**

In `src/stride_core/db.py`, replace the `upsert_vo2max_pb` body (around lines 1691-1735) with:

```python
def upsert_vo2max_pb(
    self,
    *,
    race_type: str,
    distance_m: float,
    duration_s: float,
    vdot: float,
    pb_date: str,
    label_id: str,
    even_paced: bool = True,
) -> bool:
    """Insert or update a per-activity PB row.

    Keyed on (race_type, label_id) — multiple activities yield multiple
    rows per race_type, forming PB history. On conflict, updates only if
    the incoming vdot strictly exceeds the stored value (e.g., algorithm
    recomputed and got higher), otherwise no-ops. Returns True iff a row
    was inserted or updated.
    """
    cursor = self._conn.execute(
        """INSERT INTO vo2max_pb
           (race_type, distance_m, duration_s, vdot, pb_date, label_id,
            even_paced, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(race_type, label_id) DO UPDATE SET
             distance_m = excluded.distance_m,
             duration_s = excluded.duration_s,
             vdot = excluded.vdot,
             pb_date = excluded.pb_date,
             even_paced = excluded.even_paced,
             updated_at = datetime('now')
           WHERE excluded.vdot > vo2max_pb.vdot""",
        (
            race_type, float(distance_m), float(duration_s), float(vdot),
            pb_date, label_id, 1 if even_paced else 0,
        ),
    )
    self._conn.commit()
    return cursor.rowcount > 0
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_db_upsert_vo2max_pb_v2.py -v
```

Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/db.py tests/test_db_upsert_vo2max_pb_v2.py
git commit -m "feat(db): upsert_vo2max_pb keyed on (race_type, label_id) → PB history"
```

---

## Task 8: `fetch_timeseries` reader + `pauses` in `_load_activity_for_l1`

**Files:**
- Modify: `src/stride_core/db.py`
- Modify: `src/stride_core/ability_hook.py`
- Create: `tests/test_fetch_timeseries.py`

- [ ] **Step 1: Write failing test for `fetch_timeseries`**

Create `tests/test_fetch_timeseries.py`:

```python
"""Tests for Database.fetch_timeseries used by segment PB scan."""
from __future__ import annotations

from stride_core.db import Database


def _insert_activity(db, label_id="X"):
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s, provider) "
        "VALUES (?, 100, '2026-05-27T10:00:00+00:00', 5.0, 1200, 'coros')",
        (label_id,),
    )


def test_fetch_timeseries_returns_ordered_rows(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_activity(db, "X")
    # Insert in reverse to verify ORDER BY timestamp ASC
    for ts, dist in [(300, 5000), (100, 1000), (200, 3000), (0, 0)]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
            ("X", ts, dist),
        )
    db._conn.commit()
    rows = db.fetch_timeseries("X")
    assert [r["timestamp"] for r in rows] == [0, 100, 200, 300]
    assert [r["distance"] for r in rows] == [0, 1000, 3000, 5000]


def test_fetch_timeseries_skips_null_distance(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_activity(db, "X")
    for ts, dist in [(0, 0), (100, None), (200, 2000)]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
            ("X", ts, dist),
        )
    db._conn.commit()
    rows = db.fetch_timeseries("X")
    assert len(rows) == 2
    assert all(r["distance"] is not None for r in rows)


def test_fetch_timeseries_returns_empty_for_unknown_label(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    assert db.fetch_timeseries("NOPE") == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_fetch_timeseries.py -v
```

Expected: 3 tests FAIL with `AttributeError: 'Database' object has no attribute 'fetch_timeseries'`.

- [ ] **Step 3: Implement `fetch_timeseries`**

Add to `src/stride_core/db.py` near other `fetch_*` methods (e.g., after `fetch_vo2max_pbs`):

```python
def fetch_timeseries(self, label_id: str) -> list[sqlite3.Row]:
    """Read (timestamp, distance) rows for one activity, ordered by
    timestamp ASC, skipping NULL distance rows. Returns [] for unknown
    label_id or activity with no timeseries.

    Units are NOT normalized here — see `ability_hook._normalize_ts_units`
    for the COROS centi-second / centimeter conversion.
    """
    return list(self._conn.execute(
        "SELECT timestamp, distance FROM timeseries "
        "WHERE label_id = ? AND distance IS NOT NULL "
        "ORDER BY timestamp ASC",
        (str(label_id),),
    ))
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_fetch_timeseries.py -v
```

Expected: 3 tests PASS.

- [ ] **Step 5: Add `pauses` column to `_load_activity_for_l1`**

In `src/stride_core/ability_hook.py`, find `_load_activity_for_l1` (around line 200) and add `pauses` to the SELECT column list:

```python
row = conn.execute(
    "SELECT label_id, sport_type, train_type, train_kind, avg_hr, max_hr, "
    "avg_pace_s_km, distance_m, duration_s, avg_cadence, date, pauses "
    "FROM activities WHERE label_id = ?",
    (label_id,),
).fetchone()
```

- [ ] **Step 6: Commit**

```bash
git add src/stride_core/db.py src/stride_core/ability_hook.py tests/test_fetch_timeseries.py
git commit -m "feat(db): add fetch_timeseries; load pauses in _load_activity_for_l1"
```

---

## Task 9: `_parse_pauses` + `_normalize_ts_units` helpers

**Files:**
- Modify: `src/stride_core/ability_hook.py`
- Create: `tests/test_ability_hook_helpers.py`

- [ ] **Step 1: Write failing tests for the parsers**

Create `tests/test_ability_hook_helpers.py`:

```python
"""Tests for _parse_pauses and _normalize_ts_units in ability_hook.

Real COROS data uses absolute centi-second ticks for timestamps and
centimeters for distance. The 2022-11-27 activity 448162183159775233
has a real pause: start_ts=166953421795, end_ts=166953421906, type=0.
"""
from __future__ import annotations

from stride_core.ability_hook import _parse_pauses, _normalize_ts_units


def _row(ts, dist):
    """Mimic a sqlite3.Row via a dict (dict access works the same)."""
    return {"timestamp": ts, "distance": dist}


def test_normalize_ts_units_converts_centi_seconds_and_centimeters():
    """COROS units: timestamp /100 → seconds; distance /100 → meters.
    t_s is activity-relative (subtract first timestamp)."""
    rows = [_row(177987904200, 0), _row(177987904300, 400), _row(177987905200, 4000)]
    out = _normalize_ts_units(rows)
    assert out[0] == (0.0, 0.0)
    assert out[1] == (1.0, 4.0)        # 0.01s, 4 cm
    assert out[2] == (10.0, 40.0)


def test_normalize_ts_units_filters_nulls():
    rows = [_row(100, 0), _row(None, 50), _row(200, None), _row(300, 100)]
    out = _normalize_ts_units(rows)
    # First (100,0) and last (300,100) survive — both have non-null
    assert out == [(0.0, 0.0), (2.0, 1.0)]


def test_normalize_ts_units_empty_input():
    assert _normalize_ts_units([]) == []


def test_parse_pauses_none_returns_empty():
    assert _parse_pauses(None, t0=0) == []
    assert _parse_pauses("", t0=0) == []


def test_parse_pauses_converts_absolute_to_activity_relative_seconds():
    """Real format: {"start_ts": <centi-sec absolute>, "end_ts": <centi-sec abs>}.
    Subtract activity-start t0, divide by 100 → activity-relative seconds."""
    raw = '[{"start_ts": 166953421795, "end_ts": 166953421906, "type": 0}]'
    out = _parse_pauses(raw, t0=166953420000)
    assert len(out) == 1
    start_s, end_s = out[0]
    assert start_s == 17.95
    assert end_s == 19.06


def test_parse_pauses_drops_inverted_intervals():
    raw = '[{"start_ts": 100, "end_ts": 50, "type": 0}]'
    out = _parse_pauses(raw, t0=0)
    assert out == []


def test_parse_pauses_bad_json_returns_empty():
    assert _parse_pauses("not-json", t0=0) == []


def test_parse_pauses_missing_keys_returns_empty():
    raw = '[{"foo": 1}]'
    out = _parse_pauses(raw, t0=0)
    assert out == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_ability_hook_helpers.py -v
```

Expected: all FAIL with `ImportError: cannot import name '_parse_pauses' from 'stride_core.ability_hook'`.

- [ ] **Step 3: Implement the helpers**

Add to `src/stride_core/ability_hook.py` (place near the bottom alongside other underscore-prefixed helpers like `_activity_iso_date`):

```python
import json


def _normalize_ts_units(rows) -> list[tuple[float, float]]:
    """Convert raw timeseries rows to (t_s, dist_m) tuples.

    COROS storage: `timestamp` in 0.01s ticks (centi-seconds), `distance`
    in cm. We divide both by 100 and rebase t to the first surviving row
    so segment scanning works in activity-relative seconds.

    Skips rows where either field is None.
    """
    filtered = [(r["timestamp"], r["distance"]) for r in rows
                if r["timestamp"] is not None and r["distance"] is not None]
    if not filtered:
        return []
    t0 = filtered[0][0]
    return [((ts - t0) / 100.0, dist / 100.0) for ts, dist in filtered]


def _parse_pauses(raw, t0: float) -> list[tuple[float, float]]:
    """Parse the `activities.pauses` JSON string into activity-relative
    seconds tuples.

    COROS stores `start_ts` / `end_ts` as absolute centi-second ticks in
    the same base as `timeseries.timestamp`. We subtract t0 (the first
    surviving timeseries timestamp) and divide by 100. Inverted intervals
    (end < start) and malformed entries are dropped silently; whole-JSON
    parse failures log a warning and return [].
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("could not parse pauses JSON: %r", raw[:80])
        return []
    out: list[tuple[float, float]] = []
    for entry in data:
        try:
            start_abs = entry["start_ts"]
            end_abs = entry["end_ts"]
        except (KeyError, TypeError):
            continue
        if start_abs is None or end_abs is None:
            continue
        start_s = (start_abs - t0) / 100.0
        end_s = (end_abs - t0) / 100.0
        if end_s <= start_s:
            continue
        out.append((start_s, end_s))
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_ability_hook_helpers.py -v
```

Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/ability_hook.py tests/test_ability_hook_helpers.py
git commit -m "feat(hook): _parse_pauses + _normalize_ts_units helpers"
```

---

## Task 10: Wire segment PB scan into `run_ability_hook`

**Files:**
- Modify: `src/stride_core/ability_hook.py`
- Create: `tests/test_ability_hook_segment_pb.py`

- [ ] **Step 1: Write failing hook integration tests**

Create `tests/test_ability_hook_segment_pb.py`:

```python
"""Tests for run_ability_hook segment PB scan path.

Uses an in-memory-ish on-disk SQLite DB seeded with one activity + a
synthetic timeseries; calls run_ability_hook and asserts on vo2max_pb.
"""
from __future__ import annotations

import pytest

from stride_core.db import Database
from stride_core.ability_hook import run_ability_hook
from stride_core.models import RUN_SPORT_IDS


RUN_SPORT_ID = next(iter(RUN_SPORT_IDS))


def _seed_activity_with_timeseries(
    db, label_id, *, total_dist_km, total_dur_s,
    sport_type=RUN_SPORT_ID,
    pauses_json=None,
):
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, "
        "duration_s, avg_hr, max_hr, provider, pauses) "
        "VALUES (?, ?, '2026-05-27T10:00:00+00:00', ?, ?, 150, 175, 'coros', ?)",
        (label_id, sport_type, total_dist_km, total_dur_s, pauses_json),
    )
    # 1 Hz timeseries (COROS units: t_ticks in 1/100 s, distance in cm)
    total_dist_cm = int(total_dist_km * 1000 * 100)
    n = int(total_dur_s) + 1
    for i in range(n):
        t_tick = 100_000_000 + i * 100        # arbitrary epoch in ticks
        dist_cm = int(total_dist_cm * (i / max(1, n - 1)))
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) "
            "VALUES (?, ?, ?)",
            (label_id, t_tick, dist_cm),
        )
    db._conn.commit()


def test_hook_writes_5k_segment_pb_from_5km_activity(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "A", total_dist_km=5.0, total_dur_s=1170)
    run_ability_hook(db, ["A"])
    rows = list(db._conn.execute(
        "SELECT race_type, label_id, duration_s FROM vo2max_pb"
    ))
    pbs = {r["race_type"]: r for r in rows}
    assert "5K" in pbs
    assert pbs["5K"]["label_id"] == "A"
    assert pbs["5K"]["duration_s"] == pytest.approx(1170, abs=2)


def test_hook_writes_5k_and_10k_from_long_run(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "B", total_dist_km=13.0, total_dur_s=4000)
    run_ability_hook(db, ["B"])
    race_types = {r["race_type"] for r in db._conn.execute(
        "SELECT race_type FROM vo2max_pb WHERE label_id='B'"
    )}
    assert race_types == {"5K", "10K"}


def test_hook_idempotent_on_resync(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_activity_with_timeseries(db, "A", total_dist_km=5.0, total_dur_s=1170)
    run_ability_hook(db, ["A"])
    run_ability_hook(db, ["A"])  # second call shouldn't duplicate
    rows = list(db._conn.execute(
        "SELECT COUNT(*) AS n FROM vo2max_pb WHERE label_id='A'"
    ))
    assert rows[0]["n"] == 1


def test_hook_skips_non_running_sport(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    # sport_type 200 is strength in COROS (NOT in RUN_SPORT_IDS)
    _seed_activity_with_timeseries(db, "S", total_dist_km=0.0,
                                    total_dur_s=2700, sport_type=200)
    run_ability_hook(db, ["S"])
    rows = list(db._conn.execute("SELECT * FROM vo2max_pb"))
    assert rows == []


def test_hook_skips_activity_without_timeseries(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, "
        "duration_s, provider) "
        "VALUES ('NOTS', ?, '2026-05-27T10:00:00+00:00', 5.0, 1200, 'coros')",
        (RUN_SPORT_ID,),
    )
    db._conn.commit()
    run_ability_hook(db, ["NOTS"])
    rows = list(db._conn.execute("SELECT * FROM vo2max_pb"))
    assert rows == []


def test_hook_skips_segment_overlapping_pause(tmp_path):
    """5km activity with a pause from t=300s to t=400s (absolute ticks
    100030000..100040000). No 5K segment can avoid the pause → no PB."""
    db = Database(db_path=tmp_path / "coros.db")
    pauses_json = '[{"start_ts": 100030000, "end_ts": 100040000, "type": 0}]'
    _seed_activity_with_timeseries(
        db, "P", total_dist_km=5.0, total_dur_s=1170,
        pauses_json=pauses_json,
    )
    run_ability_hook(db, ["P"])
    rows = list(db._conn.execute(
        "SELECT * FROM vo2max_pb WHERE race_type='5K'"
    ))
    assert rows == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_ability_hook_segment_pb.py -v
```

Expected: most tests FAIL because the hook still uses the old whole-activity path which doesn't scan timeseries for segments.

- [ ] **Step 3: Rewire the hook**

In `src/stride_core/ability_hook.py`, find the PB block inside `run_ability_hook` (around lines 55-79) — the code that calls `compute_pb_vdot_for_activity` and `upsert_vo2max_pb`. Replace it with a segment-scan call:

```python
# Add at top of file with the other imports:
from stride_core.running_calibration.segments import best_distance_candidates


CANONICAL_RACE_DISTANCES = {
    "5K": 5000.0, "10K": 10000.0, "half": 21097.5, "full": 42195.0,
}
```

Then inside `run_ability_hook`, replace the existing PB block (the `try:` containing `compute_pb_vdot_for_activity`) with:

```python
# v8: segment-scan PB enrollment. Each (race_type, source_activity)
# yields its own row; the L3 reader picks current best per race_type.
try:
    from stride_core.ability import compute_pb_vdot_for_segment

    ts_rows = db.fetch_timeseries(lid)
    if ts_rows and len(ts_rows) >= 2:
        ts_norm = _normalize_ts_units(ts_rows)
        if ts_norm and len(ts_norm) >= 2:
            t0_tick = ts_rows[0]["timestamp"]
            pauses_s = _parse_pauses(activity.get("pauses"), t0=t0_tick)
            candidates = best_distance_candidates(
                ts_norm, pauses_s, CANONICAL_RACE_DISTANCES,
            )
            pb_date = _activity_iso_date(activity, today_iso)
            for race_type, cand in candidates.items():
                vdot = compute_pb_vdot_for_segment(
                    race_type, cand.distance_m, cand.duration_s,
                )
                if vdot is None:
                    continue
                db.upsert_vo2max_pb(
                    race_type=race_type,
                    distance_m=cand.distance_m,
                    duration_s=cand.duration_s,
                    vdot=vdot,
                    pb_date=pb_date,
                    label_id=str(lid),
                    even_paced=True,
                )
except Exception:
    logger.warning("segment PB scan failed for %s", lid, exc_info=True)
```

Also remove `compute_pb_vdot_for_activity` from the top-of-function import block:

```python
from stride_core.ability import (
    ABILITY_MODEL_VERSION,
    L4_WEIGHTS,
    compute_ability_snapshot,
    compute_l1_quality,
    # compute_pb_vdot_for_activity is gone — replaced by compute_pb_vdot_for_segment
)
```

- [ ] **Step 4: Run hook tests**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_ability_hook_segment_pb.py -v
```

Expected: 6 tests PASS.

Also run the full segments + hook helpers + DB tests:

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_segments_distance.py tests/test_ability_hook_helpers.py tests/test_db_upsert_vo2max_pb_v2.py tests/test_fetch_timeseries.py -v
```

Expected: all PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/ability_hook.py tests/test_ability_hook_segment_pb.py
git commit -m "feat(hook): segment-scan PB enrollment in run_ability_hook"
```

---

## Task 11: Update `compute_l3_vo2max` reader query

**Files:**
- Modify: `src/stride_core/ability.py`
- Create: `tests/test_compute_l3_vo2max_reader.py`

- [ ] **Step 1: Write failing test for "current best per race_type" selection**

Create `tests/test_compute_l3_vo2max_reader.py`. This tests the SQL reader query in isolation rather than the full snapshot pipeline (which would need much more fixture setup) — the change in this task is purely the query string.

```python
"""Tests for the per-race_type top-vdot reader query used by
compute_ability_snapshot when blending PB history into L3 vo2max."""
from __future__ import annotations

import pytest

from stride_core.db import Database


READER_QUERY = """
SELECT race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced
FROM (
    SELECT race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced,
           ROW_NUMBER() OVER (
             PARTITION BY race_type
             ORDER BY vdot DESC, pb_date DESC
           ) AS rn
    FROM vo2max_pb
)
WHERE rn = 1
"""


def _insert_pb(db, race_type, label_id, vdot, pb_date,
               distance_m=5000.0, duration_s=1200.0):
    db._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))",
        (race_type, distance_m, duration_s, vdot, pb_date, label_id),
    )
    db._conn.commit()


def test_reader_picks_highest_vdot_when_multiple_rows_same_race_type(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_pb(db, "5K", "OLD", vdot=49.8, pb_date="2026-04-24")
    _insert_pb(db, "5K", "NEW", vdot=51.2, pb_date="2026-05-27")

    rows = list(db._conn.execute(READER_QUERY))
    assert len(rows) == 1
    assert rows[0]["race_type"] == "5K"
    assert rows[0]["label_id"] == "NEW"
    assert rows[0]["vdot"] == pytest.approx(51.2)


def test_reader_tie_break_prefers_newer_pb_date(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_pb(db, "5K", "OLDER", vdot=50.0, pb_date="2026-04-24")
    _insert_pb(db, "5K", "NEWER", vdot=50.0, pb_date="2026-05-27")
    rows = list(db._conn.execute(READER_QUERY))
    assert rows[0]["label_id"] == "NEWER"


def test_reader_one_row_per_race_type(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_pb(db, "5K", "A", vdot=51.0, pb_date="2026-05-27")
    _insert_pb(db, "5K", "B", vdot=50.0, pb_date="2026-04-24")
    _insert_pb(db, "10K", "C", vdot=52.0, pb_date="2026-04-25",
               distance_m=10000.0)
    _insert_pb(db, "10K", "D", vdot=51.5, pb_date="2026-03-15",
               distance_m=10000.0)
    rows = list(db._conn.execute(READER_QUERY))
    by_type = {r["race_type"]: r for r in rows}
    assert set(by_type) == {"5K", "10K"}
    assert by_type["5K"]["label_id"] == "A"
    assert by_type["10K"]["label_id"] == "C"


def test_reader_empty_table(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    rows = list(db._conn.execute(READER_QUERY))
    assert rows == []


def test_ability_module_uses_this_query():
    """Guard against the query in ability.py drifting from this test's copy."""
    from pathlib import Path
    import re
    src = Path(__file__).parent.parent / "src" / "stride_core" / "ability.py"
    text = src.read_text()
    # Must contain ROW_NUMBER OVER (PARTITION BY race_type ORDER BY vdot DESC
    pattern = re.compile(
        r"ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION\s+BY\s+race_type\s+"
        r"ORDER\s+BY\s+vdot\s+DESC", re.IGNORECASE
    )
    assert pattern.search(text), (
        "ability.py no longer contains the expected PARTITION BY race_type "
        "ORDER BY vdot DESC reader — either revert the change or update this test"
    )
```

- [ ] **Step 2: Run test to verify partial-fail**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_compute_l3_vo2max_reader.py -v
```

Expected: the four inline-query tests PASS (they execute the new query directly on the test DB), but `test_ability_module_uses_this_query` FAILS because `ability.py` still uses the old `SELECT … FROM vo2max_pb` reader without the window function. This is the test that drives the change in Step 3.

- [ ] **Step 3: Update the reader query in `ability.py`**

In `src/stride_core/ability.py`, find the SELECT statement around line 2152 in `compute_ability_snapshot`:

```python
"label_id, even_paced FROM vo2max_pb"
```

Replace with the per-race_type top-vdot picker:

```python
"""
SELECT race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced
FROM (
    SELECT race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced,
           ROW_NUMBER() OVER (
             PARTITION BY race_type
             ORDER BY vdot DESC, pb_date DESC
           ) AS rn
    FROM vo2max_pb
)
WHERE rn = 1
"""
```

(Keep the surrounding `db._conn.execute(...)` and `.fetchall()` calls intact.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_compute_l3_vo2max_reader.py -v
```

Expected: PASS.

Also run the existing L3 tests to confirm no regression:

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_ability.py -v -k "l3 or pb" 2>&1 | tail -40
```

Expected: any failures here are from tests that will be cleaned up in Task 13. Check counts before that task and after to ensure nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/ability.py tests/test_compute_l3_vo2max_reader.py
git commit -m "feat(ability): L3 reader picks max-vdot per race_type via window fn"
```

---

## Task 12: Integration regression test with captured 2026-05-27 fixture

**Files:**
- Create: `tests/fixtures/segment_pb/activity_477783793625760045.json`
- Create: `tests/test_integration_segment_pb.py`
- Create: `scripts/dump_activity_fixture.py`

- [ ] **Step 1: Write fixture dump script**

Create `scripts/dump_activity_fixture.py`:

```python
#!/usr/bin/env python3
"""Dump one activity + its timeseries + pauses to a JSON fixture for tests.

Usage:
    python scripts/dump_activity_fixture.py -P zhaochaoyi 477783793625760045 \\
        > tests/fixtures/segment_pb/activity_477783793625760045.json
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from stride_core.db import Database  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-P", "--profile", required=True)
    ap.add_argument("label_id")
    args = ap.parse_args()

    db = Database(user=args.profile)
    con = db._conn
    con.row_factory = __import__("sqlite3").Row

    activity = dict(con.execute(
        "SELECT label_id, sport_type, date, distance_m, duration_s, "
        "avg_hr, max_hr, train_kind, train_type, pauses, provider "
        "FROM activities WHERE label_id = ?",
        (args.label_id,),
    ).fetchone())

    ts = [
        {"timestamp": r["timestamp"], "distance": r["distance"]}
        for r in con.execute(
            "SELECT timestamp, distance FROM timeseries "
            "WHERE label_id = ? ORDER BY timestamp ASC",
            (args.label_id,),
        )
    ]

    json.dump({"activity": activity, "timeseries": ts}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
```

Then run it to capture the fixture:

```bash
mkdir -p tests/fixtures/segment_pb
cd /home/zhaochy/running && .venv/bin/python scripts/dump_activity_fixture.py -P zhaochaoyi 477783793625760045 > tests/fixtures/segment_pb/activity_477783793625760045.json
ls -la tests/fixtures/segment_pb/
```

Expected: JSON file ~few hundred KB (4172 timeseries points × ~50 bytes each).

- [ ] **Step 2: Write failing integration test**

Create `tests/test_integration_segment_pb.py`:

```python
"""Integration regression test: real 2026-05-27 long-run-with-embedded-5K-tempo
activity must yield a 5K PB ≈ 19:30 via the segment scan path. This locks in
the bug-fix that motivated the feature."""
from __future__ import annotations

import json
import pytest
from pathlib import Path

from stride_core.db import Database
from stride_core.ability_hook import run_ability_hook


FIXTURE = (
    Path(__file__).parent / "fixtures" / "segment_pb"
    / "activity_477783793625760045.json"
)


@pytest.fixture
def db_with_fixture(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    data = json.loads(FIXTURE.read_text())
    a = data["activity"]
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, "
        "duration_s, avg_hr, max_hr, train_kind, train_type, pauses, provider) "
        "VALUES (:label_id, :sport_type, :date, :distance_m, :duration_s, "
        ":avg_hr, :max_hr, :train_kind, :train_type, :pauses, :provider)",
        a,
    )
    for point in data["timeseries"]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) "
            "VALUES (?, ?, ?)",
            (a["label_id"], point["timestamp"], point["distance"]),
        )
    db._conn.commit()
    return db


def test_segment_pb_for_2026_05_27_long_run_tempo(db_with_fixture):
    """The 13.36 km activity 477783793625760045 contains a 5km segment in
    ~19:30. After the hook runs, vo2max_pb has a 5K row with that label_id
    and duration ≈ 1170 s."""
    label_id = "477783793625760045"
    run_ability_hook(db_with_fixture, [label_id])

    row = db_with_fixture._conn.execute(
        "SELECT race_type, duration_s, vdot, label_id "
        "FROM vo2max_pb WHERE race_type='5K' AND label_id=?",
        (label_id,),
    ).fetchone()
    assert row is not None
    assert row["duration_s"] == pytest.approx(1170, abs=5)   # 19:30 ±5s
    assert 49.0 < row["vdot"] < 55.0


def test_segment_pb_beats_prior_5k_pb_in_history(db_with_fixture):
    """Insert the prior 2026-04-24 19:59 PB as 'OLD' and run the hook;
    the 'current best' query should now select the new row, not OLD."""
    label_id = "477783793625760045"
    db_with_fixture._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES ('5K', 5000, 1199.64, 49.8, '2026-04-24', 'OLD', 1, datetime('now'))"
    )
    db_with_fixture._conn.commit()

    run_ability_hook(db_with_fixture, [label_id])

    # The window-function reader should pick the new (higher-vdot) row
    current = db_with_fixture._conn.execute(
        "SELECT label_id FROM ("
        "  SELECT label_id, ROW_NUMBER() OVER ("
        "    PARTITION BY race_type ORDER BY vdot DESC, pb_date DESC"
        "  ) AS rn FROM vo2max_pb WHERE race_type='5K'"
        ") WHERE rn = 1"
    ).fetchone()
    assert current["label_id"] == label_id
```

- [ ] **Step 3: Run integration test**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/test_integration_segment_pb.py -v
```

Expected: both tests PASS. If `test_segment_pb_for_2026_05_27_long_run_tempo` fails with a duration outside the ±5s window, inspect the actual value — if the algorithm finds, say, 19:30 ± 1s exactly, the test is fine; if it finds something very different (e.g., 18:00 or 21:00), there's a bug in the algorithm or units.

- [ ] **Step 4: Commit fixture + test + dump script**

```bash
git add tests/fixtures/segment_pb/ tests/test_integration_segment_pb.py scripts/dump_activity_fixture.py
git commit -m "test(integration): segment PB regression on 2026-05-27 13km tempo"
```

---

## Task 13: Delete dead code in `ability.py` + clean obsolete tests

**Files:**
- Modify: `src/stride_core/ability.py`
- Modify: `tests/test_ability.py`

- [ ] **Step 1: Identify dead callers**

```bash
cd /home/zhaochy/running && grep -rn "compute_pb_vdot_for_activity\|classify_race_type\|_is_well_paced_marathon\|RACE_TYPE_BANDS" src/ tests/ scripts/
```

Expected callers (besides definitions): `ability_hook.py` (already updated in Task 10), `scripts/backfill_vo2max_pbs.py` (Task 14 will replace), `tests/test_ability.py` (this task cleans).

- [ ] **Step 2: Delete obsolete tests from `tests/test_ability.py`**

Open `tests/test_ability.py` and delete these test functions entirely:

- `test_compute_pb_vdot_for_5k` (around line 1265)
- `test_compute_pb_vdot_for_marathon_uses_table` (around line 1280) — will be replaced
- `test_compute_pb_vdot_rejects_dnf_marathon` (around line 1303) — behavior change #4: crashed marathons enroll now
- `test_db_upsert_vo2max_pb_keeps_higher_vdot` (around line 1340) — replaced by `test_db_upsert_vo2max_pb_v2.py`
- `test_db_upsert_vo2max_pb_atomic_on_conflict` (around line 1371) — replaced by the v2 atomic test below

Then add a replacement test in `tests/test_db_upsert_vo2max_pb_v2.py`:

```python
def test_v2_upsert_atomic_under_concurrent_connections(tmp_path):
    """Two connections racing on the same (race_type, label_id) — the
    second commit must not demote a higher-vdot first commit."""
    import sqlite3
    db_path = tmp_path / "coros.db"
    db_a = Database(db_path=db_path)
    db_b = Database(db_path=db_path)

    db_a.upsert_vo2max_pb(
        race_type="5K", distance_m=5000, duration_s=1170, vdot=51.0,
        pb_date="2026-05-27", label_id="A", even_paced=True,
    )
    # Attempt to demote
    written = db_b.upsert_vo2max_pb(
        race_type="5K", distance_m=5000, duration_s=1200, vdot=49.0,
        pb_date="2026-05-27", label_id="A", even_paced=True,
    )
    assert written is False
    row = db_a._conn.execute(
        "SELECT vdot FROM vo2max_pb WHERE race_type='5K' AND label_id='A'"
    ).fetchone()
    assert row["vdot"] == pytest.approx(51.0)
```

- [ ] **Step 3: Delete dead functions in `src/stride_core/ability.py`**

Delete these:

- `RACE_TYPE_BANDS` constant (around line 245)
- `classify_race_type` function (around line 1691)
- `compute_pb_vdot_for_activity` function (around line 1707)
- `_is_well_paced_marathon` function (search for the name)

Keep `_marathon_time_to_vdot_table` — it's still used by `compute_pb_vdot_for_segment`.

- [ ] **Step 4: Run full test suite to confirm nothing else depends on the deleted code**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/ 2>&1 | tail -40
```

Expected: 0 unexpected failures. If anything imports `compute_pb_vdot_for_activity` etc., fix the import or surface as a real dependency.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/ability.py tests/test_ability.py tests/test_db_upsert_vo2max_pb_v2.py
git commit -m "refactor(ability): delete dead whole-activity PB path + obsolete tests"
```

---

## Task 14: Update `scripts/backfill_vo2max_pbs.py`

**Files:**
- Modify: `scripts/backfill_vo2max_pbs.py`

- [ ] **Step 1: Read the current script structure**

```bash
cd /home/zhaochy/running && wc -l scripts/backfill_vo2max_pbs.py && head -50 scripts/backfill_vo2max_pbs.py
```

- [ ] **Step 2: Rewrite the main loop to use segment scan**

In `scripts/backfill_vo2max_pbs.py`:

1. At the top, after imports, ensure migration is invoked once:

```python
from stride_core.db import Database
from stride_core.ability_hook import (
    _normalize_ts_units, _parse_pauses, CANONICAL_RACE_DISTANCES,
)
from stride_core.ability import compute_pb_vdot_for_segment
from stride_core.running_calibration.segments import best_distance_candidates
from stride_core.models import RUN_SPORT_IDS
```

2. Inside `main()` (or wherever the per-user processing happens), call migration first:

```python
db = Database(user=args.profile)
db._migrate_vo2max_pb_to_v2()  # idempotent
```

3. Replace the per-activity body. Locate the existing loop that calls `classify_race_type` + `compute_pb_vdot_for_activity` and replace with:

```python
for row in db._conn.execute(
    "SELECT label_id, sport_type, date, pauses FROM activities "
    "WHERE sport_type IN ({}) ORDER BY date ASC".format(
        ",".join("?" * len(RUN_SPORT_IDS))
    ),
    tuple(RUN_SPORT_IDS),
):
    label_id = row["label_id"]
    activity_date_utc = row["date"]
    pauses_raw = row["pauses"]

    ts_rows = db.fetch_timeseries(label_id)
    if not ts_rows or len(ts_rows) < 2:
        continue
    ts_norm = _normalize_ts_units(ts_rows)
    if len(ts_norm) < 2:
        continue
    t0_tick = ts_rows[0]["timestamp"]
    pauses_s = _parse_pauses(pauses_raw, t0=t0_tick)

    candidates = best_distance_candidates(
        ts_norm, pauses_s, CANONICAL_RACE_DISTANCES,
    )
    if not candidates:
        continue

    # Use Shanghai date for pb_date (label-time, not run-time)
    from stride_core.timefmt import utc_iso_to_shanghai_iso
    pb_date = utc_iso_to_shanghai_iso(activity_date_utc)[:10]

    for race_type, cand in candidates.items():
        vdot = compute_pb_vdot_for_segment(
            race_type, cand.distance_m, cand.duration_s,
        )
        if vdot is None:
            continue
        if args.dry_run:
            print(f"[DRY-RUN] {pb_date} {label_id} {race_type} "
                  f"dur={cand.duration_s:.1f}s vdot={vdot:.2f}")
            continue
        db.upsert_vo2max_pb(
            race_type=race_type,
            distance_m=cand.distance_m,
            duration_s=cand.duration_s,
            vdot=vdot,
            pb_date=pb_date,
            label_id=str(label_id),
            even_paced=True,
        )
```

- [ ] **Step 3: Verify `--help` still works**

```bash
cd /home/zhaochy/running && .venv/bin/python scripts/backfill_vo2max_pbs.py --help
```

Expected: usage banner prints, no Python errors.

- [ ] **Step 4: Dry-run on test profile**

```bash
cd /home/zhaochy/running && .venv/bin/python scripts/backfill_vo2max_pbs.py -P zhaochaoyi --dry-run 2>&1 | head -30
```

Expected: a list of `[DRY-RUN]` lines, including:
- The 2026-04-24 5K entry (vdot ~49.8)
- The 2026-05-27 entry — **the bug we set out to fix** — with `5K` race_type, duration ≈ 1170, vdot > 49.8
- Possibly other historical embedded segments

If you don't see a 5K entry for 2026-05-27, the algorithm or wiring has a bug. Stop and debug before continuing.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill_vo2max_pbs.py
git commit -m "feat(backfill): single segment-scan path + auto-migrate v1→v2"
```

---

## Task 15: Real backfill + verify race prediction lifts

**Files:**
- None (operational task)

- [ ] **Step 1: Real backfill on zhaochaoyi (no `--dry-run`)**

```bash
cd /home/zhaochy/running && .venv/bin/python scripts/backfill_vo2max_pbs.py -P zhaochaoyi 2>&1 | tail -30
```

Expected: completes without errors. Notice how many new rows the segment path added vs. the previous one-row-per-race_type table.

- [ ] **Step 2: Inspect new 5K PB**

```bash
cd /home/zhaochy/running && .venv/bin/python -c "
import sqlite3
con = sqlite3.connect('data/f10bc353-01ab-4db1-af9f-d9305ea9a532/coros.db')
con.row_factory = sqlite3.Row
# Top 5 historical 5K efforts
for r in con.execute('SELECT pb_date, duration_s, vdot, label_id FROM vo2max_pb WHERE race_type=\"5K\" ORDER BY vdot DESC LIMIT 5'):
    print(dict(r))
"
```

Expected: top row is 2026-05-27 with duration ≈ 1170s (19:30), vdot > 49.8. Second-best is 2026-04-24 with duration 1199.64.

- [ ] **Step 3: Recompute today's ability snapshot and verify race predictions**

```bash
cd /home/zhaochy/running && .venv/bin/python -c "
from stride_core.db import Database
from stride_core.ability import compute_ability_snapshot
from datetime import datetime, timezone, timedelta
today = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime('%Y-%m-%d')
db = Database(user='zhaochaoyi')
snap = compute_ability_snapshot(db, date=today)
l3 = snap.get('l3_dimensions', {}).get('vo2max', {})
print('L3 vo2max:', l3)
print('marathon est:', snap.get('marathon_estimate'))
"
```

Expected: marathon estimate updates downward (faster) compared to the pre-fix value 2:58:24.

- [ ] **Step 4: Final verification — run the full test suite**

```bash
cd /home/zhaochy/running && .venv/bin/python -m pytest tests/ 2>&1 | tail -20
```

Expected: all tests PASS, no regressions.

- [ ] **Step 5: Commit nothing for this task** (operational only). Open a PR summarizing all the changes:

```bash
cd /home/zhaochy/running && git log --oneline master..HEAD
```

Verify the commit chain reads cleanly: segments → vdot → db migration → schema → upsert → fetch_timeseries → helpers → hook wiring → L3 reader → integration test → dead-code cleanup → backfill script.

---

## Notes

- **Order matters**: schema migration (Task 5) must precede SCHEMA constant change (Task 6) so the test for `_migrate_vo2max_pb_to_v2` doesn't accidentally start from v2.
- **Behavior changes accepted by spec**: short-course marathons (< 42.195 km) no longer enroll as `full` PBs; crashed marathons over 42195 m now enroll (well-paced gate removed). Listed under "Behavior Changes from Old Path" in the design doc.
- **No backwards-compat shims**: per project CLAUDE.md, do not leave `even_paced` reads or `RACE_TYPE_BANDS` exports around for legacy callers. Delete clean.
- **Idempotency**: the migration + upsert are both idempotent so re-running backfill (or re-syncing) doesn't pollute. Verified by test.
- **Performance**: 4172 timeseries points × 4 race_types × N pause-overlap checks per double-pointer step = sub-millisecond per activity. Real-data activity count (low thousands per user) → backfill completes in seconds.
