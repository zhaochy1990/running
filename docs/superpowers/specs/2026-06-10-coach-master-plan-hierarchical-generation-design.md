# Coach Agent — Master Plan 分层生成重构（设计）

**日期**：2026-06-10
**范围**：生产 Coach Agent（`src/coach/` 核心 + `src/stride_server/coach_adapters/` adapter），受两层 import-linter 约束。本地 `scripts/gen_my_master_plan.py` 作为测试入口。**持久化（落盘到 `logs/` 或 store）不在本次 scope**。
**状态**：设计待 review

---

## 1. 动机

当前 master plan 生成是**单次 LLM call** 直接吐出整份 `MasterPlan`（phases + milestones + 全部周的 `weekly_key_sessions` 骨架）。本 session 排查出几类问题：

1. **负荷量纲混用**：`_query_fitness_state` 读 COROS 厂商指标 `daily_health.ati/cti`，贴上 ATL/CTL 标签，但 plan 又套用 STRIDE 自研 form-zone 框架——两套不同量纲的负荷混用。实测同一天 COROS cti=120 vs STRIDE chronic=64。
2. **历史查询 bug**（已在本 session 修复）：`_query_history` 用 `sport_type = 1`（非有效跑步码）+ `distance_m/1000`（列实为 km）→ 历史归零。
3. **计划过于通用**：generation 只吃到 goal + DB 跑量 + 体能，没吃到 athlete 的伤病/约束/延续性，产出像通用模板。
4. **无延续性意识**：不考虑"赛后已恢复就不必排恢复期""已练多周有氧就不必再堆有氧"。

**目标（三点要求）**：

1. 统一使用 STRIDE 自研负荷，弃用手表厂商负荷，基于它做周期/计划设计。
2. 改单次生成为**分层生成 + review**：先生成 Phase + 各 Phase 的训练重点 + 可量化出口目标（milestone），再用**针对各 Phase 特点的专家 sub-agent** 生成每周的**完整周计划**。
3. 周期/计划设计考虑**训练延续性**。

---

## 2. 整体管线（三阶段）

```
Stage 0  load_context（确定性，复用并修好）
  ├ _query_history            ← 已修（RUN_SPORT_IDS + km 单位）
  ├ STRIDE 负荷                ← 本次修：backfill_training_load + 读 daily_training_load，弃用 ati/cti
  ├ continuity_analyzer        ← 新增：确定性延续性信号（见 §4）
  ├ baseline_history_summary   ← 注入跑量曲线 + 比赛史摘要
  └ injuries                   ← 从结构化 running_profile 注入（软信号，非 HARD rule）

Stage 1  structure_planner（1 个组件，prompt 按 macro_cycle 组合）
  输入：goal + 延续性信号 + 历史摘要 + injuries +（可选 read-tool drill-down）
  输出：phases[]（含 phase_type 枚举 + focus + 周量带）+ milestones[]（结构化出口目标）
  → L1-结构 rule_filter → 结构 reviewer → verdict

Stage 2  phase_router → 专家 sub-agents（按 phase 串行）
  for phase in phases（base→build→speed→peak→taper→recovery 顺序）:
    specialist = registry[phase.phase_type]      # 各自 prompt + tools
    for week in phase（串行）:
      ctx = phase spec + 本 phase milestone + 上一周收尾 + 累计 STRIDE 负荷 + injuries
      run week graph(specialist, ctx) → 完整 WeeklyPlan（plan.json）
      → L1-周 rule_filter（复用 S2 run_rule_filter）
    → per-phase reviewer（顺带查是否能达成本 phase milestone）

Stage 3  assemble + return（无持久化）
  组装 SeasonPlanBundle（MasterPlan 结构 + list[WeeklyPlan]）
  → L1-赛季聚合 rule_filter（跨周不变量）
  返回 bundle
```

**两层架构归属**：`continuity_analyzer` / STRIDE 负荷读取 / 专家 sub-agent 的 DB+LLM 副作用都在 **adapter 层**（`coach_adapters/`）；纯编排（结构图、phase 循环、router、三层 rule_filter、prompt 组合）在 **core 层**（`coach/`），不 import `stride_server.*` / `azure.*` / `stride_core.db`，守住 import-linter。

---

## 3. 数据层修正（统一 STRIDE 负荷 = 要求 #1 的基础）

