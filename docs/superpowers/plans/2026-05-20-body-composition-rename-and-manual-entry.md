# Body Composition Rename + Manual Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the InBody-named body-composition module to brand-neutral `body-composition` and add a manual data entry modal form on `BodyCompositionPage`. Ships as one PR with one squash merge commit.

**Architecture:** Brand-neutral identifiers replace `inbody_*` across API routes, DB tables, frontend types, CLI, coach tool registry, and structured-data files. Existing `coros.db` instances auto-migrate via idempotent `ALTER TABLE RENAME` in `_migrate()`. Brand-neutral identifiers are flipped atomically per layer to keep tests green between commits. Manual entry uses the existing `POST /api/{user}/body-composition` upsert endpoint via a new modal component (`BodyCompositionEntryModal.tsx`).

**Tech Stack:** Python 3.11+ (FastAPI / SQLite / Click), React + Vite + TypeScript, vitest, pytest, LangGraph (coach layer).

**Reference spec:** [`docs/superpowers/specs/2026-05-20-body-composition-rename-and-manual-entry-design.md`](../specs/2026-05-20-body-composition-rename-and-manual-entry-design.md)

---

## Task 1: DB layer rename + migration logic (TDD)

**Files:**
- Modify: `src/stride_core/db.py` (SCHEMA constant, `_migrate()`, 6 method renames + SQL string inside)
- Modify: `src/stride_core/state_stores.py` (method signature renames on store interface)
- Modify: `src/stride_core/models.py` (rename `INBODY_SEGMENTS` constant; tweak `BodyCompositionScan` docstring)
- Test: rename `tests/test_inbody_db.py` → `tests/test_body_composition_db.py` (add migration test + method-ref updates)
- Test: rename `tests/test_inbody_models.py` → `tests/test_body_composition_models.py`

- [ ] **Step 1.1: Write failing migration test in a new file**

`git mv tests/test_inbody_db.py tests/test_body_composition_db.py` — then open and replace top docstring + method refs at the end of this task. For now, ADD this test at the bottom of the moved file (still has old name in step 1.1; we rename file in 1.6):

```python
def test_migration_renames_legacy_tables(tmp_path):
    """Existing inbody_scan / inbody_segment tables auto-rename on Database() open."""
    import sqlite3
    from stride_core.db import Database

    db_path = tmp_path / "coros.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE inbody_scan (
            scan_date TEXT PRIMARY KEY,
            jpg_path TEXT,
            weight_kg REAL NOT NULL,
            body_fat_pct REAL NOT NULL,
            smm_kg REAL NOT NULL,
            fat_mass_kg REAL NOT NULL,
            visceral_fat_level INTEGER NOT NULL,
            bmr_kcal INTEGER,
            protein_kg REAL,
            water_l REAL,
            smi REAL,
            inbody_score INTEGER,
            ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE inbody_segment (
            scan_date TEXT NOT NULL,
            segment TEXT NOT NULL,
            lean_mass_kg REAL NOT NULL,
            fat_mass_kg REAL NOT NULL,
            lean_pct_of_standard REAL,
            fat_pct_of_standard REAL,
            PRIMARY KEY (scan_date, segment)
        );
        INSERT INTO inbody_scan
            (scan_date, weight_kg, body_fat_pct, smm_kg, fat_mass_kg, visceral_fat_level)
            VALUES ('2026-04-23', 71.6, 22.9, 31.1, 16.4, 5);
        INSERT INTO inbody_segment
            (scan_date, segment, lean_mass_kg, fat_mass_kg)
            VALUES ('2026-04-23', 'left_arm', 2.59, 1.0);
    """)
    conn.commit()
    conn.close()

    with Database(db_path) as db:
        scan = db.get_body_composition_scan("2026-04-23")
        assert scan is not None
        assert dict(scan)["weight_kg"] == 71.6
        segs = db.get_body_composition_segments("2026-04-23")
        assert len(segs) == 1

        tables = {r[0] for r in db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "inbody_scan" not in tables
        assert "inbody_segment" not in tables
        assert "body_composition_scan" in tables
        assert "body_composition_segment" in tables
```

- [ ] **Step 1.2: Run the new test, confirm it fails**

Run: `PYTHONPATH=src pytest tests/test_inbody_db.py::test_migration_renames_legacy_tables -v`
Expected: FAIL with `AttributeError: 'Database' object has no attribute 'get_body_composition_scan'`.

- [ ] **Step 1.3: Update SCHEMA constant in `src/stride_core/db.py`**

Find the two `CREATE TABLE IF NOT EXISTS inbody_scan` / `inbody_segment` blocks (around lines 237–261). Replace exactly:

```sql
CREATE TABLE IF NOT EXISTS body_composition_scan (
    scan_date           TEXT PRIMARY KEY,
    jpg_path            TEXT,
    weight_kg           REAL NOT NULL,
    body_fat_pct        REAL NOT NULL,
    smm_kg              REAL NOT NULL,
    fat_mass_kg         REAL NOT NULL,
    visceral_fat_level  INTEGER NOT NULL,
    bmr_kcal            INTEGER,
    protein_kg          REAL,
    water_l             REAL,
    smi                 REAL,
    inbody_score        INTEGER,
    ingested_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS body_composition_segment (
    scan_date               TEXT NOT NULL REFERENCES body_composition_scan(scan_date) ON DELETE CASCADE,
    segment                 TEXT NOT NULL,
    lean_mass_kg            REAL NOT NULL,
    fat_mass_kg             REAL NOT NULL,
    lean_pct_of_standard    REAL,
    fat_pct_of_standard     REAL,
    PRIMARY KEY (scan_date, segment)
);
```

The column `inbody_score` STAYS named `inbody_score` (brand-specific reading; documented).

- [ ] **Step 1.4: Add `_rename` helper inside `_migrate()` in `src/stride_core/db.py`**

After the existing `_add(...)` calls (around line 789), append:

```python
        def _rename(old: str, new: str) -> None:
            """Rename table if old exists and new doesn't. Idempotent."""
            try:
                existing = {
                    r[0] for r in self._conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if old in existing and new not in existing:
                    self._conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
            except sqlite3.OperationalError:
                pass  # race-condition swallow, same pattern as _add

        # Parent before child so SQLite rewrites FK reference text.
        _rename("inbody_scan",    "body_composition_scan")
        _rename("inbody_segment", "body_composition_segment")
```

Also update the existing line:
```python
        _add("inbody_segment", "fat_pct_of_standard", "REAL")
```
to:
```python
        _add("body_composition_segment", "fat_pct_of_standard", "REAL")
```

- [ ] **Step 1.5: Rename the six `Database` methods + their inline SQL**

In `src/stride_core/db.py`, find `list_inbody_scans` and rename through the file. The method names and their SQL targets:

| Old name | New name | SQL table inside |
|----------|----------|------------------|
| `list_inbody_scans` | `list_body_composition_scans` | `FROM body_composition_scan` |
| `latest_inbody_scan` | `latest_body_composition_scan` | `FROM body_composition_scan` |
| `inbody_scan_before` | `body_composition_scan_before` | `FROM body_composition_scan` |
| `get_inbody_scan` | `get_body_composition_scan` | `FROM body_composition_scan` |
| `get_inbody_segments` | `get_body_composition_segments` | `FROM body_composition_segment` |
| `upsert_inbody_scan` | `upsert_body_composition_scan` | `INSERT INTO body_composition_scan ... ON CONFLICT` and `INSERT INTO body_composition_segment` |

