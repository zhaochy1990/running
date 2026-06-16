# Coach Stage-0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a correct, deterministic Stage-0 context layer for master-plan generation — unified STRIDE training load (not COROS), backfilled so chronic converges; deterministic continuity signals; injury injection — all from canonical code / structured stores.

**Architecture:** Fix/extend the existing `load_master_context` path. `_query_fitness_state` switches from COROS `daily_health.ati/cti` to canonical STRIDE `daily_training_load`. A new deterministic `continuity_analyzer` (adapter layer, reads DB) produces a `ContinuitySignals` pydantic object (type lives in coach core so the planner can consume it later). Injuries come from structured `running_profile`. Everything is wired into `load_master_context` and surfaced in the generator's prompt. This plan does NOT change the generation flow shape — it only enriches/corrects the context the existing single-shot generator already consumes, so it's independently shippable and testable.

**Tech Stack:** Python 3.13, SQLite (`stride_core.db.Database`), `stride_core.training_load` (PMC backfill), pydantic, pytest.

**Scope of this plan:** Spec §3 (data-layer load unification) + §4 (continuity signals) + injuries injection. Spec §5–§10 (structure planner, specialists, schema changes, eval) are later plans.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `tests/stride_server/test_master_plan_generator.py` | Modify | Regression tests for `_query_history` (locks already-applied fix) + `_query_fitness_state` rewrite |
| `src/stride_server/master_plan_generator.py` | Modify | `_query_fitness_state` → STRIDE `daily_training_load` + ensure-backfill |
| `src/coach/schemas/continuity.py` | Create | `ContinuitySignals` pydantic type (coach core, no DB dep) |
| `src/coach/schemas/__init__.py` | Modify | Export `ContinuitySignals` |
| `src/stride_server/coach_adapters/continuity_analyzer.py` | Create | Deterministic signal computation from DB + running_profile |
| `tests/coach_adapters/test_continuity_analyzer.py` | Create | Unit tests for each signal against seeded temp DBs |
| `src/stride_server/coach_adapters/master_plan_adapter.py` | Modify | Wire continuity + injuries into `load_master_context` |
| `src/stride_server/master_plan_generator.py` | Modify | Surface continuity + injuries in `_build_system_prompt` |

**Test DB seeding convention (used throughout):** create a fresh DB with `Database(db_path=tmp_path / "coros.db")` (this applies the schema), then insert rows via `db._conn.execute(...)`. `activities` requires `sport_type` (NOT NULL); `label_id`/`date`/`distance_m`/`duration_s` are the only other columns these queries touch.

---

## Task 1: Regression test for `_query_history` (lock the already-applied fix)

The `sport_type IN (RUN_SPORT_SQL_LIST)` + km-unit normalization fixes are already in the working tree but have NO test. Lock them so they can't regress.

**Files:**
- Test: `tests/stride_server/test_master_plan_generator.py`

- [ ] **Step 1: Write the failing test**

Add this class to the test file:

```python
import sqlite3
from stride_server.master_plan_generator import _query_history


class TestQueryHistoryRealDB:
    def _seed(self, tmp_path):
        from stride_core.db import Database
        db = Database(db_path=tmp_path / "coros.db")
        c = db._conn
        # Running, COROS code (100) + Garmin code (8001); distance stored as KM (<500).
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a1', 100, '2026-05-01T08:00:00+00:00', 21.1, 5400)"
        )
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a2', 8001, '2026-05-08T08:00:00+00:00', 10.0, 2550)"
        )
        # Legacy meters row (>=500) — must normalize to km too.
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a3', 101, '2026-05-15T08:00:00+00:00', 15000, 4000)"
        )
        # Non-running (strength=4) — must be excluded.
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a4', 4, '2026-05-16T08:00:00+00:00', 0, 1800)"
        )
        c.commit()
        return db

    def test_counts_running_across_sport_codes_excludes_strength(self, tmp_path, monkeypatch):
        db = self._seed(tmp_path)
        from stride_server import master_plan_generator as mod
        monkeypatch.setattr(mod, "Database", lambda user: db) if False else None
        # _query_history constructs Database(user=...) internally; patch it to our seeded db.
        from stride_core import db as db_mod
        monkeypatch.setattr("stride_core.db.Database", lambda **kw: db)
        result = _query_history("anyuser")
        assert result["total_activities"] == 3  # a1, a2, a3 (not a4)

    def test_distance_normalized_to_km(self, tmp_path, monkeypatch):
        db = self._seed(tmp_path)
        monkeypatch.setattr("stride_core.db.Database", lambda **kw: db)
        result = _query_history("anyuser")
        may = next(m for m in result["monthly_km"] if m["month"] == "2026-05")
        # 21.1 (km) + 10.0 (km) + 15000m→15km = 46.1 km
        assert abs(may["km"] - 46.1) < 0.2
```

