# Personal Bests — Activity Name + Link

**Date:** 2026-06-21
**Status:** Approved (design)

## Goal

In the `/ability` Personal Bests table, each PB row should show the **name** of
the activity where the PB was set, rendered as a **link** to that activity's
detail page. The activity name itself is the clickable link (one new column).

## Context

- The PB table (`frontend/src/components/AbilityPBTable.tsx`) shows: 距离 · 成绩 ·
  配速 · 日期. Each `PBEntry` already carries `label_id` (the source activity id).
- Single activities are routed at `/activity/:id` (`frontend/src/App.tsx`), where
  `:id` is the `label_id`. `ActivitiesPage` links the same way:
  `<Link to={\`/activity/${activity.label_id}\`}>`. This id works for both COROS
  and Garmin (`label_id` is the activities table primary key).
- The activity `name` is **not** currently in the PB payload. The detector's SQL
  (`pb_records.py`) already `SELECT`s `name` from `activities`, but it is never
  threaded into `BestEffortCandidate` → `pb_entry()` → the Pydantic `PBEntry` →
  the frontend type. `activities.name` is `TEXT` (nullable) but almost always
  populated by watch sync.

## Changes

### Backend — `src/stride_core/pb_records.py`

- Add `name: str | None = None` to the `BestEffortCandidate` dataclass, placed
  after the required fields and before the `segment_start_s`/`segment_end_s`
  defaults (so all defaulted fields stay at the end).
- Populate `name=_get(activity, "name")` at **both** candidate-creation sites:
  the segment path in `best_effort_candidates_for_activity` and the activity-level
  fallback in `_activity_level_candidates` (both already have the `activity` row).
- Emit `"name": self.name` in `BestEffortCandidate.pb_entry()`.

Name flows automatically through `detect_personal_bests` (which builds entries via
`pb_entry()`) and the legacy `_detect_pbs` wrapper. `history_point()` does **not**
need `name`.

### Backend — `src/stride_server/routes/pbs.py`

- Add `name: str | None = None` to the `PBEntry` Pydantic model.

Additive and nullable → existing route tests are unaffected.

### Frontend — `frontend/src/api.ts`

- Add `name: string | null` to the `PBEntry` interface.

### Frontend — `frontend/src/components/AbilityPBTable.tsx`

- Add a left-aligned **运动 / Activity** column header after 日期.
- For a row with a PB entry, render the name as a React Router `<Link>`:
  - `to={\`/activity/${entry.label_id}\`}` (same-tab SPA navigation).
  - class `font-mono text-accent-green hover:opacity-75 transition-opacity`.
  - `title={entry.name ?? undefined}` for the full text on hover.
  - Link text = `entry.name`, falling back to `查看` when `name` is null/empty so
    the link is still usable.
- Rows with no PB entry render `—` in this column (unchanged pattern).
- `Link` is imported from `react-router-dom` (the component currently imports
  nothing from the router).

### Tests

- `tests/stride_server/test_pbs.py`: extend a seeded activity with a `name` and
  assert the `/pbs` response carries it on the matching `PBEntry`. Confirm a row
  whose source activity has no `name` returns `name: null` (does not error).

## Decisions (locked)

- The activity **name is the link** (not name-as-text + a separate link icon).
- New column is the **last** column (after 日期).
- **Same-tab** in-app navigation (matches `ActivitiesPage`), not a new browser tab.

## Out of scope

- No change to the activity detail page itself.
- No backend schema/migration (column already exists).
- PB segment links point at the *whole* source run's detail page (correct — that
  run contains the best-effort segment); no segment deep-linking.