Use `Grep` to find each method's body, change both `def` line and SQL strings inside. Internal docstrings: rephrase any "InBody" → "body-composition" mention.

- [ ] **Step 1.6: Update `src/stride_core/state_stores.py`**

Grep for `inbody_` in this file. Method signatures on the store class need the same six renames as Step 1.5. The body of each store method delegates to `Database.*_inbody_*`, which now has the new names — update delegation too.

- [ ] **Step 1.7: Update `src/stride_core/models.py`**

Replace constant + docstring:

```python
# Line 455 — rename constant
BODY_COMPOSITION_SEGMENTS = {"left_arm", "right_arm", "trunk", "left_leg", "right_leg"}
```

And update line 469 inside `BodySegment.from_dict`:
```python
        if segment not in BODY_COMPOSITION_SEGMENTS:
            raise ValueError(f"segment must be one of {BODY_COMPOSITION_SEGMENTS}, got {segment!r}")
```

And line 494 docstring:
```python
@dataclass
class BodyCompositionScan:
    """Body-composition scan snapshot. Validated at the `from_dict()` boundary."""
```

- [ ] **Step 1.8: Rename test files via `git mv` and update internal refs**

```bash
git mv tests/test_inbody_db.py tests/test_body_composition_db.py
git mv tests/test_inbody_models.py tests/test_body_composition_models.py
```

Then in `tests/test_body_composition_db.py`:
- Top docstring: `"""Tests for InBody DB upsert/read helpers."""` → `"""Tests for body-composition DB upsert/read helpers."""`
- All `db.upsert_inbody_scan` / `db.get_inbody_scan` / `db.get_inbody_segments` / `db.list_inbody_scans` → new names
- Class `class TestInBodyUpsert` → `class TestBodyCompositionUpsert`

In `tests/test_body_composition_models.py`:
- Top docstring + any references to `INBODY_SEGMENTS` → `BODY_COMPOSITION_SEGMENTS`

- [ ] **Step 1.9: Update other test files referencing the old Database methods**

Files to update (use Grep first to confirm):
- `tests/test_state_stores.py`
- `tests/coach_adapters/test_read_impls.py`
- `tests/coach/stubs/fake_toolkit.py`

In each: replace any `*_inbody_*` method/field names with their new counterparts.

- [ ] **Step 1.10: Update all `src/` callers of the renamed Database methods**

Files (already verified via Grep):
- `src/stride_server/routes/inbody.py` — calls `store.list_inbody_scans()`, `store.latest_inbody_scan()`, `store.inbody_scan_before(...)`, `store.get_inbody_scan(...)`, `store.get_inbody_segments(...)`, `store.upsert_inbody_scan(...)`. Rename all six call sites. (Route paths + file name change in Task 2; for now just fix the method calls.)
- `src/coros_sync/cli.py` — calls `db.upsert_inbody_scan(...)`, `db.get_inbody_scan(...)`, `db.get_inbody_segments(...)`, `db.list_inbody_scans(...)`. Rename. (Click group / URL change in Task 6.)
- `src/stride_server/commentary_ai.py` — Grep to confirm what it calls; rename.
- `src/stride_server/coach_adapters/toolkit.py` — same.
- `src/stride_server/coach_adapters/tool_impls/read_impls.py` — same.
- `src/coach_agent/context.py` — same.

For each file, run: `Grep "inbody_scan\|inbody_segment\|list_inbody\|latest_inbody\|get_inbody\|upsert_inbody"` and replace each match with its new-name counterpart.

- [ ] **Step 1.11: Run full pytest, expect green**

```bash
PYTHONPATH=src pytest tests/ -v 2>&1 | tail -40
```
Expected: all tests pass, including the new `test_migration_renames_legacy_tables`.

If any test fails citing old `inbody_*` method names, re-run Grep on the failing file's path and fix.

- [ ] **Step 1.12: Commit**

```bash
git add -A
git commit -m "refactor(body-composition): rename Database methods + add table migration

Renames inbody_scan/inbody_segment tables to body_composition_scan/_segment
with idempotent ALTER TABLE RENAME in Database._migrate(). All six Database
methods (list/latest/before/get/get_segments/upsert) renamed. INBODY_SEGMENTS
constant renamed to BODY_COMPOSITION_SEGMENTS. All Python callers updated
in lockstep. inbody_score column kept (brand-specific reading)."
```

---

## Task 2: HTTP route surface rename

**Files:**
- Modify: `git mv src/stride_server/routes/inbody.py → src/stride_server/routes/body_composition.py`
- Modify: `src/stride_server/deps.py`
- Modify: `src/stride_server/app.py`
- Modify: `src/stride_server/routes/weeks.py`

- [ ] **Step 2.1: Rename the route module via `git mv`**

```bash
git mv src/stride_server/routes/inbody.py src/stride_server/routes/body_composition.py
```

- [ ] **Step 2.2: Update content of `src/stride_server/routes/body_composition.py`**

Top docstring:
```python
"""Body-composition scans — read trends + upsert writes from local CLI / web form."""
```

Import line — `from ..deps import get_inbody_store` → `from ..deps import get_body_composition_store`.

Route + function renames:

```python
@router.get("/api/{user}/body-composition")
def list_body_composition(user: str, days: int | None = Query(None, ge=1, le=3650)):
    """List scans (newest-first) with derived per-scan fields + segments."""
    store = get_body_composition_store(user)
    try:
        scans = [_scan_row_to_dict(r) for r in store.list_body_composition_scans(days=days)]
        for s in scans:
            segs = _segments_by_name(store.get_body_composition_segments(s["scan_date"]))
            _derive(s, segs)
            s["segments"] = list(segs.values())
        return {"scans": scans}
    finally:
        store.close()


@router.get("/api/{user}/body-composition/summary")
def body_composition_summary(user: str):
    """Latest scan + 30-day deltas + phase-checkpoint comparison."""
    store = get_body_composition_store(user)
    try:
        latest = store.latest_body_composition_scan()
        if not latest:
            return {"latest": None, "deltas": None, "checkpoints": PHASE_CHECKPOINTS}
        latest_d = _scan_row_to_dict(latest)
        segs = _segments_by_name(store.get_body_composition_segments(latest_d["scan_date"]))
        _derive(latest_d, segs)
        latest_d["segments"] = list(segs.values())

        prior_row = store.body_composition_scan_before(latest_d["scan_date"])
        prior = dict(prior_row) if prior_row else None
        # ... (rest of function body unchanged)


@router.get("/api/{user}/body-composition/{scan_date}")
def get_body_composition(user: str, scan_date: str):
    """Single scan with all 5 segments."""
    store = get_body_composition_store(user)
    try:
        row = store.get_body_composition_scan(scan_date)
        # ... (rest unchanged)


@router.post("/api/{user}/body-composition")
def upsert_body_composition(user: str, payload: dict):
    """Upsert a scan + 5 segments. Body validated via `BodyCompositionScan.from_dict()`."""
    try:
        scan = BodyCompositionScan.from_dict(payload)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    store = get_body_composition_store(user)
    try:
        store.upsert_body_composition_scan(scan)
        row = store.get_body_composition_scan(scan.scan_date)
        # ... (rest unchanged)
```

