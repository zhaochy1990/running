---
name: adjust-master-plan
description: >-
  针对已在使用某个赛季训练计划（MasterPlan）训练一段时间的用户，根据伤病、目标赛事变化、目标成绩调整、时间/生活约束、疲劳过度或中断复训等原因，在现有计划基础上调整并输出完整替换版赛季训练计划。冻结已完成阶段/周，仅重排剩余赛季，遵循 Jack Daniels 训练法体系与 generate-master-plan 的既有规则。
---
# 调整赛季训练计划（丹尼尔斯训练法）

## 核心顶层原则（全局强制执行）

1. 本技能以 **Jack Daniels 四阶段训练体系** 为底层框架，调整后的阶段划分、负荷权限、强度进阶、里程碑设置、key_sessions 结构**全部沿用 [`generate-master-plan`](../generate-master-plan/SKILL.md) 的规则**，本技能只定义"如何从既有计划出发做调整"，不重复生成规则。
2. 调整的唯一可信数据源是工具返回的 **当前激活 MasterPlan（`get_master_plan`）** 与 **上下文（`get_master_plan_context`）** 中的 `plan_start` / `as_of` / `current_phase`。禁止凭空生成新计划、禁止使用系统当前日期推导"本周/下周"。
3. **冻结原则（HARD）**：`is_completed === true` 的阶段、以及 `week_start` 早于 `as_of` 所在周的周计划，必须**原样保留**（含 `summary`、`milestones[].completed_actual`、`key_sessions`、`strength`、`recovery`、`coach_note`），只重排冻结边界之后的剩余赛季。对已完成阶段的任何"重写/润色"都视为错误。
4. **调整原因驱动策略**：先分类调整原因，再选择对应策略。不同原因对应不同策略，不得混用：伤病=减量（且不可避免影响目标成绩）；目标赛事变化=重排训练周期；目标成绩调整=只动目标与 MP 配速。
5. 所有配速、心率区间从用户标定数据（`running_calibration`）读取，禁止自行估算。
6. 产出**完整替换版 MasterPlan**，复用 generate-master-plan 的输出 schema、枚举值与校验规则。

---

## Step 1：加载上下文与确认调整原因

### 1.1 调用工具（各一次）

必须且仅调用一次 `get_master_plan` 与一次 `get_master_plan_context`：

- `get_master_plan`：当前激活赛季计划（目标、阶段、里程碑、周框架）。**返回 null 时立即停止**，说明没有可调整的激活计划，引导用户先走 generate-master-plan。
- `get_master_plan_context`：个人最佳、跑步校准、比赛/训练历史、近期按周训练与恢复、当前 CTL/ATL/Form、伤病记录、`active_plan`（含 revision）、`current_phase`、`continuity`、数据基准日 `as_of` 与计划起始日 `plan_start`。

### 1.2 调整原因分类

将用户诉求归类到下列原因之一；无法确定时用 `ask_user_question` 追问（原因、严重程度、预期时长、约束）。用户可能同时命中多个原因（如"受伤 + 目标赛事改期"），此时逐条应用对应策略并合并。

| # | 原因 | 典型表述 | 关键证据（来自工具） | 核心调整策略 | 对目标成绩的影响 |
| --- | --- | --- | --- | --- | --- |
| 1 | 伤病 `injury` | "膝盖疼""扭伤了""跑不了" | `injuries`；`recent_history.weeks` 跑量骤降；`continuity.days_since_last_run` 增大 | 减量、替换高强度课为交叉训练/轻松跑、插入恢复周或延长当前阶段、顺延或下调里程碑 | 通常下调目标成绩或推迟比赛日；严重时建议停训就医 |
| 2 | 目标赛事变化 `race_change` | "10月比赛改到11月""改报半马""比赛取消" | 用户口径 + 当前 `goal.race_date` / `distance` 与新目标差异 | 以新比赛日重算剩余周数，重排阶段周期化；距离变化时切换全马/半马权重与最低时长 | 时间变长可维持/上调目标；变短则压缩前置阶段并提示风险 |
| 3 | 目标成绩调整 `goal_revision` | "里程碑没完成想下调""状态好想冲更快" | `milestones[].completed_actual` 未达标；或 `recent_history` / `fitness_state` 表现超预期 | 仅调整 `goal.target_time` 与 MP 相关配速、重算 MP 配速区间；阶段结构与周数基本不动 | 直接对应目标成绩本身 |
| 4 | 时间/生活约束 `constraint` | "出差两周""这月只能跑3天" | 用户口径 + `recent_history.weeks.run_day_count` 下降 | 下调周跑量上限、减少 key_sessions 数量与课型、下调力量课频率 | 视压缩幅度可能影响目标，需显式提示 |
| 5 | 疲劳过度/过度负荷 `overtraining` | "很累""睡不好""状态一直差" | `fitness_state.form` < −25%（overreach）；`recent_history.weeks.rhr` 上行 / `hrv` 下行 | 调整点后立即插入 1 周恢复（减 15-20%），未来 2-4 周 ramp 压到 3-5% | 短期不影响目标；若持续需重新评估目标 |
| 6 | 中断后复训 `resume` | "停了一两周" | `continuity.days_since_last_run` 大；`recent_history.weeks` 出现空窗 | 以当前 CTL/标定重锚能力起点，重排剩余阶段，首周过渡适应 | 视中断时长可能影响目标 |

其它原因（多赛事、赛前伤病减量、完赛策略调整等）可归入上述类别或组合处理。

---

## Step 2：确定冻结边界与调整点

