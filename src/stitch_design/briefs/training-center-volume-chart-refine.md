# Training Center — Mobile Weekly Volume Chart

Edit the selected approved training-center screen to add a compact mobile version of the Web season weekly-volume chart.

## Placement

- Keep the compact season header, goal, current phase, `距比赛 103 天`, `赛季 8 / 20 周`, and the approved `查看计划` outline button unchanged.
- Replace the existing standalone five-node phase rail (`基础 / 进展 / 赛前 / 减量 / 比赛`) with the new chart.
- Place the chart immediately before `本周课表`.

## Chart

- Header `周训练量`.
- Small label `预计周跑量 · km/周`.
- Compact chart height 128-150 px including labels.
- Display 20 narrow vertical bars, one per season week, with small consistent gaps and no horizontal scrolling.
- Use low-saturation phase groups:
  - W01-W06 base: muted light green;
  - W07-W12 build: muted cyan;
  - W13-W16 pre-race: muted blue-gray;
  - W17-W18 peak: muted orange;
  - W19-W20 taper/race: muted purple.
- Current week is W08. Use a STRIDE Green `#1FAD5B` outline around that bar and a compact label `W08 · 当前` above it. Show `38 km` close to the current label.
- Bar heights should show realistic rhythm: gradual ramps, recovery dips, peak, then taper.
- Only show compact stage-start labels below: `W01 基础`, `W07 进展`, `W13 赛前`, `W17 峰值`, `W19 减量`. Do not label all 20 weeks.
- No dense y-axis, grid, tooltip mockup, legend pills, or chart card border. Use whitespace and one baseline.

## Preservation

- Keep the complete seven-day `本周课表`, today highlight, push/adjust actions, next-week section, review/history/nutrition rows, and bottom navigation exactly as they are.
- Keep the approved `查看计划` control: 48 px touch target containing a 36 px white outlined visual button with right chevron.
- Do not add runner-home content, activity history, status rings, gradients, glass effects, or oversized cards.
- `训练` remains the active bottom tab.

## Acceptance

- At 390 px width, all 20 bars fit without horizontal scroll.
- Stage grouping and current week remain legible without relying only on color.
- At 390 x 844, the season summary, volume chart, and the beginning of `本周课表` are visible.
