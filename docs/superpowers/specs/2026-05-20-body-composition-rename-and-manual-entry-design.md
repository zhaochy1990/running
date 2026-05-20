# Body Composition Module — Rename + Manual Entry

**Date**: 2026-05-20
**Branch**: `worktree-inbody-manual-entry` (from `origin/master`)
**Status**: design approved, plan pending

## Summary

Two bundled changes shipped as **one PR, one squash commit** (Approach B):

1. **Rename** the InBody-branded body-composition module to brand-neutral `body-composition`. The 体测 feature should support any brand of body-composition analyzer (Tanita, Omron, InBody, etc.), so brand-specific identifiers leak abstraction.
2. **Add manual data entry** via a modal form on the renamed `BodyCompositionPage`. The backend `POST /api/{user}/body-composition` endpoint already accepts a JSON payload — the gap is purely UI access. Today users must hand-craft a JSON file and run `coros-sync inbody add --from-json`, which is developer-only friction.

## Goals

- Brand-neutral identifiers across API, page, DB tables, CLI, structured-data files, and coach tool registry.
- Web-form path to enter a full body-composition scan (5 main metrics + 5 optional + 5 segments × 4 fields) without leaving the dashboard.
- Existing `coros.db` instances (dev local + Azure Files prod) auto-migrate on next connection open. No downtime, no manual script.
- All test suites green; `lint-imports` clean.

## Non-goals (v1)

