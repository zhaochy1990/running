# Screen

Name: `Season Plan Route Map`
Route: `/v2/training-plan/view`
State: `season active, current phase build, current week 7 of 23`

## User Goal

Help the runner understand where they are in the full season, what the current phase is trying to achieve, and what important transition comes next. The screen should feel like a season route map, not a dashboard or a stack of summary cards.

## Required Content

- Use realistic data for `2026 上海马拉松`, race day `12月6日`, target `3:20:00`, and `距比赛 117 天`.
- The first viewport must show `12月6日 · 目标 3:20:00` and answer: current location `W07 / 23`, current phase `进展期 BUILD`, current phase purpose `建立阈值耐力`, and the next key event `8月31日 · 10K 阈值测试`.
- Make the dominant object a vertically readable season route. It must show completed, current, and future phases with dates or week ranges: `基础期 W01-W04`, `进展期 W05-W10`, `专项期 W11-W18`, `减量期 W19-W22`, `比赛周 W23`.
- The route must communicate progress and phase transitions through structure, labels, and line or shape, not color alone. The current phase is expanded in place; every completed, current, future, and milestone row is a semantic full-width button or link with a touch height of at least 48 px.
- Expanded current phase includes `本阶段第 3 / 6 周`, weekly volume `46-52 km`, key sessions `阈值间歇` and `长距离`, and a concise Coach explanation grounded in current load.
- Expanded current phase must also show its full range `W05-W10` alongside current position `W07 / 23`.
- Show the next milestone as part of the route, not as an unrelated metric card.
- Include a compact race destination at the end of the route so the season reads from now toward race day.
- Include stable access to `本周课表`, `调整计划`, and `版本记录`, but only one visually dominant action.
- Keep enough of the route visible above the fold that the runner immediately understands there is a longer season below.

## Actions

- Primary: `查看本周课表` because the active season should lead to execution.
- Secondary: `调整计划`, phase rows, next milestone, and `版本记录`.

## Navigation

- Enter from the Training center by tapping `查看赛季计划`.
- This is a full-screen detail, so use a top app bar with back and title `赛季训练计划`; do not show bottom navigation.
- Back returns to `/v2/train` with its scroll position preserved.

## Constraints

- Apply the current STRIDE Raycast Mobile Foundation. Preserve the route-map hierarchy rather than the former segmented tabs, race hero card, metric grid, or weekly-volume bar chart.
- Avoid a generic fitness dashboard, excessive bordered cards, gradients, glass, decorative illustrations, rings, and a card-per-metric layout.
- Do not show `计划`, `首页`, `记录`, `分析`, `Coach` as a five-item bottom bar. Do not expose `Master Plan`, `Draft`, revision IDs, or internal state names.
- Do not duplicate the weekly plan. This screen explains long-term direction; the primary action navigates to the current week.
- The back button is exactly 48 px square. The route and phase rows remain readable at 360 px width without horizontal scrolling.
- Keep at least 160 px bottom padding plus safe area so the race destination can scroll completely above the fixed action area.
- Use Inter for interface copy and Geist Mono for every number, date, week range, distance, and target time.
- The back button, every phase row, milestone row, and both secondary actions must each have a full touch target of at least 48 px.
- If actions are fixed to the bottom, leave at least 160 px plus safe-area bottom padding in the scrollable content so the race destination is never obscured.

## Acceptance Checks

- In the first viewport, a runner can identify the race date and target time, current week and phase, current phase purpose, next milestone, and the route toward race day.
- Current, completed, and future phases are distinguishable without relying on color alone.
- The hierarchy has one dominant season route, not several equally weighted cards.
- `查看本周课表` is the single primary action; `调整计划` remains visible but secondary.
- The screen uses the four-destination mobile information architecture only through its back destination, without rendering bottom navigation on this detail screen.
- The result looks intentionally designed for a serious runner and materially different from the source screen.
- Every route node is semantic and at least 48 px high, Geist Mono is loaded, and the race destination remains visible above the fixed action area at maximum scroll.
