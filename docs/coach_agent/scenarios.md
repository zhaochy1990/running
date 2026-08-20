# Coach Agent Master Plan Scenarios

本文定义 Coach Agent 生成战略级赛季训练计划（Master Plan）时必须覆盖的用户场景。Master Plan 只描述阶段、周量范围、里程碑和逐周关键课 skeleton；普通 easy、recovery 和填充跑由 Weekly Plan 生成。

## 固定流程的含义

推荐的主流程为：

```text
Intake
  -> Context
  -> Assessment
  -> Strategy
  -> Skeleton
  -> Rule Filter
  -> Reviewer
  -> Revision
```

固定的是每个阶段的输入、输出和质量门禁，而不是要求所有用户执行相同训练模板。流程必须允许条件分支、跳过不适用步骤、回到澄清阶段，以及在不适合生成计划时提前结束。

每个阶段都可以返回以下工作流决策：

| Decision | 含义 |
|---|---|
| `continue` | 上下文充分且风险可控，继续生成 |
| `needs_clarification` | 缺少会实质改变计划的信息，需要追问 |
| `needs_baseline` | 缺少能力或训练耐受基线，先生成评估周期 |
| `goal_conflict` | 多个目标、时间或约束无法同时满足 |
| `multi_cycle_required` | 用户目标无法通过一个赛季合理实现 |
| `blocked_for_safety` | 当前健康或伤病风险不适合生成正常训练计划 |
| `unsupported` | 目标项目或需求不在当前 planner 能力范围内 |

运行时输出应明确区分三个字段：

```text
planning_mode + decision + optional_artifact
```

- `planning_mode` 表示本次规划采用的场景策略，可以包含一个 primary mode 和若干 modifiers。
- `decision` 表示工作流下一步，例如继续、追问、阻断或要求建立基线。
- `optional_artifact` 只在当前 decision 允许时包含 assessment、strategy preview 或 skeleton。

### 多场景命中优先级

同一用户可能同时命中多个场景，例如“急性伤病 + 比赛临近 + 每周只能跑三天”。此时不要强行选择单一场景，使用一个 primary mode 加 modifiers，并按以下顺序决策：

1. **安全优先**：急性伤病或医学风险覆盖其它模式，返回 `blocked_for_safety`。
2. **支持能力**：没有匹配项目 planner 时返回 `unsupported`，不使用其它项目模板代替。
3. **目标冲突**：互不兼容的比赛、时间和约束先返回 `goal_conflict`。
4. **关键信息缺失**：安全相关信息缺失先 `needs_clarification`；能力基线缺失再 `needs_baseline`。
5. **赛季位置**：按 post-race、in-season continuation、race salvage 或 new season 选择 primary mode。
6. **执行约束**：低频、伤病史、环境和日程作为 modifiers，调整 Strategy 和 Rule Filter。

例如，健康但距离比赛仅三周、每周只能跑三天的用户可表示为：

```text
planning_mode = race_salvage
modifiers = [frequency_limited]
decision = continue
```

## 场景 1：没有目标比赛

**典型请求**：提升跑步能力、减脂、保持健康、建立有氧基础。

**Planning mode**：`general_fitness`、`base_development` 或 `weight_management`。伤后返跑统一进入场景 6 的 `return_to_run`。

**流程变化**：不强行构造 race peak、比赛专项期或 taper。Strategy 应生成滚动的 8-12 周 development block，并设置重新评估节点。

**合法输出**：通用发展计划、基础周期或 `needs_clarification`。

**禁止行为**：虚构比赛日期；套用马拉松备赛模板；为不存在的比赛设计 taper。

## 场景 2：数据和自报信息都不足

**典型情况**：新用户没有 PB、训练区间、稳定周量、跑步历史或可靠伤病信息。

**Planning mode**：`baseline_assessment`。

**流程变化**：Assessment 不应猜测能力。缺少可能影响安全判断的伤病或健康信息时，先返回 `needs_clarification`。只有安全边界明确但能力不足时，才生成 2-4 周 onboarding/assessment block，收集跑频、easy HR/RPE、长跑耐受和必要的测试结果，再进入正式赛季规划。

**合法输出**：`needs_baseline`，附带短期评估计划和下一次评估条件。

**禁止行为**：根据年龄或通用公式虚构阈值；直接生成完整赛季；把无数据用户默认视为新手或高水平运动员。

