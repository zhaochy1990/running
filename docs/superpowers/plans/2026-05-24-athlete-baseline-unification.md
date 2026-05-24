# Athlete Baseline Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `src/stride_core/running_calibration/` the single source of truth for all athlete-level baseline metrics derived from user history (max HR, RHR baseline, threshold HR, threshold speed, critical power). Delete the duplicate computations in `training_load/calibration.py`, `routes/health.py`, `coach_agent/context.py`, and wire `compute_ability_snapshot` to consume the detected `hrmax_estimate` instead of the hardcoded `185`.

**Architecture:** Path 1 — extend `running_calibration/` in place (do **not** create a parallel `athlete_baseline/` package). The package already has the right layering (pure algorithms in `core.py` / `segments.py` / `zones.py`, types in `types.py`, persistence in `sqlite_connector.py` behind a `Protocol` in `repository.py`). The work is: (a) fill the missing fields (`rhr_baseline` is declared but always written as `None`; `critical_power_w` doesn't exist yet), (b) implement the orphaned `fetch_latest()` Protocol method, (c) replace inline duplicates with reader calls, (d) wire `compute_ability_snapshot` to the reader. Onboarding's P25/30d seed-value computation is preserved as a documented semantic exception.

**Tech Stack:** Python 3.12, SQLite (per-user `data/{user_id}/coros.db`), pytest, `dataclasses`, `stride_core.timefmt` (Shanghai-local helpers).

**Out of scope:**
- `ability.py:2081` 28-day median RHR for L2 freshness — different semantic from trained baseline; document but do not unify.
- VO2max / Daniels VDOT / Riegel — these are derived ability metrics, not baselines.
- Renaming the package from `running_calibration` to `athlete_baseline` — defer to a follow-up plan once dust settles.

---

## File Structure

**Files modified (8):**
- `src/stride_core/running_calibration/types.py` — add `critical_power_w` field + `RunningHealthRow` dataclass
- `src/stride_core/running_calibration/core.py` — add `estimate_rhr_baseline()` + `estimate_critical_power()` + extend `estimate_running_calibration()` signature with `health_rows`
- `src/stride_core/running_calibration/sqlite_connector.py` — schema column `critical_power_w`, `_ensure_columns` migration, INSERT/UPDATE SQL, `fetch_recent_health_rows()` helper, `fetch_latest()` implementation
- `src/stride_core/running_calibration/repository.py` — orchestrator fetches health rows and passes them through
- `src/stride_core/training_load/calibration.py` — delete `_estimate_hrmax`, `_estimate_critical_power`, inline P10 RHR; delegate all three to `running_snapshot`
- `src/stride_core/ability.py` — `compute_ability_snapshot` resolves `hr_max` from baseline reader when not provided; default kwarg → `None`
- `src/stride_server/routes/health.py` — replace inline P10 RHR with reader call
- `src/coach_agent/context.py` — replace `_rhr_baseline` helper with reader call

**Test files created (4):**
- `tests/stride_core/running_calibration/test_rhr.py`
- `tests/stride_core/running_calibration/test_critical_power.py`
- `tests/stride_core/running_calibration/test_fetch_latest.py`
- `tests/test_no_baseline_duplicates.py` — CI guard against future duplication

**Test files extended (4):**
- `tests/stride_core/running_calibration/test_core.py` — RHR + CP integration in `estimate_running_calibration`
- `tests/stride_core/running_calibration/test_repository.py` — health-row orchestration
- `tests/stride_core/running_calibration/test_sqlite_connector.py` — `critical_power_w` schema migration
- `tests/stride_core/training_load/test_calibration.py` — confirm delegation (hrmax/cp/rhr come from running_snapshot)
- `tests/test_ability.py` — `compute_ability_snapshot` uses baseline-derived hr_max

---

# Phase 1 — Extend running_calibration with RHR + critical_power

Each task in Phase 1 leaves the codebase in a working state: existing duplicates remain functional until Phase 2 deletes them.

## Task 1: Add `estimate_rhr_baseline()` pure function

**Files:**
- Modify: `src/stride_core/running_calibration/types.py`
- Modify: `src/stride_core/running_calibration/core.py`
- Create: `tests/stride_core/running_calibration/test_rhr.py`

- [ ] **Step 1: Write the failing test**

Create `tests/stride_core/running_calibration/test_rhr.py`:

```python
from __future__ import annotations

from datetime import date

import pytest

from stride_core.running_calibration.core import estimate_rhr_baseline
from stride_core.running_calibration.types import RunningHealthRow


def _rows(values: list[tuple[str, float | None]]) -> tuple[RunningHealthRow, ...]:
    return tuple(
        RunningHealthRow(date=date.fromisoformat(d), rhr=v) for d, v in values
    )


def test_returns_none_when_too_few_samples():
    rows = _rows([(f"2026-05-{i:02d}", 50.0) for i in range(1, 14)])  # 13 samples
    assert estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 20)) is None


def test_returns_p10_index_round():
    # Canonical p10 definition: round((N-1)*0.10) index of sorted asc.
    # N=20 → idx=round(1.9)=2 → 3rd smallest. Values 41..60 → idx 2 = 43.0
    rows = _rows([(f"2026-05-{i:02d}", float(40 + i)) for i in range(1, 21)])
    result = estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 25))
    assert result == 43.0


def test_excludes_rows_outside_90d_window():
    rows = _rows([
        ("2025-12-01", 30.0),  # outside window
        *((f"2026-05-{i:02d}", 50.0) for i in range(1, 21)),
    ])
    result = estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 25))
    assert result == 50.0  # outlier excluded


def test_ignores_none_and_nonpositive_rhr():
    rows = _rows([
        *((f"2026-05-{i:02d}", float(40 + i)) for i in range(1, 21)),
        ("2026-05-22", None),
        ("2026-05-23", 0.0),
        ("2026-05-24", -5.0),
    ])
    result = estimate_rhr_baseline(rows, as_of_date=date(2026, 5, 25))
    assert result == 43.0  # same as canonical case
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_rhr.py -v`
Expected: FAIL with `ImportError: cannot import name 'estimate_rhr_baseline'` and `'RunningHealthRow'`.

- [ ] **Step 3: Add `RunningHealthRow` to types**

In `src/stride_core/running_calibration/types.py`, after the `RunningSample` dataclass (around line 28), add:

```python
@dataclass(frozen=True)
class RunningHealthRow:
    """Per-day resting-HR row sourced from `daily_health`.

    Defined here (not in `training_load.types`) to keep
    `running_calibration` free of cross-package dependencies — it is the
    canonical baseline module.
    """
    date: date
    rhr: float | None = None
```

Then add `"RunningHealthRow"` to the alphabetical position in the type re-exports at the bottom of `src/stride_core/running_calibration/__init__.py`:

```python
from .types import (
    RUNNING_CALIBRATION_MODEL_VERSION,
    CalibrationConfidence,
    CalibrationEvidence,
    HrMaxProfile,
    HeartRateZone,
    PaceZone,
    RunningActivity,
    RunningCalibrationRunSummary,
    RunningCalibrationSnapshot,
    RunningHealthRow,
    RunningLap,
    RunningSample,
    RunningZoneSet,
)
```

And add `"RunningHealthRow"` to the `__all__` list, alphabetically.

- [ ] **Step 4: Implement `estimate_rhr_baseline`**

In `src/stride_core/running_calibration/core.py`, add after `_raw_observed_max_hr` (around line 200):

```python
def estimate_rhr_baseline(
    health_rows: Sequence["RunningHealthRow"],
    *,
    as_of_date: date,
    lookback_days: int = 90,
    min_samples: int = 14,
) -> float | None:
    """P10 of recent valid daily-RHR samples.

    Returns None when fewer than `min_samples` valid rows fall inside the
    window. Mirrors the algorithm previously inlined in
    `training_load.calibration.estimate_calibration`,
    `routes/health.py::get_health`, and `coach_agent/context.py::_rhr_baseline`
    — those three sites now read this single implementation.
    """
    window_start = as_of_date - timedelta(days=lookback_days)
    values = sorted(
        float(row.rhr)
        for row in health_rows
        if row.rhr is not None
        and float(row.rhr) > 0
        and window_start <= row.date <= as_of_date
    )
    if len(values) < min_samples:
        return None
    idx = max(0, min(len(values) - 1, round((len(values) - 1) * 0.10)))
    return values[idx]
```

Update the imports at the top of `core.py` to include `RunningHealthRow`:

```python
from .types import (
    CalibrationConfidence,
    CalibrationEvidence,
    HrMaxProfile,
    RunningActivity,
    RunningCalibrationSnapshot,
    RunningHealthRow,
)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/stride_core/running_calibration/test_rhr.py -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/stride_core/running_calibration/types.py \
        src/stride_core/running_calibration/core.py \
        src/stride_core/running_calibration/__init__.py \
        tests/stride_core/running_calibration/test_rhr.py
git commit -m "feat(running_calibration): add estimate_rhr_baseline (P10/90d) as single source"
```

---

## Task 2: Add `estimate_critical_power()` pure function

**Files:**
- Modify: `src/stride_core/running_calibration/core.py`
- Create: `tests/stride_core/running_calibration/test_critical_power.py`

- [ ] **Step 1: Write the failing test**

Create `tests/stride_core/running_calibration/test_critical_power.py`:

```python
from __future__ import annotations

from datetime import date

from stride_core.running_calibration.core import estimate_critical_power
from stride_core.running_calibration.types import RunningActivity, RunningSample


def _activity(
    label_id: str,
    activity_date: date,
    sport: str = "run_outdoor",
    avg_power_w: float | None = None,
    sample_powers: tuple[float | None, ...] = (),
) -> RunningActivity:
    return RunningActivity(
        label_id=label_id,
        activity_date=activity_date,
        sport=sport,
        avg_power_w=avg_power_w,
        samples=tuple(
            RunningSample(elapsed_s=float(i * 10), power_w=p)
            for i, p in enumerate(sample_powers)
        ),
    )


def test_returns_none_when_no_power_data():
    history = (_activity("a", date(2026, 5, 1)),)
    assert estimate_critical_power(history, as_of_date=date(2026, 5, 20)) == (None, 0)


def test_median_of_avg_and_sample_power():
    history = (
        _activity("a", date(2026, 5, 1), avg_power_w=240.0, sample_powers=(230.0, 250.0)),
        _activity("b", date(2026, 5, 10), avg_power_w=260.0, sample_powers=(255.0, 270.0)),
    )
    result, count = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    # values: [240, 230, 250, 260, 255, 270] sorted → median = (250+255)/2 = 252.5
    assert result == 252.5
    assert count == 6


def test_excludes_non_running_sports():
    history = (
        _activity("a", date(2026, 5, 1), sport="cycle", avg_power_w=200.0),
        _activity("b", date(2026, 5, 2), sport="run_outdoor", avg_power_w=300.0),
    )
    result, _ = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    assert result == 300.0


def test_excludes_outside_180d_window():
    history = (
        _activity("old", date(2025, 1, 1), avg_power_w=100.0),
        _activity("recent", date(2026, 5, 1), avg_power_w=250.0),
    )
    result, _ = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    assert result == 250.0


def test_clamps_out_of_range_power():
    history = (
        _activity("a", date(2026, 5, 1), avg_power_w=30.0),  # below MIN_RUNNING_POWER_W
        _activity("b", date(2026, 5, 2), avg_power_w=1500.0),  # above MAX
        _activity("c", date(2026, 5, 3), avg_power_w=250.0),
    )
    result, count = estimate_critical_power(history, as_of_date=date(2026, 5, 20))
    assert result == 250.0
    assert count == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_critical_power.py -v`
Expected: FAIL with `ImportError: cannot import name 'estimate_critical_power'`.

- [ ] **Step 3: Implement `estimate_critical_power`**

In `src/stride_core/running_calibration/core.py`, after `estimate_rhr_baseline` (the function added in Task 1), add:

```python
MIN_RUNNING_POWER_W = 50.0
MAX_RUNNING_POWER_W = 1000.0


def _is_running_sport(sport: str | None) -> bool:
    s = (sport or "").strip().lower()
    return s == "run" or s.startswith("run_") or s.startswith("running")


def _valid_running_power(value: float | None) -> bool:
    if value is None:
        return False
    p = float(value)
    return MIN_RUNNING_POWER_W <= p <= MAX_RUNNING_POWER_W


def estimate_critical_power(
    history: Sequence[RunningActivity],
    *,
    as_of_date: date,
    lookback_days: int = 180,
) -> tuple[float | None, int]:
    """Median running-power proxy over the lookback window.

    Replaces `training_load.calibration._estimate_critical_power` (which is
    deleted in Phase 2). Filters to running sports only. Returns
    `(median_power_w, sample_count)`.
    """
    window_start = as_of_date - timedelta(days=lookback_days)
    values: list[float] = []
    for activity in history:
        if not (window_start <= activity.activity_date <= as_of_date):
            continue
        if not _is_running_sport(activity.sport):
            continue
        if _valid_running_power(activity.avg_power_w):
            values.append(float(activity.avg_power_w))
        values.extend(
            float(sample.power_w)
            for sample in activity.samples
            if _valid_running_power(sample.power_w)
        )
    return (median(values) if values else None, len(values))
```

Add `from statistics import median` to the imports at the top of `core.py` (it's currently only importing what's needed for existing code — confirm with grep).

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/stride_core/running_calibration/test_critical_power.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/running_calibration/core.py \
        tests/stride_core/running_calibration/test_critical_power.py
git commit -m "feat(running_calibration): add estimate_critical_power (running-only median/180d)"
```

---

## Task 3: Add `critical_power_w` field to `RunningCalibrationSnapshot`

**Files:**
- Modify: `src/stride_core/running_calibration/types.py`

- [ ] **Step 1: Write the failing test**

In `tests/stride_core/running_calibration/test_core.py`, find the existing `RunningCalibrationSnapshot` construction tests (search for `RunningCalibrationSnapshot(`) and add a new test at the bottom of the file:

```python
def test_snapshot_has_critical_power_field():
    from datetime import date as _d
    snap = RunningCalibrationSnapshot(as_of_date=_d(2026, 5, 1), critical_power_w=265.0)
    assert snap.critical_power_w == 265.0


def test_snapshot_critical_power_defaults_to_none():
    from datetime import date as _d
    snap = RunningCalibrationSnapshot(as_of_date=_d(2026, 5, 1))
    assert snap.critical_power_w is None
```

If `RunningCalibrationSnapshot` is not yet imported in `test_core.py`, add the import.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_core.py::test_snapshot_has_critical_power_field -v`
Expected: FAIL with `TypeError: ... got an unexpected keyword argument 'critical_power_w'`.

- [ ] **Step 3: Add the field**

In `src/stride_core/running_calibration/types.py`, modify the `RunningCalibrationSnapshot` dataclass — add `critical_power_w` between `high_hr_reference` and `source`:

```python
@dataclass(frozen=True)
class RunningCalibrationSnapshot:
    as_of_date: date
    threshold_hr: float | None = None
    threshold_speed_mps: float | None = None
    threshold_hr_confidence: CalibrationConfidence = CalibrationConfidence.NONE
    threshold_speed_confidence: CalibrationConfidence = CalibrationConfidence.NONE
    rhr_baseline: float | None = None
    observed_max_hr: float | None = None
    hrmax_estimate: float | None = None
    hrmax_confidence: CalibrationConfidence = CalibrationConfidence.NONE
    high_hr_reference: float | None = None
    critical_power_w: float | None = None
    source: dict[str, Any] = field(default_factory=dict)
    evidence: tuple[CalibrationEvidence, ...] = ()
    id: int | str | None = None
    algorithm_version: int = RUNNING_CALIBRATION_MODEL_VERSION
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/stride_core/running_calibration/test_core.py::test_snapshot_has_critical_power_field tests/stride_core/running_calibration/test_core.py::test_snapshot_critical_power_defaults_to_none -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/running_calibration/types.py \
        tests/stride_core/running_calibration/test_core.py
git commit -m "feat(running_calibration): add critical_power_w to RunningCalibrationSnapshot"
```

---

## Task 4: Wire RHR + CP into `estimate_running_calibration` orchestrator

**Files:**
- Modify: `src/stride_core/running_calibration/core.py`
- Modify: `tests/stride_core/running_calibration/test_core.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/stride_core/running_calibration/test_core.py`:

```python
def test_estimate_running_calibration_includes_rhr_and_cp():
    from datetime import date as _d
    from stride_core.running_calibration.core import estimate_running_calibration
    from stride_core.running_calibration.types import (
        RunningActivity, RunningSample, RunningHealthRow,
    )

    # 20 days of valid RHR 41..60 → P10 (idx 2) = 43.0
    health = tuple(
        RunningHealthRow(date=_d(2026, 5, i), rhr=float(40 + i))
        for i in range(1, 21)
    )
    history = (
        RunningActivity(
            label_id="run-1",
            activity_date=_d(2026, 5, 5),
            sport="run_outdoor",
            avg_power_w=250.0,
            samples=(RunningSample(elapsed_s=10.0, power_w=260.0),),
        ),
    )
    snap = estimate_running_calibration(
        history, as_of_date=_d(2026, 5, 25), health_rows=health,
    )
    assert snap.rhr_baseline == 43.0
    assert snap.critical_power_w == 255.0  # median of [250, 260]


def test_estimate_running_calibration_health_rows_optional():
    from datetime import date as _d
    from stride_core.running_calibration.core import estimate_running_calibration
    snap = estimate_running_calibration((), as_of_date=_d(2026, 5, 25))
    assert snap.rhr_baseline is None
    assert snap.critical_power_w is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_core.py::test_estimate_running_calibration_includes_rhr_and_cp -v`
Expected: FAIL — either `TypeError: estimate_running_calibration() got unexpected keyword argument 'health_rows'` OR `assert None == 43.0`.

- [ ] **Step 3: Update signature and wiring**

In `src/stride_core/running_calibration/core.py`, modify `estimate_running_calibration` (currently at line 36):

```python
def estimate_running_calibration(
    history: Sequence[RunningActivity],
    as_of_date: date,
    *,
    health_rows: Sequence[RunningHealthRow] = (),
) -> RunningCalibrationSnapshot:
    """Estimate running threshold speed, threshold HR, and supporting evidence.

    The function accepts only in-memory domain objects. Database fields,
    provider-specific units, and persistence are connector responsibilities.
    """
    recent = [a for a in history if as_of_date - timedelta(days=180) <= a.activity_date <= as_of_date]
    source: dict[str, object] = {"algorithm": "running_calibration_v3", "lookback_days": 180}
    evidence: list[CalibrationEvidence] = []
    hrmax_profile = estimate_hrmax_profile(recent)
    if hrmax_profile.source:
        source["hrmax_profile"] = hrmax_profile.source

    speed_candidates = best_speed_candidates(recent, BEST_EFFORT_DURATIONS_S)
    threshold_speed, speed_confidence, speed_evidence = _estimate_threshold_speed(speed_candidates)
    if threshold_speed is not None:
        source["threshold_speed"] = {
            "method": "best_efforts_upper_envelope_model",
            "candidate_count": len(speed_candidates),
        }
        evidence.extend(speed_evidence)

    threshold_hr = None
    hr_confidence = CalibrationConfidence.NONE
    if threshold_speed is not None:
        hr_candidates = stable_threshold_hr_candidates(recent, threshold_speed)
        threshold_hr, hr_confidence, hr_evidence = _estimate_threshold_hr(
            hr_candidates,
            hrmax_estimate=hrmax_profile.estimated_hrmax,
            hrmax_confidence=hrmax_profile.confidence,
        )
        if threshold_hr is not None:
            source["threshold_hr"] = {
                "method": "weighted_median_stable_threshold_segments",
                "candidate_count": len(hr_candidates),
            }
            evidence.extend(hr_evidence)

    rhr_baseline = estimate_rhr_baseline(health_rows, as_of_date=as_of_date)
    if rhr_baseline is not None:
        source["rhr_baseline"] = {"method": "p10_90d", "sample_count": len(tuple(health_rows))}

    critical_power, cp_count = estimate_critical_power(history, as_of_date=as_of_date)
    if critical_power is not None:
        source["critical_power_w"] = {"method": "median_180d", "sample_count": cp_count}

    return RunningCalibrationSnapshot(
        as_of_date=as_of_date,
        threshold_hr=_round(threshold_hr),
        threshold_speed_mps=_round(threshold_speed),
        threshold_hr_confidence=hr_confidence,
        threshold_speed_confidence=speed_confidence,
        rhr_baseline=_round(rhr_baseline),
        observed_max_hr=_round(hrmax_profile.observed_max_hr),
        hrmax_estimate=_round(hrmax_profile.estimated_hrmax),
        hrmax_confidence=hrmax_profile.confidence,
        high_hr_reference=_round(hrmax_profile.high_hr_reference),
        critical_power_w=_round(critical_power),
        source=source,
        evidence=tuple(evidence + list(hrmax_profile.evidence)),
    )
```

- [ ] **Step 4: Run new + existing core tests**

Run: `pytest tests/stride_core/running_calibration/test_core.py -v`
Expected: all pass (new tests + existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/running_calibration/core.py \
        tests/stride_core/running_calibration/test_core.py
git commit -m "feat(running_calibration): plumb RHR + critical_power into snapshot orchestrator"
```

---

## Task 5: SQLite schema — add `critical_power_w` column + persist field

**Files:**
- Modify: `src/stride_core/running_calibration/sqlite_connector.py`
- Modify: `tests/stride_core/running_calibration/test_sqlite_connector.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/stride_core/running_calibration/test_sqlite_connector.py`:

```python
def test_persists_critical_power_w(tmp_path):
    from datetime import date as _d
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    # Bare-minimum schema to satisfy the connector; reuse existing fixture helper
    # if test_sqlite_connector.py already has a _setup_activities_table fixture.
    conn.executescript("""
        CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT, sport_name TEXT);
    """)
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    repo = SQLiteRunningCalibrationRepository(db)
    snap = RunningCalibrationSnapshot(
        as_of_date=_d(2026, 5, 20),
        critical_power_w=265.0,
        hrmax_estimate=185.0,
        threshold_hr=165.0,
        threshold_hr_confidence=CalibrationConfidence.MEDIUM,
        threshold_speed_confidence=CalibrationConfidence.MEDIUM,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
    )
    snap_id = repo.save_snapshot(snap)
    row = conn.execute(
        "SELECT critical_power_w FROM running_calibration_snapshot WHERE id = ?",
        (snap_id,),
    ).fetchone()
    assert row["critical_power_w"] == 265.0


def test_schema_migration_adds_critical_power_w_column(tmp_path):
    """Simulate a legacy DB created before the migration."""
    db_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT);
        CREATE TABLE running_calibration_snapshot (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            as_of_date TEXT NOT NULL,
            algorithm_version INTEGER NOT NULL,
            threshold_hr_confidence TEXT NOT NULL,
            threshold_speed_confidence TEXT NOT NULL,
            hrmax_confidence TEXT NOT NULL DEFAULT 'none',
            UNIQUE(as_of_date, algorithm_version)
        );
    """)
    conn.commit()
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    SQLiteRunningCalibrationRepository(db)  # ensure_schema runs in __init__
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(running_calibration_snapshot)").fetchall()}
    assert "critical_power_w" in cols
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_sqlite_connector.py::test_persists_critical_power_w -v`
Expected: FAIL — either `no such column: critical_power_w` or KeyError.

- [ ] **Step 3: Update schema and SQL**

In `src/stride_core/running_calibration/sqlite_connector.py`:

(a) In `RUNNING_CALIBRATION_SCHEMA` (around line 25), add `critical_power_w REAL,` to the `running_calibration_snapshot` `CREATE TABLE` between `high_hr_reference REAL,` and `source_json TEXT,`.

(b) In `ensure_schema()` (around line 95), add `"critical_power_w": "REAL"` to the `_ensure_columns` dict.

(c) In `save_snapshot()` (around line 125), update the INSERT and ON CONFLICT clauses to include `critical_power_w`:

```python
self._conn.execute(
    """INSERT INTO running_calibration_snapshot
       (as_of_date, algorithm_version, threshold_hr, threshold_speed_mps,
        threshold_hr_confidence, threshold_speed_confidence,
        rhr_baseline, observed_max_hr, hrmax_estimate, hrmax_confidence,
        high_hr_reference, critical_power_w, source_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(as_of_date, algorithm_version) DO UPDATE SET
           threshold_hr = excluded.threshold_hr,
           threshold_speed_mps = excluded.threshold_speed_mps,
           threshold_hr_confidence = excluded.threshold_hr_confidence,
           threshold_speed_confidence = excluded.threshold_speed_confidence,
           rhr_baseline = excluded.rhr_baseline,
           observed_max_hr = excluded.observed_max_hr,
           hrmax_estimate = excluded.hrmax_estimate,
           hrmax_confidence = excluded.hrmax_confidence,
           high_hr_reference = excluded.high_hr_reference,
           critical_power_w = excluded.critical_power_w,
           source_json = excluded.source_json,
           computed_at = excluded.computed_at""",
    (
        snapshot.as_of_date.isoformat(),
        snapshot.algorithm_version,
        snapshot.threshold_hr,
        snapshot.threshold_speed_mps,
        snapshot.threshold_hr_confidence.value,
        snapshot.threshold_speed_confidence.value,
        snapshot.rhr_baseline,
        snapshot.observed_max_hr,
        snapshot.hrmax_estimate,
        snapshot.hrmax_confidence.value,
        snapshot.high_hr_reference,
        snapshot.critical_power_w,
        source_json,
    ),
)
```

(d) Also update the row-hydration helper (search for `observed_max_hr=_float_or_none` around line 190 to find the function that reads `running_calibration_snapshot` rows back into a `RunningCalibrationSnapshot`). Add `critical_power_w=_float_or_none(_row_value(row, "critical_power_w"))` to the constructor call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/stride_core/running_calibration/test_sqlite_connector.py -v`
Expected: all existing tests + 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/running_calibration/sqlite_connector.py \
        tests/stride_core/running_calibration/test_sqlite_connector.py
git commit -m "feat(running_calibration): persist critical_power_w (schema migration + upsert)"
```

---

## Task 6: SQLite connector — fetch `daily_health` rows

**Files:**
- Modify: `src/stride_core/running_calibration/sqlite_connector.py`
- Modify: `tests/stride_core/running_calibration/test_sqlite_connector.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/stride_core/running_calibration/test_sqlite_connector.py`:

```python
def test_fetch_health_rows_reads_daily_health(tmp_path):
    from datetime import date as _d
    from stride_core.running_calibration.types import RunningHealthRow
    db_path = tmp_path / "h.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT);
        CREATE TABLE daily_health (date TEXT PRIMARY KEY, rhr INTEGER);
        INSERT INTO daily_health (date, rhr) VALUES
            ('20260501', 50),
            ('20260510', 48),
            ('20260520', 47),
            ('20260101', 60),  -- outside 90d window
            ('20260515', NULL); -- null RHR
    """)
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    repo = SQLiteRunningCalibrationRepository(db)
    rows = repo.fetch_health_rows(start=_d(2026, 2, 25), end=_d(2026, 5, 25))
    # Should include the 3 valid in-window rows; exclude 20260101 (outside)
    # and 20260515 (null rhr).
    assert {r.date for r in rows} == {_d(2026, 5, 1), _d(2026, 5, 10), _d(2026, 5, 20)}
    assert all(isinstance(r, RunningHealthRow) for r in rows)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_sqlite_connector.py::test_fetch_health_rows_reads_daily_health -v`
Expected: FAIL with `AttributeError: ... has no attribute 'fetch_health_rows'`.

- [ ] **Step 3: Implement `fetch_health_rows`**

In `src/stride_core/running_calibration/sqlite_connector.py`, add a method to `SQLiteRunningCalibrationRepository` (after `fetch_history`):

```python
def fetch_health_rows(self, start: date, end: date) -> list[RunningHealthRow]:
    """Read `daily_health.rhr` between [start, end] inclusive.

    `daily_health.date` is stored in YYYYMMDD (Shanghai-local) — see
    `CLAUDE.md` Timezone discipline whitelist. We convert each row's date
    to a Python `date` before returning. Rows with NULL `rhr` are skipped.
    """
    start_compact = start.strftime("%Y%m%d")
    end_compact = end.strftime("%Y%m%d")
    rows = self._conn.execute(
        "SELECT date, rhr FROM daily_health "
        "WHERE rhr IS NOT NULL AND date >= ? AND date <= ?",
        (start_compact, end_compact),
    ).fetchall()
    out: list[RunningHealthRow] = []
    for row in rows or []:
        date_str = str(row["date"] if _has_key(row, "date") else row[0])
        rhr_val = row["rhr"] if _has_key(row, "rhr") else row[1]
        try:
            d = date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))
        except (ValueError, IndexError):
            continue
        out.append(RunningHealthRow(date=d, rhr=float(rhr_val) if rhr_val is not None else None))
    return out
