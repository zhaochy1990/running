# Screen

Name: `Season Plan Geist Mono Fix`
Route: `/v2/training-plan/view`
State: `season active`

## User Goal

Preserve the completed season route-map screen while making its existing numeric font declarations functional.

## Required Content

- Preserve every current element, value, action, size, spacing, and color exactly.

## Actions

- Preserve all current actions unchanged.

## Navigation

- Preserve the current top app bar and fixed bottom action area.

## Constraints

- Make exactly one code-level correction: update the existing Google Fonts import so it loads both `Geist` and `Geist Mono`.
- Keep all existing `font-['Geist_Mono']` usage unchanged.
- Do not change any DOM content, layout, classes, values, colors, actions, or screen dimensions.

## Acceptance Checks

- The HTML imports both `Geist` and `Geist Mono` from Google Fonts.
- The complete screen is otherwise visually and structurally unchanged.
