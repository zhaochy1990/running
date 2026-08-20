# Training Center Active — Precision Refinement

Edit the selected training-center screen without changing its overall structure, seven-day schedule, actions, lower sections, visual language, or bottom navigation.

Apply exactly these corrections:

1. Top bar
   - Keep menu icon left and centered title `训练`.
   - Remove the incorrect date `2024-05-20` from the right side.
   - Use an empty 48 x 48 balancing area on the right. Do not replace it with another date, sync, bell, or action.

2. Season-plan summary
   - Add a compact header row above the goal: `赛季训练计划` on the left and text action `查看计划` on the right.
   - Keep `上海马拉松 · 2026.10.25` and `进展期 · 第 3 / 6 周`.
   - Replace the two large outlined metric boxes with one compact inline summary row: `距比赛 103 天` and `赛季 8 / 20 周`, using aligned monospace numbers and a subtle divider.
   - Keep the phase rail and make state semantics clear: `基础` completed, `进展` current, then `赛前 / 减量 / 比赛` future.

3. Today row
   - The highlighted row must explicitly show both `周四` and `今天`, plus date `7/16`.
   - Preserve `力量 A · 35 min`, `下肢 + 核心`, and `待训练`.

Hard preservation rules:

- Keep all seven schedule rows, week summary, progress line, `推送到手表`, `调整本周`, `下周安排`, `上周复盘`, `历史课表`, and `今日营养`.
- Bottom navigation stays exactly `跑者 / 训练 / 数据 / 教练`, with `训练` active.
- Preserve `#1FAD5B`, opaque white surfaces, typography, 48-pixel touch targets, and no gradients or glass effects.
- Do not add runner-home content such as greeting, recovery evidence, today activity, or activity history.
- Do not introduce large metric cards or dashboard grids.
