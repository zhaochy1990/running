# Weekly Plan 设计稿

本目录存放本周课表场景的 Stitch HTML 导出快照。这里的页面只用于本地审阅；正式设计源仍是 Stitch 项目 `STRIDE · Web`。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 9

## Story 1: 本周课表当前视图 Tabs

本组页面是本周课表的常规查看态，基于 `season_bundle.json` 中 `2026-05-04_05-10(W1)` 的真实 weekly schema 做静态 Review 样张。顶层页面保留 Weekly Plan 总览区，并拆成 4 个 tab 页面。原“方案”页与“日历”页都与首页信息重复，已合并回首页。

### 1. 本周训练课表

- 状态: 展示 W1 七天课表，支持一天多 session
- 内容: run / strength / rest、距离优先、训练重点、营养日标记、右侧摘要
- HTML: [1_weekly-plan-current-home.html](./1_weekly-plan-current-home.html)

### 2. 本周力量训练

- 状态: 展示本周 strength sessions
- 内容: 从 notes_md 展开的动作、组数、执行重点和跑步课关系
- HTML: [2_weekly-plan-tab-strength.html](./2_weekly-plan-tab-strength.html)

### 3. 本周训练记录

- 状态: 展示计划 vs 实际的预留态
- 内容: session completion、距离进度、质量维度和 Coach 复盘提示
- HTML: [3_weekly-plan-tab-records.html](./3_weekly-plan-tab-records.html)

### 4. 本周反馈

- 状态: 展示针对本周关键课的用户反馈输入
- 内容: VO2max、双 session、中长跑营养反馈提示
- HTML: [4_weekly-plan-tab-feedback.html](./4_weekly-plan-tab-feedback.html)

## Story 2: 用户调整当前本周课表

本周课表调整默认只影响当前周。用户从本周课表页进入三栏工作区，查看周级变化；只有用户明确确认时，才升级为赛季训练计划调整。

调整流程页面已放入独立目录: [`adjustment/`](./adjustment/)。

### 1. 当前周调整

- 状态: 用户点击 `调整本周`，当前本周课表仍保持可见
- 布局: 三栏
- HTML: [adjustment/1_weekly-plan-current-week-adjust.html](./adjustment/1_weekly-plan-current-week-adjust.html)

### 2. 本周计划生成中

- 状态: Coach 正在生成新的本周调整方案
- 布局: 三栏
- HTML: [adjustment/2_weekly-plan-generating.html](./adjustment/2_weekly-plan-generating.html)

### 3. 本周变化审阅

- 状态: 用户查看训练移动、替换、降强度、删除和保留项
- 布局: 三栏
- HTML: [adjustment/3_weekly-plan-week-diff-review.html](./adjustment/3_weekly-plan-week-diff-review.html)

### 4. 赛季训练计划影响提示

- 状态: 本周调整可能影响更长期的赛季训练计划
- 布局: 三栏
- HTML: [adjustment/4_weekly-plan-season-plan-impact-prompt.html](./adjustment/4_weekly-plan-season-plan-impact-prompt.html)

### 5. 本周计划启用成功

- 状态: 本周调整已启用
- 布局: 成功 / 返回状态
- HTML: [adjustment/5_weekly-plan-applied-success.html](./adjustment/5_weekly-plan-applied-success.html)
