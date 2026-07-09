# Master Plan · 存量用户修改赛季训练计划

存量用户从赛季训练计划首页点击 `调整计划` 后直接进入三栏工作区。中栏先展示当前赛季训练计划；如果 Coach 需要更多输入，会在右侧聊天区用结构化问题卡追问；输入收齐后进入生成中状态，随后中栏展示调整后的完整赛季训练计划，右侧 Coach 用文字说明变化。用户在中栏点击 `启用计划` 后直接回到 Master Plan current view。本目录同时收录调整流程的边界状态（更新中、系统异常、Coach 驳回、流程恢复）。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 8

## 主线：调整赛季训练计划

### 1. 当前赛季训练计划调整

- 状态: 用户点击 `调整计划`，当前赛季训练计划仍保持生效
- 布局: 三栏
- HTML: [1_master-plan-existing-current-adjust.html](./1_master-plan-existing-current-adjust.html)

### 2. Coach 结构化追问

- 状态: Coach 判断还需要更多输入，在右侧聊天区用问题卡片向用户追问
- 布局: 三栏
- HTML: [2_master-plan-existing-coach-questions.html](./2_master-plan-existing-coach-questions.html)

### 3. 调整方案生成中

- 状态: Coach 已收齐输入，正在生成调整方案；中栏保留当前计划，聊天输入暂不可发送
- 布局: 三栏
- HTML: [3_master-plan-existing-adjust-generating.html](./3_master-plan-existing-adjust-generating.html)

### 4. 调整后的赛季训练计划审阅

- 状态: 中栏展示调整后的完整赛季训练计划，右侧 Coach Chat 用文字说明变化；用户点击 `启用计划` 后直接回到 Master Plan current view
- 布局: 三栏
- HTML: [4_master-plan-existing-diff-review.html](./4_master-plan-existing-diff-review.html)

## 边界状态与流程恢复

### 5. 反馈后计划更新中

- 状态: 用户在审阅后给出反馈，Coach 正在重新生成调整方案
- 布局: 三栏
- HTML: [5_master-plan-feedback-update-in-progress.html](./5_master-plan-feedback-update-in-progress.html)

### 6. 系统异常导致生成失败

- 状态: 网络中断、服务异常或内部错误导致生成没有完成；中栏保留失败前正在处理的上一版调整方案，右侧用错误卡片说明并提供重试
- 布局: 三栏
- HTML: [6_master-plan-generation-failed.html](./6_master-plan-generation-failed.html)

### 7. Coach 驳回调整要求

- 状态: 用户要求不合理或风险过高，Coach 不生成新计划；中栏保留上一版调整方案，右侧用文字说明原因和替代方向
- 布局: 三栏
- HTML: [7_master-plan-request-rejected.html](./7_master-plan-request-rejected.html)

### 8. 继续未完成的计划调整

- 状态: 用户返回后恢复未完成的计划调整流程
- 布局: 三栏
- HTML: [8_master-plan-resume-unfinished-flow.html](./8_master-plan-resume-unfinished-flow.html)