```

Update the import block at the top of `sqlite_connector.py` to include `RunningHealthRow`:

```python
from .types import (
    CalibrationConfidence,
    CalibrationEvidence,
    HeartRateZone,
    PaceZone,
    RunningActivity,
    RunningCalibrationSnapshot,
    RunningHealthRow,
    RunningLap,
    RunningSample,
)
```

Also extend the `RunningCalibrationRepository` Protocol in `repository.py` to declare the new method:

```python
class RunningCalibrationRepository(Protocol):
    def fetch_history(self, start: date, end: date) -> list[RunningActivity]: ...
    def fetch_health_rows(self, start: date, end: date) -> list[RunningHealthRow]: ...
    def save_snapshot(self, snapshot: RunningCalibrationSnapshot) -> str | int: ...
    def fetch_latest(self, as_of_date: date | None = None) -> RunningCalibrationSnapshot | None: ...
```

Add the necessary `RunningHealthRow` import to `repository.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/stride_core/running_calibration/test_sqlite_connector.py::test_fetch_health_rows_reads_daily_health -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/running_calibration/sqlite_connector.py \
        src/stride_core/running_calibration/repository.py \
        tests/stride_core/running_calibration/test_sqlite_connector.py
git commit -m "feat(running_calibration): connector fetches daily_health rows"
```

---

## Task 7: Repository orchestrator passes health_rows through

**Files:**
- Modify: `src/stride_core/running_calibration/repository.py`
- Modify: `tests/stride_core/running_calibration/test_repository.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/stride_core/running_calibration/test_repository.py`:

```python
def test_recompute_passes_health_rows_to_estimator(monkeypatch):
    from datetime import date as _d
    from stride_core.running_calibration import recompute_running_calibration
    from stride_core.running_calibration.types import (
        RunningCalibrationSnapshot, RunningHealthRow, CalibrationConfidence,
    )

    captured: dict = {}

    def fake_estimate(history, as_of_date, *, health_rows=()):
        captured["health_rows"] = tuple(health_rows)
        captured["as_of_date"] = as_of_date
        return RunningCalibrationSnapshot(
            as_of_date=as_of_date,
            threshold_hr_confidence=CalibrationConfidence.NONE,
            threshold_speed_confidence=CalibrationConfidence.NONE,
            hrmax_confidence=CalibrationConfidence.NONE,
        )

    monkeypatch.setattr(
        "stride_core.running_calibration.repository.estimate_running_calibration",
        fake_estimate,
    )

    class FakeRepo:
        def fetch_history(self, start, end): return []
        def fetch_health_rows(self, start, end):
            return [RunningHealthRow(date=_d(2026, 5, 10), rhr=48.0)]
        def save_snapshot(self, snap): return 1
        def fetch_latest(self, as_of_date=None): return None

    repo = FakeRepo()
    summary = recompute_running_calibration(repo, as_of_date=_d(2026, 5, 20), persist=False)
    assert len(captured["health_rows"]) == 1
    assert captured["health_rows"][0].rhr == 48.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_repository.py::test_recompute_passes_health_rows_to_estimator -v`
Expected: FAIL with `assert 0 == 1` (health_rows is empty because orchestrator doesn't pass them yet).

- [ ] **Step 3: Update orchestrator**

In `src/stride_core/running_calibration/repository.py`, modify `recompute_running_calibration`:

```python
def recompute_running_calibration(
    repo: RunningCalibrationRepository,
    *,
    as_of_date: date | None = None,
    lookback_days: int = 180,
    health_lookback_days: int = 90,
    persist: bool = True,
) -> RunningCalibrationRunSummary:
    end = as_of_date or today_shanghai()
    start = end - timedelta(days=lookback_days)
    history = repo.fetch_history(start, end)
    health_start = end - timedelta(days=health_lookback_days)
    health_rows = repo.fetch_health_rows(health_start, end)
    snapshot = estimate_running_calibration(history, end, health_rows=health_rows)
    snapshot_id: str | int | None = None
    if persist:
        snapshot_id = repo.save_snapshot(snapshot)
        snapshot = replace(snapshot, id=snapshot_id)
    zones = compute_training_zones(snapshot)
    return RunningCalibrationRunSummary(
        snapshot=snapshot,
        zones=zones,
        activities_considered=len(history),
        snapshot_id=snapshot_id,
        start=start,
        end=end,
        persist=persist,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/stride_core/running_calibration/test_repository.py -v`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stride_core/running_calibration/repository.py \
        tests/stride_core/running_calibration/test_repository.py
git commit -m "feat(running_calibration): orchestrator fetches and threads daily_health rows"
```

---

## Task 8: Implement `fetch_latest()` reader

**Files:**
- Modify: `src/stride_core/running_calibration/sqlite_connector.py`
- Create: `tests/stride_core/running_calibration/test_fetch_latest.py`

- [ ] **Step 1: Write the failing test**

Create `tests/stride_core/running_calibration/test_fetch_latest.py`:

```python
from __future__ import annotations

import sqlite3
from datetime import date

import pytest

from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)


def _make_db(tmp_path):
    db_path = tmp_path / "lat.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT)")
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    return SQLiteRunningCalibrationRepository(db), conn


def _snap(as_of: str, hrmax: float = 185.0, algorithm_version: int = 3) -> RunningCalibrationSnapshot:
    return RunningCalibrationSnapshot(
        as_of_date=date.fromisoformat(as_of),
        hrmax_estimate=hrmax,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
        algorithm_version=algorithm_version,
    )


def test_fetch_latest_returns_none_when_empty(tmp_path):
    repo, _ = _make_db(tmp_path)
    assert repo.fetch_latest() is None
    assert repo.fetch_latest(as_of_date=date(2026, 5, 1)) is None


def test_fetch_latest_returns_most_recent(tmp_path):
    repo, _ = _make_db(tmp_path)
    repo.save_snapshot(_snap("2026-05-01", hrmax=180.0))
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0))
    result = repo.fetch_latest()
    assert result is not None
    assert result.hrmax_estimate == 190.0


def test_fetch_latest_respects_as_of_date(tmp_path):
    repo, _ = _make_db(tmp_path)
    repo.save_snapshot(_snap("2026-05-01", hrmax=180.0))
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0))
    result = repo.fetch_latest(as_of_date=date(2026, 5, 15))
    assert result is not None
    assert result.hrmax_estimate == 185.0


def test_fetch_latest_prefers_higher_algorithm_version(tmp_path):
    repo, _ = _make_db(tmp_path)
    # Same as_of_date, two algorithm versions
    repo.save_snapshot(_snap("2026-05-20", hrmax=180.0, algorithm_version=2))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0, algorithm_version=3))
    result = repo.fetch_latest()
    assert result is not None
    assert result.hrmax_estimate == 190.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/stride_core/running_calibration/test_fetch_latest.py -v`
Expected: FAIL — `fetch_latest` not implemented (likely `NotImplementedError` or `AttributeError` depending on current Protocol stub).

- [ ] **Step 3: Implement `fetch_latest`**

In `src/stride_core/running_calibration/sqlite_connector.py`, add this method to `SQLiteRunningCalibrationRepository` (after `save_snapshot`):

```python
def fetch_latest(
    self, as_of_date: date | None = None,
) -> RunningCalibrationSnapshot | None:
    """Return the most recent snapshot at or before ``as_of_date``.

    Ordering: ``as_of_date`` DESC, then ``algorithm_version`` DESC so newer
    algorithm versions on the same day win. Returns None when no snapshot
    exists. This is the canonical reader used by all consumers
    (compute_ability_snapshot, routes/health.py, coach_agent/context.py,
    training_load adapter).
    """
    if as_of_date is None:
        row = self._conn.execute(
            "SELECT * FROM running_calibration_snapshot "
            "ORDER BY as_of_date DESC, algorithm_version DESC LIMIT 1"
        ).fetchone()
    else:
        row = self._conn.execute(
            "SELECT * FROM running_calibration_snapshot "
            "WHERE as_of_date <= ? "
            "ORDER BY as_of_date DESC, algorithm_version DESC LIMIT 1",
            (as_of_date.isoformat(),),
        ).fetchone()
    if row is None:
        return None
    return self._hydrate_snapshot(row)
```

If there is no existing `_hydrate_snapshot` helper, extract one from the existing row-reading code (search the file for `RunningCalibrationSnapshot(` constructions after `_float_or_none(_row_value(row, "observed_max_hr"))` — there should already be one used by other methods; if not, factor it out). The helper should return a `RunningCalibrationSnapshot` with all fields including `critical_power_w` populated from the row.

If no existing helper, add this method to the class:

```python
def _hydrate_snapshot(self, row: Any) -> RunningCalibrationSnapshot:
    source = _parse_json(_row_value(row, "source_json"))
    return RunningCalibrationSnapshot(
        id=int(row["id"] if _has_key(row, "id") else row[0]),
        as_of_date=date.fromisoformat(str(_row_value(row, "as_of_date"))),
        algorithm_version=int(_row_value(row, "algorithm_version") or RUNNING_CALIBRATION_MODEL_VERSION),
        threshold_hr=_float_or_none(_row_value(row, "threshold_hr")),
        threshold_speed_mps=_float_or_none(_row_value(row, "threshold_speed_mps")),
        threshold_hr_confidence=CalibrationConfidence(_row_value(row, "threshold_hr_confidence") or "none"),
        threshold_speed_confidence=CalibrationConfidence(_row_value(row, "threshold_speed_confidence") or "none"),
        rhr_baseline=_float_or_none(_row_value(row, "rhr_baseline")),
        observed_max_hr=_float_or_none(_row_value(row, "observed_max_hr")),
        hrmax_estimate=_float_or_none(_row_value(row, "hrmax_estimate")),
        hrmax_confidence=CalibrationConfidence(_row_value(row, "hrmax_confidence") or "none"),
        high_hr_reference=_float_or_none(_row_value(row, "high_hr_reference")),
        critical_power_w=_float_or_none(_row_value(row, "critical_power_w")),
        source=source or {},
        evidence=(),  # evidence belongs in separate table; reader skips it for the fetch_latest path
    )


def _parse_json(value: Any) -> dict | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    try:
        import json as _json
        return _json.loads(str(value))
    except (ValueError, TypeError):
        return None
```

Add `RUNNING_CALIBRATION_MODEL_VERSION` to the type imports at the top of `sqlite_connector.py`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/stride_core/running_calibration/test_fetch_latest.py -v`
Expected: 4 passed.

- [ ] **Step 5: Run the full running_calibration test suite as sanity check**

Run: `pytest tests/stride_core/running_calibration/ -v`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/stride_core/running_calibration/sqlite_connector.py \
        tests/stride_core/running_calibration/test_fetch_latest.py
git commit -m "feat(running_calibration): implement fetch_latest() reader"
```

---

# Phase 2 — Delete duplicates in training_load/calibration.py

This phase deletes the redundant computations and confirms the legacy `CalibrationSnapshot` shape still works for downstream training-load code.

## Task 9: Delegate `hrmax_estimate`, `rhr_baseline`, `critical_power_w` to running_snapshot

**Files:**
- Modify: `src/stride_core/training_load/calibration.py`
- Modify: `tests/stride_core/training_load/test_calibration.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/stride_core/training_load/test_calibration.py`:

```python
def test_calibration_delegates_hrmax_to_running_snapshot():
    """training_load.calibration.estimate_calibration must source hrmax_estimate
    from running_calibration, not from a local copy of the same algorithm.
    """
    from datetime import date as _d
    from stride_core.training_load.calibration import estimate_calibration
    from stride_core.training_load.types import (
        CalibrationActivity, CalibrationSample, CalibrationHealthRow,
    )
    history = (
        CalibrationActivity(
            label_id="a",
            activity_date=_d(2026, 5, 1),
            sport="run_outdoor",
            max_hr=192.0,
            samples=(),
        ),
    )
    snap = estimate_calibration(history, as_of_date=_d(2026, 5, 20))
    # running_calibration.estimate_hrmax_profile applies neighbor-supported
    # filtering; for a single activity with no timeseries, the summary max_hr
    # is accepted (raw_contains_summary_max is vacuously true).
    assert snap.hrmax_estimate == 192.0
    # 'hrmax_estimate' source should now name running_calibration as the producer
    assert snap.source.get("hrmax_estimate", {}).get("source") == "running_calibration"


def test_calibration_delegates_rhr_to_running_snapshot():
    from datetime import date as _d
    from stride_core.training_load.calibration import estimate_calibration
    from stride_core.training_load.types import CalibrationHealthRow

    health = tuple(
        CalibrationHealthRow(date=_d(2026, 5, i), rhr=float(40 + i))
        for i in range(1, 21)
    )
    snap = estimate_calibration((), as_of_date=_d(2026, 5, 25), health_rows=health)
    assert snap.rhr_baseline == 43.0


def test_calibration_no_local_hrmax_function():
    """Guard: there must be no _estimate_hrmax in training_load.calibration."""
    from stride_core.training_load import calibration as cal_mod
    assert not hasattr(cal_mod, "_estimate_hrmax"), (
        "Found duplicate _estimate_hrmax in training_load.calibration — "
        "delegate to running_calibration.estimate_hrmax_profile instead "
        "(see CLAUDE.md 'Athlete baseline metrics — single source')"
    )
    assert not hasattr(cal_mod, "_estimate_critical_power"), (
        "Found duplicate _estimate_critical_power — delegate to "
        "running_calibration.estimate_critical_power"
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/stride_core/training_load/test_calibration.py -v`
Expected: 3 new tests fail — assertion errors on `source["hrmax_estimate"]["source"]` and the `hasattr` guard.

- [ ] **Step 3: Update `estimate_calibration` to delegate**

In `src/stride_core/training_load/calibration.py`:

(a) **Add a health-row adapter** above `estimate_calibration`:

```python
from stride_core.running_calibration.types import RunningHealthRow as _RCHealthRow


def _to_running_health_row(row: CalibrationHealthRow) -> _RCHealthRow:
    return _RCHealthRow(date=row.date, rhr=row.rhr)
```

(b) **Replace the body of `estimate_calibration`** (currently the bit that computes hrmax / rhr_baseline / critical_power locally) with delegation:

```python
def estimate_calibration(
    history: Sequence[CalibrationActivity],
    *,
    as_of_date: date,
    health_rows: Sequence[CalibrationHealthRow] = (),
) -> CalibrationSnapshot:
    """Estimate training-load calibration values.

    All three baseline metrics (hrmax_estimate, rhr_baseline, critical_power_w)
    are sourced from `stride_core.running_calibration.estimate_running_calibration`
    — this wrapper exists solely to preserve the legacy `CalibrationSnapshot`
    shape consumed by `training_load.adapter`. See CLAUDE.md HARD rule
    "Athlete baseline metrics — single source".
    """
    running_snapshot = estimate_running_calibration(
        tuple(_to_running_activity(activity) for activity in history),
        as_of_date,
        health_rows=tuple(_to_running_health_row(r) for r in health_rows),
    )
    source: dict[str, dict] = {"running_calibration": running_snapshot.source}
    if running_snapshot.hrmax_estimate is not None:
        source["hrmax_estimate"] = {"source": "running_calibration"}
    if running_snapshot.rhr_baseline is not None:
        source["rhr_baseline"] = {"source": "running_calibration", "method": "p10_90d"}
    if running_snapshot.critical_power_w is not None:
        source["critical_power_w"] = {"source": "running_calibration", "method": "median_180d"}
    return CalibrationSnapshot(
        as_of_date=as_of_date,
        rhr_baseline=running_snapshot.rhr_baseline,
        hrmax_estimate=running_snapshot.hrmax_estimate,
        threshold_hr=running_snapshot.threshold_hr,
        threshold_speed_mps=running_snapshot.threshold_speed_mps,
        critical_power_w=running_snapshot.critical_power_w,
        source=source,
    )
```

(c) **Delete** the now-unused helpers from the file:
- `_estimate_hrmax` (lines 57–69 currently)
- `_estimate_critical_power` (lines 72–86)
- `_valid_running_power` (lines 89–93) — moved into `running_calibration.core`
- `_percentile` (lines 18–24) — only used by the deleted inline RHR block

Remove the now-unused imports: `from statistics import median`, `from datetime import timedelta` (only if no other usage remains in the file — check before removing), and the module-level constants `MIN_RUNNING_POWER_W` / `MAX_RUNNING_POWER_W`.

- [ ] **Step 4: Run training_load test suite**

Run: `pytest tests/stride_core/training_load/ -v`
Expected: 3 new tests pass + existing tests pass. If any existing test expected the old `source["hrmax_estimate"]["method"] == "max_valid_180d"` value, update it to the new shape `{"source": "running_calibration"}`.

- [ ] **Step 5: Run downstream training_load consumer tests**

Run: `pytest tests/stride_core/training_load/test_adapter_db.py tests/stride_server/test_training_load_backfill.py -v`
Expected: all pass — the `CalibrationSnapshot` shape consumed by the adapter is unchanged (only the `source` dict structure shifted).

- [ ] **Step 6: Commit**

```bash
git add src/stride_core/training_load/calibration.py \
        tests/stride_core/training_load/test_calibration.py
git commit -m "refactor(training_load): delegate hrmax/rhr/cp to running_calibration; drop duplicates"
```

---

# Phase 3 — Replace inline duplicates in consumers

Each task in Phase 3 changes a single consumer to read from the baseline reader.

## Task 10: `routes/health.py` reads RHR baseline from reader

**Files:**
- Modify: `src/stride_server/routes/health.py`
- Modify or create: `tests/stride_server/test_health_route.py`

- [ ] **Step 1: Locate or create the test file**

Run: `find tests -name "test_health*.py"` to confirm location. If `tests/stride_server/test_health_route.py` exists, append; otherwise create.

- [ ] **Step 2: Write the failing test**

Add to (or create) `tests/stride_server/test_health_route.py`:

```python
from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient

# Project-specific test fixtures and TestClient bootstrap are codebase-wide;
# follow the pattern in tests/stride_server/test_onboarding_defaults.py for
# how to construct an authenticated client. The test below assumes a helper
# `make_authed_client(tmp_path, user_uuid)` that wires the per-user DB and
# returns a TestClient with bearer auth applied — match the existing pattern.


def test_get_health_returns_baseline_from_running_calibration(make_authed_client, tmp_path):
    """`/api/{user}/health` must read rhr_baseline from
    running_calibration_snapshot, not recompute P10 inline.
    """
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
    from stride_core.running_calibration.types import (
        CalibrationConfidence, RunningCalibrationSnapshot,
    )

    user_uuid = "00000000-0000-0000-0000-000000000001"
    client, db = make_authed_client(tmp_path, user_uuid)

    # Seed the canonical baseline directly — the route must read this value.
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 20),
        rhr_baseline=42.0,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.NONE,
    ))

    response = client.get(f"/api/{user_uuid}/health")
    assert response.status_code == 200
    assert response.json()["rhr_baseline"] == 42.0
```

If `make_authed_client` is not the project's existing fixture name, replace with the actual one — grep for `TestClient(` usage under `tests/stride_server/` to find the convention.

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/stride_server/test_health_route.py -v`
Expected: FAIL — `42.0 != <whatever P10 of empty daily_health returns>` (likely `None`).

- [ ] **Step 4: Replace inline RHR calculation with reader**

In `src/stride_server/routes/health.py`, find `get_health` (around line 55). Replace the inline RHR P10 block (currently lines 65–74) with:

```python
from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
from stride_core.timefmt import today_shanghai

# Inside get_health(...) after `db = get_db(user)` and `hrv = ...`:
try:
    repo = SQLiteRunningCalibrationRepository(db)
    snap = repo.fetch_latest(as_of_date=today_shanghai())
    rhr_baseline = int(snap.rhr_baseline) if snap and snap.rhr_baseline is not None else None
except Exception:  # noqa: BLE001
    # New user with no calibration snapshot yet is normal — return None.
    rhr_baseline = None
```

Delete the inline `rhr_rows = db.query(...)` … `rhr_baseline = ...` block entirely.

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/stride_server/test_health_route.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stride_server/routes/health.py \
        tests/stride_server/test_health_route.py
git commit -m "refactor(routes/health): read rhr_baseline from running_calibration reader"
```

---

## Task 11: `coach_agent/context.py` reads RHR baseline from reader

**Files:**
- Modify: `src/coach_agent/context.py`
- Modify: `tests/coach_agent/test_context.py` (or wherever `_rhr_baseline` is tested)

- [ ] **Step 1: Locate existing tests**

Run: `grep -rn "_rhr_baseline" tests/ src/coach_agent/`
Document which test file covers the current behavior. If none exist, create `tests/coach_agent/test_context_rhr.py`.

- [ ] **Step 2: Write the failing test**

Add to the relevant test file:

```python
def test_coach_context_reads_rhr_from_running_calibration(tmp_path):
    """coach_agent.context must read rhr_baseline from the canonical
    running_calibration reader, not recompute P10 inline.
    """
    import sqlite3
    from datetime import date
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
    from stride_core.running_calibration.types import (
        CalibrationConfidence, RunningCalibrationSnapshot,
    )
    # Minimal in-memory DB
    db_path = tmp_path / "ctx.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript("CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT);")
    db = type("DB", (), {"_conn": conn, "_path": str(db_path), "query": lambda self, *a, **k: []})()
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 20),
        rhr_baseline=44.0,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.NONE,
    ))

    from coach_agent.context import _rhr_baseline  # public-ish — module-internal but stable
    assert _rhr_baseline(db) == 44
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/coach_agent/test_context_rhr.py -v` (or the relevant file)
Expected: FAIL — likely returns `None` (the inline `daily_health` query finds no rows in this fixture).

- [ ] **Step 4: Replace `_rhr_baseline` body with reader**

In `src/coach_agent/context.py`, find `_rhr_baseline` (around line 43). Replace its body:

```python
def _rhr_baseline(db: Database) -> int | None:
    """Trained RHR baseline (P10/90d).

    Reads from `running_calibration_snapshot` via the canonical reader. See
    CLAUDE.md HARD rule "Athlete baseline metrics — single source".
    """
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
    from stride_core.timefmt import today_shanghai
    try:
        repo = SQLiteRunningCalibrationRepository(db)
        snap = repo.fetch_latest(as_of_date=today_shanghai())
    except Exception:  # noqa: BLE001
        return None
    if snap is None or snap.rhr_baseline is None:
        return None
    return int(snap.rhr_baseline)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/coach_agent/test_context_rhr.py -v`
Expected: PASS.

- [ ] **Step 6: Run full coach_agent test suite as sanity check**

Run: `pytest tests/coach_agent/ -v`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/coach_agent/context.py \
        tests/coach_agent/test_context_rhr.py
git commit -m "refactor(coach_agent): read rhr_baseline from running_calibration reader"
```

---

## Task 12: `compute_ability_snapshot` resolves hr_max from baseline

This is the most impactful task: it makes the detected `hrmax_estimate` actually flow into VO2max / HR-pace regression / target HR inference, instead of the hardcoded `185`.

**Files:**
- Modify: `src/stride_core/ability.py`
- Modify: `tests/test_ability.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_ability.py`:

```python
def test_compute_ability_snapshot_uses_baseline_hrmax(ability_db):
    """compute_ability_snapshot resolves hr_max from
    running_calibration_snapshot when the kwarg is not provided.
    Previously hardcoded to 185.
    """
    from datetime import date
    from stride_core.ability import compute_ability_snapshot
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
    from stride_core.running_calibration.types import (
        CalibrationConfidence, RunningCalibrationSnapshot,
    )
    # Seed a baseline with hrmax_estimate=200 (well above default 185)
    repo = SQLiteRunningCalibrationRepository(ability_db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 4, 23),
        hrmax_estimate=200.0,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
    ))
    snap = compute_ability_snapshot(ability_db, "2026-04-23")
    # The L3 vo2max computation should record the hr_max it actually used
    # (we expose this via `snap["l3"]["vo2max_detail"]["hr_max_used"]` —
    # adding this passthrough is part of this task).
    assert snap["l3"]["vo2max_detail"]["hr_max_used"] == 200


