# STRIDE Plan Viewer

Single-file, zero-dependency HTML tool to read coach-generated plan JSON as a UI.

## Use

Open `index.html` in a browser (double-click, or serve it), then **drag in** or
**select** a JSON file. The type is auto-detected:

| JSON | Detected as | Renders |
|---|---|---|
| `season_bundle_draft.json` (`SeasonPlanBundle`) | **Season** | per-phase cards · weekly-km ramp bar · per-phase review verdict + commentary · expandable weeks → sessions + nutrition |
| `master_plan_draft.json` (`MasterPlan`) | **Master** | phase timeline (type / dates / km band / focus / key sessions) · quantifiable milestones · training principles |
| `logs/.../plan.json` (`WeeklyPlan`) | **Week** | sessions (run pace/distance, structured strength specs with COROS T-codes) + nutrition macros |

Detection keys off shape (`phases[].weeks` → season, `milestones`+`phases` →
master, `sessions`+`week_folder` → week), so unsaved/draft JSON works too.

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
