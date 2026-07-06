# Master Plan 设计稿

本目录存放赛季训练计划场景的 Stitch HTML 导出快照。这里的页面只用于本地审阅；正式设计源仍是 Stitch 项目 `STRIDE · Web`。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 14

## Story 1: 新用户生成赛季训练计划

新用户先在两栏 Coach 工作区完成信息收集、等待生成，并在计划生成后主动点击 `查看计划`，再进入三栏计划审阅工作区。确认后进入已启用的赛季训练计划首页。

### 1. 创建计划信息收集

- 状态: Coach 收集目标比赛、备选赛事、地点、日期和训练背景
- 布局: 两栏
- HTML: [1_master-plan-new-user-intake.html](./1_master-plan-new-user-intake.html)

### 2. Coach 结构化追问

- 状态: Coach 用问题卡补齐必要信息，用户直接在聊天区回答
- 布局: 两栏
- HTML: [2_master-plan-new-user-coach-questions.html](./2_master-plan-new-user-coach-questions.html)

### 3. 训练计划生成中

- 状态: 展示生成步骤、预计耗时、当前处理内容和恢复提示
- 布局: 两栏
- HTML: [3_master-plan-new-user-generating.html](./3_master-plan-new-user-generating.html)

### 4. 计划待查看

- 状态: 训练计划已生成，用户点击 `查看计划` 后进入审阅
- 布局: 两栏
- HTML: [4_master-plan-new-user-plan-ready.html](./4_master-plan-new-user-plan-ready.html)

### 5. 审阅赛季训练计划

- 状态: 用户查看并确认生成的赛季训练计划
- 布局: 三栏
- HTML: [5_master-plan-new-user-plan-review.html](./5_master-plan-new-user-plan-review.html)

### 6. 赛季训练计划首页

- 状态: 赛季训练计划已启用；新用户确认后进入，存量用户也从这里点击 `调整计划`
- 布局: 首页视图，非聊天页，非审阅页
- HTML: [6_master-plan-current-view.html](./6_master-plan-current-view.html)

## Story 2: 存量用户修改赛季训练计划

存量用户从赛季训练计划首页点击 `调整计划` 后直接进入三栏工作区。中间栏先展示当前赛季训练计划，Coach 生成调整方案后切换到变化审阅。

### 7. 当前赛季训练计划调整

- 状态: 用户点击 `调整计划`，当前赛季训练计划仍保持生效
- 布局: 三栏
- HTML: [7_master-plan-existing-current-adjust.html](./7_master-plan-existing-current-adjust.html)

### 8. 调整方案生成中

- 状态: Coach 正在生成赛季训练计划调整方案，中栏仍保留当前计划上下文，生成状态以内联消息嵌入右侧 Coach 对话
- 布局: 三栏
- HTML: [8_master-plan-existing-adjust-generating.html](./8_master-plan-existing-adjust-generating.html)

### 9. 赛季训练计划变化审阅

- 状态: 用户查看当前计划到新计划之间的变化，并在中栏确认启用
- 布局: 三栏
- HTML: [9_master-plan-existing-diff-review.html](./9_master-plan-existing-diff-review.html)

### 10. 赛季训练计划启用成功

- 状态: 新版赛季训练计划已启用，用户可返回首页或查看版本
- 布局: 成功 / 返回状态
- HTML: [10_master-plan-existing-applied-success.html](./10_master-plan-existing-applied-success.html)

## Story 3: 边界状态与流程恢复

边界状态用于处理赛季训练计划生成、调整和恢复过程中的异常或等待场景。它们遵循同一套两栏 / 三栏规则，确保用户知道当前计划是否受影响、输入是否已保存、下一步应该在哪里继续。

### 11. 反馈后计划更新中

- 状态: 用户在审阅后给出反馈，Coach 正在重新生成调整方案
- 布局: 三栏
- HTML: [11_master-plan-feedback-update-in-progress.html](./11_master-plan-feedback-update-in-progress.html)

### 12. 计划生成没有完成

- 状态: 生成调整方案失败；当前已启用计划不受影响，用户输入已保存
- 布局: 三栏
- HTML: [12_master-plan-generation-failed.html](./12_master-plan-generation-failed.html)

### 13. 没有需要应用的变化

- 状态: Coach 判断当前计划已覆盖用户诉求，或输入不足以产生安全、明确的变化
- 布局: 三栏
- HTML: [13_master-plan-no-effective-change.html](./13_master-plan-no-effective-change.html)

### 14. 继续未完成的计划调整

- 状态: 用户返回后恢复未完成的计划调整流程
- 布局: 三栏
- HTML: [14_master-plan-resume-unfinished-flow.html](./14_master-plan-resume-unfinished-flow.html)
