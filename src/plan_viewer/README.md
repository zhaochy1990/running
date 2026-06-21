# STRIDE Plan Viewer

Single-file, zero-dependency HTML tool to read coach-generated plan JSON as a UI.

## Use

Open `index.html` in a browser (double-click, or serve it). Either **open a
local folder** from the left sidebar (recommended) or **drag in / select** a
single JSON file. The type is auto-detected:

| JSON | Detected as | Renders |
|---|---|---|
| `season_bundle_draft.json` (`SeasonPlanBundle`) | **Season** | per-phase cards · weekly-km ramp bar · per-phase review verdict + commentary · expandable weeks → sessions + nutrition |
| `master_plan_draft.json` (`MasterPlan`) | **Master** | phase timeline (type / dates / km band / focus / key sessions) · quantifiable milestones · training principles |
| `logs/.../plan.json` (`WeeklyPlan`) | **Week** | sessions (run pace/distance, structured strength specs with COROS T-codes) + nutrition macros |

Detection keys off shape (`phases[].weeks` → season, `milestones`+`phases` →
master, `sessions`+`week_folder` → week), so unsaved/draft JSON works too.

## Folder sidebar (VSCode-style)

Click **📁 打开文件夹** in the left sidebar, pick a local directory (e.g.
`data/<uid>/testing/runs/`), and the viewer recursively lists every `.json` plan
in a collapsible file tree. Click a file to render it; ↻ re-scans the folder
after you regenerate plans. Files are tagged `M`/`S`/`W` (master / season /
week) by name.

Powered by the **File System Access API** (`showDirectoryPicker`) — the picked
directory handle is stored in IndexedDB, so on reload the folder is restored
automatically (one permission click if the browser dropped the grant). This API
needs a **secure context**: serve over `localhost`
(`python -m http.server` → `http://localhost:8000/src/plan_viewer/index.html`).
On `file://` or unsupported browsers it falls back to a one-shot
`<input webkitdirectory>` directory picker (no auto-restore).

## Single-file drag/drop (recents)

Dragging in or selecting a single JSON remembers it in `localStorage` under the
**file's name** (sans `.json`) and lists it under **最近拖入** in the sidebar, so
you can hold several one-off plans without re-loading. 🗑 removes a record (local
only — never touches files on disk). Re-loading a same-named file updates the
entry in place rather than duplicating it.

## Notes

- Pure client-side: the file never leaves the browser. No build, no server
  required for the file-picker path.
- `file://` is fine for the picker/drop. If a browser blocks `file://` for a
  helper flow, serve the repo: `python -m http.server` then open
  `http://localhost:8000/src/plan_viewer/index.html`.
- Handles the misnamed `activities.distance_m` convention (`<500` = km, else
  meters) when computing weekly km + pace, matching the backend.
- Generate the inputs with `scripts/gen_my_master_plan.py` (master plan) and
  `scripts/gen_my_season.py` (season bundle).
