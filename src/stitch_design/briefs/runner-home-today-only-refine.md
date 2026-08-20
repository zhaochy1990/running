# Runner Home — Today Only

Edit the selected approved runner-home screen to remove weekly-plan management from the home page.

Preserve exactly:

- opaque top bar, menu, STRIDE wordmark, sync action;
- greeting, date, recovery decision;
- HRV, resting heart rate, and `当前状态` evidence;
- compact `今日活动` zero state above the workout;
- today's tempo workout content: `节奏跑 · 8 km`, `18:30 · 约 48 min`, pace `5:15–5:25 /km`, heart rate `Z3 · 150–162 bpm`, coach reason, `查看训练详情`, and `调整今天安排`;
- bottom navigation `跑者 / 训练 / 数据 / 教练` with `跑者` active;
- `#1FAD5B`, typography, spacing, and 48-pixel touch targets.

Make these changes:

1. Rename the workout section header from `本周训练` to `今日训练`.
2. Remove the entire weekly summary row `3 / 5 课 · 22.4 / 38 km`.
3. Remove the week progress line.
4. Remove the Monday-to-Sunday selector and all completed/future/key-session indicators.
5. Remove `查看完整课表`.
6. Remove the redundant selected-day label `今天 · 关键课`; keep only a small `关键课` badge aligned with the `今日训练` header.
7. Pull the workout details upward so the page remains compact.

The final page order must be:

`当前状态判断与依据 → 今日活动 → 今日训练 → bottom navigation`

Do not add another way to show weekly progress. Full-week management belongs exclusively to the `训练` tab.
