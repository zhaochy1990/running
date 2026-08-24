# Screen

Name: `Season Plan Route Map (schema-aligned)`
Route: `/v2/training-plan/view`
State: `season active, current phase build, current week 7 of 23`

## User Goal

Help the runner understand where they are in the full season, what the current phase is trying to achieve, and what important transition comes next. The screen should feel like a season route map, not a dashboard or a stack of summary cards.

All visible data maps cleanly to the `coach_contract` master-plan schema (see `src/coach_contract/src/master_plan/schemas.ts`). User-facing labels use Chinese; the underlying structure is `PhaseNameSchema`, `KeySessionTypeSchema`, `MilestoneSchema`, and `WeekSchema`-compatible.

## Required Content

Use realistic data for a **Shanghai Marathon 2026** season. Contract-aligned values:

- `goal.race_name`: `2026 上海马拉松`
- `goal.distance`: `FM` (42.195 km)
- `goal.race_date`: `2026-12-06`
- `goal.target_time`: `3:20:00`
- `total_weeks`: `23`
- `start_date`: `2026-07-06`（第 1 周周一）
- `end_date`: `2026-12-06`（比赛日）
- `phases`（按 `PhaseNameSchema` 顺序，使用 `PHASE_NAME_CN` 中文标签，英文字段名可藏在结构中）:
  1. `base` 基础期 — W01–W04（2026-07-06 至 2026-08-02），已完成
  2. `build` 提升期 — W05–W10（2026-08-03 至 2026-09-13），进行中，当前第 3/6 周
  3. `marathon` 马拉松专项期 — W11–W18（2026-09-14 至 2026-11-08），未来
  4. `taper` 赛前减量期 — W19–W22（2026-11-09 至 2026-12-06），未来
  5. `race` week 包含在 `taper` 末周 W23 中——以 milestone `race` 类型标记终点，不单独作为 phase

首屏必须回答：

- **比赛目标**：`12月6日 · 目标 3:20:00`（来自 `goal.race_date` + `goal.target_time`，赛事为 FM 全马）
- **当前位置**：`第 7 周 / 共 23 周`（来自 `week_index = 7` + `total_weeks = 23`；显示可以用 W07/23 样式，但语义对应 `week_index`）
- **当前阶段**：`提升期（build）`，第 3 / 6 周（来自 `phases[1].name = "build"` + 进度计数）
- **阶段目标**：`建立阈值耐力，推动体能上升`（来自 `phases[1].focus`）
- **下一里程碑**：`8月31日 · 10K 阈值测试`（来自 `phases[1].milestones[]` 中 `type = "test_run"` 的项，日期 `2026-08-31`）

主体是一条垂直的赛季路线（season route），从上到下从过去走向比赛日。每个 phase 是一个语义行，高度 ≥ 48 px，可点击展开。区分 completed / current / future 不只靠颜色——用线型（实线 / 加重线 / 虚线）、图标或形状差异。

展开的当前 phase（build 提升期）必须包含：

- **周里程范围**：`46–52 km/周`（`weekly_distance_km_low` = 46, `weekly_distance_km_high` = 52）
- **关键课类型**：`阈值跑`、`长距离`、`节奏跑`（对应 `key_session_types`: `threshold`, `long_run`, `tempo`——使用 `KeySessionTypeSchema` 枚举值的中文展示）
- **训练负荷预估**：以剂量形式显示本周预期 `estimated_dose` 约 540，周末 CTL 约 72，Form 落在 **提升期（productive）**（来源：`simulation-schemas.ts::SimulationWeekSchema.end_ctl / end_form / ratio`，form zone 用 `FitnessState.form` + `chronic_load` 比例判定，中文标签用前端 `FORM_ZONE_LABEL`：`productive → 提升期`）
- **监控触发项**：`连续 3 天 form 落入过度负荷 → 强制减 15-20%`（`monitoring_triggers` 数组中的一条，简明展示）
- **Coach 说明**：基于当前负荷的一句话解释，引用 `coach_note`
- **力量安排**：`2 次/周，重点在下肢力量与核心`（`strength.sessions_per_week` + `strength.focus`）
- **恢复策略**：`睡眠 ≥ 7.5h；RHR 上升 5 bpm 以上触发轻松日调整`（`recovery.sleep_target_hours` + `recovery.adjustment_trigger`）
- **阶段全范围标注**：`W05–W10 · 共 6 周`，同时标注当前进度 `第 3 周`（即 `week_index` 7，相对 phase 内第 3 周）

里程碑（milestones）嵌在路线中，不是独立卡片：