def test_compute_ability_snapshot_explicit_hr_max_overrides_baseline(ability_db):
    from datetime import date
    from stride_core.ability import compute_ability_snapshot
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
    from stride_core.running_calibration.types import (
        CalibrationConfidence, RunningCalibrationSnapshot,
    )
    repo = SQLiteRunningCalibrationRepository(ability_db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 4, 23),
        hrmax_estimate=200.0,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
    ))
    snap = compute_ability_snapshot(ability_db, "2026-04-23", hr_max=210)
    assert snap["l3"]["vo2max_detail"]["hr_max_used"] == 210


def test_compute_ability_snapshot_falls_back_to_185(ability_db):
    """When no baseline exists, the legacy 185 default is preserved."""
    from stride_core.ability import compute_ability_snapshot
    snap = compute_ability_snapshot(ability_db, "2026-04-23")
    assert snap["l3"]["vo2max_detail"]["hr_max_used"] == 185
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_ability.py::test_compute_ability_snapshot_uses_baseline_hrmax tests/test_ability.py::test_compute_ability_snapshot_explicit_hr_max_overrides_baseline tests/test_ability.py::test_compute_ability_snapshot_falls_back_to_185 -v`
Expected: FAIL — `hr_max_used` not yet in the snapshot detail; baseline not consulted.

- [ ] **Step 3: Implement baseline resolution**

In `src/stride_core/ability.py`:

(a) Add this helper near the top (after imports, before the first function):

```python
def _resolve_hr_max(db: Any, as_of_date_iso: str, fallback: int = 185) -> int:
    """Look up hrmax_estimate from running_calibration_snapshot.

    Falls back to `fallback` (default 185) when:
      - the connector can't be constructed (legacy DB / missing schema)
      - no snapshot exists yet
      - snapshot has no hrmax_estimate
    See CLAUDE.md HARD rule "Athlete baseline metrics — single source".
    """
    try:
        from datetime import date as _date
        from stride_core.running_calibration.sqlite_connector import (
            SQLiteRunningCalibrationRepository,
        )
        repo = SQLiteRunningCalibrationRepository(db)
        snap = repo.fetch_latest(as_of_date=_date.fromisoformat(as_of_date_iso))
    except Exception:  # noqa: BLE001
        return fallback
    if snap is None or snap.hrmax_estimate is None:
        return fallback
    return int(round(snap.hrmax_estimate))
