# 调整预案手册（adjust-master-plan 参考）

本手册是 `adjust-master-plan` SKILL 的补充参考：给出「调整原因 → 证据 → 策略 → 目标影响」的展开矩阵，以及三个典型示例。调整的底层训练学规则（阶段顺序、最低时长、Q/L 计数、form 分布、key_sessions 结构）一律以 [`generate-master-plan`](../generate-master-plan/SKILL.md) 为准。

## 缩写

- Q：强度课（间歇、节奏、混氧等）
- L：长距离
- MP：目标马拉松配速（半马计划中为目标半马配速）
- E：有氧慢跑 / 轻松跑

---

## 展开矩阵

### 1. 伤病 `injury`

| 维度 | 内容 |
| --- | --- |
| 证据 | `injuries` 记录；`recent_history.weeks` 跑量/强度课骤降；`continuity.days_since_last_run` 增大；`fitness_state.form` 异常 |
| 分诊 | 轻度（跑中可忍受、跑后不加重）→ 减量可继续；中度（持续痛、影响跑姿）→ 替换课型 + 减量；重度（应力性骨折风险、静息痛）→ 建议就医停训，不排计划 |
| 负荷策略 | 未来 2-4 周周剂量 −15~30%；移除 I/R/T 与长距离；交叉训练（游泳/骑行）+ E 跑；力量聚焦伤病周围肌群与核心 |
| 里程碑 | 顺延受影响阶段里程碑；临时降低达标标准（如长距离距离下调、间歇配速放宽） |
| 目标影响 | 通常下调 `goal.target_time` 或推迟 `goal.race_date`；在 `coach_note` 显式声明 |
| 复训 | 伤病期后插入 1 周过渡适应周再回阶段负荷 |

### 2. 目标赛事变化 `race_change`

| 维度 | 内容 |
| --- | --- |
| 证据 | 用户口径 + 当前 `goal.race_date` / `goal.distance` 与新目标差异 |
| 周期重排 | 剩余周数 = 新比赛日 − 调整点；按阶段顺序 + 最低时长下限重排；已达标阶段冻结 |
| 时间变长 | 延长薄弱阶段或专项期；保持/上调目标 |
| 时间变短 | 压缩前置阶段，刚性保障专项期与减量期下限；低于极限时长输出最高级风险提示 |
| 距离切换 FM↔HM | 切换最低时长表、里程碑距离标准、专项长距离（FM 28-32km / HM 16-18km）、taper 长距离上限（FM ≤25km / HM ≤15km） |

### 3. 目标成绩调整 `goal_revision`

| 维度 | 内容 |
| --- | --- |
| 下调证据 | `milestones[].completed_actual` 未达标；`recent_history.weeks` 专项长距离/MP 分段未达成 |
| 上调证据 | 里程碑实测超额、`fitness_state` 提升期持续、`recent_history` MP 表现稳定超目标 |
| 策略 | 仅改 `goal.target_time` + MP 配速区间（用 `running_calibration.pace_zones` / `threshold_speed_mps` 重推）；同步 MP 相关 key_sessions 与里程碑达标标准；阶段结构/周数基本不动 |
| 约束 | 目标成绩改动必须用户确认；上调不得仅凭意愿 |

### 4. 时间/生活约束 `constraint`

| 维度 | 内容 |
| --- | --- |
| 证据 | 用户口径 + `recent_history.weeks.run_day_count` 下降 |
| 策略 | 下调 `weekly_distance_km_high` 与周剂量；key_sessions 减为 0Q1L / 1Q1L；力量课频率下调；长距离占周量 <33% |
| 目标影响 | 显式提示压缩幅度对目标成绩的影响 |

### 5. 疲劳过度 / 过度负荷 `overtraining`

| 维度 | 内容 |
| --- | --- |
| 证据 | `fitness_state.form` < −25%（overreach，按当日 chronic 比例判定，见 AGENTS.md）；`recent_history.weeks.rhr` 上行 / `hrv` 下行 |
| 策略 | 调整点后立即插入 1 周 `recovery`（−15~20%）；未来 2-4 周 ramp 压到 3-5%；强化 `recovery.focus` / `adjustment_trigger` |
| 目标影响 | 短期不影响目标；持续则重新评估目标 |

### 6. 中断后复训 `resume`

| 维度 | 内容 |
| --- | --- |
| 证据 | `continuity.days_since_last_run` 大；`recent_history.weeks` 出现空窗 |
| 策略 | 以当前 `fitness_state.ctl` / `running_calibration` 重锚能力起点；按能力定位重排剩余阶段；首周过渡适应 |
| 目标影响 | 视中断时长可能影响目标 |

---

## 示例 1：伤病

- **诉求**：备赛全马，专项期第 2 周"右膝髌骨处隐痛"，跑后加重。
- **证据**：`injuries` 有一条右膝记录；`recent_history` 上两周跑量 −25%；`current_phase = marathon`。
- **策略**：
  1. 未来 3 周进入减量：周剂量 −25%，移除 T/MP 课与长距离，替换为游泳 + E 跑（40-50min）。
  2. 里程碑「MP 配速分段突破」「专项长距离达标」顺延 3 周，长距离达标标准临时从 30km 下调到 24km。
  3. 力量课保留核心 + 髋膝稳定，不安排深蹲/弓步等膝负荷大的动作。
- **目标影响**：`goal.target_time` 从 3:10 下调到 3:20；`coach_note` 声明"右膝伤病导致专项窗口缩短，目标下调 10 分钟"。

## 示例 2：目标赛事变化（改期）

- **诉求**：原定 10 月 26 日全马改到 11 月 30 日，当前处于过渡期（build）第 4 周，已完成 12 周。
- **证据**：`goal.race_date = 2026-10-26`；`current_phase = build`；新比赛日 2026-11-30。
- **策略**：
  1. 重算剩余周数：调整点 → 11-30 共约 14 周（含减量）。
  2. 冻结已完成 12 周；剩余按 build 补齐 1 周 → marathon 8 周 → taper 2 周（比原计划多出的约 4 周延长专项期）。
  3. 目标成绩维持 3:10，不调整。
- **目标影响**：时间变长，专项期延长，可维持目标。

## 示例 3：目标成绩调整（下调）

- **诉求**：里程碑"10km 测试赛达标"未完成，实测 10km 比预期慢 3 分钟，想下调全马目标。
- **证据**：`milestones[].completed_actual` 10km 测试赛未达阈值；`recent_history` MP 分段表现偏弱。
- **策略**：
  1. `goal.target_time` 从 3:10 下调到 3:20；MP 配速区间放宽约 10-12s/km（用 `pace_zones` 重推）。
  2. 阶段结构与周数不动；同步更新专项期 MP 分段、MP 内嵌长距离的配速目标与里程碑达标标准。
- **目标影响**：目标成绩本身下调，阶段结构保持稳定。
