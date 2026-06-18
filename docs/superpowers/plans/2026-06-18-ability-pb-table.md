# Ability Page Personal Bests Table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a six-distance (1K/3K/5K/10K/HM/FM) personal-bests table to the bottom of the `/ability` page.

**Architecture:** Reuse the existing segment-scan PB detector. Add 1K/3K as a *display-only* distance set so the `/pbs` route can opt into six distances while the ability/VDOT model and coach tool keep their narrow four-distance set unchanged. Frontend adds a `fetchPbs` wrapper and an `AbilityPBTable` component wired into `AbilityPage`.

**Tech Stack:** Python (FastAPI, pytest), React + TypeScript (Vite, Vitest), Tailwind CSS.

**Design doc:** `docs/superpowers/specs/2026-06-18-ability-pb-table-design.md`

---

## Prerequisites (one-time, this worktree)

This worktree has no installed dependencies yet. Before running any test/build command below:

```bash
# Backend deps (from repo root) — installs fastapi, pytest, etc. per pyproject
pip install -e .
# Frontend deps
cd frontend && npm install && cd ..
```

Pytest is pre-configured (`pyproject.toml`: `pythonpath = ["src"]`, `testpaths = ["tests"]`), so tests run with a bare `python3 -m pytest …` from the repo root.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/stride_core/pb_records.py` | PB constants + detector. Add display-only 1K/3K set; parametrize detector by distance set. | Modify |
| `src/stride_server/routes/pbs.py` | `/pbs` route opts into the wide display set. | Modify |
| `tests/stride_server/test_pbs.py` | Route + detector tests for 1K/3K display vs narrow default. | Modify |
| `frontend/src/lib/fmt.ts` | Add `fmtClock` (M:SS under 1h, H:MM:SS at/over 1h). | Modify |
| `frontend/src/lib/__tests__/fmt.test.ts` | Unit tests for `fmtClock`. | Create |
| `frontend/src/api.ts` | `PBEntry`/`PBsResponse` types + `fetchPbs`. | Modify |
| `frontend/src/components/AbilityPBTable.tsx` | Renders the six-row PB table. | Create |
| `frontend/src/pages/AbilityPage.tsx` | Fetch PBs + render table at bottom. | Modify |

---

## Task 1: Parametrize the PB detector with a display-only distance set

**Files:**
- Modify: `src/stride_core/pb_records.py`
- Test: `tests/stride_server/test_pbs.py`

- [ ] **Step 1: Write the failing tests**

Append these two tests to `tests/stride_server/test_pbs.py`. The first is route-level (wide set via `/pbs`); the second proves the narrow default is unchanged. Both reuse the existing `app_client`, `_make_db`, `_auth`, and `SEGMENT_FIXTURE` helpers already in that file.

```python
def _seed_segment_fixture(db) -> dict:
    """Insert the 13.36 km segment-PB fixture activity + timeseries. Returns the
    activity dict. The run is long enough to contain 1K/3K/5K best efforts."""
    data = json.loads(SEGMENT_FIXTURE.read_text())
    activity = data["activity"]
    db._conn.execute(
        """INSERT INTO activities
           (label_id, sport_type, date, distance_m, duration_s, avg_hr,
            max_hr, train_kind, train_type, pauses, provider)
           VALUES (:label_id, :sport_type, :date, :distance_m, :duration_s,
                   :avg_hr, :max_hr, :train_kind, :train_type, :pauses,
                   :provider)""",
        activity,
    )
    for point in data["timeseries"]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
            (activity["label_id"], point["timestamp"], point["distance"]),
        )
    db._conn.commit()
    return activity


