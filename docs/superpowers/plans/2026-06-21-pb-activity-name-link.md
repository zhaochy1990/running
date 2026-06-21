# PB Activity Name + Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each PB's source-activity name as a link to that activity's detail page in the `/ability` Personal Bests table.

**Architecture:** Thread the already-queried `name` column through `BestEffortCandidate` → `pb_entry()` → the `PBEntry` Pydantic model → the frontend `PBEntry` type, then add a 运动 column to `AbilityPBTable` that renders the name as a react-router `<Link to={/activity/${label_id}}>`.

**Tech Stack:** Python (FastAPI, pytest), React + TypeScript (Vite, Vitest, react-router-dom).

**Spec:** `docs/superpowers/specs/2026-06-21-pb-activity-name-link-design.md`

**Env note:** This worktree uses a venv — run backend tests as `.venv/bin/python -m pytest ...`; frontend `node_modules` is installed (`npx`/`npm` on PATH).

---

## Task 1: Thread activity `name` through the backend PB pipeline

**Files:**
- Modify: `src/stride_core/pb_records.py`
- Modify: `src/stride_server/routes/pbs.py`
- Test: `tests/stride_server/test_pbs.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/stride_server/test_pbs.py` (reuses existing `app_client`, `_make_db`, `_auth`, `USER_UUID`):

```python
def test_pbs_includes_activity_name(app_client):
    """Each PB carries the source activity's name; a nameless activity → name=None.
    Exercises the activity-level fallback path (no timeseries)."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    db._conn.execute(
        "INSERT INTO activities (label_id, name, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("named_5k", "晨跑 5公里", 100, "2025-05-01", 5000.0, 1300.0),
    )
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        ("unnamed_10k", 100, "2025-05-02", 10000.0, 2600.0),
    )
    db._conn.commit()
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pb_map = {p["distance"]: p for p in resp.json()["pbs"]}

    assert pb_map["5K"]["name"] == "晨跑 5公里"
    assert pb_map["5K"]["label_id"] == "named_5k"
    assert pb_map["10K"]["name"] is None
```

Also add one assertion to the existing `test_pbs_includes_1k_and_3k_segments` (after `pb_map = {...}`) to confirm the **segment** construction site emits the field too:

```python
    assert "name" in pb_map["5K"]  # segment path threads name through (None for this fixture)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest "tests/stride_server/test_pbs.py::test_pbs_includes_activity_name" "tests/stride_server/test_pbs.py::test_pbs_includes_1k_and_3k_segments" -v`
Expected: FAIL — `test_pbs_includes_activity_name` `KeyError: 'name'` (or assert mismatch); the segment test fails on the new `"name" in pb_map["5K"]` assertion.

- [ ] **Step 3: Add `name` to the `BestEffortCandidate` dataclass**

In `src/stride_core/pb_records.py`, add a `name` field with a default (kept after the required fields, before the segment defaults):

```python
@dataclass(frozen=True)
class BestEffortCandidate:
    distance: str
    race_type: str
    distance_m: float
    duration_s: float
    achieved_at: str
    label_id: str
    source: str
    name: str | None = None
    segment_start_s: float | None = None
    segment_end_s: float | None = None
```

- [ ] **Step 4: Emit `name` from `pb_entry()`**

In the same file, add `"name"` to the `pb_entry()` dict (leave `history_point()` unchanged):

```python
    def pb_entry(self, history: list[dict[str, Any]]) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "distance": self.distance,
            "race_type": self.race_type,
            "pb_time_sec": self.duration_s,
            "achieved_at": self.achieved_at,
            "label_id": self.label_id,
            "source": self.source,
            "name": self.name,
            "history": history,
        }
```

- [ ] **Step 5: Populate `name` at the segment construction site**

In `best_effort_candidates_for_activity`, the segment-path `BestEffortCandidate(...)` gains `name`:

```python
                out.append(BestEffortCandidate(
                    distance=_DISPLAY_DISTANCE_BY_RACE_TYPE[race_type],
                    race_type=race_type,
                    distance_m=segment.distance_m,
                    duration_s=float(segment.duration_s),
                    achieved_at=date_disp,
                    label_id=label_id,
                    source="segment",
                    name=_get(activity, "name"),
                    segment_start_s=float(segment.start_s),
                    segment_end_s=float(segment.end_s),
                ))
```

- [ ] **Step 6: Populate `name` at the activity-fallback construction site**

In `_activity_level_candidates`, the `BestEffortCandidate(...)` gains `name`:

```python
        out.append(BestEffortCandidate(
            distance=display,
            race_type=race_type,
            distance_m=PB_DISPLAY_DISTANCES[race_type],
            duration_s=float(duration_s),
            achieved_at=date_disp,
            label_id=label_id,
            source="activity",
            name=_get(activity, "name"),
        ))
```