```

(b) Modify `compute_ability_snapshot` signature (around line 2040) — change `hr_max: int = 185` to `hr_max: int | None = None` and resolve early:

```python
def compute_ability_snapshot(
    db: Any,
    date: str,
    hr_max: int | None = None,
) -> dict:
    """Compute full snapshot {l1 (latest), l2, l3, l4, marathon_s} for `date`.

    `date` is an ISO YYYY-MM-DD string.  All date filtering uses Shanghai
    local time (UTC+8) as project memory requires.

    `hr_max` defaults to the user's latest detected `hrmax_estimate` from
    `running_calibration_snapshot`; falls back to 185 when no snapshot
    exists. Explicit kwargs override.
    """
    if db is None:
        return _empty_snapshot(date)
    if hr_max is None:
        hr_max = _resolve_hr_max(db, date)
    # ... rest of body unchanged
```

(c) In `compute_l3_vo2max`, record `hr_max_used` in the detail dict it returns:

Search for the function `compute_l3_vo2max` (around line 1376). At the point where it constructs the returned `detail` dict (search for `return ... vo2_det` or similar), add `"hr_max_used": int(hr_max)` to the dict. If the function signature is `def compute_l3_vo2max(activities, health_7d, hr_max, *, pbs, today_iso):`, the value is already in scope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_ability.py -v -k "hr_max_used or baseline"`
Expected: 3 new tests pass.