1. **冻结边界** = 最后一个已完成的周：某周 `week_start`（周一）早于 `as_of` 所在周，或其所在阶段 `is_completed === true`。
2. **冻结阶段**：`is_completed` 保持 true；`summary` 已填则原样保留（已冻结但 `summary` 为 null 时，补写一句客观完成总结，不虚构数据）；`milestones[].completed_actual` 回填真实达标结果。
3. **调整点** = 冻结边界之后的第一周，其 `week_start` 必须等于 `get_master_plan_context.plan_start`（下一个周一）。
4. **剩余赛季** = 从调整点到（新的）比赛日的所有周。比赛日之前的 `taper` 减量期与（若适用）赛前内容必须纳入剩余赛季。

---

## Step 3：按原因执行调整策略

### 3.1 伤病 `injury`

1. **减量**：未来 2-4 周周剂量下调 15-30%（按伤病严重程度），移除或替换所有 I/R/T 高强度课与长距离，改用交叉训练（游泳/骑行）+ 轻松跑。
2. **里程碑顺延**：将受影响阶段的里程碑后移，或临时降低达标标准（如长距离距离下调）。
3. **目标影响（必须显式告知）**：明确说明"该伤病不可避免影响目标成绩达成"，给出目标成绩下调建议或比赛推迟建议；疑似应力性骨折等严重伤病时建议就医停训，**不得硬排计划**。
4. **伤愈复训**：在伤病期结束后插入 1 周过渡适应周，再回到阶段目标负荷，禁止直接从 0 跳回高强度。

### 3.2 目标赛事变化 `race_change`

1. **重算剩余周数** = 新比赛日 − 调整点。
2. **重排阶段周期化**：按 generate-master-plan 3.2 的阶段顺序与最低时长下限重新分配剩余周；已达标阶段不重复安排（冻结），压缩前置阶段、**刚性保障专项期与减量期下限**。
3. **时间变长**：优先延长当前薄弱阶段或专项期；**时间变短**：压缩前置阶段，若低于极限备赛时长（全马 12 周 / 半马 7 周）输出最高级风险提示。
4. **距离变化（FM↔HM）**：切换全马/半马最低时长、里程碑距离标准、专项长距离距离（全马 28-32km / 半马 16-18km）、taper 长距离上限（全马 ≤25km / 半马 ≤15km）。

### 3.3 目标成绩调整 `goal_revision`

1. **下调**：降低 `goal.target_time`，同步放宽 MP 配速区间（用 `running_calibration` 的 `pace_zones` / `threshold_speed_mps` 重新推导 MP）；阶段结构与周数基本不动，仅同步 MP 相关 key_sessions 与里程碑达标标准。
2. **上调**：仅在 `recent_history` / `fitness_state` / 里程碑实测明确支持时上调，并给出风险提示；不得仅凭用户意愿激进上调。
3. 目标成绩的任何改动必须经用户确认后才写入输出。

### 3.4 时间/生活约束 `constraint`

1. 下调 `weekly_distance_km_high` 与周剂量，减少 key_sessions 数量（0Q1L 或 1Q1L），力量课频率下调。
2. 长距离占周量仍遵守 <33% 的 anti-pattern 约束。
3. 明确压缩幅度对目标成绩的影响。

### 3.5 疲劳过度/过度负荷 `overtraining`

1. 在调整点后立即插入 1 周 `recovery`（减 15-20%），未来 2-4 周 ramp 压到 3-5%。
2. 强化 `recovery.focus` 与 `recovery.adjustment_trigger`。

### 3.6 中断后复训 `resume`

1. 以当前 `fitness_state.ctl` / `running_calibration` 重锚能力起点，按 generate-master-plan 3.2 的能力定位重排剩余阶段。
2. 首周设置为过渡适应周，强度与负荷逐步爬坡。

---

## Step 4：重建剩余赛季并冻结已完成部分

1. **阶段**：冻结阶段原样透传；剩余阶段重新生成（`phase_name` 不重复、里程碑 2-3 个、`strength` / `recovery` / `milestones` 三模块齐全）。
2. **周**：冻结周原样透传；剩余周 `week_index` 从冻结周数 +1 连续递增，`week_start` 从调整点开始连续周一。
3. **key_sessions / workout_structure / Q-L 独立计数 / form 分布**：沿用 generate-master-plan Step 3 / Step 4 全部规则（含 `run-workout/v1` 结构、work 段禁止 open、长跑内嵌配速不拆课、恢复周 ≤1 节关键课等）。
4. **力量与恢复**：沿用 generate-master-plan 3.3 / 3.4。

---

## Step 5：结构化输出 MasterPlan（替换版）

输出格式与 generate-master-plan Step 4 完全一致，另加：

1. `created_at` 保持不变；`updated_at` 为本次调整的 UTC ISO 8601 时间（带 `Z` 或 `+00:00`）；`status=draft`、`generated_by=coach_agent`、`version=1`。
2. 冻结阶段/周的字段**原样透传**，不得重写或"润色"。
3. `goal.race_date` 与 `target_time` 反映调整后的目标（若本次调整涉及）。
4. 风险提示（低于最低备赛时长、伤病、目标下调等）必须在相关字段或 `coach_note` 中显式标注。

---

## 补充说明

1. 参考资料：`references/adjustment-playbook.md` 为「调整原因 → 证据 → 策略 → 目标影响」的完整矩阵与三个典型示例（伤病 / 赛事改期 / 目标成绩调整）。
2. 冻结原则是 HARD：调整只重排剩余赛季，不推翻已完成的训练事实。
3. 低于标准最低备赛时长的调整结果，必须在计划开头显式标注风险提示。