| 项 | 状态 | 说明 |
|---|---|---|
| `_query_history` sport_type/km | ✅ 本 session 已修 | 用 `RUN_SPORT_SQL_LIST` + 按 `<500→km` 归一 |
| `generated_by` 取配置 | ✅ 本 session 已修 | `coach_runtime.get_generator_model()`，非硬编码 |
| `_query_fitness_state` 改 STRIDE 负荷 | ⏳ 本次 | 弃 `daily_health.ati/cti`，读 canonical `daily_training_load.acute_load/chronic_load/form` |
| context load 内 backfill | ⏳ 本次 | 调 `backfill_training_load`（足够 lookback 让 42 天 EWMA 收敛）后再读，避免冷启动低估 chronic |

**单一来源原则**：负荷一律走 `stride_core.training_load`（`daily_training_load` + `training_load/core.py`）。COROS `ati/cti` 不再进入 coach 生成路径。

---

## 4. continuity_analyzer 信号（确定性，要求 #3）

全部追溯到结构化存储或 canonical 代码，**不引用任何 markdown/CLAUDE.md**。

| 信号 | 来源 | 驱动决策 | 性质 |
|---|---|---|---|
| `days_since_last_race` | `race_predictions` / `activities` 比赛史 | 赛后久+已恢复 → 不排 recovery | 硬数据 |
| `post_race_recovery_status` | STRIDE `daily_training_load`（form/acute 回基线）+ `daily_health` RHR | recovered → 砍开头恢复期 | 硬数据 |
| `recent_aerobic_weeks` | `activities`（z2 容量达标连续周数） | 已练 N 周有氧 → 缩 base | 硬数据 |
| `recent_volume_trend` | `activities` 近 4-8 周周量+趋势 | base 起点周量 / ramp 斜率 | 硬数据 |
| `recent_longest_run_km` | `activities`（km 单位） | peak 长跑起点 | 硬数据 |
| `recent_quality_frequency` | `activities`（近期 z4+ 频率） | 是否已有强度基础 | 硬数据 |
| `current_form_zone` | STRIDE chronic/acute/form，按 canonical `training_load` form 分类 | 是否需先减量 | 硬数据 |
| `current_chronic_load` (CTL) | 修好后的 STRIDE chronic | 周量天花板（周 dose ≈ chronic×7） | 硬数据 |
| `return_from_layoff` | `activities`（近期 >N 周断训） | 断训回归 → base 延长、ramp 保守 | 硬数据 |
| `macro_cycle` + `season_context` | race date + 起止日期推断 | 选 prompt 片段（夏/冬）、夏段插 speed、长课热/冷调整 | 硬数据 |
| `injuries` | 结构化 `running_profile` | planner/专家**软参考**（延 base/避坡/换协议/控强度） | **注入信号，非 HARD rule** |

> **旁注（不阻塞）**：form-zone 比例带目前在 `training_load/core.py` / `routes/stride.py` / `routes/health.py` / `coach/.../prompts/shared.py` 等多处有副本，是 single-source 隐患。`continuity_analyzer` 接其中 canonical 那份；是否顺手收敛为单源留到实现时定。

---

## 5. Stage 1 — structure_planner（要求 #2 上半 + 季节性）

**一个组件**，共享硬逻辑（结构化输出解析、rule_filter 接入、信号注入、tool 访问、athlete 适配）。**system prompt 按 macro_cycle 组合**：

```
planner_prompt = SHARED_FRAGMENTS（输出 schema / 信号解读 / tool 用法 / 专家 registry 约束——两季单源）
               + MACRO_CYCLE_GUIDANCE[macro_cycle]
```

- `MACRO_CYCLE_GUIDANCE["summer"]`：长块、气温高、适合发展速度 → 中段排独立 speed cycle、长课避正午控量、base 可铺开。
- `MACRO_CYCLE_GUIDANCE["winter"]`：压缩块、温度低消耗小 → 堆有氧、base 长、尽快进专项、速度并入 build。

`macro_cycle` 由 race date 确定性推断（3 月赛 → 冬训块；10/11 月赛 → 夏训块），块起点由 continuity 信号定。**当前先一个 planner + 两套 prompt 片段；真有需要再拆独立 Agent（YAGNI）。**

**push/pull 混合**：确定性信号 + baseline 摘要**预先注入**（可测核心）；额外暴露现有 coach read-tool 给 planner 做 drill-down。**eval 时 tool 不关**，背后接真实 committed DB（见 §9）。

**输出**：`phases[]`（含 `phase_type`）+ `milestones[]`（结构化出口目标）+ `training_principles[]`。

---

## 6. Stage 2 — phase 专家 registry（要求 #2 下半）

**phase_type 是封闭枚举 = 专家 registry 的 key**。结构规划器只能吐出有对应专家的 phase 类型。