- [ ] **Step 5: Run full ability test suite**

Run: `pytest tests/test_ability.py -v`
Expected: all tests pass. If any existing test relied on the unconditional `hr_max=185` behavior (e.g. computed expected VO2max scores against `185`), update them to either pass `hr_max=185` explicitly or seed a snapshot with `hrmax_estimate=185.0`.

- [ ] **Step 6: Commit**

```bash
git add src/stride_core/ability.py tests/test_ability.py
git commit -m "feat(ability): compute_ability_snapshot resolves hr_max from baseline reader"
```

---

# Phase 4 — CI guard against future duplication

## Task 13: Add a grep-based test that fails when baseline computations duplicate

**Files:**
- Create: `tests/test_no_baseline_duplicates.py`

- [ ] **Step 1: Write the test**

Create `tests/test_no_baseline_duplicates.py`:

```python
"""Guard against future duplication of athlete-baseline computations.

See CLAUDE.md HARD rule 'Athlete baseline metrics — single source'.

If you are adding a new file that legitimately needs an inline RHR / hrmax
computation with a different semantic (like the onboarding seed value),
add it to the WHITELIST below with a one-line justification.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
SRC = REPO_ROOT / "src"


WHITELIST_RHR_P10 = {
    # The canonical implementation lives here.
    "stride_core/running_calibration/core.py",
}

WHITELIST_HRMAX_LOCAL = {
    # The canonical implementation lives here.
    "stride_core/running_calibration/core.py",
    "stride_core/running_calibration/segments.py",  # uses hrmax_estimate as input, not as a computation
}

# Onboarding's P25/30d seed-value computation is intentionally different from
# the trained baseline (P10/90d). Documented exception.
ONBOARDING_SEED = "stride_server/routes/onboarding.py"


def _walk_py(root: Path):
    for p in root.rglob("*.py"):
        if any(part in {"__pycache__"} for part in p.parts):
            continue
        yield p


def test_no_inline_rhr_p10_outside_running_calibration():
    """Forbids inline 'SELECT rhr FROM daily_health' + sort + index[~10%] patterns
    outside the canonical computation.
    """
    pattern_select_rhr = re.compile(
        r"SELECT\s+rhr\s+FROM\s+daily_health", re.IGNORECASE
    )
    pattern_p10_idx = re.compile(
        r"len\([^)]+\)\s*\*\s*0\.1"
    )
    offenders: list[str] = []
    for path in _walk_py(SRC):
        rel = path.relative_to(SRC).as_posix()
        if rel in WHITELIST_RHR_P10 or rel == ONBOARDING_SEED:
            continue
        text = path.read_text(encoding="utf-8")
        if pattern_select_rhr.search(text) and pattern_p10_idx.search(text):
            offenders.append(rel)
    assert not offenders, (
        f"Found inline RHR-P10 computation outside running_calibration: {offenders}. "
        "Replace with: SQLiteRunningCalibrationRepository(db).fetch_latest().rhr_baseline. "
        "See CLAUDE.md 'Athlete baseline metrics — single source'."
    )


def test_no_local_estimate_hrmax_function():
    """Forbids any `def _estimate_hrmax(` outside running_calibration."""
    pattern = re.compile(r"def\s+_estimate_hrmax\s*\(")
    offenders: list[str] = []
    for path in _walk_py(SRC):
        rel = path.relative_to(SRC).as_posix()
        if rel in WHITELIST_HRMAX_LOCAL:
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(rel)
    assert not offenders, (
        f"Found `_estimate_hrmax` outside running_calibration: {offenders}. "
        "Use running_calibration.estimate_hrmax_profile or "
        "SQLiteRunningCalibrationRepository(db).fetch_latest().hrmax_estimate."
    )


def test_no_local_estimate_critical_power():
    pattern = re.compile(r"def\s+_estimate_critical_power\s*\(")
    offenders: list[str] = []
    for path in _walk_py(SRC):
        rel = path.relative_to(SRC).as_posix()
        if rel == "stride_core/running_calibration/core.py":
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(rel)
    assert not offenders, (
        f"Found `_estimate_critical_power` outside running_calibration: {offenders}."
    )


def test_no_hr_max_185_magic_default():
    """The hardcoded `hr_max: int = 185` default in compute_ability_snapshot
    is gone — any reintroduction must go through review.
    """
    pattern = re.compile(r"hr_max\s*:\s*int\s*=\s*185")
    offenders: list[str] = []
    for path in _walk_py(SRC):
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(path.relative_to(SRC).as_posix())
    assert not offenders, (
        f"Reintroduced `hr_max: int = 185` magic default in {offenders}. "
        "Use `hr_max: int | None = None` + `_resolve_hr_max(db, date)`."
    )
```

- [ ] **Step 2: Run the test**

Run: `pytest tests/test_no_baseline_duplicates.py -v`
Expected: 4 passed (because Phases 1–3 cleared all known offenders).

- [ ] **Step 3: Commit**

```bash
git add tests/test_no_baseline_duplicates.py
git commit -m "test: CI guard against athlete-baseline computation duplication"
```

---

# Final verification

- [ ] **Step 1: Run the full backend test suite**

Run: `pytest tests/ -x --timeout=120`
Expected: all tests pass.

- [ ] **Step 2: Run import-linter**

Run: `PYTHONPATH=src lint-imports`
Expected: no violations. (The new code adds a `coach_agent → stride_core.running_calibration.sqlite_connector` edge, which is allowed under the existing Core/Adapters policy because `running_calibration` lives in `stride_core`. Confirm `.importlinter` does not restrict `running_calibration` specifically.)

- [ ] **Step 3: Run timezone-invariants check**

Run: `pytest tests/test_timezone_invariants.py -v`
Expected: pass. The new `fetch_health_rows` uses YYYYMMDD string comparisons against `daily_health.date`, which is already a Shanghai-local column — no UTC slicing involved.

- [ ] **Step 4: Smoke test against a real user DB (manual)**

Run: `PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi recompute-calibration` if such a CLI exists; otherwise:

```bash
PYTHONIOENCODING=utf-8 python -c "
from stride_core.db import Database
from stride_core.running_calibration import recompute_running_calibration
from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
db = Database('data/zhaochaoyi/coros.db')
repo = SQLiteRunningCalibrationRepository(db)
summary = recompute_running_calibration(repo)
print('hrmax_estimate:', summary.snapshot.hrmax_estimate)
print('rhr_baseline:', summary.snapshot.rhr_baseline)
print('critical_power_w:', summary.snapshot.critical_power_w)
print('threshold_hr:', summary.snapshot.threshold_hr)
print('threshold_speed_mps:', summary.snapshot.threshold_speed_mps)
"
```

Expected: non-None values for hrmax_estimate, rhr_baseline, and threshold_hr/speed. Critical power may be None if zhaochaoyi's COROS does not record running power — that is OK.

- [ ] **Step 5: Smoke test compute_ability_snapshot against real DB**

```bash
PYTHONIOENCODING=utf-8 python -c "
from stride_core.db import Database
from stride_core.ability import compute_ability_snapshot
from stride_core.timefmt import today_shanghai
db = Database('data/zhaochaoyi/coros.db')
snap = compute_ability_snapshot(db, today_shanghai().isoformat())
print('hr_max_used:', snap['l3']['vo2max_detail'].get('hr_max_used'))
"
```

Expected: a non-185 value (proves the baseline reader path is wired). If 185, the user has no snapshot yet — run Step 4 first.

- [ ] **Step 6: Final summary commit (optional, only if anything cleanup-worthy is uncommitted)**

```bash
git status
# If clean, no commit needed.
```

---

# Risk register

| Risk | Mitigation |
|------|------------|
| **Behavior change in TRIMP / TSS calculations** because `training_load.calibration` now sources hrmax/cp/rhr via running_calibration (which has stricter filtering, e.g. neighbor-support for hrmax) | Existing `tests/stride_core/training_load/test_calibration.py` exercises the snapshot shape. Run it after Task 9. The neighbor-support filter only rejects spurious peaks — if production data has any, this is a strict improvement, not a regression. |
| **Existing ability snapshots in DB used 185** and the new code uses a different value, causing apparent shifts in VO2max scores on first re-run | This *is* the intended behavior change. Document in commit message. ability_hook recomputes daily, so values self-heal. |
| **Legacy DBs missing `critical_power_w` column** | Task 5's `_ensure_columns` migration adds the column on first connector init. The schema migration test covers this case. |
| **`fetch_latest()` returning a stale snapshot** when `as_of_date` is in the past but the user has no snapshot yet | Returns None → `_resolve_hr_max` falls back to 185. No exception raised. |
| **coach context regression**: replacing inline RHR P10 with reader changes when the value is None (e.g. brand-new user with no calibration run yet) | The inline P10 also returned None for < 14 samples, and a fresh DB has no calibration snapshot — both paths return None. No regression for the new-user case. |
| **import-linter violations** if coach_adapters / coach_agent now imports new running_calibration symbols | Inspect `.importlinter` config; running_calibration is part of `stride_core` and was already importable from `coach_agent`. The new edge is to `sqlite_connector` which depends only on `stride_core.timefmt` + sqlite3 — no transitive boundary crossings. |
