# Screen

Name: `Training Center Active Season and Week`
Route: `/v2/train`
State: `season_state=active, week_state=active, current_day=Thursday`

## User Goal

The runner uses the `训练` tab to manage the whole training system: understand where they are in the season, inspect the complete current-week schedule, adjust or push the week, and know what happens next. This page is for planning and management, not today's readiness decision or activity history.

## Required Shell

- Root-tab screen at 390 px logical width with safe areas and a fixed opaque-white top bar.
- Top bar: 48 x 48 menu action on the left, centered title `训练`, and an empty 48 px balancing area on the right. Do not show a back button.
- Four-item bottom navigation in this exact order: `跑者`, `训练`, `数据`, `教练`. `训练` is active. Never show `发现` or `我`.
- Match the approved runner-home visual language: white canvas, near-black text, Geist Sans, Geist Mono for all athletic numbers, thin rules, quiet surfaces, and STRIDE green `#1FAD5B`.

## Content Order

### 1. Season Plan Summary

- Header row: `赛季训练计划` and a compact secondary outline button `查看计划` with a right arrow. The control uses a white background, subtle `#E5E5E5` 1 px border, 8 px radius, near-black label, and an explicit 48 px touch target. Do not style it as a green underlined text link or a filled primary button.
- Goal: `上海马拉松 · 2026.10.25`.
- Current position: `进展期 · 第 3 / 6 周`.
- Compact supporting values: `距比赛 103 天` and `赛季 8 / 20 周`.
- A restrained horizontal phase rail: `基础` completed, `进展` current, then `赛前`, `减量`, `比赛`. Use labels as well as visual state.
- Replace a standalone phase-dot rail with a compact full-season weekly-volume chart. Do not show both.
- Chart title: `周训练量`; subtitle/axis label: `预计周跑量 · km/周`.
- Show 20 narrow weekly bars across the available width. Use low-saturation phase colors: green for base, cyan for build, blue-gray for pre-race, muted orange for peak, and muted purple for taper/race.
- Highlight the current bar as `W08 · 当前` using a STRIDE Green outline. Current target value is `38 km`.
- Only label phase starts under the chart: `W01 基础`, `W07 进展`, `W13 赛前`, `W17 减量`, `W20 比赛`. Do not label every week.
- The volume rhythm should visually ramp, include recovery dips, peak, and taper. Keep the chart compact at roughly 128-150 px total height.
- Keep this summary compact. It is context for the week, not a large promotional hero card.

### 2. Current Week Schedule

- Dominant section header: `本周课表` with date range `7月13日–19日`.
- Summary: `3 / 5 课`, `22.4 / 38 km`, `3h05 / 5h10` using compact aligned monospace data.
- Thin progress line.
- Show all seven days as a readable vertical schedule, not a tiny chart:
  - `周一 7/13` — `轻松跑 · 6.2 km`, `已完成 · RPE 3`;
  - `周二 7/14` — `节奏跑 · 8 km`, `已完成 · 关键课`;
  - `周三 7/15` — `恢复跑 · 5 km`, `已完成 · Z1–Z2`;
  - `周四 7/16` — explicitly `今天`, `力量 A · 35 min`, `下肢 + 核心`, pending;
  - `周五 7/17` — `休息`, `灵活性 15 min`;
  - `周六 7/18` — `休息`, `可选散步`;
  - `周日 7/19` — `长距离 · 16 km`, `Z2 · 关键课`.
- Completed, today, rest, future, and key-session states must remain understandable without color alone.
- Each training row is at least 48 px tall and can open session detail. Rest rows do not pretend to be pushable workouts.
- Below the schedule, two actions: primary `推送到手表`, secondary `调整本周`. Both have at least 48 px touch targets.

### 3. Next Week

- Compact section `下周安排`.
- Show `周日 23:59 自动生成草稿`.
- Explain current condition: `还需完成本周并提交 1 条训练反馈`.
- Do not show a fake enabled generation CTA while conditions are unmet.

### 4. Review, History, and Nutrition

- Two compact navigable rows:
  - `上周复盘` with `完成率 80% · 3 条洞察`;
  - `历史课表` with `查看已完成的训练周`.
- One compact nutrition row: `今日营养` with `力量日 · 蛋白 120 g · 碳水 260 g` and an entry to daily nutrition advice.

## Actions

- Open full season plan.
- Open a training session.
- Push the active week to the watch.
- Start Coach-based weekly adjustment.
- Open previous-week review, historical weeks, and today's nutrition advice.

## Constraints

- Do not duplicate runner-home content: no greeting, recovery decision, HRV/RHR/current-status evidence, today activity, recent activity, or activity list.
- Do not expand only today's workout; the full seven-day schedule is the main work area.
- Do not use legacy terms `训练总纲`, `单周计划`, `周计划 Draft`, `TSB`, `ATL`, or `CTL`.
- Do not use status rings, radar charts, large circular progress, dashboard metric-card grids, gradients, glass effects, illustrations, floating action buttons, or oversized rounded cards.
- Avoid excessive card stacking. Prefer section headers, thin dividers, row states, whitespace, and at most one quiet surface around the active week.
- Do not show social content, activity records, subscription upsells, or unavailable features.

## Acceptance Checks

- Within five seconds, the user can identify season position, current week progress, today's row, and the next key session.
- The first 390 x 844 viewport shows the season summary, current-week summary, and at least the first several schedule rows.
- The page clearly differs from `跑者`: it manages the full week and season rather than answering today's readiness question.
- The selected bottom tab is `训练`; navigation order and style match the approved runner-home HTML.
- All numerical training data uses aligned monospace typography.
- The page remains usable at 360 px width and with larger system text.
