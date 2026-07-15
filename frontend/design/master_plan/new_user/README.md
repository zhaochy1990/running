# Master Plan · 新用户创建赛季训练计划

新用户从空白开始创建赛季训练计划的完整闭环。先在两栏 Coach 工作区完成信息收集与生成等待，计划生成后由用户主动点击 `查看计划` 进入三栏计划审阅，确认启用后进入已生效的赛季训练计划首页。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only
- 页面数量: 6
- 补充状态稿: [7_master-plan-load-view.html](./7_master-plan-load-view.html) — 当前页训练周期的周负荷视图

## 故事线

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

- 状态: 用户查看并确认生成的赛季训练计划；中栏是主工作区，唯一主 CTA `启用计划`
- 布局: 三栏
- HTML: [5_master-plan-new-user-plan-review.html](./5_master-plan-new-user-plan-review.html)

### 6. 赛季训练计划首页

- 状态: 赛季训练计划已启用；新用户确认后进入，存量用户也从这里点击 `调整计划`
- 布局: 首页视图，非聊天页，非审阅页
- HTML: [6_master-plan-current-view.html](./6_master-plan-current-view.html)