The 4 helper functions `_scan_row_to_dict`, `_segments_by_name`, `_derive`, and the `PHASE_CHECKPOINTS` constant stay as-is (no rename needed; they're brand-neutral).

- [ ] **Step 2.3: Rename `get_inbody_store` → `get_body_composition_store` in `src/stride_server/deps.py`**

Grep first to see surrounding context, then rename the function definition + any module-internal references.

- [ ] **Step 2.4: Update `src/stride_server/app.py`**

Find the line that imports the router from `routes.inbody`:
```python
from .routes.inbody import router as inbody_router
```
Change to:
```python
from .routes.body_composition import router as body_composition_router
```

And the `app.include_router(inbody_router)` (or equivalent) → `app.include_router(body_composition_router)`.

- [ ] **Step 2.5: Update `src/stride_server/routes/weeks.py`**

Find the `has_inbody` field around line 51:

```python
                "has_inbody": any_exists(
                    f"{user}/logs/{folder_name}/inbody{ext}"
                    ...
                )
```

Rename field key to `has_body_composition` and update the filename probe from `inbody{ext}` to `body-composition{ext}`. If there's any backward-compat or fallback handling needed, NOTE that we are committing to the rename — no dual probe.

- [ ] **Step 2.6: Run pytest, expect green**

```bash
PYTHONPATH=src pytest tests/ -v 2>&1 | tail -20
```

If a route test exists for the old `/inbody` URL it must now be updated to `/body-composition`. (Run `Grep "/api/.*/inbody"` in `tests/` to find any.)

- [ ] **Step 2.7: Commit**

```bash
git add -A
git commit -m "refactor(body-composition): rename HTTP route surface

Routes /api/{user}/inbody* → /body-composition*. Route module renamed via
git mv. get_inbody_store → get_body_composition_store. weeks.py field
has_inbody → has_body_composition; file pattern inbody.* → body-composition.*"
```

---

## Task 3: Coach layer rename

**Files:**
- Modify: `src/coach/tools/protocols.py`
- Modify: `src/coach/runtime/toolkit.py`
- Modify: `src/coach/graphs/conversation/tool_bridge.py`
- Modify: `src/coach/graphs/conversation/prompts/master_chat.py`
- Modify: `src/coach/graphs/conversation/prompts/week_chat.py`
- Modify: `src/coach_agent/context.py`
- Modify: `src/coach_agent/tools.py`
- Modify: `src/coach_agent/agent.py`
- Modify: `src/stride_server/coach_adapters/toolkit.py`
- Modify: `src/stride_server/coach_adapters/tool_impls/read_impls.py`

- [ ] **Step 3.1: Rename Protocol class + registry entry in `src/coach/tools/protocols.py`**

Grep for `GetInbodyLatest` and `get_inbody_latest`. Replace:
- `class GetInbodyLatest(Protocol):` → `class GetBodyCompositionLatest(Protocol):`
- Tool-name string in the registry list: `"get_inbody_latest"` → `"get_body_composition_latest"`

- [ ] **Step 3.2: Update `src/coach/runtime/toolkit.py`**

- `from ..tools.protocols import (... GetInbodyLatest ...)` → `GetBodyCompositionLatest`
- Dataclass field: `get_inbody_latest: GetInbodyLatest` → `get_body_composition_latest: GetBodyCompositionLatest`

- [ ] **Step 3.3: Update `src/coach/graphs/conversation/tool_bridge.py`**

- Description map key `"get_inbody_latest"` → `"get_body_composition_latest"`
- Value string: `"Latest InBody scan + delta from prior scan (weight_kg/body_fat_pct/smm_kg)."` → `"Latest body-composition scan + delta from prior scan (weight_kg/body_fat_pct/smm_kg)."`
- The `_ALLOWED_TOOLS` (or equivalent) list entry `"get_inbody_latest"` → `"get_body_composition_latest"`

- [ ] **Step 3.4: Update prompt files**

`src/coach/graphs/conversation/prompts/master_chat.py` line 21:
```python
- get_inbody_latest — InBody 数据
```
→
```python
- get_body_composition_latest — 体测数据
```

`src/coach/graphs/conversation/prompts/week_chat.py` line 20: same substitution.

- [ ] **Step 3.5: Update `src/coach_agent/` files**

Grep `src/coach_agent/` for `inbody|InBody|Inbody`. Each occurrence is either a method reference (rename to `*body_composition*`) or a docstring/comment (rephrase to "body composition"). Files touched: `context.py`, `tools.py`, `agent.py`.

- [ ] **Step 3.6: Update `src/stride_server/coach_adapters/`**

In `toolkit.py` and `tool_impls/read_impls.py`:
- Function/method `get_inbody_latest(...)` → `get_body_composition_latest(...)`
- Tool wiring: the dictionary or registration that maps `"get_inbody_latest"` to the impl → key renamed.
- Internal calls to `db.get_inbody_scan` / `db.inbody_scan_before` etc. already done in Task 1; verify no leftover.

- [ ] **Step 3.7: Run pytest + lint-imports, expect green**

```bash
PYTHONPATH=src pytest tests/ -v 2>&1 | tail -20
PYTHONPATH=src lint-imports
```

Both must pass. `lint-imports` enforces the coach core/adapter layering — renames shouldn't break it, but verify.

- [ ] **Step 3.8: Commit**

```bash
git add -A
git commit -m "refactor(body-composition): rename coach tool registry

get_inbody_latest → get_body_composition_latest across protocols.py,
toolkit.py, tool_bridge.py, prompts, agent, and adapters. Tool-name
string flips atomically so LLM tool calls remain valid."
```

---

## Task 4: Frontend rename (mechanical)

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `git mv frontend/src/pages/InbodyPage.tsx → frontend/src/pages/BodyCompositionPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppLayout.tsx`
- Modify: `frontend/src/lib/breadcrumb.ts`
- Modify: `frontend/src/telemetry/routeNames.ts`
- Modify: `frontend/src/telemetry/__tests__/routeNames.test.ts`
- Modify: `frontend/src/pages/__tests__/WeekLayoutCalendar.test.tsx`
- Modify: `frontend/src/pages/__tests__/HealthPage.test.tsx`

- [ ] **Step 4.1: Update `frontend/src/api.ts`**

Types:
```typescript
export interface BodyCompositionScan {
  scan_date: string
  jpg_path: string | null
  weight_kg: number
  body_fat_pct: number
  smm_kg: number
  fat_mass_kg: number
  visceral_fat_level: number
  bmr_kcal: number | null
  protein_kg: number | null
  water_l: number | null
  smi: number | null
  inbody_score: number | null   // brand-specific reading kept verbatim
  ingested_at: string
  // ... derived fields preserved as-is
}

export interface BodyCompositionDeltas {
  // ... existing fields verbatim
}

export interface BodyCompositionCheckpoint {
  // ... existing fields verbatim
}

export interface BodyCompositionSummary {
  latest: BodyCompositionScan | null
  deltas: BodyCompositionDeltas | null
  checkpoints: BodyCompositionCheckpoint[]
}
```

Functions:
```typescript
export function getBodyComposition(user: string, days?: number) {
  const qs = days ? `?days=${days}` : ''
  return fetchJSON<{ scans: BodyCompositionScan[] }>(`/${user}/body-composition${qs}`)
}

export function getBodyCompositionSummary(user: string) {
  return fetchJSON<BodyCompositionSummary>(`/${user}/body-composition/summary`)
}

export function getBodyCompositionScan(user: string, scanDate: string) {
  return fetchJSON<BodyCompositionScan>(`/${user}/body-composition/${scanDate}`)
}
```

Also: in the `WeekSummary` interface around line 377, rename field:
```typescript
  has_body_composition: boolean
```

- [ ] **Step 4.2: Add a new POST helper for manual entry**

In `frontend/src/api.ts`, append a new exported function (used by the modal in Task 5):

```typescript
export type BodyCompositionScanInput = {
  scan_date: string
  weight_kg: number
  body_fat_pct: number
  smm_kg: number
  fat_mass_kg: number
  visceral_fat_level: number
  bmr_kcal?: number | null
  protein_kg?: number | null
  water_l?: number | null
  smi?: number | null
  inbody_score?: number | null
  segments?: Array<{
    segment: 'left_arm' | 'right_arm' | 'trunk' | 'left_leg' | 'right_leg'
    lean_mass_kg: number
    fat_mass_kg: number
    lean_pct_of_standard?: number | null
    fat_pct_of_standard?: number | null
  }>
}

export function upsertBodyComposition(user: string, payload: BodyCompositionScanInput) {
  return fetchJSON<BodyCompositionScan>(`/${user}/body-composition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
```

(If `fetchJSON` does not currently accept `method`/`body`/`headers` overrides, inspect its signature and adapt — usually it forwards a `RequestInit`. Confirm before editing.)

- [ ] **Step 4.3: Rename page file + update component**

```bash
git mv frontend/src/pages/InbodyPage.tsx frontend/src/pages/BodyCompositionPage.tsx
```

Open the renamed file. Replace:
- `export default function InbodyPage()` → `export default function BodyCompositionPage()`
- Import lines: `getInbody, getInbodySummary, InBodyScan, InBodySummary` → `getBodyComposition, getBodyCompositionSummary, BodyCompositionScan, BodyCompositionSummary`
- Promise.all: `Promise.all([getInbody(user), getInbodySummary(user)])` → `Promise.all([getBodyComposition(user), getBodyCompositionSummary(user)])`
- Local state types `useState<InBodyScan[]>` → `useState<BodyCompositionScan[]>`; `useState<InBodySummary | null>` → `useState<BodyCompositionSummary | null>`
- ViewHead `eyebrow="体测记录 · InBody"` → `eyebrow="体测记录"`
- ViewHead `lede={`InBody Body Composition — ${scans.length} 次扫描`}` → `lede={`身体成分 — ${scans.length} 次扫描`}`
- Empty-state copy (around line 87) — change to:
  ```tsx
  暂无体测数据。点击右上「+ 录入新数据」开始录入，
  或使用 <code className="font-mono text-text-primary">coros-sync body-composition add</code> 批量导入 JSON。
  ```
- Type alias `type ChartRow = InBodyScan & { dateLabel: string }` → `BodyCompositionScan & { dateLabel: string }`
- `function SegmentAnalysis({ chartData, latest }: { chartData: ChartRow[]; latest: InBodyScan })` → `latest: BodyCompositionScan`

The button + modal wiring is added in Task 5; for now just rename.

- [ ] **Step 4.4: Update `frontend/src/App.tsx`**

Grep for `InbodyPage` and `/inbody`:
- Import: `import InbodyPage from './pages/InbodyPage'` → `import BodyCompositionPage from './pages/BodyCompositionPage'`
- Route element: `<Route path="/inbody" element={<InbodyPage />} />` → `<Route path="/body-composition" element={<BodyCompositionPage />} />`

- [ ] **Step 4.5: Update `frontend/src/components/AppLayout.tsx`**

Grep for `/inbody`. The nav link `href="/inbody"` (or `to="/inbody"` depending on routing lib) → `/body-composition`. The display label `体测` stays. If telemetry tracking attaches a route name to the link, that updates in Step 4.7.

- [ ] **Step 4.6: Update `frontend/src/lib/breadcrumb.ts`**

```typescript
if (pathname === '/body-composition') {
    return { section: '数据', current: '体测记录' }
}
```
(Replacing the `pathname === '/inbody'` branch around line 35.)

- [ ] **Step 4.7: Update `frontend/src/telemetry/routeNames.ts` + its test**

In `routeNames.ts`:
```typescript
['/body-composition', 'BodyComposition'],
```
(Replacing `['/inbody', 'InBody']` at line 8.)

In `frontend/src/telemetry/__tests__/routeNames.test.ts`:
```typescript
['/body-composition', 'BodyComposition'],
```
(Replacing line 11.)

- [ ] **Step 4.8: Update existing page tests**

In `frontend/src/pages/__tests__/WeekLayoutCalendar.test.tsx` line 46:
```typescript
has_body_composition: false,
```

In `frontend/src/pages/__tests__/HealthPage.test.tsx` line 120:
```typescript
has_body_composition: false,
```

- [ ] **Step 4.9: Run frontend tests, expect green**

```bash
cd frontend && npm test
```

All vitest tests green. If something fails citing old `getInbody` or `InBodyScan`, run Grep and fix the missed file.

- [ ] **Step 4.10: Commit**

```bash
git add -A
git commit -m "refactor(body-composition): rename frontend surface

Page InbodyPage → BodyCompositionPage; API client types and functions
renamed; routes /inbody → /body-composition. Adds upsertBodyComposition
POST helper used by the manual-entry modal (Task 5). has_inbody field
renamed in WeekSummary + fixtures."
```

---

## Task 5: Manual entry modal (TDD)

**Files:**
- Create: `frontend/src/pages/BodyCompositionEntryModal.tsx` (NEW)
- Modify: `frontend/src/pages/BodyCompositionPage.tsx`
- Create: `frontend/src/pages/__tests__/BodyCompositionPage.test.tsx` (NEW)
- Create: `frontend/src/pages/__tests__/BodyCompositionEntryModal.test.tsx` (NEW)

- [ ] **Step 5.1: Write failing test — page shows entry button**

Create `frontend/src/pages/__tests__/BodyCompositionPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BodyCompositionPage from '../BodyCompositionPage'
import * as api from '../../api'

vi.mock('../../UserContextValue', () => ({
  useUser: () => ({ user: 'testuser' }),
}))

describe('BodyCompositionPage', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getBodyComposition').mockResolvedValue({ scans: [] })
    vi.spyOn(api, 'getBodyCompositionSummary').mockResolvedValue({
      latest: null,
      deltas: null,
      checkpoints: [],
    })
  })

  it('renders an entry button next to the page header', async () => {
    render(<MemoryRouter><BodyCompositionPage /></MemoryRouter>)
    const button = await screen.findByRole('button', { name: /录入新数据/ })
    expect(button).toBeInTheDocument()
  })
})
```

- [ ] **Step 5.2: Run the test, confirm it fails**

```bash
cd frontend && npm test -- BodyCompositionPage
```
Expected: FAIL with "Unable to find an accessible element with the role 'button' and name '/录入新数据/'".

- [ ] **Step 5.3: Add the entry button to `BodyCompositionPage.tsx`**

In `BodyCompositionPage.tsx`, locate the `<ViewHead>` element. Wrap it (or place a button alongside) so the button sits visually top-right. Concrete change — replace the `<ViewHead ... />` block with:

```tsx
          <div className="flex items-start justify-between gap-4">
            <ViewHead
              eyebrow="体测记录"
              title="身体成分趋势"
              lede={`Body Composition — ${scans.length} 次扫描`}
            />
            <button
              type="button"
              onClick={() => setShowEntry(true)}
              className="shrink-0 mt-2 px-3 py-2 text-xs font-mono font-medium rounded-md bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 transition-colors"
            >
              + 录入新数据
            </button>
          </div>