- `test_run`：W07 · 10K 阈值测试（`2026-08-31`）
- `long_run`：W14 · 30 km 长距离（`2026-10-11`，马拉松专项期）
- `time_trial`：W18 · 半马配速测试（`2026-11-08`）
- `race`：W23 · 上海马拉松（`2026-12-06`，终点）

每个里程碑至少有 `type` + `date` + `target` 三个字段的可见信息，类型用图标或标签区分（`race / test_run / long_run / time_trial`）。

路线末端是比赛日终点（race destination），用明显的视觉锚点表示 `2026 上海马拉松 · 3:20:00`。

稳定的操作入口：`本周课表`（主操作）、`调整计划`（次操作）、`版本记录`（次操作）。只有一个视觉主导操作。

首屏必须露出足够的路线，让跑者立刻理解"下面还有整个赛季"。

## Actions

- Primary: `查看本周课表`（跳转 `/v2/weekly-plan/:week_start`，对应 `weeks[week_index-1]`）
- Secondary: `调整计划`（提出调整提案）、phase 行（展开/收起 + 查看该阶段详情）、milestone 行（查看里程碑详情）、`版本记录`（plan revision 历史）

## Navigation

- 入口：训练中心（/v2/train）点击 `查看赛季计划` 进入
- 全屏详情页，顶部 app bar 带返回按钮和标题 `赛季训练计划`；不显示底部导航
- 返回后训练中心保留滚动位置
- 主 CTA 跳转到当前周的周计划页面

## Constraints

- 遵循 STRIDE Raycast Mobile Foundation。保留路线图的主层级，不要分段 tabs、不要赛事 hero card、不要指标网格、不要周里程柱状图。
- **字段对齐约束（HARD）**：所有可见的阶段、周、里程碑、负荷数据，底层字段必须能一一映射到 `src/coach_contract/src/master_plan/schemas.ts` 和 `types.ts` 中的类型：
  - Phase 名称和顺序 → `PhaseNameSchema`（`base / build / speed / marathon / taper / recovery`），中文标签用 `PHASE_NAME_CN`
  - 不要使用 contract 中不存在的 phase 名称（如"进展期""专项期""比赛周"作为独立 phase）
  - 周编号 → `week_index`（从 1 开始的整数），`total_weeks` 是总周数
  - 里程碑 → `MilestoneSchema.type`（`race / test_run / long_run / strength_test / body_composition`）
  - 关键课类型 → `KeySessionTypeSchema` 枚举
  - 训练负荷 → `training_dose`（TSS 制，1h 阈值 = 100），form = chronic − acute（`FitnessState` 字段定义）
  - Form zone → 按 `form / chronic_load` 比例判定，中文标签为 `减量过多 / 比赛就绪 / 维持期 / 提升期 / 过度负荷`（对应英文 `over_taper / race_ready / transition / productive / overload`）
- 不要做成通用健身 dashboard，不要过多边框卡片、渐变、玻璃效果、装饰性插画、圆环图、逐指标卡片布局。
- 底部导航不要出现"计划 / 首页 / 记录 / 分析 / Coach"五项。不要暴露 `Master Plan`、`Draft`、revision ID 或内部状态名。
- 不要重复周计划内容。本页说明长期方向，主操作跳转到当前周。
- 返回按钮 48 px 见方。路线和 phase 行在 360 px 宽度下可读，无横向滚动。
- 底部固定操作区之上留出至少 160 px + safe area 的底部 padding，确保比赛终点可以完整滚出。
- Inter 用于界面文案，Geist Mono 用于所有数字、日期、周范围、距离、目标时间、配速、负荷值。
- 返回按钮、每个 phase 行、milestone 行、两个次操作的触控目标都 ≥ 48 px。

## Acceptance Checks

- 首屏内，跑者能识别：比赛日期与目标时间、当前周与阶段、阶段目标、下一里程碑、通往比赛日的路线。
- 已完成 / 当前 / 未来阶段，不靠颜色也能区分（线型、形状、位置结构至少一种）。
- 主层级是一条赛季路线，不是多张等重卡片。
- `查看本周课表` 是唯一主操作；`调整计划` 可见但是次操作。
- Phase 名称与 `coach_contract` 的 `PhaseNameSchema` 一致（中文展示用 `PHASE_NAME_CN`），不出现 contract 外的 phase 命名。
- Milestone 类型可映射回 `MilestoneSchema.type` 枚举。
- Form / 训练负荷字段名与 `FitnessState` / `SimulationWeekSchema` 一致，单位正确（dose 为 TSS，form = CTL − ATL）。
- 结果看起来是为严肃跑者设计的，且与源页面有实质性差异。
- 每个路线节点都是语义元素且高度 ≥ 48 px，Geist Mono 已加载，比赛终点在最大滚动时不会被固定操作区遮挡。
- 360 px 宽度下无横向溢出。