def test_pbs_includes_1k_and_3k_segments(app_client):
    """The /pbs route uses the wide display set, so a long run yields 1K and 3K
    best efforts ordered before 5K, with strictly increasing times."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    _seed_segment_fixture(db)
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pbs = resp.json()["pbs"]
    pb_map = {p["distance"]: p for p in pbs}

    assert "1K" in pb_map
    assert "3K" in pb_map
    assert "5K" in pb_map
    # Absolute fastest-segment durations must increase with distance.
    assert pb_map["1K"]["pb_time_sec"] < pb_map["3K"]["pb_time_sec"]
    assert pb_map["3K"]["pb_time_sec"] < pb_map["5K"]["pb_time_sec"]
    # Response order follows DISTANCE_ORDER: 1K, 3K come before 5K.
    order = [p["distance"] for p in pbs]
    assert order.index("1K") < order.index("3K") < order.index("5K")


def test_detect_personal_bests_default_excludes_1k_3k(app_client):
    """The default (narrow) detector must NOT emit 1K/3K — this is what the
    ability/VDOT model and coach tool consume. The wide set opts in explicitly."""
    from stride_core.pb_records import (
        CANONICAL_RACE_DISTANCES,
        PB_DISPLAY_DISTANCES,
        detect_personal_bests,
    )

    _, _, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    _seed_segment_fixture(db)

    narrow = detect_personal_bests(db)  # default
    assert "1K" not in narrow
    assert "3K" not in narrow
    assert set(narrow).issubset({"5K", "10K", "HM", "FM"})

    wide = detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES)
    assert "1K" in wide
    assert "3K" in wide
    db.close()

    # Guard: the display set is the canonical four plus 1K/3K.
    assert set(PB_DISPLAY_DISTANCES) == set(CANONICAL_RACE_DISTANCES) | {"1K", "3K"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m pytest tests/stride_server/test_pbs.py::test_pbs_includes_1k_and_3k_segments tests/stride_server/test_pbs.py::test_detect_personal_bests_default_excludes_1k_3k -v`
Expected: FAIL — `ImportError: cannot import name 'PB_DISPLAY_DISTANCES'` (and `1K`/`3K` absent).

- [ ] **Step 3: Add the display constants and 1K/3K metadata**

In `src/stride_core/pb_records.py`, replace the constants block (lines 19–44) so `CANONICAL_RACE_DISTANCES` stays narrow and a new wide set is added:

```python
CANONICAL_RACE_DISTANCES: dict[str, float] = {
    "5K": 5000.0,
    "10K": 10000.0,
    "half": 21097.5,
    "full": 42195.0,
}

# Display-only superset used by the /pbs route. 1K/3K are intentionally NOT in
# CANONICAL_RACE_DISTANCES: the Daniels VDOT formula has no short-distance guard
# (see compute_pb_vdot_for_segment), so feeding 1K/3K into the ability model
# would inflate VO2max. Keep them on the display path only.
PB_DISPLAY_DISTANCES: dict[str, float] = {
    "1K": 1000.0,
    "3K": 3000.0,
    **CANONICAL_RACE_DISTANCES,
}

DISTANCE_ORDER = ["1K", "3K", "5K", "10K", "HM", "FM"]

_DISPLAY_DISTANCE_BY_RACE_TYPE = {
    "1K": "1K",
    "3K": "3K",
    "5K": "5K",
    "10K": "10K",
    "half": "HM",
    "full": "FM",
}

_RACE_TYPE_BY_DISPLAY_DISTANCE = {
    display: race_type for race_type, display in _DISPLAY_DISTANCE_BY_RACE_TYPE.items()
}

ACTIVITY_DISTANCE_TOLERANCE_M: dict[str, tuple[float, float]] = {
    "1K": (950.0, 1050.0),
    "3K": (2900.0, 3100.0),
    "5K": (4800.0, 5200.0),
    "10K": (9800.0, 10200.0),
    "HM": (20800.0, 21300.0),
    "FM": (41800.0, 42400.0),
}
```

- [ ] **Step 4: Parametrize `detect_personal_bests` by distance set**

In `src/stride_core/pb_records.py`, change the `detect_personal_bests` signature (line 89) and the call inside it (line 112):

```python
def detect_personal_bests(
    db: Any, *, distances: dict[str, float] = CANONICAL_RACE_DISTANCES,
) -> dict[str, dict[str, Any]]:
```

and:

```python
    for row in rows:
        candidates = best_effort_candidates_for_activity(db, row, distances=distances)
```

- [ ] **Step 5: Parametrize `best_effort_candidates_for_activity` and filter the activity fallback**

In `src/stride_core/pb_records.py`, change the signature (lines 125–130), the segment-detector call (line 150–152), and the fallback call (line 166):

```python
def best_effort_candidates_for_activity(
    db: Any,
    activity: Mapping[str, Any],
    *,
    include_activity_fallback: bool = True,
    distances: dict[str, float] = CANONICAL_RACE_DISTANCES,
) -> list[BestEffortCandidate]:
```

segment call:

```python
            for race_type, segment in best_distance_candidates(
                ts_norm, pauses, distances,
            ).items():
```

fallback call:

```python
    if include_activity_fallback:
        allowed = {_DISPLAY_DISTANCE_BY_RACE_TYPE[rt] for rt in distances}
        out.extend(_activity_level_candidates(activity, date_disp, label_id, allowed))
```

- [ ] **Step 6: Filter `_activity_level_candidates` to the allowed display distances**

In `src/stride_core/pb_records.py`, change `_activity_level_candidates` (lines 245–256) to accept and honor the allowed set:

```python
def _activity_level_candidates(
    activity: Mapping[str, Any],
    date_disp: str,
    label_id: str,
    allowed_display: set[str],
) -> list[BestEffortCandidate]:
    distance_raw = _get(activity, "distance_m") or 0.0
    duration_s = _get(activity, "duration_s") or 0.0
    if duration_s <= 0:
        return []
    distance_m = _activity_distance_to_meters(float(distance_raw))
    out: list[BestEffortCandidate] = []
    for display, (low, high) in ACTIVITY_DISTANCE_TOLERANCE_M.items():
        if display not in allowed_display:
            continue
        if not (low <= distance_m <= high):
            continue
```

(The remainder of the loop body and function are unchanged.)

- [ ] **Step 7: Export the new constant**

In `src/stride_core/pb_records.py`, add `"PB_DISPLAY_DISTANCES"` to the `__all__` list (lines 299–308):

```python
__all__ = [
    "BestEffortCandidate",
    "ACTIVITY_DISTANCE_TOLERANCE_M",
    "CANONICAL_RACE_DISTANCES",
    "PB_DISPLAY_DISTANCES",
    "DISTANCE_ORDER",
    "best_effort_candidates_for_activity",
    "detect_personal_bests",
    "normalize_timeseries_units",
    "parse_pauses",
]
```

- [ ] **Step 8: Update the route to pass the wide set**

In `src/stride_server/routes/pbs.py`, update the import (lines 11–16) to add `PB_DISPLAY_DISTANCES`, the `detect_personal_bests` call (line 109), and the route docstring (line 106):

```python
from stride_core.pb_records import (
    ACTIVITY_DISTANCE_TOLERANCE_M,
    DISTANCE_ORDER,
    PB_DISPLAY_DISTANCES,
    best_effort_candidates_for_activity,
    detect_personal_bests,
)
```

```python
    """Return best-effort PBs for 1K, 3K, 5K, 10K, HM, and FM."""
    db = get_db(user)
    try:
        pb_map = detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES)
    finally:
        db.close()
```

- [ ] **Step 9: Run the new tests to verify they pass**

Run: `python3 -m pytest tests/stride_server/test_pbs.py::test_pbs_includes_1k_and_3k_segments tests/stride_server/test_pbs.py::test_detect_personal_bests_default_excludes_1k_3k -v`
Expected: PASS (both).

- [ ] **Step 10: Run the full PB suite to confirm no regressions**

Run: `python3 -m pytest tests/stride_server/test_pbs.py -v`
Expected: PASS — all original tests still green (the four 5K/10K activities don't match 1K/3K tolerance; the segment fixture gains 1K/3K entries but existing assertions only check 5K).

- [ ] **Step 11: Confirm the ability/coach import path is untouched**

Run: `python3 -m pytest tests/ -k "ability or coach" -q`
Expected: PASS (no behavior change — they use the narrow default).

- [ ] **Step 12: Commit**

```bash
git add src/stride_core/pb_records.py src/stride_server/routes/pbs.py tests/stride_server/test_pbs.py
git commit -m "feat(pbs): add display-only 1K/3K distances to /pbs detector"
```

---

## Task 2: Add `fmtClock` time formatter

**Files:**
- Modify: `frontend/src/lib/fmt.ts`
- Test: `frontend/src/lib/__tests__/fmt.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/__tests__/fmt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { fmtClock } from '../fmt'

describe('fmtClock', () => {
  it('formats sub-hour times as M:SS', () => {
    expect(fmtClock(210)).toBe('3:30')      // 1K PB
    expect(fmtClock(1290)).toBe('21:30')    // 5K PB
    expect(fmtClock(9)).toBe('0:09')
  })

  it('formats hour+ times as H:MM:SS', () => {
    expect(fmtClock(3600)).toBe('1:00:00')
    expect(fmtClock(7530)).toBe('2:05:30')  // HM PB
  })

  it('returns em dash for empty/invalid input', () => {
    expect(fmtClock(null)).toBe('—')
    expect(fmtClock(undefined)).toBe('—')
    expect(fmtClock(0)).toBe('—')
    expect(fmtClock(-5)).toBe('—')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/fmt.test.ts`
Expected: FAIL — `fmtClock` is not exported from `../fmt`.

- [ ] **Step 3: Implement `fmtClock`**

Append to `frontend/src/lib/fmt.ts`:

```typescript
/** Clock format: M:SS under an hour, H:MM:SS at/over an hour. '—' when empty. */
export function fmtClock(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/fmt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/fmt.ts frontend/src/lib/__tests__/fmt.test.ts
git commit -m "feat(fmt): add fmtClock adaptive time formatter"
```

---

## Task 3: Add `fetchPbs` API wrapper and types

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Add the response types**

In `frontend/src/api.ts`, immediately before the `fetchAbilityCurrent` function (line 920), add:

```typescript
export interface PBHistoryPoint {
  date: string
  best_so_far_sec: number
  label_id: string | null
  source: string | null
  segment_start_s: number | null
  segment_end_s: number | null
}

export interface PBEntry {
  distance: string            // "1K" | "3K" | "5K" | "10K" | "HM" | "FM"
  race_type: string | null
  pb_time_sec: number
  achieved_at: string         // Shanghai YYYY-MM-DD
  label_id: string
  source: string | null
  segment_start_s: number | null
  segment_end_s: number | null
  history: PBHistoryPoint[]
}

export interface PBsResponse {
  user_id: string
  computed_at: string
  pbs: PBEntry[]
}

export function fetchPbs(user: string) {
  return fetchJSON<PBsResponse>(`/${user}/pbs`)
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(api): add fetchPbs wrapper and PB types"
```

---

## Task 4: Build the `AbilityPBTable` component

**Files:**
- Create: `frontend/src/components/AbilityPBTable.tsx`

- [ ] **Step 1: Create the component**

Create `frontend/src/components/AbilityPBTable.tsx`:

```tsx
import type { PBEntry } from '../api'
import { fmtClock, fmtPace } from '../lib/fmt'

// Fixed display order + per-distance metadata. Mirrors DISTANCE_ORDER on the
// backend so every distance always renders a row (— when no record exists).
const PB_ROWS: { code: string; label: string; km: number }[] = [
  { code: '1K', label: '1K', km: 1 },
  { code: '3K', label: '3K', km: 3 },
  { code: '5K', label: '5K', km: 5 },
  { code: '10K', label: '10K', km: 10 },
  { code: 'HM', label: '半马', km: 21.0975 },
  { code: 'FM', label: '全马', km: 42.195 },
]

export default function AbilityPBTable({ pbs }: { pbs: PBEntry[] }) {
  const byCode = new Map(pbs.map((p) => [p.distance, p]))

  return (
    <div>
      <p className="text-xs font-mono text-text-muted tracking-widest mb-3 uppercase">
        个人最佳 · Personal Bests
      </p>
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-border">
                <th className="text-left py-2 px-3 text-xs font-mono text-text-muted tracking-wider">距离</th>
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">成绩</th>
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">配速</th>
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">日期</th>
              </tr>
            </thead>
            <tbody>
              {PB_ROWS.map((row) => {
                const entry = byCode.get(row.code)
                return (
                  <tr
                    key={row.code}
                    className="border-b border-border-subtle hover:bg-bg-card-hover transition-colors"
                  >
                    <td className="py-2.5 px-3 font-mono text-text-secondary">{row.label}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-medium text-accent-green">
                      {entry ? fmtClock(entry.pb_time_sec) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-text-secondary">
                      {entry ? fmtPace(entry.pb_time_sec, row.km) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-text-muted text-xs">
                      {entry ? entry.achieved_at : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
```

(`achieved_at` is already a Shanghai `YYYY-MM-DD` from the backend `_normalise_date`, so it is displayed directly — no further timezone conversion needed.)

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AbilityPBTable.tsx
git commit -m "feat(ability): add AbilityPBTable component"
```

---

## Task 5: Wire the table into `AbilityPage`

**Files:**
- Modify: `frontend/src/pages/AbilityPage.tsx`

- [ ] **Step 1: Import the component, types, and fetcher**

In `frontend/src/pages/AbilityPage.tsx`, update the api import (lines 3–7) and add the component import (after line 11):

```tsx
import {
  fetchAbilityCurrent, fetchAbilityHistory, fetchAbilityWeights, fetchPbs,
  triggerAbilityBackfill,
  type AbilityCurrent, type AbilityHistoryPoint, type PBEntry, type RaceEstimates,
} from '../api'
```

```tsx
import AbilityPBTable from '../components/AbilityPBTable'
```

- [ ] **Step 2: Add PB state**

In `frontend/src/pages/AbilityPage.tsx`, after the `history` state (line 20), add:

```tsx
  const [pbs, setPbs] = useState<PBEntry[]>([])
```

- [ ] **Step 3: Fetch PBs alongside the existing loads**

In `frontend/src/pages/AbilityPage.tsx`, extend the `Promise.all` (lines 45–52). Add `fetchPbs` to the array with a `.catch(() => ({ pbs: [] }))` guard so a PB failure never blocks the page, and capture it in the destructure:

```tsx
    Promise.all([
      fetchAbilityCurrent(user),
      fetchAbilityHistory(user, days),
      fetchAbilityWeights(user).catch(() => null),
      fetchPbs(user).catch(() => ({ pbs: [] as PBEntry[] })),
    ])
      .then(async ([cur, hist, w, pbResp]) => {
        setCurrent(cur)
        setWeights(w?.l4_weights ?? null)
        setPbs(pbResp.pbs)
```

(The rest of the `.then` body — the `hist.length === 0` backfill branch and `else setHistory(hist)` — is unchanged.)

- [ ] **Step 4: Render the table at the bottom**

In `frontend/src/pages/AbilityPage.tsx`, after the history-chart `div` (closes at line 146) and before the closing `</div>` of the `animate-fade-in` block (line 147), add:

```tsx
          <div className="mb-6">
            <AbilityPBTable pbs={pbs} />
          </div>
```

- [ ] **Step 5: Typecheck and build**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AbilityPage.tsx
git commit -m "feat(ability): render personal-bests table on ability page"
```

---

## Task 6: Full verification

- [ ] **Step 1: Backend — full PB + ability + coach suites**

Run: `python3 -m pytest tests/stride_server/test_pbs.py tests/ -k "pbs or ability or coach" -q`
Expected: PASS.

- [ ] **Step 2: Frontend — lint, typecheck, unit tests, build**

Run: `cd frontend && npm run lint && npx tsc -b && npx vitest run && npm run build`
Expected: all pass.

- [ ] **Step 3: Real-backend smoke (no mocked fetch / no fake JWT)**

Per project rule (verify against a real backend with a real account and real data — never mock fetch or fake a JWT):
- Start the backend, log in via the real account from `~/running/.credentials.local`, and open `/ability`.
- Confirm the Personal Bests table renders at the bottom with six rows (1K/3K/5K/10K/半马/全马), real times/paces/dates for distances you've run, and `—` for any you haven't.
- Confirm the rest of the page (hero, triptych, radar, history chart) is unchanged.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(ability): verify personal-bests table end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** display set + 1K/3K metadata (Task 1 Steps 3); detector parametrization keeping ability/coach narrow (Task 1 Steps 4–6, verified Steps 2/9/11); route opt-in (Task 1 Step 8); `fetchPbs` + types (Task 3); `AbilityPBTable` with Distance·Time·Pace·Date and six fixed rows + `—` (Task 4); page wiring with non-blocking fetch (Task 5); tests for wide-vs-narrow (Task 1) and `fmtClock` (Task 2). All spec sections mapped.
- **Type consistency:** `PB_DISPLAY_DISTANCES`, `detect_personal_bests(db, *, distances=…)`, `best_effort_candidates_for_activity(..., distances=…)`, `_activity_level_candidates(..., allowed_display)`, `PBEntry`, `fetchPbs`, `fmtClock`, `AbilityPBTable` props (`{ pbs: PBEntry[] }`) are used consistently across tasks.
- **No placeholders:** every code step shows complete code.