## 场景 3：距离比赛时间过短

**典型情况**：距离全马只剩 2-4 周，已没有产生新适应的时间。

**Planning mode**：`race_salvage`、`taper_only` 或 `completion_strategy`。

**流程变化**：跳过标准 base/build/peak 周期，不补训练债。Assessment 聚焦当前准备程度、健康风险和可实现目标；Strategy 聚焦减量、维持跑感和比赛执行。

**合法输出**：短周期 taper skeleton、建议调低的目标、战略级完赛准备重点，或在风险过高时 `blocked_for_safety`。比赛日配速分段和补给时点属于后续比赛执行计划，不在 Master Plan 展开。

**禁止行为**：短期突增周量；补做遗漏长跑；承诺在数周内获得长期训练适应。

## 场景 4：目标成绩明显不可实现

**典型情况**：全马 PB 4:00，8 周后目标 2:50。

**Planning mode**：`goal_negotiation` 或 `multi_cycle_development`。

**流程变化**：Goal Assessment 必须区分用户愿景和本周期可执行目标，提供有依据的 A/B/C 目标或多周期路径。必要时停在目标协商阶段。

**合法输出**：`multi_cycle_required`，或提出以现实 B/C 目标作为本周期默认、将用户目标保留为长期愿景的候选方案。目标变化必须经用户明确确认后，才能生成权威 skeleton。

**禁止行为**：生成一条看似能在单周期达到目标的虚假路径；仅用免责声明掩盖不现实计划；用危险周量追逐目标。

## 场景 5：急性伤病或医学风险

**典型情况**：疼痛改变步态、疑似应力性骨折、胸痛、晕厥、发热，或医生明确禁止跑步。

**Planning mode**：`safety_hold`。

**流程变化**：立即停止正常训练计划生成。Coach 只能说明停止训练和寻求合格专业评估的边界建议，不提供诊断或康复处方。

**合法输出**：`blocked_for_safety`，并列出恢复规划前所需的医学许可或状态信息。

**禁止行为**：继续安排跑步或力量课；用低强度训练替代就医建议；把 Coach 表述成医疗专业人员。

## 场景 6：伤后返跑但缺少明确基线

**典型情况**：用户获准恢复活动，但跑步耐受、疼痛反应或当前能力尚不明确。

**Planning mode**：`return_to_run`。

**流程变化**：先生成 rebuild/return-to-run block，设置疼痛、肿胀、次日反应、跑走耐受和基础力量 checkpoint。只有通过 checkpoint 后才展开后续 build/peak。

**合法输出**：条件式短期 skeleton；远期阶段可以保留方向，但不能写成无条件确定计划。

**禁止行为**：直接恢复伤前周量；用陈旧 PB 决定当前训练配速；提前安排高强度或峰值长跑。

## 场景 7：赛季进行中，需要延续或重规划

**典型情况**：基础期已经完成，用户当前处于 build，因执行偏差、环境变化或新信息需要重规划剩余赛季。

**Planning mode**：`continue_existing` 或 `replan_remaining_season`。

**流程变化**：Context 必须确定已完成阶段、当前阶段位置和最近实际执行。Assessment 只评估剩余赛季；已完成阶段作为历史保留，但不重新生成对应 weeks。

**合法输出**：从当前或经 Assessment 推荐的 entry phase 开始的剩余赛季 skeleton。若严重断训或状态倒退，允许有依据地回到 rebuild/base。

**禁止行为**：未经 Assessment 自动从 Week 1 或 base 重启；改写已完成训练；忽略最近实际周量和未完成关键课。

## 场景 8：刚完成目标比赛

**典型情况**：用户刚完成全马，希望马上规划下一场比赛。

**Planning mode**：`post_race_transition`。

**流程变化**：先进行比赛复盘和恢复状态评估，再生成 recovery block。只有通过睡眠、疼痛、疲劳和轻松跑恢复 checkpoint 后，才进入下一赛季 Strategy。

**合法输出**：战略级赛后恢复 skeleton、下一次规划日期或条件；状态稳定后再生成下一赛季。逐日恢复跑和生活安排属于 Weekly Plan。

**禁止行为**：比赛结束后立即进入 build；用下一目标跳过恢复；把一次比赛结果直接当作完整的新能力基线。

## 场景 9：多个比赛目标

**典型情况**：9 月半马、10 月全马、12 月越野赛，且用户可能希望全部作为主要目标。