```

And declare the state at the top of the component:
```tsx
  const [showEntry, setShowEntry] = useState(false)
```

(Add `useState` import only if not already present — it is, since the page uses it.)

- [ ] **Step 5.4: Run test, confirm it passes**

```bash
cd frontend && npm test -- BodyCompositionPage
```
Expected: PASS.

- [ ] **Step 5.5: Write failing test — clicking button opens modal**

Append to `BodyCompositionPage.test.tsx`:

```typescript
  it('opens the entry modal when the button is clicked', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><BodyCompositionPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: /录入新数据/ }))
    expect(await screen.findByRole('dialog', { name: /录入体测数据/ })).toBeInTheDocument()
  })
```

Top imports of the test file get:
```typescript
import userEvent from '@testing-library/user-event'
```

- [ ] **Step 5.6: Run test, confirm it fails**

Expected: FAIL — no element with role `dialog` exists yet.

- [ ] **Step 5.7: Create the modal scaffold**

Create `frontend/src/pages/BodyCompositionEntryModal.tsx`:

```tsx
import { useState } from 'react'
import { shanghaiToday } from '../lib/shanghai'
import { upsertBodyComposition, type BodyCompositionScanInput } from '../api'

type SegmentRow = {
  segment: 'left_arm' | 'right_arm' | 'trunk' | 'left_leg' | 'right_leg'
  lean_mass_kg: string
  fat_mass_kg: string
  lean_pct_of_standard: string
  fat_pct_of_standard: string
}

