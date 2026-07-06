# Master Plan · 存量用户修改赛季训练计划

存量用户从赛季训练计划首页点击 `调整计划` 后直接进入三栏工作区。中栏先展示当前赛季训练计划，Coach 生成调整方案后切换到变化审阅，用户在中栏确认启用。本目录同时收录调整流程的边界状态（更新中、生成失败、无有效变化、流程恢复）。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 8

## 主线：调整赛季训练计划

### 1. 当前赛季训练计划调整

- 状态: 用户点击 `调整计划`，当前赛季训练计划仍保持生效
- 布局: 三栏
- HTML: [1_master-plan-existing-current-adjust.html](./1_master-plan-existing-current-adjust.html)

### 2. 调整方案生成中

- 状态: Coach 正在生成调整方案，中栏保留当前计划，生成状态内联在右侧 Coach 对话
- 布局: 三栏
- HTML: [2_master-plan-existing-adjust-generating.html](./2_master-plan-existing-adjust-generating.html)

### 3. 赛季训练计划变化审阅

- 状态: 用户查看当前计划到新计划之间的变化，并在中栏确认启用
- 布局: 三栏
- HTML: [3_master-plan-existing-diff-review.html](./3_master-plan-existing-diff-review.html)

### 4. 赛季训练计划启用成功

- 状态: 新版赛季训练计划已启用，用户可返回首页或查看版本
- 布局: 成功 / 返回状态
- HTML: [4_master-plan-existing-applied-success.html](./4_master-plan-existing-applied-success.html)

## 边界状态与流程恢复

### 5. 反馈后计划更新中

- 状态: 用户在审阅后给出反馈，Coach 正在重新生成调整方案
- 布局: 三栏
- HTML: [5_master-plan-feedback-update-in-progress.html](./5_master-plan-feedback-update-in-progress.html)

### 6. 计划生成没有完成

- 状态: 生成调整方案失败；当前已启用计划不受影响，用户输入已保存，提供重试入口
- 布局: 三栏
- HTML: [6_master-plan-generation-failed.html](./6_master-plan-generation-failed.html)

### 7. 没有需要应用的变化

- 状态: Coach 判断当前计划已覆盖用户诉求，或输入不足以产生安全、明确的变化
- 布局: 三栏
- HTML: [7_master-plan-no-effective-change.html](./7_master-plan-no-effective-change.html)

### 8. 继续未完成的计划调整

- 状态: 用户返回后恢复未完成的计划调整流程
- 布局: 三栏
- HTML: [8_master-plan-resume-unfinished-flow.html](./8_master-plan-resume-unfinished-flow.html)