**Planning mode**：`multi_race_season`。

**流程变化**：先标记 A/B/C race priority，评估赛事间隔、距离和训练适应是否兼容。B/C race 可以作为 tune-up、测试或训练；互相冲突的 A race 必须要求用户取舍。

**合法输出**：有明确优先级的多赛事赛季计划，或 `goal_conflict`。

**禁止行为**：把所有比赛都当作 A race；为相邻比赛重复 peak/taper；忽略比赛后的恢复成本。

## 场景 10：低频或高度受限的训练日程

**典型情况**：每周只能跑 2-3 次，固定工作日无法训练，或无法安排双练。

**Planning mode**：`frequency_limited`。

**流程变化**：Rule Filter 必须读取用户频次和时间约束。每周通常只保留长跑与一个质量刺激；包含比赛配速的长跑本身计为质量课。周量、长跑占比和恢复规则使用受限频次口径。

**合法输出**：可执行的低频 skeleton，明确训练取舍和目标影响。

**禁止行为**：套用 5-6 跑模板；通过额外短 jog 绕过频次限制；为了满足普通长跑占比规则而虚增周量。

## 场景 11：高水平运动员或教练协作

**典型情况**：用户已有完整 periodization，只希望系统审查、模拟负荷或调整局部阶段。

**Planning mode**：`review_existing_strategy` 或 `coach_collaboration`。

**流程变化**：跳过从零生成 Strategy。导入现有计划，执行 Assessment、负荷模拟、Rule Filter 和专项 Review，然后给出局部 revision proposal。

**合法输出**：审查报告、风险清单、候选调整或剩余赛季 skeleton。

**禁止行为**：无视现有教练策略重新生成整份计划；把不同训练哲学自动判定为错误；未经用户选择替换现有计划。

## 场景 12：当前 planner 不支持的项目

**典型情况**：用户目标项目没有出现在运行时 capability registry 中。仓库的 S1 规范可以覆盖 5K、10K、HM 和 FM，但具体 Agent 只有在加载对应 doctrine、schema 和 Rule Filter 后才应声明支持；越野、超马、铁三或障碍赛通常需要独立 planner。

**Planning mode**：例如 `road_5k`、`road_10k`、`half_marathon`、`marathon` 或对应专项 planner；不存在时 decision 为 `unsupported`。

**流程变化**：按项目路由到 discipline-specific Strategy、Skeleton 和 Rule Filter。没有匹配能力时停止生成，并明确当前支持范围。

**合法输出**：路由到支持该项目的 planner，或 `unsupported`。

**禁止行为**：用马拉松模板替代越野、超马或铁三计划；只修改比赛名称而沿用不匹配的 taper、长跑和强度规则。

## 场景 13：快速假设或方案比较

**典型请求**：如果每周只能跑 4 天会怎样；如果把比赛提前两周，阶段如何变化。

**Planning mode**：`strategy_preview` 或 `scenario_comparison`。

**流程变化**：不执行正式完整生成和发布流程。基于现有 Assessment 比较宏观变化、约束和 trade-off；只有用户明确选择方案后，才生成正式 skeleton。

**合法输出**：多个策略的差异、风险和推荐，不产生权威 Master Plan draft。

**禁止行为**：把假设性讨论自动保存为正式计划；为回答局部问题生成整份赛季计划；省略方案之间的代价说明。

## 统一架构要求

上述场景共享同一个工作流框架，但每个节点必须根据 `planning_mode` 选择相应策略：

1. Intake 识别用户意图、planning mode、目标优先级和是否存在 active plan。
2. Context Builder 只收集会改变决策的信息，并区分长期历史与近期状态。
3. Assessment 输出能力、负荷、连续性、风险、目标现实性和数据置信度。
4. Strategy 决定阶段结构、周量曲线、关键适应和条件 gate；必要时可以停止，不强制生成 skeleton。
5. Skeleton 只包含战略级逐周关键课、周量范围、recovery/taper 标记和里程碑。
6. Rule Filter 根据项目、频次、经验、伤病和 planning mode 选择规则，不能使用单一模板阈值。
7. Reviewer 必须按当前场景评审。例如 race salvage 不能因缺少 base phase 而失败，return-to-run 不能因峰值周量低而失败。
8. Revision 只修复已识别问题；若问题来自缺失信息或目标冲突，应回到澄清，而不是让模型自行假设。
