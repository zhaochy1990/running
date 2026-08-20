# Screen

Name: `Season Plan Route Map Refine`
Route: `/v2/training-plan/view`
State: `season active, current phase build, current week 7 of 23`

## User Goal

Preserve the selected vertical season route from the source screen while fixing product accuracy, typography, actions, and touch behavior.

## Required Content

- Keep the source hierarchy and route geometry: centered race summary, completed phase, expanded current phase, milestone, compact future phases, and race destination.
- Keep exact race data: `2026 上海马拉松`, `12月6日`, `距比赛 117 天`, target `3:20:00`.
- In the expanded current phase, show both `W07 / 23` and `本阶段第 3 / 6 周` without using the English badge `CURRENT`.
- Keep `阶段目标 · 建立阈值耐力`, `46-52 km`, `阈值间歇`, `长距离`, and the grounded Coach note.
- Keep milestone `8月31日 · 10K 阈值测试` integrated into the route.
- Keep exact phase ranges: `基础期 W01-W04`, `进展期 W05-W10`, `专项期 W11-W18`, `减量期 W19-W22`, `比赛周 W23`.
- Keep `12月6日 · 3:20:00` as the route destination.

## Actions

- Primary: `查看本周课表`.
- Secondary: `调整计划` and `版本记录`, both visible in the pinned action area as distinct 48 px touch targets.
- Phase and milestone rows are tappable with at least 48 px hit areas.

## Navigation

- Preserve the top app bar with back and title `赛季训练计划`.
- Do not add bottom navigation.

## Constraints

- This is a targeted refinement, not another redesign. Preserve the source screen's white route-map direction and restrained visual hierarchy.
- Use Geist Mono for every number, date, week range, distance, duration, and target time. Use Geist Sans for Chinese interface copy.
- Use `#1FAD5B` sparingly. Do not replace it with darker generated greens.
- Remove `CURRENT`, all-caps English status labels, gradients, glass, blur, and decorative shadows.
- Do not reintroduce tabs, a race hero card, metric grid, weekly-volume chart, bottom navigation, or multiple metric cards.
- All touch targets must be at least 48 px, including back, phases, milestone, and secondary actions.
- The fixed action area must not obscure the race destination when the page is scrolled to the end.

## Acceptance Checks

- All race, week, phase, and milestone data exactly match this brief.
- `本阶段第 3 / 6 周`, `调整计划`, and `版本记录` are visible.
- All athletic values visibly use a monospace font.
- The screen has no gradient, glass blur, English status badge, or bottom navigation.
- The source route remains the single dominant object.
