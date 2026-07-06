# Weekly Plan 设计稿

本目录存放本周课表场景的 Stitch HTML 导出快照。这里的页面只用于本地审阅；正式设计源仍是 Stitch 项目 `STRIDE · Web`。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 6

## Story 1: 用户调整当前本周课表

本周课表调整默认只影响当前周。用户从本周课表页进入三栏工作区，查看周级变化；只有用户明确确认时，才升级为赛季训练计划调整。

本组设计稿需要覆盖六个核心模块: `上周总结`、`本周训练重点`、`本周训练课表`、`本周力量训练`、`本周训练记录`、`本周用户反馈`，并保留手表推送能力。

### 1. 本周课表首页

- 状态: 当前本周课表已启用，保留训练反馈、手表推送、训练记录和力量训练入口
- 布局: 本周课表首页
- HTML: [1_weekly-plan-current-home.html](./1_weekly-plan-current-home.html)

### 2. 当前周调整

- 状态: 用户点击 `调整本周`，当前本周课表仍保持可见
- 布局: 三栏
- HTML: [2_weekly-plan-current-week-adjust.html](./2_weekly-plan-current-week-adjust.html)

### 3. 本周计划生成中

- 状态: Coach 正在生成新的本周调整方案
- 布局: 三栏
- HTML: [3_weekly-plan-generating.html](./3_weekly-plan-generating.html)

### 4. 本周变化审阅

- 状态: 用户查看训练移动、替换、降强度、删除和保留项
- 布局: 三栏
- HTML: [4_weekly-plan-week-diff-review.html](./4_weekly-plan-week-diff-review.html)

### 5. 赛季训练计划影响提示

- 状态: 本周调整可能影响更长期的赛季训练计划
- 布局: 三栏
- HTML: [5_weekly-plan-season-plan-impact-prompt.html](./5_weekly-plan-season-plan-impact-prompt.html)

### 6. 本周计划启用成功

- 状态: 本周调整已启用
- 布局: 成功 / 返回状态
- HTML: [6_weekly-plan-applied-success.html](./6_weekly-plan-applied-success.html)