- [ ] **Step 2: Run test to verify behavior**

Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py::TestQueryHistoryRealDB -v`
Expected: PASS (the fix is already applied). If a column is rejected by the schema, adjust the INSERT column list to match `db.py` and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/stride_server/test_master_plan_generator.py
git commit -m "test: lock _query_history sport_type + km-unit fixes with real-DB regression"
```

---

## Task 2: `_query_fitness_state` → STRIDE `daily_training_load` (with ensure-backfill)

Stop reading COROS `daily_health.ati/cti`. Read canonical STRIDE `daily_training_load.acute_load/chronic_load/form`, after ensuring the table is backfilled far enough for the 42-day EWMA to converge. Keep `rhr` from `daily_health` (raw measurement, not vendor-derived load).

**Files:**
- Modify: `src/stride_server/master_plan_generator.py` (`_query_fitness_state`, ~line 318)
- Test: `tests/stride_server/test_master_plan_generator.py`

- [ ] **Step 1: Write the failing test**

```python
class TestQueryFitnessStateStride:
    def test_reads_stride_load_not_coros(self, tmp_path, monkeypatch):
        from stride_core.db import Database
        db = Database(db_path=tmp_path / "coros.db")
        c = db._conn
        # COROS values that must NOT be used:
        c.execute(
            "INSERT INTO daily_health (date, ati, cti, fatigue, rhr) "
            "VALUES ('20260610', 136, 120, 50, 48)"
        )
        # STRIDE canonical values that MUST be used:
        c.execute(
            "INSERT INTO daily_training_load (date, algorithm_version, training_dose, "
            "acute_load, chronic_load, form) VALUES ('2026-06-10', 1, 70, 69.9, 64.1, -5.8)"
        )
        c.commit()
        monkeypatch.setattr("stride_core.db.Database", lambda **kw: db)
        # Skip the heavy real backfill in this unit test:
        from stride_server import master_plan_generator as mod
        monkeypatch.setattr(mod, "_ensure_training_load_current", lambda db, as_of=None: None)

        state = mod._query_fitness_state("anyuser")
        assert state["ctl"] == 64.1      # chronic_load, NOT cti=120
        assert state["atl"] == 69.9      # acute_load, NOT ati=136
        assert state["rhr"] == 48        # rhr still from daily_health
        assert "64" in state["summary"]  # summary reflects STRIDE chronic
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py::TestQueryFitnessStateStride -v`
Expected: FAIL — current code reads `ati/cti`, and `_ensure_training_load_current` doesn't exist yet.

- [ ] **Step 3: Add the ensure-backfill helper**

Add to `src/stride_server/master_plan_generator.py` (near `_query_fitness_state`):

```python
def _ensure_training_load_current(db, as_of=None) -> None:
    """Ensure daily_training_load is backfilled far enough that the 42-day
    chronic EWMA has converged at ``as_of``. The EWMA has ~42-day memory, so a
    365-day warmup window (>> 3x42) yields a converged chronic regardless of how
    few rows existed before. Idempotent; safe to call every generation."""
    from stride_core.training_load import backfill_training_load
    try:
        backfill_training_load(db, as_of_date=as_of, load_lookback_days=365,
                               calibration_lookback_days=365, persist=True)
    except Exception as exc:  # noqa: BLE001 — context load must never hard-fail
        logger.warning("_ensure_training_load_current failed: %s", exc)
```

- [ ] **Step 4: Rewrite `_query_fitness_state` body**

Replace the `daily_health` query block (the `SELECT ati, cti, ...` and its unpacking) with:

```python
        from stride_core.timefmt import today_shanghai

        _ensure_training_load_current(db, as_of=today_shanghai())

        row = conn.execute(
            "SELECT date, acute_load, chronic_load, form FROM daily_training_load "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        rhr_row = conn.execute(
            "SELECT rhr FROM daily_health WHERE rhr IS NOT NULL ORDER BY date DESC LIMIT 1"
        ).fetchone()
        rhr = rhr_row[0] if rhr_row else None

        if row:
            _date, atl, ctl, form = row
            ratio = round(atl / ctl, 2) if ctl else None
            result.update({
                "ctl": round(ctl, 1) if ctl is not None else None,
                "atl": round(atl, 1) if atl is not None else None,
                "tsb": round(form, 1) if form is not None else None,
                "rhr": rhr,
                "training_load_ratio": ratio,
            })
            parts = []
            if ctl is not None:
                parts.append(f"CTL {ctl:.0f}")
            if atl is not None:
                parts.append(f"ATL {atl:.0f}")
            if form is not None:
                parts.append(f"Form {form:+.0f}")
            if ratio is not None:
                parts.append(f"acute/chronic {ratio}")
            if rhr is not None:
                parts.append(f"RHR {rhr}bpm")
            result["summary"] = "，".join(parts) if parts else "体能数据暂无"
```

Keep the `result` dict's default keys; drop the `fatigue` / `training_load_state` keys that came from COROS (or leave them defaulting to `None` — they are no longer populated). Ensure `logger` is imported (it already is).