const SEGMENT_KEYS: SegmentRow['segment'][] = ['left_arm', 'right_arm', 'trunk', 'left_leg', 'right_leg']
const SEGMENT_LABELS: Record<SegmentRow['segment'], string> = {
  left_arm: '左臂',
  right_arm: '右臂',
  trunk: '躯干',
  left_leg: '左腿',
  right_leg: '右腿',
}

const makeBlankSegments = (): SegmentRow[] =>
  SEGMENT_KEYS.map((s) => ({
    segment: s,
    lean_mass_kg: '',
    fat_mass_kg: '',
    lean_pct_of_standard: '',
    fat_pct_of_standard: '',
  }))

export default function BodyCompositionEntryModal({
  user,
  existingDates,
  onClose,
  onSaved,
}: {
  user: string
  existingDates: Set<string>
  onClose: () => void
  onSaved: () => void
}) {
  const [scanDate, setScanDate] = useState(shanghaiToday())
  const [weight, setWeight] = useState('')
  const [bf, setBf] = useState('')
  const [smm, setSmm] = useState('')
  const [fatMass, setFatMass] = useState('')
  const [vfl, setVfl] = useState('')
  const [showOptional, setShowOptional] = useState(false)
  const [bmr, setBmr] = useState('')
  const [protein, setProtein] = useState('')
  const [water, setWater] = useState('')
  const [smi, setSmi] = useState('')
  const [inbodyScore, setInbodyScore] = useState('')
  const [showSegments, setShowSegments] = useState(false)
  const [segments, setSegments] = useState<SegmentRow[]>(makeBlankSegments())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function validate(): { ok: true; payload: BodyCompositionScanInput } | { ok: false; message: string } {
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    const required: Array<[string, string, number, number]> = [
      ['weight_kg', weight, 30, 150],
      ['body_fat_pct', bf, 3, 50],
      ['smm_kg', smm, 10, 60],
      ['fat_mass_kg', fatMass, 0, 80],
      ['visceral_fat_level', vfl, 1, 30],
    ]
    for (const [name, raw, lo, hi] of required) {
      const v = num(raw)
      if (v == null || Number.isNaN(v) || v < lo || v > hi) {
        return { ok: false, message: `${name} 必填且需在 [${lo}, ${hi}]` }
      }
    }

    // Segment all-or-none rule
    const segFilled = segments.map(s =>
      s.lean_mass_kg.trim() !== '' || s.fat_mass_kg.trim() !== ''
    )
    const filledCount = segFilled.filter(Boolean).length
    let segmentPayload: BodyCompositionScanInput['segments'] = undefined
    if (filledCount > 0 && filledCount < 5) {
      return { ok: false, message: '节段数据必须 5 个都填，或者全部留空' }
    }
    if (filledCount === 5) {
      segmentPayload = segments.map((s) => {
        const lean = num(s.lean_mass_kg)
        const fat = num(s.fat_mass_kg)
        if (lean == null || fat == null) {
          throw new Error('segment lean/fat must be numeric when filled')
        }
        return {
          segment: s.segment,
          lean_mass_kg: lean,
          fat_mass_kg: fat,
          lean_pct_of_standard: num(s.lean_pct_of_standard),
          fat_pct_of_standard: num(s.fat_pct_of_standard),
        }
      })
    }

    return {
      ok: true,
      payload: {
        scan_date: scanDate,
        weight_kg: num(weight)!,
        body_fat_pct: num(bf)!,
        smm_kg: num(smm)!,
        fat_mass_kg: num(fatMass)!,
        visceral_fat_level: num(vfl)!,
        bmr_kcal: num(bmr),
        protein_kg: num(protein),
        water_l: num(water),
        smi: num(smi),
        inbody_score: num(inbodyScore),
        segments: segmentPayload,
      },
    }
  }

  async function handleSubmit() {
    setError(null)
    const result = validate()
    if (!result.ok) {
      setError(result.message)
      return
    }
    if (existingDates.has(scanDate)) {
      if (!window.confirm(`该日期 ${scanDate} 已有数据，覆盖？`)) return
    }
    setSubmitting(true)
    try {
      await upsertBodyComposition(user, result.payload)
      onSaved()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`提交失败：${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="录入体测数据"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">录入体测数据</h2>
            <p className="text-xs font-mono text-text-muted">Body Composition Manual Entry</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-text-muted hover:text-text-primary text-lg leading-none">×</button>
        </div>

        <div className="space-y-4">
          <Field label="扫描日期" required>
            <input type="date" value={scanDate} onChange={(e) => setScanDate(e.target.value)} className={inputCls} />
          </Field>

          <div>
            <h3 className="text-xs font-mono text-text-muted mb-2">主指标 (必填)</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="体重 (kg)" required>
                <input type="number" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} className={inputCls} />
              </Field>
              <Field label="体脂率 (%)" required>
                <input type="number" step="0.1" value={bf} onChange={(e) => setBf(e.target.value)} className={inputCls} />
              </Field>
              <Field label="骨骼肌量 (kg)" required>
                <input type="number" step="0.1" value={smm} onChange={(e) => setSmm(e.target.value)} className={inputCls} />
              </Field>
              <Field label="脂肪量 (kg)" required>
                <input type="number" step="0.1" value={fatMass} onChange={(e) => setFatMass(e.target.value)} className={inputCls} />
              </Field>
              <Field label="内脏脂肪等级" required>
                <input type="number" step="1" value={vfl} onChange={(e) => setVfl(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </div>

          <details open={showOptional} onToggle={(e) => setShowOptional((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-xs font-mono text-text-muted mb-2">可选指标 (5)</summary>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Field label="BMR (kcal)"><input type="number" value={bmr} onChange={(e) => setBmr(e.target.value)} className={inputCls} /></Field>
              <Field label="蛋白质 (kg)"><input type="number" step="0.1" value={protein} onChange={(e) => setProtein(e.target.value)} className={inputCls} /></Field>
              <Field label="水分 (L)"><input type="number" step="0.1" value={water} onChange={(e) => setWater(e.target.value)} className={inputCls} /></Field>
              <Field label="SMI"><input type="number" step="0.1" value={smi} onChange={(e) => setSmi(e.target.value)} className={inputCls} /></Field>
              <Field label="InBody Score"><input type="number" value={inbodyScore} onChange={(e) => setInbodyScore(e.target.value)} className={inputCls} /></Field>
            </div>
          </details>

          <details open={showSegments} onToggle={(e) => setShowSegments((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-xs font-mono text-text-muted mb-2">节段数据 (5×4，要么全填，要么全空)</summary>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="text-left py-1 px-2 font-medium">节段</th>
                    <th className="text-left py-1 px-2 font-medium">肌肉 kg</th>
                    <th className="text-left py-1 px-2 font-medium">脂肪 kg</th>
                    <th className="text-left py-1 px-2 font-medium">肌肉 % 标准</th>
                    <th className="text-left py-1 px-2 font-medium">脂肪 % 标准</th>
                  </tr>
                </thead>
                <tbody>
                  {segments.map((s, i) => (
                    <tr key={s.segment}>
                      <td className="py-1 px-2">{SEGMENT_LABELS[s.segment]}</td>
                      {(['lean_mass_kg', 'fat_mass_kg', 'lean_pct_of_standard', 'fat_pct_of_standard'] as const).map((field) => (
                        <td key={field} className="py-1 px-2">
                          <input
                            type="number"
                            step="0.1"
                            aria-label={`${SEGMENT_LABELS[s.segment]} ${field}`}
                            value={s[field]}
                            onChange={(e) => {
                              const v = e.target.value
                              setSegments((prev) => prev.map((row, idx) => idx === i ? { ...row, [field]: v } : row))
                            }}
                            className={`${inputCls} text-xs`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {error && (
            <div className="px-3 py-2 rounded-md bg-accent-red/10 border border-accent-red/30 text-xs font-mono text-accent-red">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 text-xs font-mono rounded-md bg-bg-secondary text-text-secondary hover:bg-bg-card-hover">取消</button>
            <button type="button" onClick={handleSubmit} disabled={submitting} className="px-4 py-2 text-xs font-mono rounded-md bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 disabled:opacity-50">
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full px-2 py-1 text-sm bg-bg-secondary border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent-amber'

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-mono text-text-muted mb-1">
        {label}{required && <span className="text-accent-red ml-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}
```

- [ ] **Step 5.8: Wire the modal into `BodyCompositionPage.tsx`**

Add the import near the top:
```tsx
import BodyCompositionEntryModal from './BodyCompositionEntryModal'
```

Inside the component, after the existing data-fetch effect, derive the existing-dates set and render the modal conditionally. Add at the bottom of the page's main JSX tree (just before the closing `</div>` of the `animate-fade-in` block, but inside the outer `<div>`):

```tsx
          {showEntry && user && (
            <BodyCompositionEntryModal
              user={user}
              existingDates={new Set(scans.map((s) => s.scan_date))}
              onClose={() => setShowEntry(false)}
              onSaved={() => {
                setShowEntry(false)
                // Force a refetch by clearing loadedKey
                setLoadedKey('')
              }}
            />
          )}
```

The existing useEffect re-runs when `requestKey !== loadedKey`, so clearing `loadedKey` triggers a refresh. (Verify this matches the existing useEffect contract before committing.)

- [ ] **Step 5.9: Run test, confirm modal opens**

```bash
cd frontend && npm test -- BodyCompositionPage
```
Expected: both tests pass.

- [ ] **Step 5.10: Write failing test — required-field validation**

Create `frontend/src/pages/__tests__/BodyCompositionEntryModal.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BodyCompositionEntryModal from '../BodyCompositionEntryModal'
import * as api from '../../api'

function renderModal(overrides: Partial<Parameters<typeof BodyCompositionEntryModal>[0]> = {}) {
  const props = {
    user: 'testuser',
    existingDates: new Set<string>(),
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  }
  render(<BodyCompositionEntryModal {...props} />)
  return props
}

describe('BodyCompositionEntryModal', () => {
  it('blocks submit and shows error when required metrics are missing', async () => {
    const user = userEvent.setup()
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal()
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/weight_kg 必填/)).toBeInTheDocument()
    expect(upsertSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5.11: Run test, expect PASS**

The validate() function already handles this (Step 5.7 implemented it together with the modal scaffold). The test verifies the behavior.

```bash
cd frontend && npm test -- BodyCompositionEntryModal
```
Expected: PASS.

- [ ] **Step 5.12: Add test for segment all-or-none rule**

Append to `BodyCompositionEntryModal.test.tsx`:

```typescript
  it('blocks submit when segments are partially filled', async () => {
    const user = userEvent.setup()
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal()

    // Fill required metrics
    await user.type(screen.getByLabelText(/体重/), '71.6')
    await user.type(screen.getByLabelText(/体脂率/), '22.9')
    await user.type(screen.getByLabelText(/骨骼肌量/), '31.1')
    await user.type(screen.getByLabelText(/脂肪量/), '16.4')
    await user.type(screen.getByLabelText(/内脏脂肪等级/), '5')

    // Open segments and fill only 2 rows partially
    await user.click(screen.getByText(/节段数据/))
    await user.type(screen.getByLabelText('左臂 lean_mass_kg'), '2.5')
    await user.type(screen.getByLabelText('右臂 lean_mass_kg'), '2.6')

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/节段数据必须 5 个都填/)).toBeInTheDocument()
    expect(upsertSpy).not.toHaveBeenCalled()
  })
```

- [ ] **Step 5.13: Run test, expect PASS**

```bash
cd frontend && npm test -- BodyCompositionEntryModal
```
Expected: both tests pass (logic already in place from Step 5.7).

- [ ] **Step 5.14: Add test for happy-path submit**

```typescript
  it('submits payload and calls onSaved on success', async () => {
    const user = userEvent.setup()
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({
      scan_date: '2026-05-20', weight_kg: 71.6, body_fat_pct: 22.9, smm_kg: 31.1,
      fat_mass_kg: 16.4, visceral_fat_level: 5, jpg_path: null, bmr_kcal: null,
      protein_kg: null, water_l: null, smi: null, inbody_score: null, ingested_at: 'x',
    } as never)
    const onSaved = vi.fn()
    renderModal({ onSaved })

    await user.type(screen.getByLabelText(/体重/), '71.6')
    await user.type(screen.getByLabelText(/体脂率/), '22.9')
    await user.type(screen.getByLabelText(/骨骼肌量/), '31.1')
    await user.type(screen.getByLabelText(/脂肪量/), '16.4')
    await user.type(screen.getByLabelText(/内脏脂肪等级/), '5')

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(upsertSpy).toHaveBeenCalledOnce()
    const [, payload] = upsertSpy.mock.calls[0]
    expect(payload.weight_kg).toBe(71.6)
    expect(payload.visceral_fat_level).toBe(5)
    expect(payload.segments).toBeUndefined()  // no segments filled
    expect(onSaved).toHaveBeenCalledOnce()
  })
```

- [ ] **Step 5.15: Add test for same-date overwrite confirm**

```typescript
  it('prompts for overwrite when scan_date already exists', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal({ existingDates: new Set(['2026-05-20']) })

    // Change the default scanDate (which is today) to a date that's in existingDates
    const dateInput = screen.getByLabelText(/扫描日期/) as HTMLInputElement
    await user.clear(dateInput)
    await user.type(dateInput, '2026-05-20')

    await user.type(screen.getByLabelText(/体重/), '71.6')
    await user.type(screen.getByLabelText(/体脂率/), '22.9')
    await user.type(screen.getByLabelText(/骨骼肌量/), '31.1')
    await user.type(screen.getByLabelText(/脂肪量/), '16.4')
    await user.type(screen.getByLabelText(/内脏脂肪等级/), '5')

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2026-05-20'))
    expect(upsertSpy).not.toHaveBeenCalled()  // confirm returned false
  })
