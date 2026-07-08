# QA 设计稿

本目录存放日常 Coach 问答场景的 Stitch HTML 导出快照。这里的页面只用于本地审阅；正式设计源仍是 Stitch 项目 `STRIDE · Web`。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 5

## 渲染模型

QA 不是单纯设计 Coach Agent 的聊天外壳，还需要覆盖 Coach 回复内容如何从数据渲染成 UI。

当前阶段分成两套渲染状态：

1. **当前 Markdown 输出**：Coach 主要返回 markdown 文本，前端把段落、列表、引用和表格渲染成一条普通 Coach message。
2. **理想 structured JSON 输出**：Coach API 返回 `message_md` + `ui_blocks` + `suggested_actions`，前端按 `stride-card` 类型渲染为聊天消息里的内联卡片。

QA 始终复用 `master_plan/new_user/1_master-plan-new-user-intake.html` 的两栏聊天布局：左侧固定产品导航，右侧是全宽 Coach Chat（顶部会话标题、消息流、底部输入框）。所有指标卡、复盘卡、分流问卷和 CTA 都属于某条 Coach message 的内联内容，不单独放中间栏。

计划修改不属于 QA 页面本身。QA 可以在聊天消息里提供 `调整本周课表` 或 `调整赛季训练计划` 入口；用户确认后，流程应进入 Weekly Plan 或 Master Plan 对应的计划工作区。

## Story 1: 当前 Markdown 输出

### 1. 当前 Markdown 渲染

- 状态: Coach 只返回 markdown 文本
- 布局: 两栏，markdown prose/table/list 在 Coach message 内渲染
- HTML: [1_qa-current-markdown-rendering.html](./1_qa-current-markdown-rendering.html)

## Story 2: 理想 structured JSON / stride-card 输出

### 2. stride-card: 指标摘要

- 状态: Coach API 返回 `metric_summary` block
- 布局: 两栏，指标卡内联在 Coach 回复中
- HTML: [2_qa-stride-card-metric-summary.html](./2_qa-stride-card-metric-summary.html)

### 3. stride-card: 单次训练复盘

- 状态: Coach API 返回 `workout_review` block
- 布局: 两栏，训练复盘卡内联在 Coach 回复中
- HTML: [3_qa-stride-card-workout-review.html](./3_qa-stride-card-workout-review.html)

### 4. stride-card: 疲劳分流

- 状态: Coach API 返回 `fatigue_triage` block
- 布局: 两栏，疲劳分流问卷和建议内联在 Coach 回复中
- HTML: [4_qa-stride-card-fatigue-triage.html](./4_qa-stride-card-fatigue-triage.html)

### 5. stride-card: 疼痛风险分流

- 状态: Coach API 返回 `pain_triage` block
- 布局: 两栏，疼痛评估和安全提示内联在 Coach 回复中
- HTML: [5_qa-stride-card-pain-triage.html](./5_qa-stride-card-pain-triage.html)
