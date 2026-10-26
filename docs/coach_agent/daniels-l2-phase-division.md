# L2 阶段划分层——详细设计

> 归属：[daniels.md 总览](./daniels.md) · 实现票：devops#782 · 治理规则同总览（只录已拍板决定）

## 1. 定位

阶段划分层只决定「哪段时间练什么能力、练到什么算数」，不输出任何周量数字。锚点/节奏/taper 深度等载荷决策独立在 L3；两层真正的耦合点（阶段周数 ↔ 载荷可行性）用**体量带**保住（见总览层间契约）。

**内容审计**（2026-10-26 与用户对齐）：本层除阶段划分本体（阶段清单、taper 属性、出口里程碑+阶段间 gate——里程碑是阶段的完成判据，属本体）外，携带两件跨界产物：**体量带**与**块模式指派**（均为载荷层词汇，在此产出以保耦合与单点定义）。

## 2. 阶段枚举合同（canonical 定稿 5 值）

对齐 Daniels' Running Formula 原生词汇：

| canonical | 中文显示名 | 丹尼尔斯原文 | 职能 |
|---|---|---|---|
| `recovery` | 恢复期 | （无，本体系显式补充） | 赛后卸疲劳 |
| `foundation` | 第一阶段·基础期 | Phase 1 Foundation | E 跑+strides+轻爬坡，地基与防伤 |
| `early_quality` | 第二阶段·早期质量期 | Phase 2 Early Quality | R 重复跑，跑姿经济性与速度 |
| `transition_quality` | 第三阶段·过渡质量期 | Phase 3 Transition Quality | I 间歇为主，T 开始上量 |
| `final_quality` | 第四阶段·最终质量期 | Phase 4 Final Quality | T+M 比赛专项，自带 taper |

丹尼尔斯用编号是刻意的：阶段由内容定义，同一套 Phase 1-4 通用于 5 公里到全马，只是配比不同。

### 2.1 recovery 是正式阶段（对丹尼尔斯的工程化补充）

丹尼尔斯只在书里非正式提赛后休息；本体系将其正式化，给完整合同：

- 入口条件：距上场比赛 ≤14 天（或主观深度疲劳）
- 出口里程碑（可观察信号）：HRV 回基线、无残留酸痛、主观疲劳 ≤3
- 体量带：赛前量的 ≤60%；块模式：纯 E + strides

### 2.2 taper 不设阶段，是 final_quality 的必填属性

正式阶段三条件（主跑道占周数、独立入口与出口里程碑、体量带与块模式）taper 都不满足——出口就是比赛（计划终点事件而非阶段闸门）、无能力目标（兑现不是发展）、拆成阶段会把一个决策变成两个旋钮。

- `final_quality` 携带 `taper_weeks`（1-3 周，**结构参数归 L2**，影响跑道预算）
- 削减深度 30-50%（**量级参数归 L3**）
- taper 作为必填属性后 LLM 不可再漏给（第五轮 LLM 曾整段丢失 taper 阶段）
- 用户可见性不降：周历末尾渲染「减量周」标签
- 正式 recovery 只保留计划开头那个；赛中恢复为周级属性（单赛制下无 B 赛 mini-taper，见总览 §3.3）

## 3. 输入

**函数签名**：`generatePhaseDivisionIntent(input: PhasingIntentInput, model: PhasingModel): Promise<PhaseDivisionOutcome>`——输入是 L1 的 PhaseEvidence **全量直传**（不做二次加工）+ 跑道参数，外加教义块进 prompt 层；模型经接口注入（生产=master_plan role 的 deepseek-flash，测试=stub）。

| 输入 | 位置 | 内容 |
|---|---|---|
| `evidence` | user 消息（JSON） | L1 产物全量：月度画像+学分（免修判据）、当前状态（伤退/断练/距赛天数）、target（目标/配速）、PB、fitness |
| `runwayWeeks` / `raceDate` | user 消息（JSON） | 跑道周数与比赛日（编排层参数，PhasingIntentInput 携带） |
| 教义块 | system 消息（prompt） | ① 丹尼尔斯阶段体系（五 canonical 职能与顺序不变量、FM 特化）② 调整规则（学分免修/速度折叠/短跑道坍缩/伤退拉长/赛后先恢复）③ 最小有效周期+四档坍缩阶梯 ④ 体量带规则（起量≤近期均值×1.25、峰值帽、recovery≤赛前 60%、伤后 foundation 带≤伤前 78%）⑤ 里程碑与 gate 词表（可观察信号）⑥ 块模式映射 ⑦ 输出契约（周区间首尾相接覆盖 1..N、rationale 引证、不输出周量数字） |

不输入：单课明细/laps、PMC 仿真（验收门用）、聊天上下文；伤退场景由 PhaseEvidence.injuries 与 injury_return 字段携带。重试轮的 user 消息额外携带上次输出与违规清单（多轮修正）。

## 4. 输出：PhaseDivisionIntentSchema（一次小调用，约 12-15 字段）