```

- [ ] **Step 5.16: Run all frontend tests**

```bash
cd frontend && npm test
```
Expected: all green.

- [ ] **Step 5.17: Commit**

```bash
git add -A
git commit -m "feat(body-composition): add manual entry modal

New BodyCompositionEntryModal component reached from the + 录入新数据
button on BodyCompositionPage. Validates the 5 required main metrics
against model ranges, enforces all-or-none on segments, and prompts
before overwriting an existing scan date. Submits to POST
/api/{user}/body-composition (existing endpoint)."
```

---

## Task 6: CLI rename

**Files:**
- Modify: `src/coros_sync/cli.py`

- [ ] **Step 6.1: Rename Click group + commands**

Find the `@cli.group() def inbody():` declaration around line 492. Replace:

```python
@cli.group()
def body_composition() -> None:
    """Manage body-composition scans (local DB + push to prod)."""
```

Click maps the underscore group name to the kebab-case CLI command `body-composition` automatically.

Rename helper functions and subcommand decorators:

```python
@body_composition.command("add")
@click.option("--from-json", "json_path", required=True, type=click.Path(exists=True, dir_okay=False),
              help="Path to a JSON file matching the body-composition scan schema.")
@click.pass_context
def body_composition_add_cmd(ctx: click.Context, json_path: str) -> None:
    """Validate and upsert a scan into the local DB."""
    ...

