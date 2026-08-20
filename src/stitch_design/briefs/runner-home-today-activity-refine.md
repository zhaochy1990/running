# Runner Home — Today Activity Only

Edit the selected approved runner-home screen with one focused content change. Preserve the header, recovery decision and evidence, today workout details, four-item bottom navigation, `#1FAD5B`, typography, spacing, and 48-pixel touch targets.

Replace the entire `最近活动` section with `今日活动`, then place this `今日活动` section above `今日训练`.

For this screen state, today's planned tempo workout is still pending, so render the zero-activity state:

- one header row with `今日活动` on the left and `全部活动` as a text action on the right;
- one compact text-only empty-state row below it: `今天暂无活动`;
- the empty row should be 40-48 pixels tall and separated only by whitespace or a thin bottom rule;
- do not place any button, icon, illustration, border box, or supporting paragraph in the empty row. Watch sync remains available only in the top bar.

Hard rules:

- Page order must be: recovery decision and evidence → `今日活动` → `今日训练` → bottom navigation.
- Do not show yesterday or earlier activities anywhere on the home screen.
- Do not retain `最近活动`, `7月13日`, `7月11日`, `轻松跑`, or `渐进跑`.
- Do not repeat explanatory copy below the empty message. The empty state must be visually quiet and shorter than a normal activity row.
- Do not use a dashed box, rounded empty-state card, illustration, chart, gradient, glass effect, or promotional copy.
- At 390 x 844, today's workout title, pace/heart-rate targets, and primary action must remain visible above the bottom navigation.
- Bottom navigation remains exactly `跑者 / 训练 / 数据 / 教练`.