| phase_type | 专家侧重 | 特有 tools（通用 read-tool 之外） |
|---|---|---|
| `base` 基础期 | 有氧容量 + 力量，有氧占比高、强度低 | 力量动作库（COROS T-code）、mobility 库 |
| `build` 进展期 | 乳酸阈值 / 节奏 / 马拉松配速，chronic 上行 | 阈值配速计算（从 calibration 读 LTHR/threshold pace） |
| `speed` 速度周期 | VO2max / 短间歇 / 速度，占比高（夏训典型） | 间歇配速/距离计算、跑道课模板 |
| `peak` 赛前期 | 比赛专项长跑 + race pace | 目标配速 + 补给演练 |
| `taper` 减量期 | 降量保锐度，acute 下降 | — |
| `recovery` 恢复期 | 主动恢复 / 低负荷（按延续性信号条件插入） | — |

- 每个专家 = **自己 prompt（侧重写死，体现"speed 和 base 排课逻辑根本不同"）+ 自己 tools**。侧重不参数化。
- Stage 1 给专家传：phase spec + 周量带 + 本 phase milestone。
- **连续性**：phase 之间串行，专家拿到上一 phase 收尾 + 累计 STRIDE 负荷；phase 内逐周顺序排，周与周自然衔接。orchestrator 维护 running context 往下传。
- **产出**：每周一份**完整 WeeklyPlan**（复用 S2 `WeeklyPlan` schema + `WeeklyPlan.from_dict` 校验）。

`master_rule_filter` 新增 `phase_type_has_specialist`，校验每个 phase_type 都有注册专家。

---

## 7. Schema / 状态改动

### 7.1 结构层
- **新增 `PhaseType` 枚举** = registry key 封闭集。
- **`Phase` 加 `phase_type: PhaseType`**（Stage1↔2 路由硬绑定）；保留 `name`/`focus` 作展示。
- **`Milestone` 改结构化出口目标**：
  ```
  Milestone { phase_id, metric, target_value, comparator, target_text }
  # 例: 速度周期末 5k sub-19 → metric="race_time_s_5k", target_value=1140, comparator="<="
  ```
- **`MasterPlan` 删除 `weekly_key_sessions`**（彻底删，不保留派生摘要）。

### 7.2 新增产物容器
```
SeasonPlanBundle { master_plan: MasterPlan, weekly_plans: list[WeeklyPlan] }
```
管线返回此 bundle（不持久化）。

### 7.3 编排状态
**复用 `build_generation_graph` 作为"单元生成器"**（不重写图）：
- 结构阶段 = `build_generation_graph(generator=structure_planner, rule_filter=master_structure_rule_filter, reviewer=structure_reviewer)`。
- 每周 = `build_generation_graph(generator=phase_specialist[type], rule_filter=run_rule_filter, reviewer=…)`。
- **新增外层 orchestrator**（adapter 层）：跑结构图 → 按 phase 串行 → phase 内按周串行 → 拼 bundle，threading 连续性 context。
- `GenState.plan_type` 加 `"master_structure"`；周用 `"week"`。orchestrator 自己的外层状态承载 bundle 拼装 + running context。

---

## 8. 三层 rule_filter + reviewer

### 8.1 rule_filter 三层
| 层 | 跑在哪 | 查什么 |
|---|---|---|
| **L1-结构** | Stage 1（MasterPlan 结构） | phase 数/顺序/时长、peak 在 race-1..3 周、season window、goal realism、phase_type 有专家、**milestone 可行性** |
| **L1-周** | Stage 2（每个 WeeklyPlan） | 单周有效性：`WeeklyPlan.from_dict`、周内强度分布、≥1 休息日、单日 dose 占比（复用 S2 `run_rule_filter`） |
| **L1-赛季聚合** | Stage 3（全套周计划拼好后） | 跨周不变量：相邻周量 ramp ≤1.10、taper 降 ≥25%、peak 最长跑达标、recovery 节奏、零 dose 天 ≤2/周、不 spike+flat。**原 weekly_key_sessions 规则迁来，现在跑在真实周计划上** |

> 单周 filter 看不到跨周，故必须有第三层赛季聚合。**伤病不进任何 rule_filter**（仅注入信号）。