@body_composition.command("push")
@click.argument("scan_date")
@click.option("--url", default=None, envvar="STRIDE_PROD_URL", ...)
@click.pass_context
def body_composition_push_cmd(ctx: click.Context, scan_date: str, url: str | None) -> None:
    ...

@body_composition.command("list")
...
def body_composition_list_cmd(...) -> None:
    ...
```

And the table-rendering helper `_render_inbody_table` → `_render_body_composition_table`, title from `"InBody scans"` → `"Body Composition scans"`.

- [ ] **Step 6.2: Update DB method calls + push endpoint URL inside CLI**

In each subcommand body, replace remaining `db.upsert_inbody_scan` / `db.get_inbody_scan` / `db.get_inbody_segments` / `db.list_inbody_scans` (these should already be renamed by Task 1, but spot-check).

The push endpoint:
```python
    endpoint = f"{url.rstrip('/')}/api/{profile}/body-composition"
```
(Replacing `/api/{profile}/inbody` around line 603.)

- [ ] **Step 6.3: Run pytest (CLI smoke if any)**

```bash
PYTHONPATH=src pytest tests/ -v 2>&1 | tail -10
```
Expected: green.

- [ ] **Step 6.4: Smoke the CLI manually**

```bash
PYTHONIOENCODING=utf-8 python -m coros_sync body-composition --help
```
Expected: subcommand list shows `add / push / list` with body-composition group name.

- [ ] **Step 6.5: Commit**

```bash
git add -A
git commit -m "refactor(body-composition): rename CLI command group

coros-sync inbody → coros-sync body-composition. Subcommand names
(add/push/list) unchanged. Push endpoint URL updated. No alias for the
old name (intentional per spec — full rename, not deprecation)."
```

---

## Task 7: Structured-data file rename

**Files:**
- `git mv` all `data/*/logs/*/inbody.json` → `body-composition.json`

- [ ] **Step 7.1: List the files that will be renamed**

```bash
git ls-files "data/*/logs/*/inbody.json"
```
Expected output: ~3-5 paths.

- [ ] **Step 7.2: Batch rename via PowerShell + `git mv`**

```powershell
git ls-files "data/*/logs/*/inbody.json" |
  ForEach-Object { git mv $_ ($_ -replace 'inbody\.json$', 'body-composition.json') }
```

(If running from POSIX bash inside Git Bash, equivalent: `for f in $(git ls-files "data/*/logs/*/inbody.json"); do git mv "$f" "${f%inbody.json}body-composition.json"; done`)

- [ ] **Step 7.3: Verify**

```bash
git status --short
```
Expected: a list of `R` (renamed) entries — one per pre-existing file. No new file content changes.

- [ ] **Step 7.4: Commit**

```bash
git commit -m "refactor(body-composition): rename structured data files

git mv data/*/logs/*/inbody.json → body-composition.json. History is
preserved via the rename. The .jpg photo files keep their inbody.jpg
naming (free-text jpg_path column allows any naming convention)."
```

---

## Task 8: Workflow + docs term substitution

**Files:**
- Modify: `.github/workflows/sync-data.yml`
- Modify: `CLAUDE.md`
- Modify: `.github/copilot-instructions.md`
- Modify: `spec/app_scope_analysis.md`
- Modify: `data/privacy.md`

- [ ] **Step 8.1: Update `.github/workflows/sync-data.yml`**

In the `paths:` block (around lines 17–22):

```yaml
    paths:
      - 'src/coros_sync/**'
      - 'data/*/coros.db'
      - 'data/*/logs/**/*.md'
      - 'data/*/logs/**/*.json'
      - 'data/*/logs/**/inbody.*'              # legacy + photo files
      - 'data/*/logs/**/body-composition.*'    # new structured data + future renames
      - 'data/*/TRAINING_PLAN.md'
      - 'data/*/status.md'
```

In the az-storage upload steps (around lines 108–127):

```yaml
              # Body-composition photos and structured data
              az storage file upload-batch \
                --account-name authstorage2026 \
                --share-name "$share" \
                --destination-path "$user/logs" \
                --source "$user_dir/logs" \
                --pattern "*/inbody.*" \
                --output none

              az storage file upload-batch \
                --account-name authstorage2026 \
                --share-name "$share" \
                --destination-path "$user/logs" \
                --source "$user_dir/logs" \
                --pattern "*/body-composition.*" \
                --output none
