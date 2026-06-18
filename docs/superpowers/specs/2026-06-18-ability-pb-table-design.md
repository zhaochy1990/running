# Ability Page — Personal Bests Table

**Date:** 2026-06-18
**Status:** Approved (design)

## Goal

Add a personal-best (PB) table to the bottom of the `/ability` page showing the
user's best efforts for **six** distances: **1K, 3K, 5K, 10K, half marathon,
full marathon**.

## Context

The repo already has a complete PB backend:

- `src/stride_core/pb_records.py` — `detect_personal_bests(db)` scans all running
  activities chronologically and finds the fastest continuous segment for each
  canonical distance (segment-based detection over timeseries, with an
  activity-level distance-match fallback for rows lacking usable timeseries).
- `GET /api/{user}/pbs` (`src/stride_server/routes/pbs.py`) returns a structured
  `PBsResponse` (current PB time, date achieved, source activity, per-distance
  history).

Two gaps for this feature:

1. The backend only covers **four** distances today: `5K`, `10K`, `HM`, `FM`.
   `1K` and `3K` are not in the system.
2. The frontend never calls `/pbs`, and there is no PB component on the page.

## Key constraint — 1K/3K must be display-only

The PB constants in `pb_records.py` are shared by **three** consumers:

| Consumer | Path | Effect of widening distances |
|---|---|---|
| PB display | `routes/pbs.py` → `detect_personal_bests` | **desired** — show 1K/3K |
| Ability/VDOT model | `stride_core/ability_hook.py` → `compute_pb_vdot_for_segment` | **undesired** |
| Coach tool | `coach_adapters/tool_impls/read_impls.py` → `detect_personal_bests` | **undesired** |

`compute_pb_vdot_for_segment` (`ability.py:527`) applies the Daniels VDOT formula
to any segment with **no short-distance guard**. Feeding 1K/3K best efforts into
it would push inflated VDOT values into the VO2max ability dimension and the coach
summary. Therefore 1K/3K must reach **only** the `/pbs` display path, never the
ability model or coach tool.

## Approach

Parametrize the detector. Keep the ability-model input set narrow; introduce a
display-only set that the `/pbs` route opts into.

Rejected alternatives:

- **Widen the shared `CANONICAL_RACE_DISTANCES`** — one line, but corrupts the
  ability model and coach with inflated short-distance VDOT.
- **Write a separate 1K/3K detector in the route layer** — duplicates the
  segment-scan logic, violating the repo's "don't reinvent the wheel" rule
  (CLAUDE.md).

## Changes

### Backend — `src/stride_core/pb_records.py`

- **Leave `CANONICAL_RACE_DISTANCES` (`5K`/`10K`/`half`/`full`) untouched** — it
  remains the ability-model input.
- Add `PB_DISPLAY_DISTANCES`: the same four plus `"1K": 1000.0`, `"3K": 3000.0`.
- Add `"1K"`/`"3K"` entries to:
  - `_DISPLAY_DISTANCE_BY_RACE_TYPE` (`"1K": "1K"`, `"3K": "3K"`)
  - `DISTANCE_ORDER` → `["1K", "3K", "5K", "10K", "HM", "FM"]`
  - `ACTIVITY_DISTANCE_TOLERANCE_M` (e.g. `"1K": (950, 1050)`, `"3K": (2900, 3100)`)
- Thread a `distances` parameter through `best_effort_candidates_for_activity()`
  and `detect_personal_bests()`, **defaulting to `CANONICAL_RACE_DISTANCES`**.
  - Segment path passes `distances` into `best_distance_candidates(...)`.
  - Activity-level fallback (`_activity_level_candidates`) must be filtered to the
    display distances whose `race_type` is in the active `distances` set, so the
    narrow default never emits 1K/3K even though the global tolerance table now
    contains 1K/3K keys.

Net effect: `ability_hook.py` and the coach tool (both using the default) produce
exactly the four distances as today — no behavior change. Only `/pbs` opts into
the wide set.

### Backend — `src/stride_server/routes/pbs.py`

- Import `PB_DISPLAY_DISTANCES` and pass it to `detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES)`.
- The response loop already iterates `DISTANCE_ORDER`, so 1K/3K flow through
  automatically once present in the map. Update the docstring.

No DB schema change and no re-sync required: detection is segment-based, so the
fastest 1K/3K inside existing longer runs is already computable from stored
timeseries.

### Frontend — `frontend/src/api.ts`

- Add `PBHistoryPoint`, `PBEntry`, `PBsResponse` interfaces mirroring the backend.
- Add `fetchPbs(user)` → `fetchJSON<PBsResponse>(`/${user}/pbs`)`, mirroring
  `fetchAbilityCurrent`.

### Frontend — `frontend/src/components/AbilityPBTable.tsx` (new)

- Props: `pbs: PBEntry[]`.
- Renders a table styled like `LapTable` (mono headers, `border-border-subtle`
  rows, `accent-green` accents), wrapped in a card matching the page's
  `rounded-2xl` sections, with an eyebrow heading consistent with the
  secondary-distance section.
- Columns: **Distance · PB Time · Pace · Date**.
  - Distance: friendly labels `1K / 3K / 5K / 10K / 半马 / 全马`.
  - PB Time: `fmtHMS(pb_time_sec)`.
  - Pace: `fmtPace(pb_time_sec, distanceKm)` with `distanceKm` from a fixed map
    (`1, 3, 5, 10, 21.0975, 42.195`).
  - Date: `achieved_at` is already a Shanghai `YYYY-MM-DD` string from the backend
    (`_normalise_date`); display directly.
- Renders **all six rows in fixed `DISTANCE_ORDER`**, looking up each distance in
  the response. Distances with no record render `—` so the user sees what is still
  missing.
- Empty `pbs` (new user / no runs): the six-row scaffold still renders with all
  `—`.

### Frontend — `frontend/src/pages/AbilityPage.tsx`

- Add `pbs` state (`PBEntry[]`, default `[]`).
- Fetch `fetchPbs(user)` inside the existing `Promise.all`, with `.catch(() => [])`
  so a PB failure never blocks the page.
- Render `<AbilityPBTable pbs={pbs} />` at the bottom, after the history-chart
  `div`.

### Tests — `tests/stride_server/test_pbs.py`

- Add a test where a segment-fixture run yields 1K/3K best efforts via the `/pbs`
  endpoint (route uses the wide set).
- Add/assert that the **default** `detect_personal_bests(db)` returns only the four
  canonical distances (proves the ability path is unaffected).
- Existing tests must stay green (the four seeded 5K/10K activities do not match
  1K/3K tolerance; the segment fixture gains extra 1K/3K entries but existing
  assertions only check 5K).

## Data flow

```
activities + timeseries (stored)
        │
        ▼
detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES)   ← /pbs route only
        │  (segment scan + filtered activity fallback)
        ▼
GET /api/{user}/pbs  →  PBsResponse { pbs: PBEntry[] }
        │
        ▼
fetchPbs(user)  →  AbilityPage state  →  AbilityPBTable (6 fixed rows)

detect_personal_bests(db)            ← coach tool   (narrow default, unchanged)
best_effort_candidates_for_activity  ← ability_hook (narrow default, unchanged)
```

## Out of scope

- No new PB history visualization (the existing `history` field is returned but
  this feature only renders current PBs).
- No changes to the ability/VDOT model or coach behavior.
- No schema/migration changes.
