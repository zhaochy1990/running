# S1 实现计划：master plan 保留已完成阶段（周期延续性）

## 背景 / 问题

S1 master plan 生成时，`build_master_prompts` 注入的 `current_phase` block
（`src/coach/skills/shared/blocks/current_phase.md`）有一条 HARD 指令：

> MANDATORY: sequence the phases starting from `${entry}`; already-completed
> leading phases (e.g. a finished base phase) must NOT be re-scheduled.

结果：generator 从 `recommended_entry_phase`（如 speed）起，**省略**已完成的
基础期。master plan 作为「赛季总纲」却看不到来路，`week_index` 从 entry phase
重新从 1 起算，丢失了「对旧计划迁移/更新」的延续性。

## 目标语义（用户确认）

- 速度期起步**没问题** —— generator 不重新规划已完成的基础期内容。
- 但 master plan 是对旧计划的**迁移和更新**：
  - 已完成的前置阶段（base）作为 **completed phase 保留在 `phases` 数组最前**，
    标记 `is_completed`，只给阶段名/日期/简要 focus，**不展开** weekly key sessions。
  - `week_index` **不从第 0/1 周重排** —— 从赛季真正起点（base W1）连续编号，
    entry phase 接续（如 base W1–8，speed 从 W9）。
  - `current_phase_id` 指向 entry phase（speed），`current_week_number` 指当前周。
  - `start_date` = 已完成阶段起点；`end_date` = race day；`total_weeks` 含已完成周。
- 前端 SeasonOverview：completed 阶段灰显/标「已完成」，current 仍高亮，timeline 完整。

## 改动清单（文件级）

### 1. Schema — `src/stride_core/master_plan.py`
- `Phase` 加 `is_completed: bool = False`（默认 False → 旧 plan/fixture 全部
  保持 upcoming，**向后兼容**）。current 由 `MasterPlan.current_phase_id` 标识，
  upcoming = 非 completed 非 current，不需额外字段。
- `week_index` 注释已是「1-based sequential across the whole plan」——语义不变，
  只是现在序列从已完成阶段起。无需改 schema。
- completed phase 允许在 `weekly_key_sessions` 里**没有**对应 week（已完成不展开）。

### 2. Builder — `src/stride_server/master_plan_generator.py::_build_master_plan`
- 解析每个 phase 的 `is_completed`（默认 False）。
- 不对 `week_index` 做偏移：让模型直接输出连续编号（已在 prompt 要求）；builder
  只透传。
- `total_weeks`：保持 `len(weeks) if weeks else compute_total_weeks(start,end)`；
  因 `start_date` 改为 base 起点，`compute_total_weeks` 自动含已完成周。
- completed phase 的 `key_session_types` 可空；`weeks` 跳过它不报错（已支持
  `phase_name_to_id` 缺失回退）。

### 3. Prompt — `current_phase.md` + `SKILL.md` + `user_prompt.md`
- **`src/coach/skills/shared/blocks/current_phase.md`**：把末行 MANDATORY 改为：
  > 已完成的前置阶段（如 base）必须作为 `is_completed=true` 的 phase **列在
  > `phases` 最前**：给出阶段名、起止日期、简要 focus，**不要**为它生成
  > weekly key sessions。`week_index` 从该已完成阶段的起点**连续编号**；从
  > `${entry}` 开始详细规划（含 weekly key sessions）。`current_phase_id`
  > 指向 `${entry}`，`current_week_number` 指向当前周。
  - 需要已完成阶段的起止：用 `${completed_aerobic_weeks}` + `plan_start` 反推
    base 起点（= plan_start − completed_weeks×7）。在 builder 里算好注入，或在
    fragment 里指示模型用 completed_aerobic_weeks 推。
- **`SKILL.md`**（system，输出 schema 段）：phase 对象加 `is_completed` 字段说明 +
  「completed phase 不输出 weekly_key_sessions / 可省略 editorial」规则。
- **`user_prompt.md`**：无需改（per-athlete 值已在 current_phase_block）。
- 注意 Prompt role discipline（CLAUDE.md）：SKILL.md 仍不得含 per-athlete 值；
  具体 completed-weeks/日期走 user 侧的 current_phase_block。

### 4. 前端 — `frontend/src/pages/TrainingPlanPage.tsx::SeasonOverview`
- `MasterPlanPhase` 类型加 `is_completed?: boolean`（`api.ts`）。
- timeline band + phase pills：`is_completed` 的阶段灰显（opacity / 勾选 icon），
  与 current（`current_phase_id` 高亮）区分。
- 默认选中阶段仍是 current（`selectedPhaseId ?? currentPhaseId ?? phases[0]`）。
- PhaseDetail：completed 阶段顶部加「已完成」徽标；editorial 字段为空时优雅降级
  （已支持）。

### 5. 评估回归 — `docs/coach-eval_S1.md` + S1 fixtures/rules
- `coach/graphs/generation/master_rule_filter.py`（L1 `run_master_rule_filter`）：
  - `weekly_key_sessions_present`：completed phase 无 weeks 不算 violation。
  - volume-ramp / peak_before_race / target_distance_long_run 等：只对 entry
    phase 起的 weeks 校验，跳过 completed weeks。
- fixtures：新增/更新一个含 completed base phase 的 fixture，确认不触发 violation。
- judge axes：可加「周期延续性 / 已完成阶段保留」轴（可选）。

### 6. 迁移收尾 — 重新生成 zhaochaoyi
- generation 改好后：本地 `migrate_master_plan_local.py` 重新生成 →
  确认 phases[0] 是 base(is_completed) + week_index 连续 + current 指 speed →
  导出 bundle → `push_master_plan_to_prod.py --execute` 覆盖 prod。

## 执行顺序（建议分 PR 或单分支分 commit）

1. schema `is_completed` + builder 解析（最小，向后兼容，单测）
2. prompt 改 current_phase.md + SKILL.md（跑 `TestPromptRoleSplit` 不变量）
3. 前端 SeasonOverview completed 渲染 + 本地 smoke
4. S1 master_rule_filter + fixtures 更新，跑 S1 eval 回归（L1+L2+L3）
5. 重新生成 + push 覆盖 zhaochaoyi 的 prod plan，浏览器验证完整 timeline

## 向后兼容 / 风险

- `is_completed` 默认 False → 所有旧 plan、eval fixture、无已完成阶段的新用户
  行为**完全不变**（无 current_phase_block 时不输出 completed phase）。
- 风险点：L1 rules 对 completed weeks 的跳过要全面，否则旧 ramp/peak 规则会对
  已完成阶段误报 → 评估回归必须覆盖。
- `current_week_number` 现在指向 entry phase 中的实际周，需确认前端「当前周」
  指示一致。

## 分支

从 `origin/master` 新建（如 `feat/s1-completed-phase-continuity`）。本计划文档
随该分支携带。