```

(And the matching `blob upload-batch` step gets the same dual-pattern treatment.)

- [ ] **Step 8.2: Term-substitute in `CLAUDE.md`**

Use Grep to find "InBody" mentions:
```bash
grep -n "InBody\|InBody\|inbody" CLAUDE.md
```

For each narrative occurrence (not file paths, not the storage-rule table), rephrase to "body composition / 体测". Specifically the line `4.  **InBody 报告含...** → InBody...` becomes "**体测报告含...**" with brand-neutral phrasing.

The `data/{user_id}/logs/...` example block needs updating: `inbody.json` reference → `body-composition.json`.

- [ ] **Step 8.3: Term-substitute in `.github/copilot-instructions.md`**

Same substitution pattern as CLAUDE.md. Grep + rephrase.

- [ ] **Step 8.4: Term-substitute in `spec/app_scope_analysis.md`**

Same.

- [ ] **Step 8.5: Term-substitute in `data/privacy.md`**

Same.

- [ ] **Step 8.6: Commit**

```bash
git add -A
git commit -m "docs(body-composition): term substitution + workflow patterns

CLAUDE.md, copilot-instructions, spec docs, privacy.md all use
'body composition / 体测' instead of brand-specific 'InBody'.
sync-data.yml watches both inbody.* (legacy photos) and
body-composition.* (new structured data + future photos)."
```

---

## Task 9: Final consistency sweep + smoke

- [ ] **Step 9.1: Full-repo grep for residuals**

```bash
PYTHONPATH=src python -c "import subprocess; print(subprocess.run(['git','grep','-i','inbody'], capture_output=True, text=True).stdout)" | head -80
```

Or via Grep tool: `pattern: "inbody|InBody|Inbody"`.

Acceptable residuals (allowlist):
- `inbody_score` column references in `src/stride_core/db.py` SCHEMA, model field, API client type, page table cell, modal optional input — brand-specific reading
- `inbody.*` pattern in `.github/workflows/sync-data.yml` for legacy photo files
- This plan + spec under `docs/superpowers/`
- User-private markdown: `data/*/TRAINING_PLAN.md`, `data/*/logs/*/plan.md`, `data/*/logs/*/feedback.md`
- Git history (unchanged commit messages)

Any other match → fix and amend.

- [ ] **Step 9.2: Run the full test matrix**

```bash
PYTHONPATH=src pytest tests/ -v 2>&1 | tail -20
PYTHONPATH=src lint-imports
cd frontend && npm test
cd ..
```
Expected: all three green.

- [ ] **Step 9.3: Manual smoke test — local dev server**

```bash
# Terminal 1 — backend
PYTHONPATH=src python -m uvicorn stride_server.app:app --reload

# Terminal 2 — frontend
cd frontend && npm run dev
```

Then in a browser:
1. Open `http://localhost:5173/body-composition` — confirm existing scans render (if any user has data).
2. Click `+ 录入新数据` — modal opens.
3. Fill required fields with values close to last scan (e.g. weight 71.6, bf 22.9, smm 31.1, fat 16.4, vfl 5), set scan_date to today, click 保存.
4. Modal closes, new row appears in the table, latest-scan summary card updates.
5. Open modal again with same date → confirm dialog `该日期 2026-05-20 已有数据，覆盖？` appears.

- [ ] **Step 9.4: DB migration verification**

```bash
# Copy a prod-style db to a sandbox path
cp data/<some_user>/coros.db /tmp/coros-test.db

# Open via Database class
PYTHONPATH=src python -c "
from pathlib import Path
from stride_core.db import Database
with Database(Path('/tmp/coros-test.db')) as db:
    tables = {r[0] for r in db._conn.execute(
        \"SELECT name FROM sqlite_master WHERE type='table'\"
    ).fetchall()}
    assert 'body_composition_scan' in tables
    assert 'inbody_scan' not in tables
    print('migration OK; tables:', sorted(tables))
"
```
Expected: prints `migration OK; tables: [..., 'body_composition_scan', 'body_composition_segment', ...]`.

- [ ] **Step 9.5: Open PR**

```bash
git push -u origin worktree-inbody-manual-entry
gh pr create --title "body-composition: brand-neutral rename + manual entry UI" --body "$(cat <<'EOF'
## Summary

- Renames the InBody-named body-composition module to brand-neutral `body-composition` across API routes, DB tables, frontend page/types/client, CLI, coach tool registry, and structured-data files.
- Adds a manual data entry modal on `BodyCompositionPage` (5 required main metrics + 5 optional + 5 segments × 4, with all-or-none segment rule and same-date overwrite confirm).
- DB migration is idempotent `ALTER TABLE RENAME` in `_migrate()` — runs on next `Database()` open per user. No downtime, no script.

Squash-merged: keeps the rename + feature as a single commit on `master`.

Reference: `docs/superpowers/specs/2026-05-20-body-composition-rename-and-manual-entry-design.md`

## Test plan

- [ ] `PYTHONPATH=src pytest tests/` green (including new migration test + route smoke)
- [ ] `PYTHONPATH=src lint-imports` clean (coach layering preserved)
- [ ] `cd frontend && npm test` green (page + modal tests)
- [ ] Manual smoke: open `/body-composition`, enter a new scan via the modal, confirm it appears and overwrites correctly
- [ ] DB migration verified against a copy of an existing user's `coros.db`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Use the squash-merge button on the PR to land it as one commit on `master`.

---

## Self-Review Checklist (run before declaring plan complete)

1. **Spec coverage:**
   - Naming map (all 13 rows) → Tasks 1–8 cover each dimension. ✓
   - DB migration code → Task 1, Steps 1.3 + 1.4. ✓
   - Backend route rename → Task 2. ✓
   - Coach layer rename → Task 3. ✓
   - Frontend rename → Task 4. ✓
   - Manual entry modal (form structure, validation, segment rule, overwrite, refresh) → Task 5, Steps 5.1–5.17. ✓
   - CLI rename → Task 6. ✓
   - JSON file rename → Task 7. ✓
   - sync-data.yml workflow → Task 8, Step 8.1. ✓
   - Markdown docs (CLAUDE.md, copilot, app_scope, privacy) → Task 8, Steps 8.2–8.5. ✓
   - Final consistency + smoke → Task 9. ✓

2. **Placeholder scan:** No TBD, TODO, "implement later", "similar to Task N", "add error handling" left. Inline notes that read like placeholders (e.g. "rest of function body unchanged" in Step 2.2) are accompanied by enough context to identify the change — these are acceptable per the convention of showing only the diff for large unchanged blocks.

3. **Type / signature consistency:**
   - `getBodyComposition` / `getBodyCompositionSummary` / `getBodyCompositionScan` / `upsertBodyComposition` — used consistently across Steps 4.1, 4.2, 5.1, 5.7, 5.11. ✓
   - `BodyCompositionScan` / `BodyCompositionScanInput` / `BodyCompositionSummary` — consistent. ✓
   - Database methods `*_body_composition_*` — consistent across db.py, state_stores, routes, cli, coach adapters.
   - `has_body_composition` field — consistent in api.ts, weeks.py, and frontend tests.