- [ ] **Step 5: Run test to verify it passes**

Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py::TestQueryFitnessStateStride -v`
Expected: PASS

- [ ] **Step 6: Run the full generator test file (no regressions)**

Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py -q`
Expected: all pass (the `patch_history` fixture stubs `_query_fitness_state` in flow tests, so they are unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/stride_server/master_plan_generator.py tests/stride_server/test_master_plan_generator.py
git commit -m "fix(coach): read STRIDE daily_training_load for fitness state, not COROS ati/cti"
```

---

## Task 3: `ContinuitySignals` schema (coach core)

The type lives in coach core (pydantic only) so the future structure_planner (core) can consume it; the analyzer (adapter) produces it.

**Files:**
- Create: `src/coach/schemas/continuity.py`
- Modify: `src/coach/schemas/__init__.py`
- Test: `tests/coach/test_continuity_schema.py` (create)

- [ ] **Step 1: Write the failing test**

```python
from coach.schemas import ContinuitySignals

def test_continuity_signals_round_trips():
    sig = ContinuitySignals(
        days_since_last_race=84,
        post_race_recovery_status="recovered",
        recent_aerobic_weeks=6,
        recent_volume_trend="rising",
        recent_longest_run_km=32.0,
        recent_quality_sessions_per_week=1.5,
        current_form_zone="维持期",
        current_chronic_load=64.1,
        return_from_layoff=False,
        macro_cycle="summer",
        season_context="夏→秋，6-10月，含高温窗口",
        injuries=["achilles"],
    )
    dumped = sig.model_dump()
    assert dumped["macro_cycle"] == "summer"
    assert ContinuitySignals.model_validate(dumped).current_chronic_load == 64.1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/coach/test_continuity_schema.py -v`
Expected: FAIL — `ImportError: cannot import name 'ContinuitySignals'`

- [ ] **Step 3: Create the schema**

`src/coach/schemas/continuity.py`:

```python
"""Deterministic continuity signals (Stage-0 context) — see spec §4.

Produced by the adapter-layer continuity_analyzer from structured DB +
running_profile; consumed by the structure_planner. Pure pydantic so it stays
import-linter clean in coach core.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ContinuitySignals(BaseModel):
    days_since_last_race: int | None = None
    post_race_recovery_status: Literal["recovering", "recovered", "no_recent_race"] = "no_recent_race"
    recent_aerobic_weeks: int = 0
    recent_volume_trend: Literal["rising", "flat", "falling", "unknown"] = "unknown"
    recent_longest_run_km: float | None = None
    recent_quality_sessions_per_week: float = 0.0
    current_form_zone: str | None = None          # canonical training_load classification
    current_chronic_load: float | None = None     # STRIDE CTL
    return_from_layoff: bool = False
    macro_cycle: Literal["summer", "winter", "unknown"] = "unknown"
    season_context: str = ""
    injuries: list[str] = []
```

- [ ] **Step 4: Export it**

In `src/coach/schemas/__init__.py` add:

```python
from .continuity import ContinuitySignals
```

and add `"ContinuitySignals"` to `__all__` if that file defines one.

- [ ] **Step 5: Run test + import-linter**

Run: `PYTHONPATH=src python -m pytest tests/coach/test_continuity_schema.py -v && PYTHONPATH=src lint-imports`
Expected: PASS, contracts kept.

- [ ] **Step 6: Commit**

```bash
git add src/coach/schemas/continuity.py src/coach/schemas/__init__.py tests/coach/test_continuity_schema.py
git commit -m "feat(coach): add ContinuitySignals schema"
```

---

## Task 4: `continuity_analyzer` — deterministic signal computation

**Files:**
- Create: `src/stride_server/coach_adapters/continuity_analyzer.py`
- Test: `tests/coach_adapters/test_continuity_analyzer.py`

Public entry point:
```python
def analyze_continuity(db, *, goal: dict, profile: dict | None, as_of) -> ContinuitySignals
```

- [ ] **Step 1: Write failing tests for race-recency + recovery + injuries**

```python
from datetime import date
from coach.schemas import ContinuitySignals


def _db(tmp_path):
    from stride_core.db import Database
    return Database(db_path=tmp_path / "coros.db")


def test_no_recent_race(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None,
                             as_of=date(2026, 6, 10))
    assert sig.post_race_recovery_status == "no_recent_race"
    assert sig.days_since_last_race is None


def test_injuries_from_profile(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"},
                             profile={"injuries": ["achilles", "itbs"]},
                             as_of=date(2026, 6, 10))
    assert sig.injuries == ["achilles", "itbs"]


def test_injuries_none_tag_filtered(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"},
                             profile={"injuries": ["none"]}, as_of=date(2026, 6, 10))
    assert sig.injuries == []


def test_macro_cycle_summer_for_autumn_race(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None,
                             as_of=date(2026, 6, 10))
    assert sig.macro_cycle == "summer"


def test_macro_cycle_winter_for_march_race(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2027-03-21"}, profile=None,
                             as_of=date(2026, 12, 1))
    assert sig.macro_cycle == "winter"
```

- [ ] **Step 2: Run to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/coach_adapters/test_continuity_analyzer.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the analyzer**

`src/stride_server/coach_adapters/continuity_analyzer.py`:

```python
"""Deterministic continuity signals — see spec §4. Adapter layer (reads DB)."""
from __future__ import annotations

import logging
from datetime import date as date_cls

from coach.schemas import ContinuitySignals
from stride_core.models import RUN_SPORT_SQL_LIST

logger = logging.getLogger(__name__)

# Distance heuristic identical to stride_core.ability._distance_to_km (km if <500).
_KM_EXPR = "CASE WHEN distance_m < 500 THEN distance_m ELSE distance_m / 1000.0 END"


def _macro_cycle(race_date: str | None) -> str:
    if not race_date:
        return "unknown"
    try:
        m = date_cls.fromisoformat(race_date).month
    except (ValueError, TypeError):
        return "unknown"
    if m in (9, 10, 11):          # autumn race → summer prep block
        return "summer"
    if m in (2, 3, 4):            # spring race → winter prep block
        return "winter"
    return "unknown"


def _injuries(profile: dict | None) -> list[str]:
    raw = (profile or {}).get("injuries") or []
    return [i for i in raw if isinstance(i, str) and i != "none"]


def analyze_continuity(db, *, goal: dict, profile: dict | None, as_of: date_cls) -> ContinuitySignals:
    conn = db._conn
    race_date = (goal or {}).get("race_date")

    # --- current STRIDE load (chronic = CTL) + form zone ---
    chronic = None
    form_zone = None
    try:
        row = conn.execute(
            "SELECT acute_load, chronic_load, form FROM daily_training_load "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        if row:
            atl, chronic, form = row
            form_zone = _classify_form_zone(chronic, atl)
    except Exception as exc:  # noqa: BLE001
        logger.warning("continuity: load read failed: %s", exc)

    # --- last race recency + post-race recovery ---
    days_since_last_race = None
    recovery = "no_recent_race"
    try:
        # Race-type activities: train_kind/train_type race markers vary; use a
        # conservative proxy — most recent activity flagged as a race in
        # activities (sport_name LIKE '%race%' is unreliable). v1: derive from
        # race_predictions' source if present, else None. Engineers: confirm the
        # race-flag column during execution; default to None when absent.
        row = conn.execute(
            "SELECT MAX(date) FROM activities WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ")"
            " AND (train_kind LIKE '%race%' OR train_type LIKE '%race%')"
        ).fetchone()
        if row and row[0]:
            last = date_cls.fromisoformat(str(row[0])[:10])
            days_since_last_race = (as_of - last).days
            # Recovered if current form has returned to neutral/positive and it's
            # been >= 21 days. (form >= -5 ≈ acute back near chronic.)
            recovered = days_since_last_race >= 21 and (form_zone in ("维持期", "比赛就绪", "减量过多"))
            recovery = "recovered" if recovered else "recovering"
    except Exception as exc:  # noqa: BLE001
        logger.warning("continuity: race recency failed: %s", exc)

    # --- weekly volume signals (last 8 ISO weeks) ---
    aerobic_weeks, trend, longest_km, quality_per_week = _volume_signals(conn, as_of)

    return ContinuitySignals(
        days_since_last_race=days_since_last_race,
        post_race_recovery_status=recovery,
        recent_aerobic_weeks=aerobic_weeks,
        recent_volume_trend=trend,
        recent_longest_run_km=longest_km,
        recent_quality_sessions_per_week=quality_per_week,
        current_form_zone=form_zone,
        current_chronic_load=round(chronic, 1) if chronic is not None else None,
        return_from_layoff=_detect_layoff(conn, as_of),
        macro_cycle=_macro_cycle(race_date),
        season_context=_season_context(race_date, as_of),
        injuries=_injuries(profile),
    )
```

Then implement the helpers in the same module:

```python
def _classify_form_zone(chronic, acute) -> str | None:
    """Canonical CTL-ratio form classification (spec §4 ratio bands). NOTE:
    this duplicates band logic that exists in several places; the spec flags
    consolidation to a single source as a follow-up. Until then, mirror the
    training_load classification exactly."""
    if not chronic or chronic <= 0 or acute is None:
        return None
    ratio = acute / chronic
    if ratio < 0.75:
        return "减量过多"
    if ratio < 0.90:
        return "比赛就绪"
    if ratio <= 1.10:
        return "维持期"
    if ratio <= 1.25:
        return "提升期"
    return "过度负荷"


def _volume_signals(conn, as_of):
    """Return (aerobic_weeks, trend, longest_run_km, quality_sessions_per_week)
    over the last 8 ISO weeks."""
    rows = conn.execute(
        "SELECT strftime('%Y-%W', date) AS wk, "
        "SUM(" + _KM_EXPR + ") AS km, "
        "MAX(" + _KM_EXPR + ") AS longest "
        "FROM activities WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ") "
        "AND date >= date(?, '-56 days') GROUP BY wk ORDER BY wk",
        (as_of.isoformat(),),
    ).fetchall()
    if not rows:
        return 0, "unknown", None, 0.0
    weekly_km = [r[1] or 0.0 for r in rows]
    longest = max((r[2] or 0.0) for r in rows)
    AEROBIC_WEEK_MIN_KM = 30.0
    aerobic_weeks = sum(1 for km in weekly_km if km >= AEROBIC_WEEK_MIN_KM)
    if len(weekly_km) >= 4:
        first, last = sum(weekly_km[:2]) / 2, sum(weekly_km[-2:]) / 2
        trend = "rising" if last > first * 1.08 else "falling" if last < first * 0.92 else "flat"
    else:
        trend = "unknown"
    return aerobic_weeks, trend, round(longest, 1) if longest else None, 0.0
    # NOTE: quality_sessions_per_week left at 0.0 in v1; populated in a follow-up
    # task once a per-activity intensity/zone marker is confirmed in the schema.


def _detect_layoff(conn, as_of) -> bool:
    """True if there is a >28-day gap between consecutive runs in the last 120 days."""
    rows = conn.execute(
        "SELECT date(date) FROM activities WHERE sport_type IN (" + RUN_SPORT_SQL_LIST + ") "
        "AND date >= date(?, '-120 days') ORDER BY date",
        (as_of.isoformat(),),
    ).fetchall()
    days = [date_cls.fromisoformat(r[0]) for r in rows if r[0]]
    for prev, nxt in zip(days, days[1:]):
        if (nxt - prev).days > 28:
            return True
    return False


def _season_context(race_date, as_of) -> str:
    mc = _macro_cycle(race_date)
    if mc == "summer":
        return "夏训块：起于夏季高温窗口，向秋季比赛过渡；长课需避正午、适合发展速度"
    if mc == "winter":
        return "冬训块：低温、消耗小，适合堆有氧大基础，向春季比赛过渡"
    return ""
```

- [ ] **Step 4: Run the tests**

Run: `PYTHONPATH=src python -m pytest tests/coach_adapters/test_continuity_analyzer.py -v`
Expected: PASS. If the `train_kind`/`train_type` columns differ, adjust the race-recency query to the real race-flag column (confirm in `db.py` schema) and re-run.

- [ ] **Step 5: Add volume-signal tests**

```python
def test_volume_trend_and_aerobic_weeks(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    from stride_core.db import Database
    db = Database(db_path=tmp_path / "coros.db")
    c = db._conn
    # 6 weekly long runs ~40km/wk rising, all running code 100, km-valued.
    base = ["2026-04-27", "2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"]
    for i, d in enumerate(base):
        c.execute("INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
                  "VALUES (?, 100, ?, ?, 3600)", (f"r{i}", d + "T08:00:00+00:00", 38.0 + i))
    c.commit()
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None,
                             as_of=__import__("datetime").date(2026, 6, 7))
    assert sig.recent_aerobic_weeks >= 5
    assert sig.recent_volume_trend == "rising"
    assert sig.recent_longest_run_km is not None
```

Run: `PYTHONPATH=src python -m pytest tests/coach_adapters/test_continuity_analyzer.py -v`
Expected: PASS

- [ ] **Step 6: import-linter + commit**

Run: `PYTHONPATH=src lint-imports`
Expected: contracts kept (analyzer is adapter layer; imports `coach.schemas` + `stride_core` only).

```bash
git add src/stride_server/coach_adapters/continuity_analyzer.py tests/coach_adapters/test_continuity_analyzer.py
git commit -m "feat(coach): deterministic continuity_analyzer (Stage-0 signals)"
```

---

## Task 5: Wire continuity + injuries into `load_master_context` and the prompt

**Files:**
- Modify: `src/stride_server/coach_adapters/master_plan_adapter.py` (`load_master_context`)
- Modify: `src/stride_server/master_plan_generator.py` (`_build_system_prompt`)
- Test: `tests/stride_server/test_master_plan_generator.py`

- [ ] **Step 1: Write failing test for prompt inclusion**

```python
class TestPromptIncludesContinuity:
    def test_system_prompt_mentions_continuity_and_injuries(self):
        from stride_server.master_plan_generator import _build_system_prompt
        from coach.schemas import ContinuitySignals
        sig = ContinuitySignals(macro_cycle="summer", current_chronic_load=64.1,
                                post_race_recovery_status="recovered", injuries=["achilles"])
        prompt = _build_system_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"},
            profile=None, history_summary="hist", fitness_state={"summary": "CTL 64"},
            today="2026-06-10", continuity=sig,
        )
        assert "achilles" in prompt
        assert "summer" in prompt or "夏训" in prompt
        assert "recovered" in prompt or "已恢复" in prompt
```

- [ ] **Step 2: Run to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py::TestPromptIncludesContinuity -v`
Expected: FAIL — `_build_system_prompt` has no `continuity` parameter.

- [ ] **Step 3: Add `continuity` param to `_build_system_prompt`**

Change the signature to accept `continuity: "ContinuitySignals | None" = None` and inject a block before the rules section:

```python
    continuity_block = ""
    if continuity is not None:
        c = continuity
        inj = "、".join(c.injuries) if c.injuries else "无"
        continuity_block = f"""
延续性信号（确定性，来自训练数据/结构化 profile）：
- macro_cycle: {c.macro_cycle}；{c.season_context}
- 距上场比赛: {c.days_since_last_race} 天；赛后状态: {c.post_race_recovery_status}
- 近期有氧周数: {c.recent_aerobic_weeks}；周量趋势: {c.recent_volume_trend}；最近最长跑: {c.recent_longest_run_km} km
- 当前 STRIDE CTL(chronic): {c.current_chronic_load}；form 区: {c.current_form_zone}
- 断训回归: {c.return_from_layoff}
- 伤病（软约束，自行权衡，勿机械禁课）: {inj}

请据此调整周期结构：已恢复且距赛久则不排开头恢复期；已有多周有氧则缩短 base；断训回归则延长 base、放缓 ramp；夏训块可插速度周期。
"""
    # ... insert {continuity_block} into the returned prompt string before 规则:
```

- [ ] **Step 4: Wire the analyzer into `load_master_context`**

In `master_plan_adapter.py`, after the existing history/fitness queries, add:

```python
    from datetime import date as _date_cls
    from .continuity_analyzer import analyze_continuity

    payload = state.get("input_payload") or {}
    goal = payload.get("goal") or {}
    profile = payload.get("profile")
    try:
        from stride_core.db import Database
        db = Database(user=user_id)
        from stride_core.timefmt import today_shanghai
        continuity = analyze_continuity(db, goal=goal, profile=profile, as_of=today_shanghai())
    except Exception as exc:  # noqa: BLE001
        logger.warning("load_master_context: continuity failed: %s", exc)
        continuity = None

    return {
        "history": history,
        "history_summary": history_summary,
        "fitness_state": fitness_state,
        "continuity": continuity.model_dump() if continuity is not None else None,
    }
```

And in `generate_master_plan` (same file), read it back and pass to the prompt:

```python
    continuity_raw = ctx.get("continuity")
    continuity = None
    if continuity_raw:
        from coach.schemas import ContinuitySignals
        continuity = ContinuitySignals.model_validate(continuity_raw)
    system_prompt = _build_system_prompt(
        goal, profile, history_summary, fitness_state, today, continuity=continuity
    )
```

- [ ] **Step 5: Run tests**

Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py -q`
Expected: all pass.

- [ ] **Step 6: import-linter + commit**

Run: `PYTHONPATH=src lint-imports`
Expected: contracts kept.

```bash
git add src/stride_server/coach_adapters/master_plan_adapter.py src/stride_server/master_plan_generator.py tests/stride_server/test_master_plan_generator.py
git commit -m "feat(coach): inject continuity signals + injuries into master-plan context and prompt"
```

---

## Task 6: End-to-end smoke against the real DB (manual verification)

- [ ] **Step 1: Run the local generation script and confirm enriched context**

Run:
```
$env:COACH_DEBUG="1"; $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_master_plan.py
```
Expected in the LLM REQUEST dump: the new 延续性信号 block with `macro_cycle: summer`, a non-zero `current chronic ~60+` (NOT 120), recovery status, and any injuries from the profile. Confirm the generated plan no longer opens with an unwarranted "消除过度疲劳" de-load if the athlete is actually in 维持期.

- [ ] **Step 2: Commit any prompt tweaks discovered during the smoke**

```bash
git add -A && git commit -m "chore(coach): smoke-tune Stage-0 continuity prompt"
```

---

## Self-Review

- **Spec coverage:** §3 load unification → Tasks 1–2. §4 continuity signals → Tasks 3–4 (race recency, recovery, volume, longest run, form zone, chronic, layoff, macro_cycle, season, injuries; `recent_quality_sessions_per_week` deferred with explicit note). Injury injection → Tasks 4–5. §3 backfill → Task 2 (`_ensure_training_load_current`).
- **Deferred-with-note (not placeholders):** `recent_quality_sessions_per_week` populated in a follow-up once an intensity marker is confirmed; race-flag column to confirm at execution; form-zone single-source consolidation (spec §4 follow-up).
- **Type consistency:** `ContinuitySignals` field names match across schema (Task 3), analyzer construction (Task 4), and prompt builder (Task 5). `_ensure_training_load_current(db, as_of=...)` defined in Task 2, monkeypatched in its own test.
- **Out of this plan (later plans):** PhaseType/Milestone/schema changes, structure_planner, specialists, orchestrator, 3-tier rule_filter, eval harness.