```typescript
type Canonical = "recovery" | "foundation" | "early_quality" | "transition_quality" | "final_quality";
type Goal = "recovery" | "aerobic_base" | "speed" | "threshold" | "race_specificity";
type BlockMode = "light" | "progressive" | "progressive_quality" | "plateau";

interface PhaseDivisionIntent {
  phases: Array<{              // 按周区间升序；免修=不设该阶段，压缩=周数缩减
    canonical: Canonical;      // 五值枚举（§2 合同）
    name: string;              // 中文显示名，如「第一阶段·基础期（压缩）」
    start_week: number;        // 1-based 周序号；起止日期由 as_of+周序号确定性推导
    end_week: number;
    primary_goal: Goal;        // 能力重点（阶段训练目标向量）
    training_goal: string;     // 本阶段训练目标（练到什么算数的自然语言）
    block_mode: BlockMode;     // 块形状指派（L3 消费；期望映射见下）
    rationale: string;         // 必须引用 Evidence 具体字段（月份/km/E份额/Q次数/PB/CTL/比赛）
  }>;
  taper_weeks: number;         // final_quality 必填属性，1-3（结构参数）
  milestones: Array<{          // final_quality 之外每阶段 ≥1 条
    phase: string;             // 对应阶段的 name 或 canonical
    signal: string;            // 可观察信号（词表：weekly_km/质量课计数/long_run_km/E份额/HRV/RPE体感/CTL/T·M配速课完成度）
    criterion: string;         // 判据，如「第 6 周末 E 份额≥70%」
  }>;
  gates: Array<{               // 阶段间 gate，2-3 条
    phase: string;
    signal: string;
    criterion: string;
    action_if_missed: string;  // 未达标建议动作，供执行回路 R2 选择回补场景
  }>;
  volume_bands: Array<{        // 每阶段体量带（与 phases 一一对应）
    phase: string;
    weekly_km_min: number;
    weekly_km_max: number;     // 峰值带全局帽 = min(120, max(近8周×1.6, 近期峰值×1.3))
  }>;
}
```

**块模式期望映射**（校验门 I9 的基准，偏离需在 rationale 说明）：recovery→light；foundation→progressive；early_quality→progressive_quality；transition_quality→progressive_quality（增量放缓）；final_quality→plateau。

**派生而不重复输出**：起止日期（as_of+周序号）、阶段周数（end−start+1）、跑道闭合性（由结构门校验而非字段携带）。

**编排层返回包装** `PhaseDivisionOutcome`：`{ intent, source: "llm" | "fallback", attempts, checks }`——source 供调用方观测兜底率，checks 为终检结果（fallback 时为其自身门检，构造保证全绿）。

不输出：周量锚点、降周节奏落位、taper 削减深度、Q 配额、LR 进展、赛周激活（全在 L3）；疲劳/超量判定（执行回路）；课结构（L4 内容层）。

## 5. 判定与兜底

- **判断模型 = deepseek-flash**（第五轮实证 6/8 门全绿、三人结构分化 3/3；GLM-5.3-flash 结构退化+慢 6-9 倍出局，glm-5.3 深思考档超时出局，pro 已弃）
- **T 查表 = 结构缺省 + 包络校验 + LLM 失败兜底**（#732 终调和：查表不拿走判断）
- **确定性结构门**：跑道闭合（周数和=跑道、日期连续）、顺序律（recovery→foundation→early_quality→transition_quality→final_quality，可坍缩不可倒置、canonical 不重复）、赛后 14 天内完赛先恢复、FM 含专项期（N≥16 时 final_quality≥4 周；N≤2 退化跑道豁免：I3 只余 recovery 与 I4 的 ≥2 周互斥时按赛前微周期退化处理）、taper 属性合法（1-3 周）、里程碑覆盖且绑可观察信号、gate 2-3 条含未达标动作、体量带合法（峰值带 ≤min(120, max(近8周×1.6, 近期峰值×1.3)) 且**帽下限 30km**——零史跑者 0 帽会锁死一切合法带，「训练计划永远给」；比较留 0.5km 容差；recovery ≤近期峰值 60%；伤后 foundation 带 ≤伤前峰值 78%；每阶段须有带）、块模式一致、rationale 引证、最小周期（见 §6）；不过 → 带违规清单重试 ≤2 次 → 落 T 骨架
- 设计时场景智能（LLM 价值区）：有氧学分够→压缩/免修 foundation；速度储备超目标→early_quality 折叠为 strides 维持；短跑道→坍缩阶梯；伤退史→foundation 拉长

**验证与落地状态**：第六轮 spike（3 运动员 × 2 模型 × 16 调用 + 短周期 v2 12 调用）deepseek-flash 常规 7/8 全绿、短周期 6/6 全绿、分化 3/3——本 scope 定稿；GLM-5.3-flash 2/7+1 超时出局。**已随 devops#782 落地（PR #630，2026-10-26 合并）**：44 单测全绿 + 真模型回放三运动员 × {22,9,5,injury} 12/12 判断层全绿、0 兜底、重试机制实测救回 1 例。

## 6. 最小有效周期与短跑道坍缩阶梯（本体系扩展）

**最小有效周期**：阶段短于最小有效剂量则不设立（并入相邻阶段或降为副课维持）——1 周的 foundation 或质量期没有训练学意义。

| 阶段 | 最小周数 |
|---|---|
| recovery | 1 |
| foundation / early_quality / transition_quality | 2 |
| final_quality（含 taper） | 3 |

**坍缩阶梯**（按跑道周数，v2 重测 flash 6/6 验证）：

- **≥10 周**：完整五阶段阶梯，学分压缩由判断层自由裁量
- **7-9 周**：≤4 阶段；先砍 early_quality（折叠为 strides/R 维持副课）→ 再砍 transition_quality；foundation≥2 与 final_quality≥3 底线不可再砍
- **≤6 周**：只有 [recovery?] + final_quality 直达专项+减量；时间目标由可行性评估降级为 B/C——**训练计划永远给，被拒绝的只是不切实际的时间目标**
- **≤3 周**：final_quality 即赛前微周期（taper+激活为主）
