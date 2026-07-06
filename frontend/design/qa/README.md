# QA 设计稿

本目录存放日常 Coach 问答场景的 Stitch HTML 导出快照。这里的页面只用于本地审阅；正式设计源仍是 Stitch 项目 `STRIDE · Web`。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 6

## Story 1: 日常 Coach 问答

日常 Coach 问答保持两栏。Coach 可以引用计划上下文，但不直接进入 Review 工作区；只有用户明确选择调整本周课表或赛季训练计划时，才升级到计划工作区。

### 1. 日常问答: 指标

- 状态: 用户询问近期训练状态
- 布局: 两栏
- HTML: [1_qa-daily-metrics.html](./1_qa-daily-metrics.html)

### 2. 日常问答: 节奏跑复盘

- 状态: 用户询问一次节奏跑表现
- 布局: 两栏
- HTML: [2_qa-tempo-review.html](./2_qa-tempo-review.html)

### 3. 日常问答: 疲劳

- 状态: 用户反馈疲劳或跑不动
- 布局: 两栏
- HTML: [3_qa-fatigue.html](./3_qa-fatigue.html)

### 4. 日常问答: 疼痛分流

- 状态: 用户报告疼痛，例如跟腱不适
- 布局: 两栏
- HTML: [4_qa-pain-triage.html](./4_qa-pain-triage.html)

## Story 2: 从问答升级到计划调整

升级前需要让用户理解即将调整的是本周课表还是赛季训练计划，以及调整不会在用户确认前生效。

### 5. 升级到本周课表调整

- 状态: 用户确认进行短期本周调整
- 布局: 两栏确认页，随后进入三栏本周课表审阅
- HTML: [5_qa-escalation-to-weekly-plan.html](./5_qa-escalation-to-weekly-plan.html)

### 6. 升级到赛季训练计划调整

- 状态: 用户确认进行更长期的赛季调整
- 布局: 两栏确认页，随后进入三栏赛季训练计划审阅
- HTML: [6_qa-escalation-to-master-plan.html](./6_qa-escalation-to-master-plan.html)
