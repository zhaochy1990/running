# Screen

Name: `Season Plan Goal and Interaction Fix`
Route: `/v2/training-plan/view`
State: `season active`

## User Goal

Preserve the completed season route-map while making the race target visible immediately and making every route node explicitly tappable.

## Required Content

- Preserve every current section, value, route line, action, color, font, and hierarchy.
- In the top race summary, add compact text `12月6日 · 目标 3:20:00` so the race date and goal time are visible in the first viewport alongside the existing race name and countdown.

## Actions

- Keep every existing action.
- Make completed, current, and future phase rows and the milestone row semantic buttons or links across their full visible width.

## Navigation

- Preserve the current top app bar, no bottom navigation, and the fixed bottom action area.

## Constraints

- This is a targeted accessibility and information correction, not a redesign.
- Every route phase row and milestone row must have a full-width touch target at least 48 px high, including completed and current phases.
- Preserve the expanded current-phase content inside its tappable container.
- Do not change route geometry, phase content, colors, bottom actions, or scroll padding.
- Keep Geist Mono loaded and applied to dates, times, week ranges, distances, and all numeric values.

## Acceptance Checks

- The first viewport shows `12月6日 · 目标 3:20:00`.
- Completed, current, future, and milestone route nodes use semantic interactive elements with at least 48 px touch height.
- The screen still has no bottom navigation or horizontal overflow.
- The race destination remains fully visible above the fixed action area at maximum scroll.
