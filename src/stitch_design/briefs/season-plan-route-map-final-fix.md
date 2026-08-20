# Screen

Name: `Season Plan Route Map Final Fix`
Route: `/v2/training-plan/view`
State: `season active`

## User Goal

Make four mechanical corrections to the selected route-map screen without changing its layout, content hierarchy, colors, or visual direction.

## Required Content

- Preserve every existing section and exact user-facing value.
- In the current phase heading area, explicitly include phase range `W05-W10` alongside `第 3 / 6 周` and `W07 / 23`.

## Actions

- Preserve all existing actions and hierarchy.

## Navigation

- Preserve the existing top app bar and fixed bottom action area.

## Constraints

- Import both `Geist` and `Geist Mono` from Google Fonts. Configure and apply actual `Geist Mono` to every number, date, week range, distance, and target time. Do not reference an unloaded font name.
- Make the back button container exactly `48px × 48px` while keeping the icon visually 24px.
- Make each compact phase row and the milestone row at least 48px tall across its full tappable width.
- Add enough bottom padding to the scrollable main content so the race destination can scroll completely above the fixed two-row action area. Use at least `160px` bottom padding plus safe area.
- Do not change any race data, phase range, milestone, copy, route geometry, card styling, action styling, or color.
- Do not add gradients, blur, bottom navigation, tabs, charts, badges, or new content.

## Acceptance Checks

- HTML imports `Geist Mono`.
- Back button is 48 by 48.
- Current phase visibly includes `W05-W10`.
- Route main content has at least 160px bottom padding.
- Milestone and phase rows have at least 48px touch height.
- All existing content remains otherwise unchanged.
