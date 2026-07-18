# Runner Home — Merge Today Into Weekly Training

Edit the selected approved runner-home screen. Preserve the opaque white top bar, sync action, greeting, date, recovery decision, three evidence rows, today's activity section, four-item bottom navigation, `#1FAD5B`, typography, and 48-pixel touch targets.

Replace the three separate sections `今日训练`, `本周进度`, and `下一节关键课` with one unified `本周训练` module.

## Unified Module

- Header: `本周训练` on the left. On the right show `3 / 5 课` and `22.4 / 38 km` in compact monospace text.
- Directly below, keep a thin 59% progress line.
- Add a seven-day selector for Monday through Sunday. Tuesday is selected by default and explicitly contains the text `今天`; do not indicate today only with green.
- Monday is visibly completed. Wednesday is easy/recovery. Thursday is strength. Friday is rest. Saturday is easy. Sunday has a key-session marker. Keep the selector compact but each day must have a 48-pixel touch target.
- Below the selector, show the selected Tuesday content directly, without another page transition:
  - label `今天 · 关键课`;
  - `节奏跑 · 8 km`;
  - `18:30 · 约 48 min`;
  - pace `5:15–5:25 /km`;
  - heart rate `Z3 · 150–162 bpm`;
  - reason `安排在今晚：恢复正常，且距周日长跑超过 72 小时。`;
  - primary `查看训练详情`;
  - secondary `调整今天安排`.
- Add a compact text action `查看完整课表` near the module header or footer.
- Sunday should be discoverable through its selector state as `长距离 16 km · Z2`, but do not show an independent `下一节关键课` card.

## Hard Preservation

- Page hierarchy becomes exactly: recovery decision and evidence → unified weekly training module with today selected → recent activities.
- Do not retain separate headings named `今日训练`, `本周进度`, or `下一节关键课` outside the unified module.
- Bottom navigation remains exactly `跑者 / 训练 / 数据 / 教练`; never add `发现` or `我`.
- Keep all visible UI copy in Simplified Chinese.
- Do not add charts, status rings, gradients, glass effects, promotional banners, weather, nutrition logging, or extra cards.