**设计考量 #1 — long-run 占周量比例（dose vs distance）**：现有 `hard_session_spacing` / 单日 dose 规则查的是 **dose** 比例；但实测（2026-06-11 带伤病生成）发现 z2 长跑 dose/km 低，导致 28-32km 长跑在 74-80km 周量下占**距离** 37-40%，突破"单日 ≤35% 周量"红线却仍 pass。L1-赛季聚合需新增 `long_run_distance_share` 规则：peak 期最长 `long_run.distance_km` / `target_weekly_km_high` > 0.35 → warning。**但对 volume-capped 跑者（伤病/历史峰值限制周量）需有显式例外**：当 chronic/历史峰值限制周量、而 target distance 又要求 ≥28km 长跑时，distance-share 必然偏高——此时规则应降级为 warning 并要求 plan 在 principles 里显式说明 trade-off（"周量受 Achilles 限制在 80km，长跑占比偏高是 FM 专项耐力的必要代价"），而不是 hard block。structure_planner 也应在 macro_cycle 提示里意识到这个张力（要么在伤病允许时抬高 peak 周量，要么接受并说明）。

### 8.2 reviewer 放置（选项 A）
- **结构 reviewer**（1 call）：生成 19 周前先审周期化（S1 axes：season_structure / peak_timing / goal_realism / continuity_respect）。
- **per-phase reviewer**（~4 call）：每 phase 的周成组审，查是否达成本 phase milestone。
- **不做** per-week reviewer（单周质量靠 L1-周 + L1-聚合兜）。
- reviewer 初期可仍为 stub，但位置在管线里预留好；接真 Claude reviewer 为后续增量。

---

## 9. Eval（用真实 DB）

- **完整真实 `coros.db` 快照** commit 进 tests（**不裁剪**——专家 tool 可能读 timeseries，裁剪会让 tool 路径不可测）。
- eval 跑**完整三阶段管线** against 真实 DB；**tool 全开**，背后接这个 committed DB（真实数据源，非脱敏 fixture）。toolkit 构造时绑 data source（生产绑 live DB / eval 绑 committed DB）。
- **L1** = §8.1 三层 rule_filter，每次确定性跑。
- **L2 judge** 评 `SeasonPlanBundle`：结构沿用 S1 axes + 新增 `continuity_respect` + `milestone_achievability`；周计划质量抽查 S2-ish axes。
- **复现性**：同一冻结 DB → tool 返回相同数据；LLM 采样波动交给 judge（与现 S1 eval 一致，非 exact-match replay）。
- 新增 **continuity 场景**：如"已完全恢复+距上场比赛久 → 无开头恢复期""已练 8 周有氧 → base 缩短"。

---

## 10. 迁移 / blast radius

删除 `weekly_key_sessions` + 改 Milestone 结构波及：
- `coach/graphs/generation/master_rule_filter.py`：查骨架的规则迁到 L1-赛季聚合。
- S1 eval fixtures（`tests/fixtures/coach_eval/s1/`）：期望字段更新。
- 前端：若渲染 weekly_key_sessions / milestone.target 需同步（前端改动本次仅标注，不实施）。
- `routes/master_plan.py` 序列化：`_build_current_response` 去掉骨架字段、适配新 Milestone。
- 现有 `master_plan_generator.run_generate_job` 单次路径：由 orchestrator 取代或并存（迁移策略实现时定）。

---

## 11. Out of scope / 后续

- **持久化**：bundle 落盘到 `logs/{week}/plan.json` + master plan store。
- **夏/冬独立 planner Agent**：当前一个 planner + prompt 片段；真有需要再拆（YAGNI）。
- **真 Claude reviewer 接入**：位置预留，实现为增量。
- **form-zone 分类单源收敛**：旁注隐患，非阻塞。
- **前端适配**：仅标注 blast radius。

---

## 12. 组件清单（隔离单元）

| 单元 | 层 | 职责 | 依赖 |
|---|---|---|---|
| `continuity_analyzer` | adapter | DB → ContinuitySignals | `stride_core.db` / `training_load` / `running_profile` |
| STRIDE 负荷 reader（修 `_query_fitness_state`）| adapter | 读 `daily_training_load` + backfill | `stride_core.training_load` |
| `macro_cycle` detector | core | race date → 夏/冬 + season_context | 纯函数 |
| `structure_planner` + macro-cycle prompt registry | core(prompt)/adapter(LLM) | 出 phases+milestones | LLM |
| phase specialist registry + router | core | phase_type → 专家 | — |
| 专家 week generator | adapter | phase → 每周 WeeklyPlan | LLM + tools |
| read-tool 暴露（绑 data source）| adapter | drill-down | 复用 `coach_adapters/toolkit.py` |
| 三层 rule_filter | core | L1 结构/周/赛季 | 纯函数 |
| reviewer（结构 + per-phase）| core(图)/adapter(LLM) | L2 把关 | LLM |
| orchestrator | adapter | 串三阶段 + 连续性 threading + 拼 bundle | 复用 `build_generation_graph` |