- Multi-brand schema adapters (Tanita and Omron output different field sets — out of scope; v1 schema stays InBody-shaped).
- Dedicated edit/delete UI (upsert-on-same-date is the edit path; delete is rare and goes via CLI/SQL).
- JPG upload through the form (CLI flow continues to set `jpg_path`).
- `entry_source` provenance column (`manual` vs `scanned`).
- Renaming the `inbody_score` column (it's a brand-specific reading; other analyzers leave it `null`).
- Editing user-private markdown (`TRAINING_PLAN.md`, `logs/*/plan.md`).
- Migrating body-composition data out of `coros.db` into Azure Table (a separate question — see *Known deviation* below).

## Naming map

| Dimension | Before (inbody) | After (body-composition) |
|-----------|-----------------|---------------------------|
| API routes | `/api/{user}/inbody`, `/inbody/summary`, `/inbody/{scan_date}` | `/api/{user}/body-composition`, `/body-composition/summary`, `/body-composition/{scan_date}` |
| Route module | `src/stride_server/routes/inbody.py` | `src/stride_server/routes/body_composition.py` |
| Deps helper | `get_inbody_store(user)` | `get_body_composition_store(user)` |
| Store methods | `list_inbody_scans`, `latest_inbody_scan`, `inbody_scan_before`, `get_inbody_scan`, `get_inbody_segments`, `upsert_inbody_scan` | `list_body_composition_scans`, `latest_body_composition_scan`, `body_composition_scan_before`, `get_body_composition_scan`, `get_body_composition_segments`, `upsert_body_composition_scan` |
| DB tables | `inbody_scan`, `inbody_segment` (singular, per existing convention) | `body_composition_scan`, `body_composition_segment` |
| Frontend page | `frontend/src/pages/InbodyPage.tsx`, route `/inbody` | `frontend/src/pages/BodyCompositionPage.tsx`, route `/body-composition` |
| Frontend types | `InBodyScan`, `InBodySummary`, `InBodyDeltas`, `InBodyCheckpoint` | `BodyCompositionScan`, `BodyCompositionSummary`, `BodyCompositionDeltas`, `BodyCompositionCheckpoint` |
| Frontend API client | `getInbody`, `getInbodySummary`, `getInbodyScan` | `getBodyComposition`, `getBodyCompositionSummary`, `getBodyCompositionScan` |
| CLI commands | `coros-sync inbody {add,push,list}` | `coros-sync body-composition {add,push,list}` |
| Structured-data files | `data/{user_id}/logs/*/inbody.json` | `data/{user_id}/logs/*/body-composition.json` (via `git mv`) |
| Telemetry route name | `['/inbody', 'InBody']` | `['/body-composition', 'BodyComposition']` |
| Weeks-summary field | `has_inbody: boolean` | `has_body_composition: boolean` |
| Coach tool registry | `get_inbody_latest`, `GetInbodyLatest` protocol | `get_body_composition_latest`, `GetBodyCompositionLatest` |

**Kept unchanged**:

- Python class `BodyCompositionScan` — already brand-neutral.
- `BodySegment` class — already brand-neutral.
- Column `inbody_score` — brand-specific InBody machine reading; other analyzers omit it (`null`).
- Chinese UI strings 「体测」「身体成分」— already brand-neutral.
- Photo files `data/{user_id}/logs/*/inbody.jpg` — user's photo-naming habit; `jpg_path` is a free-text column.

## DB migration

**Constraints**:

- `PRAGMA foreign_keys=OFF` globally → the `REFERENCES inbody_scan(scan_date)` FK in `inbody_segment` is documentation-only at runtime.
- SQLite ≥ 3.25 `ALTER TABLE … RENAME TO …` auto-rewrites FK reference text in child schemas.
- Existing `_migrate()` in `src/stride_core/db.py` runs on every `Database()` open; each step swallows "already done" errors for idempotency under concurrent connections.

**Migration code** (added to `_migrate()` after the existing `_add(…)` calls):

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
        pass  # race-condition swallow

# Parent before child so SQLite rewrites the child's FK text in place.
_rename("inbody_scan",    "body_composition_scan")
_rename("inbody_segment", "body_composition_segment")
```

**SCHEMA constant**: `CREATE TABLE IF NOT EXISTS inbody_scan` and `inbody_segment` rename to the new names, including the FK reference text in `body_composition_segment`. Fresh DBs land on the new schema directly.

**Old `_add("inbody_segment", "fat_pct_of_standard", "REAL")`**: update to `_add("body_composition_segment", "fat_pct_of_standard", "REAL")`. The old-name call would now hit the `if not cols: return` early-exit since the table no longer exists by that name.

**No-downtime guarantee**: at next `Database()` open per-user, the rename runs in the same transaction as the schema seed. Subsequent reads/writes hit the new table name. Azure Files SMB workflow (seed-in-tmp-then-move) is unaffected because migration runs on already-existing DBs, not fresh-seed.

**Rollback**: single squash commit → `git revert` restores all code paths, but renamed DB tables remain. Recovery is `ALTER TABLE body_composition_scan RENAME TO inbody_scan` (and segment), or `git revert` followed by adding a temporary reverse-rename step. We accept the asymmetry given dev-test gating.

## Backend changes

**`src/stride_core/db.py`**:

- SCHEMA constant: rename two `CREATE TABLE` blocks (table name + FK text).
- `_migrate()`: add `_rename` helper + two calls (above).
- Update `_add("inbody_segment", "fat_pct_of_standard", …)` → new table name.
- Rename all six methods: `list_inbody_scans` → `list_body_composition_scans`, `latest_inbody_scan` → `latest_body_composition_scan`, `inbody_scan_before` → `body_composition_scan_before`, `get_inbody_scan` → `get_body_composition_scan`, `get_inbody_segments` → `get_body_composition_segments`, `upsert_inbody_scan` → `upsert_body_composition_scan`.

**`src/stride_core/state_stores.py`**: store interface — same method renames.

**`src/stride_server/routes/inbody.py` → `routes/body_composition.py`** (git mv):

- Route paths `/api/{user}/inbody*` → `/api/{user}/body-composition*`.
- Function renames: `list_inbody` → `list_body_composition`, `inbody_summary` → `body_composition_summary`, `get_inbody` → `get_body_composition`, `upsert_inbody` → `upsert_body_composition`.
- POST endpoint logic unchanged — already accepts `BodyCompositionScan.from_dict()` payload. Form submits land here.

**`src/stride_server/deps.py`**: `get_inbody_store` → `get_body_composition_store`.

**`src/stride_server/app.py`**: router import + `include_router` call updated.

**`src/stride_server/routes/weeks.py`**: returned field `has_inbody` → `has_body_composition`; file-existence probe pattern changes from `inbody{ext}` to `body-composition{ext}`.

**Coach layer** — single-commit-cutover requires the LLM tool-registry strings to flip atomically with prompt files:

- `src/coach/tools/protocols.py`: `GetInbodyLatest` Protocol class → `GetBodyCompositionLatest`; tool registry list `"get_inbody_latest"` → `"get_body_composition_latest"`.
- `src/coach/runtime/toolkit.py`: import + dataclass field renamed.
- `src/coach/graphs/conversation/tool_bridge.py`: tool name string + description ("Latest body composition scan + delta…").
- `src/coach/graphs/conversation/prompts/master_chat.py`, `week_chat.py`: tool-list bullet renamed (`get_body_composition_latest — 体测数据`).
- `src/coach_agent/context.py`, `tools.py`, `agent.py`: import + method references.
- `src/stride_server/coach_adapters/toolkit.py`, `tool_impls/read_impls.py`: adapter wire-up.

## Frontend changes

**Renames** (mechanical):

- `frontend/src/api.ts`: types + functions + fetch paths; `has_inbody` → `has_body_composition`.
- `frontend/src/pages/InbodyPage.tsx` → `BodyCompositionPage.tsx` (git mv); component name + chart subtitle "InBody Body Composition — N 次扫描" → "身体成分 — N 次扫描".
- `frontend/src/App.tsx`: route path `/inbody` → `/body-composition`.
- `frontend/src/components/AppLayout.tsx`: nav link path.
- `frontend/src/lib/breadcrumb.ts`: path key (`'/inbody'` → `'/body-composition'`); current label 「体测记录」 retained.
- `frontend/src/telemetry/routeNames.ts` + its test: pair entry.
- `frontend/src/pages/__tests__/WeekLayoutCalendar.test.tsx`, `HealthPage.test.tsx`: fixture field renamed.

**New: manual entry modal**

`BodyCompositionPage` gains a "+ 录入新数据" button (accent-amber, top-right of `ViewHead`). Clicking opens a modal:

```
┌─────────────────────────────────────────┐
│  录入体测数据                       [X] │
│  Body Composition Manual Entry          │
├─────────────────────────────────────────┤
│  扫描日期 *  [ 2026-05-20 ▼ ]           │
│                                         │
│  ── 主指标 (必填) ──                    │
│  体重 (kg)        *  [______]          │
│  体脂率 (%)       *  [______]          │
│  骨骼肌量 (kg)    *  [______]          │
│  脂肪量 (kg)      *  [______]          │
│  内脏脂肪等级     *  [______]          │
│                                         │
│  ▼ 可选指标 (5)   [folded]              │
│    BMR (kcal) / 蛋白 (kg) / 水分 (L)    │
│    SMI / InBody Score                   │
│                                         │
│  ▼ 节段数据 (5×4 = 20)  [folded]        │
│    table: left_arm/right_arm/trunk/     │
│           left_leg/right_leg            │
│    cols: 肌肉 kg / 脂肪 kg /            │
│          肌肉 % 标准 / 脂肪 % 标准      │
│                                         │
│  [取消]                          [保存] │
└─────────────────────────────────────────┘
```

**UX rules**:

- `scan_date` default: `shanghaiToday()` from `frontend/src/lib/shanghai.ts`. User-editable (`<input type="date">`).
- Optional + Segments sections **folded by default** — minimum-entry user fills 5 required main metrics + saves.
- Segment rule: **all five segments filled** or **all five empty**. Partially-filled segments → inline error before submit; segments either feed `BodyCompositionScan.segments` (all 5) or omit the key entirely.
- Same-date submit: backend upserts silently (existing behavior). UI checks scan-date against current `scans` list; if a row exists, prompt 「该日期已有数据，覆盖？」 before submit.
- Submit success → close modal → re-fetch `getBodyComposition()` + `getBodyCompositionSummary()` → list and charts refresh.
- 422 from backend (model validation): error text shown at modal footer, modal stays open, fields keep values.
- Cancel discards in-progress input without confirm (low cost, low surprise).

**Empty-state copy**:

```tsx
{!latest && (
  <div className="...">
    暂无体测数据。点击右上「+ 录入新数据」开始录入，
    或使用 <code>coros-sync body-composition add</code> 批量导入 JSON。
  </div>
)}
```

## CLI rename + JSON file rename

**`src/coros_sync/cli.py`**:

- `@cli.group() def inbody():` → `def body_composition():`. Click maps to `body-composition` subcommand.
- Subcommand functions: `inbody_add_cmd` → `body_composition_add_cmd`, etc.
- `db.get_inbody_scan` etc. → new names per Section 3.
- Push endpoint URL: `/api/{profile}/inbody` → `/api/{profile}/body-composition`.
- Display table title "InBody scans" → "Body Composition scans".
- No `inbody` alias retained.

**JSON file rename** (single batch operation):

```powershell
git ls-files "data/*/logs/*/inbody.json" |
  ForEach-Object { git mv $_ ($_ -replace 'inbody\.json$', 'body-composition.json') }
```

Estimated ~3-5 files based on `data/f10bc353-…/logs/` scan. `git mv` preserves history.

**`inbody.jpg` photo files**: untouched. The `jpg_path` column stores free-text relative paths, so any naming the user chooses (`inbody.jpg`, `tanita.jpg`, etc.) continues to work.

## Workflow & docs

**`.github/workflows/sync-data.yml`** (path triggers + az upload patterns):

```yaml
paths:
  - 'data/*/logs/**/*.md'
  - 'data/*/logs/**/*.json'                      # body-composition.json picked up here
  - 'data/*/logs/**/inbody.*'                    # legacy + photo files
  - 'data/*/logs/**/body-composition.*'          # future photo renames + new json
```

`az storage file/blob upload-batch` `--pattern` arguments add the new pattern alongside `*/inbody.*`. Inline comment "# InBody photos" → "# Body-composition photos and structured data".

**Markdown docs** (term substitution only, no path rewrites):

- `CLAUDE.md`: rephrase any narrative "InBody" → "body composition / 体测".
- `.github/copilot-instructions.md`: same.
- `spec/app_scope_analysis.md`: same.
- `data/privacy.md`: same.

User-private markdown (`data/*/TRAINING_PLAN.md`, `logs/*/plan.md`) is **not** modified.

## Testing

**Existing test renames**:

- `tests/test_inbody_db.py` → `test_body_composition_db.py`: file rename + all `db.*_inbody_*` references switched. Class `TestInBodyUpsert` → `TestBodyCompositionUpsert`.
- `tests/test_inbody_models.py` → `test_body_composition_models.py`: rename (model class name unchanged inside).
- `tests/test_state_stores.py`, `tests/coach_adapters/test_read_impls.py`, `tests/coach/stubs/fake_toolkit.py`: method-name references updated.

**New: migration test** (in `test_body_composition_db.py`):

```python
def test_migration_renames_legacy_tables(tmp_path):
    db_path = tmp_path / "coros.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE inbody_scan (
            scan_date TEXT PRIMARY KEY, weight_kg REAL NOT NULL,
            body_fat_pct REAL NOT NULL, smm_kg REAL NOT NULL,
            fat_mass_kg REAL NOT NULL, visceral_fat_level INTEGER NOT NULL);
        CREATE TABLE inbody_segment (
            scan_date TEXT, segment TEXT, lean_mass_kg REAL, fat_mass_kg REAL,
            PRIMARY KEY (scan_date, segment));
        INSERT INTO inbody_scan VALUES ('2026-04-23', 71.6, 22.9, 31.1, 16.4, 5);
    """)
    conn.commit()
    conn.close()
    with Database(path=db_path) as db:
        scan = db.get_body_composition_scan("2026-04-23")
        assert scan is not None
        assert scan["weight_kg"] == 71.6
        tables = {r[0] for r in db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert "inbody_scan" not in tables
        assert "body_composition_scan" in tables
```

**New: route smoke** (location follows existing route-test convention; if none, add `tests/stride_server/test_body_composition_routes.py`):

- POST valid payload → 200 + row queryable via store.
- POST missing required metric → 422 + error detail.

**New: frontend tests** at `frontend/src/pages/__tests__/BodyCompositionPage.test.tsx`. The codebase already has `__tests__` siblings for other pages (`HealthPage.test.tsx`, `WeekLayoutCalendar.test.tsx`) — same convention. Cases:

- Empty state renders "+ 录入新数据" button.
- Click opens modal.
- Required-field validation blocks submit (5 main metrics non-empty, positive numbers).
- Segment all-or-none rule fires on partial input.
- Same-date overwrite prompt fires when `scan_date` already present in `scans`.
- Successful submit closes modal, calls `getBodyComposition` + `getBodyCompositionSummary` to refresh.

## Final consistency checklist (run during implementation)

- [ ] `Grep` whole-repo `inbody|InBody|Inbody`: residual matches limited to (a) git-history only commits, (b) the `inbody_score` column references, (c) `inbody.jpg`-pattern lines in `sync-data.yml`, (d) user-private markdown narrative, (e) this design doc itself.
- [ ] `pytest tests/ -k "body_composition or inbody"` green.
- [ ] `cd frontend && npm test` green.
- [ ] `PYTHONPATH=src lint-imports` clean.
- [ ] Manual smoke: local server → `/body-composition` shows existing data → "+ 录入新数据" → submit → new row appears.
- [ ] DB migration: open a prod `coros.db` backup with new code → tables renamed, data intact.

## Known deviation (flagged, not fixed in this PR)

`CLAUDE.md` "Storage scope rule (HARD)" reserves per-user `coros.db` for watch-synced 运动数据. Body-composition scans are entered manually (from an external machine), so strictly they should live in **Azure Table Storage** (PartitionKey=`user_id`, RowKey=`scan_date`). The current implementation puts them in `coros.db`, and this PR continues that pattern (rename is mechanical, not architectural). A future ticket should evaluate migrating body-composition rows out of SQLite into Azure Table — captured here as a known deviation, not addressed.