- [ ] **Step 7: Add `name` to the `PBEntry` Pydantic model**

In `src/stride_server/routes/pbs.py`, add the field to `PBEntry`:

```python
class PBEntry(BaseModel):
    distance: str
    race_type: str | None = None
    pb_time_sec: float
    achieved_at: str
    label_id: str
    source: str | None = None
    name: str | None = None
    segment_start_s: float | None = None
    segment_end_s: float | None = None
    history: list[PBHistoryPoint]
```

- [ ] **Step 8: Run the tests — expect PASS**

Run: `.venv/bin/python -m pytest "tests/stride_server/test_pbs.py::test_pbs_includes_activity_name" "tests/stride_server/test_pbs.py::test_pbs_includes_1k_and_3k_segments" -v`
Expected: PASS (both).

- [ ] **Step 9: Run the full PB suite — expect no regressions**

Run: `.venv/bin/python -m pytest tests/stride_server/test_pbs.py -q`
Expected: PASS (all).

- [ ] **Step 10: Commit**

```bash
git add src/stride_core/pb_records.py src/stride_server/routes/pbs.py tests/stride_server/test_pbs.py
git commit -m "feat(pbs): include source activity name in PB entries"
```

---

## Task 2: Render the activity name as a link in the PB table

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/components/AbilityPBTable.tsx`

- [ ] **Step 1: Add `name` to the frontend `PBEntry` type**

In `frontend/src/api.ts`, add a `name` field to the `PBEntry` interface (place it after `label_id`):

```typescript
export interface PBEntry {
  distance: string            // "1K" | "3K" | "5K" | "10K" | "HM" | "FM"
  race_type: string | null
  pb_time_sec: number
  achieved_at: string         // Shanghai YYYY-MM-DD
  label_id: string
  name: string | null
  source: string | null
  segment_start_s: number | null
  segment_end_s: number | null
  history: PBHistoryPoint[]
}
```

- [ ] **Step 2: Import `Link` and add the 运动 column**

In `frontend/src/components/AbilityPBTable.tsx`:

Add the router import at the top (the file currently imports only from `../api` and `../lib/fmt`):

```tsx
import { Link } from 'react-router-dom'
```

Add a header cell after the 日期 `<th>`:

```tsx
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">日期</th>
                <th className="text-left py-2 px-3 text-xs font-mono text-text-muted tracking-wider">运动</th>
```

Add a body cell after the 日期 `<td>` (inside the `PB_ROWS.map` row, after the date cell):

```tsx
                    <td className="py-2.5 px-3 text-right font-mono text-text-muted text-xs">
                      {entry ? entry.achieved_at : '—'}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs">
                      {entry ? (
                        <Link
                          to={`/activity/${entry.label_id}`}
                          title={entry.name ?? undefined}
                          className="text-accent-green hover:opacity-75 transition-opacity"
                        >
                          {entry.name || '查看'}
                        </Link>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
```

- [ ] **Step 3: Typecheck and build**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Lint the changed files (no new lint errors)**

Run: `cd frontend && npx eslint src/api.ts src/components/AbilityPBTable.tsx`
Expected: clean (exit 0).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/components/AbilityPBTable.tsx
git commit -m "feat(ability): link each PB to its source activity by name"
```

---

## Task 3: Verification

- [ ] **Step 1: Backend regression**

Run: `.venv/bin/python -m pytest tests/stride_server/test_pbs.py tests/ -k "pbs or ability or coach" -q`
Expected: PASS.

- [ ] **Step 2: Frontend full check**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run build`
Expected: all pass.

- [ ] **Step 3: Real-data check (no mocks/fake JWT)**

Run the real `/pbs` HTTP route against the real zhaochaoyi DB (pattern from the prior feature: real FastAPI app + RS256 token verified by `stride_server.bearer`, `USER_DATA_DIR` → `/home/zhaochy/running/data`). Confirm each returned `PBEntry` now has a non-null `name` and a valid `label_id`, and spot-check that `/activity/{label_id}` is a real activity id.

---

## Self-Review Notes

- **Spec coverage:** name threaded through dataclass (Task 1 Steps 3–4), both construction sites (Steps 5–6), Pydantic (Step 7), frontend type (Task 2 Step 1); 运动 column with `<Link to=/activity/${label_id}>`, `查看` fallback, `—` for empty rows (Task 2 Step 2). Tests cover named + null name on the fallback path and the field's presence on the segment path (Task 1 Step 1).
- **Type consistency:** `name: str | None` (Python) / `name: string | null` (TS); `BestEffortCandidate.name`, `PBEntry.name`, `entry.name` consistent across tasks.
- **No placeholders:** every code step shows complete code.
