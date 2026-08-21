# Screen

Name: `Weekly Plan Active`
Route: `/v2/plan/weeks/:weekId`
State: `week active, current day Thursday`

## User Goal

Review the active week, identify today's key workout, and understand the rest of the schedule and training support guidance.

## Required Content

- Show week dates, phase context, distance, duration, and training-load totals.
- Make today's threshold workout the dominant schedule item.
- Include the seven-day schedule, Coach guidance, strength, and nutrition guidance.
- Keep access to the season plan and workout detail.

## Actions

- Primary: open today's workout detail.
- Secondary: switch to season context and inspect other days.

## Navigation

- Use current terminology `赛季训练计划 / 本周课表` and the four-item navigation `跑者 / 训练 / 数据 / 教练`, with `训练` active.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation without preserving legacy Ember styling.
- Do not introduce draft terminology or imply that an active plan still needs activation.

## Acceptance Checks

- Today's workout and weekly totals are immediately identifiable.
- All seven days remain vertically scannable.
- The page has no horizontal overflow at 360 px or 390 px.
