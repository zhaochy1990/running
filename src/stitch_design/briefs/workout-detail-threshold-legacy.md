# Screen

Name: `Threshold Workout Detail`
Route: `/v2/plan/weeks/:weekId/workouts/:workoutId`
State: `active structured threshold workout, watch connected`

## User Goal

Understand exactly how to execute the threshold workout, review Coach's safeguards and fueling guidance, then sync it to the connected watch.

## Required Content

- Show workout duration, distance, training load, warm-up, six work/recovery repeats, and cooldown.
- Keep pace and heart-rate requirements attached to each segment.
- Include Coach cautions, route, equipment, and COROS connection status.
- Use a full-width `补给建议` card that supports long Chinese guidance; do not reduce it to a metric tile.

## Actions

- Primary: `同步到运动手表`.
- Secondary: return to the current week and discuss the workout with Coach.

## Navigation

- This is a focused detail screen with a back action and no bottom navigation.
- Back returns to the current weekly-plan detail.

## Constraints

- Preserve this HTML as an approved legacy Ember snapshot; do not treat it as the current visual baseline.
- The fueling card must retain natural wrapping and comfortable line height.
- Future visual edits must use the current STRIDE Mobile Foundation.

## Acceptance Checks

- Repetition count, pace, heart-rate zones, and stop conditions are unambiguous.
- `补给建议` spans the content width and the obsolete `400–600ml` metric is absent.
- COROS status and the sync action remain visible.
- The page has no horizontal overflow at 360 px or 390 px.
