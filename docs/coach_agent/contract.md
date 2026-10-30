# 训练计划生成管道——L1-L5 契约总表（含数据结构定版）

> 归属：[daniels.md 总览](./daniels.md) · 本文是总览 §4 层间契约表的**全层展开**（Epic [devops#795](https://github.com/zhaochy1990/stride-devops/issues/795) 终态契约整理，2026-10-27）。
> 治理：同总览（只录已拍板决定）。**L1-L3 的数据结构按已合并代码的 zod/interface 逐字段转写**（来源：`src/coach_agent/src/graph/master_plan/phasing/` 及 `master_plan/context.ts`）；**L4 课表契约已拍板（2026-10-27 终审）= 扩展现网 run-workout/v1**（追加 `type`/`purpose` 两个可选字段，ADR 0043 追加路径；**弃 V2 段 schema**——V1 五值 step_kind+判别联合生产验证充分，判定表从 target 派生不依赖标签；`day` 不需要=date 由 L5 填、`km` 不需要=totals 派生，#796 待拍点①随之消解），落地票 #807；L4 编排与 L5 细节待拍（#796 剩 8weeks.md 用法/重试兜底 + #798/#799）；每层「待定」小节集中未定项并挂票号——待定项不是拍板结论。与总览正文冲突时以总览为准，拍板后同步本文。
> 状态图例：✅ 已实现合并 ｜ 🟢 契约已拍板（daniels.md 拍板项）｜ 🟡 spike 实证/用户拍板、形态为草案 ｜ ⏳ grilling 中（挂票号）
> **同步规则（用户明令 2026-10-27）**：契约一变（拍板/票面修订/实现 PR 合并）必须同轮更新本文对应层小节 + 总览层间契约表 + 对应层分文档，状态图例同步——禁止票面/代码先行而文档滞后的不一致窗口。

## 0. 管道全景与不变量

```
生成时（赛季一次，产物=政策包，不含课表明细）          执行时（块界生成+每夜复盘）
L1 证据层      纯代码   ✅  ─→ L1.5 可行性 纯函数 🟢(#792 实现中)
L2 阶段划分层  LLM×1    ✅
L3 载荷层      纯代码   ✅  ──────────────────────────→ 政策包落库（#803 ⏳）
                                                        │
L4 内容与排位层（2026-10-29 拍板合并为一层两段，共享 R1 生命周期） ←─ R1 块界生成（#801 ⏳）
  L4a 内容生成  LLM×1/块 ✅  周骨架→课包（无 day、E=槽位+时长带）
  L4b 波浪排位  纯代码   ✅  课包→日历+load_series（#799 已实现）
R0 每夜复盘    纯代码   🟢骨架(#800 ⏳阈值) ←── 完成追踪（#802 ⏳）；微调走 L4b scheduleOnly
R2 块边界级    每~4周   🟢骨架(#805 ⏳触发表)  R3 结构级 → 重发 L2
```

**跨层不变量**（拍板，总览 §1/§3）：判断只住在 L2（赛季 1 次）与 L4（每块 1 次），其余全确定性；每层自带验收门，失败各自回炉自己的层；计划=政策不是预测（§3.1）；一管线两产物——政策变更贵、留痕、过用户确认，课表廉价重生成（§3.2）；不静默降级（§3.5）；训练计划永远给（被拒绝的只是不切实际的时间目标）；单赛制 V1 仅 FM，L4 接口按四 profile 参数化留口。

---

## 1. L1 证据层 ✅

**职责**：训练画像=纯事实聚合，零判断。纯函数、无存储、生成时现算；L2/L3/R2 共用同一份事实。入口 `buildPhaseEvidence(snapshot, activities, goal, asOf): PhaseEvidence`。

### 1.1 输入一：`PhasingGoalInput`（目标参数，生产来源=race_goals 表 status=active 的 A 赛目标，由调用方转换）

```typescript
interface PhasingGoalInput {
  raceName: string;          // 赛事名，如「上海马拉松」
  distance: "FM";            // V1 仅 FM（教义只验证过 FM；HM 需连同教义另立，⏳C 目标暂不支持）
  targetTime: string;        // 目标完赛时间 "H:MM:SS"，如 "2:50:00"
  weeklyRunDaysMax: number;  // 每周可用训练日（1-7），进 availability
}
```

### 1.2 输入二：`PhasingActivityInput`（活动行投影，DataProvider.Activity 的结构子集，测试 fixture 直接满足）

```typescript
interface PhasingActivityInput {
  date: Date | string;              // 活动日期（训练日归属按 UTC+8 折算）
  name: string | null;              // 活动名（race_like 记录用，截 30 字）
  sport?: string | null;            // 运动类型；有则走 isRunLikeActivity 防骑行污染
  sportName?: string | null;        // 同上的厂商名字段
  distanceM: number | null;         // 距离（米）；null 行不计里程
  strideSessionClass: string | null;// 生产 session_class（#743/#745 分类器产出，聚合前经双值归一）
}
```

### 1.3 输入三：`ContextSnapshot`（master plan 规划 Kernel 的完整冻结快照，`master_plan/context.ts`；L1 只消费其中一部分——各字段标 ◎=L1 消费 / ○=kernel 其他节点消费）

```typescript
interface ContextSnapshot {                    // deepFreeze 深度只读
  user: {
    id: string;                               // ○ 用户 id（可信字段，runtime 注入）
    profile: {
      display_name: string | null;            // ○ 显示名
      dob: string | null;                     // ○ 出生日期 YYYY-MM-DD
      sex: string | null;                     // ○ 性别
      height_cm: number | null;               // ○ 身高
      weight_kg: number | null;               // ○ 体重
      running_age_range: string | null;       // ○ 跑龄档（问卷口径）
    };
  };
  race_target?: {                             // ○ race_goals 表 active 行透传（L1 的目标走 PhasingGoalInput，不读这里）
    goal_id: string; user_id: string; status: string;
    race_date: string;                        // 比赛日 YYYY-MM-DD
    race_distance: string; race_name: string;
    target_finish_time: string;
    weekly_training_days: number;             // 1-7
  } | null;
  injuries: Array<{                           // ◎ 伤退推导输入
    body_area: string;                        // 部位
    status: string;                           // "active; restriction=…" 前缀 active 触发；"recovered;…" 不触发
    occurred_on: string | null;               // 发生日
    source: string;                           // 来源（问卷/对话）
  }>;
  personal_bests: Array<{                     // ◎ PB（peak_fm_pb 辅助字段；不作可行性锚）
    distance: string;                         // "5K"|"10K"|"HM"|"FM"
    time_sec: number;                         // 成绩（秒）
    achieved_at: string | null;
    activity_label_id: string;                // 关联活动行
  }>;
  running_calibration?: {                     // ◎ 校准快照（VDOT 阶梯第 3 档 + 配速带直读）
    as_of_date: string;
    threshold_hr: number | null;              // 阈值心率
    threshold_speed_mps: number | null;       // 阈值速度 m/s → 1000/x=s/km → %max(60) 代入 DG 方程
    rhr_baseline: number | null;              // 静息心率基线
    threshold_hr_confidence: string;          // 校准置信度标注
    threshold_speed_confidence: string;
    heart_rate_zones: unknown[];              // 心率区带（本层未消费）
    pace_zones: Array<{ name: string; minPaceSPerKm?: number | null; maxPaceSPerKm?: number | null }>;
                                              // ◎ 配速区带（校准产物）→ L1 转丹系五带 easy/marathon/threshold/interval/repetition
  } | null;
  race_history: Array<{                       // ◎ VDOT 取锚主数据源（12 个月窗）
    date: string;
    distance_km: number | null;               // 实际距离（4.5-45.1 分桶 5K/10K/HM/FM，桶外不参与取锚）
    duration_min: number | null;              // 完赛分钟（无独立移动时长字段，取锚即用它）
    avg_pace_s_km: number | null;             // 均配（全力识别：慢于阈值配速×1.15 视为训练性比赛、剔除）
    avg_hr: number | null; max_hr: number | null; feel: number | null;
  }>;
  macro_history: {                            // ◎（gap_periods 伤退推导）/ ○（months 长期画像供评审）
    start_date: string; end_date: string;
    months: Array<{                           // 月粒度宏观量
      month: string;                          // "YYYY-MM"
      distance_km: number; hours: number;
      avg_pace_s_km: number | null; avg_hr: number | null; run_count: number;
    }>;
    peak_weekly_distance_km: number | null;
    longest_run_km: number | null;            // 最长单课（历史）
    longest_road_run_km: number | null;       // 最长路跑（缺省回落 longest_run_km）
    gap_periods: Array<{                      // ◎ 断练期（≥21 天且近 12 周内结束 → 伤退回归推导）
      start_date: string; end_date: string; days: number;
    }>;
    consistency_pct: number | null;           // 一致性 %
  };
  recent_history: {                           // ◎ 周序列（recent_volume / injury_return 的 pre_injury 峰值）
    start_date: string; end_date: string;
    weeks: Array<{                            // WeeklyMetrics（连续含零周——跳过零周会令断练期均值虚高）
      week_start: string;                     // 周一 YYYY-MM-DD
      distance_km: number;                    // 周跑量 km
      hours: number;                          // 周时长
      avg_pace_s_km: number | null; avg_hr: number | null;
      run_count: number;                      // 跑步次数
      run_day_count: number;                  // 跑步天数（缺省补 min(7, run_count)）
      long_run_km: number | null;             // 周最长跑
      speed_session_count: number;            // 快课计数
      race_count: number;                     // 比赛计数
      training_dose: number;                  // 自算训练剂量（stride_training_dose）
      ctl: number | null; atl: number | null; form: number | null;   // PMC
      rhr: number | null; hrv: number | null;
    }>;
  };
  fitness_state: {                            // ◎ fitness 三值直读
    as_of_date: string; ctl: number | null; atl: number | null; form: number | null;
  };
  body_composition: {                         // ○（评审用）
    weight_kg: number | null; body_fat_pct: number | null; skeletal_muscle_kg: number | null;
  };
  active_plan?: {                             // ○ 既有计划（生成前预检/延续判定）
    plan_id: string; revision: number; status: string; start_date: string | null; end_date: string | null;
  } | null;
  current_phase?: { name: string; start_date: string | null; end_date: string | null; source: "active_plan" | "inferred" } | null;  // ○
  continuity: {                               // ○ 连续性
    active_plan_continuation: boolean; last_activity_date: string | null; days_since_last_run: number | null;
  };
  coverage: Array<{ domain: string; status: "complete" | "partial" | "missing"; detail: string | null }>;  // ○ 数据域覆盖声明
  plan_start: string;                         // 计划起点日（周一）
  as_of: string;                              // 快照时间戳（ISO datetime with offset）
}
```

### 1.4 输出：`PhaseEvidence`（L2 全量消费的判断 payload；`phasing/evidence.ts`）

```typescript
interface PhaseEvidence {
  as_of: string;                              // "2026-10-26"（周一，锚定日）

  target: {
    race: string;                             // "全程马拉松 上海马拉松"（单赛制 A 赛拼接串）
    target_time: string;                      // "2:50:00"（透传）
    goal_pace: string;                        // "4:02/km" = targetTime ÷ 42.195 推导
    improvement_pct: number | null;           // 相对当前等效水平的提升幅度 %（1 位小数；正=目标快于当前、负=慢于、null=无法估计）
                                              //   锚=按目标距离取 equivalents；主锚与校准档同时可得取保守（VDOT 低者）
  };
  personal_bests: Record<string, string>;     // {"5K":"19:30","10K":"39:21","HM":"86:38","FM":"177:11"}（分:秒）
  peak_fm_pb: { time_sec: number; achieved_at: string | null } | null;
                                              // FM 历史 PB（辅助：追平/超越峰值叙事与多周期参考，不作可行性锚）
  current_capability: {                       // 当前训练水平（#789）：锚「当前能力」非历史 PB
    vdot: number | null;                      // 能力标量（换算阶梯 VDOT 直读，1 位小数，距离无关）
    equivalents: { "5K": number; "10K": number; HM: number; FM: number } | null;
                                              // 同一 VDOT 四距离换算（秒）；短距离源对比源更长的距离已含 ×1.03 保守折扣
    source: "recent_race_hm_fm" | "recent_race_short" | "calibration" | "none";
                                              // 取锚阶梯：① 近 12 月 HM+ 全力最佳（high）→ ② 10K/5K 最佳（medium，长距离等效 ×1.03）
                                              //   → ③ 校准阈值配速 %max(60)（medium）→ none（low）
    source_date: string | null;               // 换算源日期（比赛日 / 校准 as_of）
    confidence: "high" | "medium" | "low";    // hm_fm=high；短距离折扣/校准=medium；none=low
    pace_zones: {                             // 当前配速带（校准快照直读、取整秒，s/km；开放端 null）
      easy: [lo, hi] | null;                  // E 带
      m: [lo, hi] | null;                     // M 带（马拉松配速）
      t: [lo, hi] | null;                     // T 带（阈值）
      i: [lo, hi] | null;                     // I 带（间歇）
      r: [lo, hi] | null;                     // R 带（重复）
    } | null;                                 // L4 的配速约束直接消费这里
  };
  fitness: { ctl: number; atl: number; form: number };   // 取整直读
  availability: { weekly_run_days_max: number };          // 1-7（goal 透传；L4 max_training_days/L5 days_max 同源）
  habitual: {                                 // 常态基线 R0-R5（#793 已实现；L3 起点）
    week_km: number;                          // 常态周量 km（1 位小数）——R5 之后的最终起点
    level: string;                            // R2 取值路径："median@12w"|"median@16w"|"median@24w"|"best2@24w"|"fallback_recent4"
    scenario: "normal" | "post_race" | "detrain_return" | "stale" | "fallback_avg4";
                                              // R4 场景门：正常/赛后（≤21 天 0.8×两块回满）/断练回归（0.4×）/能力衰减（0.85×）/回退均值
    avg4_km: number;                          // 近 4 完成周均值（R4/R5 判定输入；周序列来自 activities 补零）
    decay_factor: number;                     // R3 新鲜度衰减系数（1=新鲜；超 4 周每周 ×0.97，下限 0.65）
    acwr_applicable: boolean;                 // 断练/零史场景 false（滚动均值被零周污染，显式标记给下游）
    pre_peak_km: number;                      // 近 8 周峰值（LR 曲线「近期最长跑」代理）
  };
  recent_volume: {
    avg_8wk_km: number;                       // 近 8 完成周均值（快照周序列，连续含零周）
    avg_4wk_km: number;
    recent_peak_week_km: number;              // 近 8 周峰值周
    longest_run_8wk_km: number;               // 近 8 周最长单课
    gap_weeks_last16: number;                 // 近 16 周 <5km 的周数（注意与基线断练周 <15km 两个阈值）
  };
  monthly_focus: Array<{                      // as_of 往前 6 个整月逐月（数据源=activities 跑步行）
    month: string;                            // "YYYY-MM"
    km: number;                               // 月总跑量（取整）
    weekly_km: number;                        // 折算周均 = 月总量 ÷ 月内跑步日数 × 7（非整月摊平）
    run_days: number;                         // 月内跑步天数
    e_share_pct: number;                      // E 份额 0-100 =（easy+long_easy）km 占比
    quality_sessions: number;                 // 质量课次（quality + long_quality）
    long_quality_sessions: number;            // 其中渐加速长距离课次
    strides_sessions: number;                 // strides 课次（不算质量课）
    longest_run_km: number;                   // long_easy+long_quality 最长单课（0.1 精度）
    race_like: Array<{ date: string; name: string; km: number }>;   // race 类且 ≥10km（防小课混入）
  }>;
  phase_credit: {                             // 学分=L2 免修/压缩判据（阈值即字段名；窗口=上述 6 整月）
    sustained_volume_months_ge40wk: number;   // 周均 ≥40km 的月数
    e_share_months_ge85: number;              // E 份额 ≥85% 的月数
    months_with_long_run_ge25: number;        // 最长跑 ≥25km 的月数（E+LQ 并算）
    months_with_ge4_quality: number;          // 质量课 ≥4 次/月的月数
    marathons_since_april: number;            // race_like ≥40km 计数（字段名=6 月窗口起点历史保留，勿按字面理解）
  };
  last_race: { date: string; distance_km: number; days_ago: number } | null;
                                              // 最近一场 ≥10km 比赛（I3 赛后恢复门输入；<10km 不触发 recovery 首阶段）
  injuries: Array<{ body_area: string; status: string; note?: string }>;
  injury_return: {                            // 伤退回归推导：在册 active 伤，或近 12 周内结束的 ≥21 天断练期
    pre_injury_peak_week_km: number;          // 伤停前 8 周峰值周量（I8 伤后带 ≤78% 的基准）
    weeks_out: number;                        // 已退出周数
  } | null;                                   // null=无伤退
  evidence_note: string;                      // 固定说明文案进 prompt：「分类来自生产 session_class…直接采信，不要重新数数」
}
```

**计算口径要点**（易错点即规则）：周序列连续补零+只计完成周（week_start<as_of）；跑步判定有 sport 走 `isRunLikeActivity`、无则退 >2km 阈值；E 份额/最长跑含 long_quality；双值归一（tempo|interval→quality、long→long_easy）在聚合前；VDOT 合理区间 10-90 外的脏数据行跳过不炸整份。

**刷新**：每晚自动。**待定 ⏳**：训练城市月度气候常态表+场地可用性字段（§3.4 生效前提）。

## 2. L1.5 可行性阶梯 🟢（契约拍板 = daniels.md §3.5 + #792 票；实现中）

**职责**：L1→L2 之间的守门纯函数，零 LLM；锚=当前等效水平（`equivalents[goal.distance]`），非 PB。Chat 层生成前预检：`needs_confirmation=true` 先对话三选（坚持原目标/调整目标/换更远比赛），用户确认后再调生成——**计划只按用户确认的目标生成，绝不换数字**。

```typescript
type GoalVerdict = {
  verdict: "supported" | "aggressive_but_plausible" | "multi_cycle_required" | "conditional";
  gap_pct: number | null;                    // = evidence.target.improvement_pct
  band_ceiling_factor: 1 | 0.95;             // aggressive → 0.95；multi_cycle 以 A 照排时同样 0.95（L2 I8 峰值帽与 T 兜底同乘）
  suggested_target_time: string | null;      // B 建议 = equivalents×1.02（仅展示，不替换）"H:MM:SS"
  needs_confirmation: boolean;               // multi_cycle / conditional → true
};
function assessGoal(evidence: PhaseEvidence, runwayWeeks: number): GoalVerdict;
```

| verdict | 判据 | 行为 |
|---|---|---|
| `supported` | gap ≤3% 且跑道 ≥12 周（gap≤0 同样） | 正常生成 |
| `aggressive_but_plausible` | 3%<gap≤10%，或跑道 <12 周 | A 目标不动；峰值帽 ×0.95+里程碑从严 |
| `multi_cycle_required` | gap>15%，或 >10% 且跑道 <16 周；跑道 ≤6 周且 gap>0 强制 | 不降级：needs_confirmation 上浮三选；坚持 A 则照 A 构造、rationale 显式写风险 |
| `conditional` | equivalents=null（锚不可得） | 引导先测一场或按 C 出计划；同样走确认流 |

## 3. L2 阶段划分层 ✅

**职责**：只决定「哪段时间练什么能力、练到什么算数」，**不输出任何周量数字**。跨界产物两件在此单点定义：体量带、块模式指派。处理=LLM×1（deepseek-flash structured）+确定性结构门，违规带清单重试 ≤2 → T 查表兜底（`phasing/generate.ts`）。

### 3.1 输入：`PhasingIntentInput`（user 消息 JSON = evidence 全量直传+跑道参数；教义块在 system 消息）

```typescript
interface PhasingIntentInput {
  evidence: PhaseEvidence;   // L1 产物全量直传，不做二次加工
  runwayWeeks: number;       // 跑道周数（今天到比赛日的整周数）
  raceDate: string;          // 比赛日 YYYY-MM-DD
}
```

### 3.2 输出：`PhaseDivisionIntent`（LLM 结构化产物）

```typescript
type Canonical = "recovery" | "foundation" | "early_quality" | "transition_quality" | "final_quality";
type Goal = "recovery" | "aerobic_base" | "speed" | "threshold" | "race_specificity";
type BlockMode = "light" | "progressive" | "progressive_quality" | "plateau";

interface PhaseDivisionIntent {
  phases: Array<{             // 1-6 个；按周区间升序、首尾相接覆盖 1..runwayWeeks
    canonical: Canonical;     // 五值枚举（顺序律：可坍缩不可倒置、不重复）
    name: string;             // 中文显示名，如「第一阶段·基础期（压缩）」
    start_week: number;       // 1-based 周序号（起止日期由 as_of+周序号确定性推导，不重复输出）
    end_week: number;
    primary_goal: Goal;       // 能力重点（缺省映射 recovery→recovery/foundation→aerobic_base/
                              //   early_quality→speed/transition_quality→threshold/final_quality→race_specificity）
    training_goal: string;    // 本阶段训练目标自然语言（练到什么算数）
    block_mode: BlockMode;    // 块形状指派，L3 消费（期望映射 I9 门：recovery→light、foundation→progressive、
                              //   early/transition_quality→progressive_quality、final_quality→plateau）
    rationale: string;        // 必须引用 Evidence 具体字段（月份/km/E份额/Q次数/PB/CTL/比赛）
  }>;
  taper_weeks: number;        // 1-3，final_quality 必填属性（结构参数归 L2；削减深度 30-50% 归 L3）
  milestones: Array<{         // 1-8 条；final_quality 之外每阶段 ≥1
    phase: string;            // 阶段引用（canonical 或 name；匹配走 phaseRefMatches 宽松三子句）
    signal: string;           // 可观察信号（词表：weekly_km/质量课计数/long_run_km/E份额/HRV/RPE体感/CTL/T·M配速课完成度）
    criterion: string;        // 判据，如「第 6 周末 E 份额≥70%」
  }>;
  gates: Array<{              // 2-3 条阶段间 gate，供执行回路 R2 选择回补场景
    phase: string;
    signal: string;
    criterion: string;
    action_if_missed: string; // 未达标建议动作
  }>;
  volume_bands: Array<{       // 1-6 条，与 phases 一一对应
    phase: string;
    weekly_km_min: number;    // ≥0（帽下限 30km：零史跑者 0 帽会锁死合法带——「训练计划永远给」）
    weekly_km_max: number;    // 峰值带全局帽 = min(120, max(近8周×1.6, 近期峰值×1.3)) × band_ceiling_factor(#792)
  }>;
}
```

### 3.3 编排层包装：`PhaseDivisionOutcome`

```typescript
interface PhaseDivisionOutcome {
  intent: PhaseDivisionIntent;
  source: "llm" | "fallback";   // llm=过结构门；fallback=重试耗尽/调用失败落 T 表（观测兜底率）
  attempts: number;             // 调用次数（含重试）
  checks: GateCheck[];          // 终检结果（fallback 时为 T 骨架自身门检，构造保证全绿）
}
interface GateCheck { id: string; pass: boolean; detail: string; }   // 全管道通用的检查行结构
```

**结构门清单**（确定性，`phasing/gates.ts`）：跑道闭合（周数和=跑道）/顺序律/赛后 14 天内完赛先恢复/FM 专项（N≥16 时 final_quality≥4 周；N≤2 退化跑道豁免）/taper 合法 1-3/里程碑覆盖且绑词表信号/gate 2-3 条含动作/体量带合法（帽+下限+recovery≤近期峰值 60%+伤后 foundation≤伤前 78%，比较留 0.5km 容差）/块模式一致/rationale 引证/最小有效周期（recovery 1、建设段 2、final_quality 3）+ 坍缩阶梯（≥10 全阶、7-9 ≤4 阶、≤6 final-only、≤3 赛前微周期）。

**刷新**：事件驱动（R3 重发）。**待定 ⏳**：带下限可达性校验回写（含布局因素，随 #793 遗留小票）。

## 4. L3 载荷层 ✅

**职责**：阶段→**每周跑多少、多难、按什么节奏**+回补政策面。零 LLM（38 案例全绿定案）。处理=`buildLoadPlan(input): LoadPlan`，纯代码：habitual 起点 → 全局贪心周量主循环（ACWR 帽=唯一真约束：构造 1.28×滚动 4 周均值、门 1.3）→ 吸收周全局每第 4 周 ×0.75 → LR 曲线 → Q 配额 → 块形状。

### 4.1 输入：`LoadInput`

```typescript
interface LoadInput {
  intent: PhaseDivisionIntent;   // L2 产物（阶段+体量带+块模式+taper_weeks）
  runwayWeeks: number;
  baseline: HabitualBaseline;    // = evidence.habitual（R0-R5 常态基线，见 §1.4）
  recentWeeksKm: number[];       // 赛前实际完成周序列（补零口径，取末 4 周作滚动均值种子=rollingSeed）
}
```

### 4.2 输出：`LoadPlan`（五件产物）

```typescript
interface LoadPlan {
  weeks: LoadWeek[];                      // ① 周骨架（默认轨迹）——用户看到的计划主体；L4/前端消费
  blocks: LoadBlock[];                    // ② 块结构标记——R2 校准挂点
  recovery_policy: RecoveryScenarioPolicy[];   // ③ 回补策略（政策面）——R2 直接读取
  strength_policy: StrengthPhasePolicy[];      // ④ 力量+强度家族——L4 的 quality_family 来源
  checks: LoadCheck[];                    // ⑤a 边界检查（六门，结构同 GateCheck）
  milestones: MilestoneAlignment[];       // ⑤b 里程碑对齐（L2 出口里程碑落到周序号）
}

interface LoadWeek {                      // 周骨架行（实测定型结构）
  week: number;                           // 1-based 周序号
  canonical: PhaseCanonical;              // 所属阶段（五值）
  block: number;                          // 所属块号
  role: "progress" | "absorb" | "taper" | "race";
                                          // 建设周/吸收周（每第 4 周 ×0.75）/减量周/赛周
  km: number;                             // 本周总跑量目标（赛周=max(42.2+10, min(42.2+激活, 0.7×final_quality 平台参照))，#809）
  lr: number | null;                      // 长跑 km（赛周 null——比赛本身不算训练长跑；G2 豁免依据）
  q: number;                              // 质量课配额（recovery=0｜foundation km≥60→1 否则 0｜建设段 km≥70→2 否则 1｜taper=1 保触感｜赛周=2=比赛课+M 激活，#825）
}

interface LoadBlock {
  block: number;
  canonical: PhaseCanonical;
  start_week: number; end_week: number;
  absorb_weeks: number[];                 // 块内吸收周（3+1 的「1」；空=纯相位块）
  boundary: "phase_start" | "absorb_cut"; // 相位切换开块 / 吸收周自身开新块
}

interface RecoveryScenarioPolicy {        // 三场景（政策面数据）
  id: "normal" | "fatigue" | "overshoot";
  trigger: string;                        // 触发信号条件（自然语言规则，R2 形式化映射 ⏳#805）
  action: string;                         // 动作（normal=块位承接+3~8%增量 / fatigue=重复块位 / overshoot=放大步长受帽）
  depth: string;                          // 降周/增量深度
}

interface StrengthPhasePolicy {
  canonical: PhaseCanonical;
  strength_focus: string;                 // 力量方向性规则（policy only，实质课表在 weekly plan）
  quality_family: string;                 // 强度家族中文串（canonical 直映射）：recovery=「无质量课（纯 E + strides 触感）」/
                                          //   foundation=「E 为主；速度触感靠 strides 副课」/ early_quality=「R 重复（速度经济性）」/
                                          //   transition_quality=「I/T（冬季以 T 为主）」/ final_quality=「M 配速比赛专项」
  strides_note: string;                   // strides 副课标记（不算质量课）
}

interface MilestoneAlignment {
  phase: string; signal: string; criterion: string;   // L2 里程碑原行
  week: number;                           // 该阶段出口周（=end_week）
}
```

**六门**（`load/gates.ts`）：H1 ACWR≤1.3｜H2 单周尖峰≤4 周均值×1.5｜H3 块对块 ≤+25%（不跨 recovery 边界、豁免跨阶段进带）｜L1 带贴合（爬坡/taper/吸收豁免）｜L2 节奏 3+1（≥8 建设周才要求；短跑道豁免）｜L3 LR 曲线（峰 22-34 低量档随峰下调、份额 ≤36%/42%、赛周 null、期内单调；taper 周削减 25→20 在构造器侧非门，#809）｜L4 taper（赛周 ≥42.2 物理下限 + 0.35-0.72×峰 OR 非比赛日里程∈激活带 [10,15]（#809 低量档右支）、峰后弧单调（赛周不进弧）、削减 30-50%）｜L5 块内微阶梯（0.97/1/1.03 质感项）。

**已落地 ✅ #806**（真人教练对比拍板三处，PR running#642）：① 吸收周不落 taper 前一周——短块形态=峰值后单调递减弧，配「峰后弧单调」门；② 赛周量公式弃 0.55×平台 → **比赛 42.2 + 激活 10-15km**（丹氏赛周激活原教义）；③ final_quality 的 quality_family 文案改强度谱（M 主+T 长间歇保留，跨周多样性指向 #798）。

**已落地 ✅ #809**（#806 验证发现）：② 的削减深度门带 [0.5,0.7]×平台参照双侧夹取在低量档（峰 <~75km）把赛周压到比赛里程之下（pan 档实测 37.8<42.2，物理不可能；L4 层 C1 周量守恒 #807 数学无解）——改为**字面最小值 42.2+10 优先于 0.7×ref 上限**（低量跑者比赛必然主导整周）、0.5×ref 下界移除（高平台回归纯字面账 ≤57.2）；L4 门加**激活量右支**（非比赛日里程∈[10,15] 过比值/削减深度两子判据）、**赛周物理下限**（≥42.2，评审加固——夹持回归的兜底）且**赛周不进弧**（峰后弧单调止于赛周前一训练周，与回退分支口径统一）；**taper 周 LR 独立削减 25→20 随深度递减**（真人教练 8 周对比拍板：末次长距离 20-25km、距赛 1-2 周，不顶格 32km；构造器侧非门）。

**刷新**：滚动种子每周吃实际周（少练则下周包络自动收紧，已实现）；骨架 R2/R3 事件驱动。**待定 ⏳**：距离 profile 化参数（V1 按 FM）。

---

## 5. L4 内容与排位层（L4a 内容生成 + L4b 波浪排位）🟢（#796 契约已关 2026-10-27；#807 契约模块 + #811 生成器 + #799 两段制/波浪排位/load_series 已实现 2026-10-29；#798 库 ⏳）

**职责**：周骨架→具体课表→具体日历。**一层两段**（2026-10-29 拍板合并，原 L5 并入）：L4a=LLM×1 整块生成**课包**（deepseek-flash structured；结构=课表库缺省+LLM 选择适配，配速=VDOT 六带确定性）；L4b=纯代码波浪排位（逐日贪心+E 实例化+load_series）。两段共享 R1 生命周期；排位失败先层内仲裁（挪日/缩 E 时长），课包无解才带原因重生成 L4a（统一重试环）——**排位段绝不直接触发 LLM**。

### 5.1 输入（user 消息 JSON，spike 实证形态）

```typescript
{
  week_rows: Array<{                 // L3 周骨架直投影（一行=一周）
    no: number;                      // 周序号（=LoadWeek.week）
    phase: string;                   // canonical（=LoadWeek.canonical）
    role: string;                    // "progress"|"absorb"|"taper"|"race"
    total_km: number;                // =LoadWeek.km（G1 守恒基准）
    long_run_km: number | null;      // =LoadWeek.lr（null=赛周无 LR）
    quality_sessions: number;        // =LoadWeek.q（G3 配额基准）
    quality_family: string;          // =StrengthPhasePolicy.quality_family（按 canonical 查）
    block_position: string;          // 如「块2第3周」（=LoadBlock 推导；组数递进参照）
  }>;
  athlete: {
    vdot: number | null;             // =current_capability.vdot
    pace_zones: {                    // =current_capability.pace_zones（五带 [lo,hi] s/km；G5 落带基准）
      easy; m; t; i; r;
    };
    max_training_days: number;       // =availability.weekly_run_days_max（G4/P1 上限）
  };
  race: { name: string; date: string };   // 整段生成时携带（赛周比赛课命名与落位）
}
```

### 5.2 L4a 输出：课包（`WeekBag`；无 day、E=槽位+时长带——#799 两段制）

课包=结构课（M/T/I/R/LR，blocks 与 v1 同形、**无日期**）+ E 槽位（`{band: normal 60-90min | interval 30-60min, strides}`——分钟数与落位归 L4b 实例化；**purpose 字段已废除（#824 拍板）**：说明统一由 L4b ePurpose 按实际落位生成，模型自写会与落位错位、draft schema 已删字段）。day 字段废除（2026-10-29）：落位归 L4b（LR 周日位型先验/谷排刺激/间隔日短带）；**C4（训练日）与 C9（E 时长分层按位判定）随 day 移入排位段**（P1/实例化定带），L4a 课包校验=C2/C3/C5-C8+一致性+C1 带区间可行性+C11/C12（分段梯度与配速宽度两阶段都判）。E 课最终物化（work time_s@E 带 + strides 独立块）与日期由 L4b 产出；终检 C1-C12 在排位后的日历上全量复跑。

### 5.2a L4b 物化输出：`RunWorkout`（**现网 run-workout/v1 + 两个可选字段**，2026-10-27 终审；排位后外层带日历 calendar[]）

**不新建段 schema（弃 V2）**：L4 直出 v1 形态（blocks/steps 五值 step_kind/duration·target 判别联合/rest 条件全保留——生产验证充分、lenient 容错层现成、存储/小程序/Go 推送零改动、四条 LLM 路径共用契约）。v1 追加（ADR 0043 只追加可选字段路径，旧文档仍是合法 v1）：

```typescript
RunWorkout 新增：
  type?: "E" | "M" | "T" | "I" | "R" | "LR" | null;
        // 生成时声明的主刺激类型（配速意义因人而异：4:10 对高手是有氧、对另一人是 M；意图必须显式，供一致性门与 R0 复盘）。
        // LR=长跑位型课（E 配速为主，可嵌 work 尾段）；strides 不独立成课
  purpose?: string | null;
        // 训练说明：练什么、为什么、本节课在本周/本阶段的位置——给用户看也给 R0 复盘看（意图基准）；新生成课必填（门校验）
```

连带消解（终审拍板）：**`day` 字段不需要**——v1 的 `date` 由 L4 给周内落位、L5 校验/修复/定最终日期（#796 待拍点①随之解决）；**`km` 不需要**——totals 按 blocks 展开派生，守恒门直接用。`note` 沿用 #794 语义（执行要点=怎么执行；purpose=为什么练）。

### 5.3 语义与验收门（判定表派生 + 一致性门；#807 落地）

**step_kind 语义统一（2026-10-27 用户拍板，全管道教义）**：
- `recovery` = **组间慢跑恢复**——以恢复为目的、无配速处方（target=open）的短慢跑（I 1km 组间 400m jog / 90s-3min），从属服务于下一组刺激
- `rest` = **不在跑**（站定/走动）——唯一写法=独立 rest step；`step.rest` 步后字段停止新生成、仅 legacy 读侧兼容（其 Garmin 物化降级为 recovery 且 hr_bpm/manual 被静默丢弃，garmin/translate.go restFollowupStep 实证）
- **变速课慢段不是 recovery**：(2k快+2k慢)×4 的 2k 慢段有配速处方（有氧配速）→ 是训练内容 → `work` 步+easy target（判定为有氧段）。判别式=**有配速处方的慢跑=work@easy；open target 的组间慢跑=recovery**
- `work` 涵盖一切有配速处方的跑步主体（含 E 课主体，v1 惯例 "easy run body"）；`warmup`/`cooldown` = 课头/课尾结构性慢跑段

**判定表**（确定性派生，**读 V1 字段**——类型从 target 配速+duration 派生，不依赖 step_kind 自报）：

| 判定 | 规则 |
|---|---|
| 质量段（刺激） | `step_kind=work` 步 且 `target.kind=pace_s_km` 且 low/high 落**质量谱**（快端=R 带下限延伸、慢端=M 带上沿 +10s/km 容差）且 duration 折算 **≥30s 且 >100m**——100m strides 与 <30s 加速跑不算间歇、不占 Q（拍板锚点）；`recovery`/`rest` 步天然排除 |
| 有氧段 | work/warmup/cooldown 步且 target 在 E 带 ±10s/km 容差内或 kind=open |
| Q 配额 | 含 ≥1 质量段的课数（LR 内嵌 work 尾段算一节 Q；strides=短 work 步按门槛出局不占 Q）；比赛课本身是一节质量课，赛周 q 由它满足 |
| 课内角色 | 首/末块的 warmup/cooldown 步=热身/放松；LR=type 声明+位型判定 |
| 合法性（谱内校验） | 质量步 target 须落质量谱、有氧步须落 E 带容差——**不要求单带归属**（教练 MP-10s/MP-20s 处方天然跨带合法）；带归类（区间中点）只作多样性统计不作合法性判据 |

**一致性校验**（声明↔数据互验）：声明 `type` 的带须罩住该课**主质量段**（按距离最长的质量段，±10s/km 容差）——声明 T 但主段在 E 带=违规；组合课（10k@M+1k 间歇+400m）主段=M 声明 M，副段只需谱内；LR 内嵌 M/T 尾段合法、type 仍 LR。

**校验集（validation，2026-10-27 拍板不用 gate 叫法；C11/C12 = #824 追加）**：C1 周量守恒（Σ课里程 vs total_km，±max(3km, 3%)；里程=totals 口径，**recovery 步 time 处方按 E 带中点折算计入**——组间慢跑计有氧公里，#824 拍板）｜C2 长跑唯一且合值（type=LR 恰一节 ±1.5km；**赛周 lr=null 豁免为 0 节**）｜C3 Q 配额=派生质量课数｜C4 训练日 ≤max_training_days（按 date 去重）｜C5 配速谱内（质量步/有氧步各按谱校验）｜C6 note 语义（无质量步且无短加速步的课 note=null；含 strides 的课给 strides 要点、LR 给补给/地形要点合法）｜C7 质量课热身/放松在场（**赛周比赛课豁免**；LR 位型课豁免独立热身段——E 主体即热身，即「按里程差判」松弛路径）｜C8 展开守恒（课总里程=blocks 按 repeat 展开后 Σ步距离 ±容差——组数×步距算术错挂校验）｜**C11 分段配速梯度（#824 用户审发现②）**：≥2 个不同时长的质量段不得全同配速（阶梯/金字塔形状像、刺激=等长间歇=梯度缺位；等长间歇=单一时长组豁免；E/LR/比赛课不在范围）｜**C12 质量段配速宽度（#824 用户审发现③）**：质量段处方宽度 ≤10s/km（教义=带中位 ±3~5s 窄带——整条投影带复制宽 15s+，运动员跑慢端时刺激实际滑到下一带；E/LR 主体与变速 work@easy 慢段不受限、比赛课 goal±5s 天然合规）。存量迁移样本（#824 前真实教练全带处方）走 `legacyQualityPace` 豁免。

- **用户拍板规则**（2026-10-27 真人教练 8 周对比 + E2E 复盘）：
  ① E 课下限=单次有氧 ≥60min 按 E 带配速折算 km 下限（唯一例外=赛周激活课；校验 C9 候选 ⏳）；
  ② 质量课结构跨周不重复、强度谱覆盖 T/乳酸阈值长间歇、不得全周同型；
  ③ 赛周必须有激活性质量课（赛前 2-3 天，M 配速触感+短组，形态参照 5-8km@MP+1k×3-5（快 15s）+400m×3-5；原生出处=维持原则之八「减量期保强度即可维持」；赛周非比赛日 km 下限校验 ⏳，配合 #809——L3 侧赛周激活带 [10,15] 与 taper 削 LR 已落地，L4 侧校验为 C9 候选）；
  ④ 长距离形态谱跨周轮换（纯有氧/渐加速/纯 MP 段/变速/混合，不得全用含 M 尾段一种）；
  ⑤ **比赛配速锚定目标**（E2E 复盘拍板，最严重项）：比赛课处方必须按 goal_pace 开（±小容差），风险写 purpose/note——内容层不得静默降级（§3.5 延伸）。反例实证：目标 2:50=4:02/km，生成处方 4:15-4:35；
  ⑥ **能力递进投影**（E2E 复盘拍板，新设计项）：排课按预估能力进步曲线逐周刷新配速带，不用静态当前能力。原生锚=课表库 §7 锚点 4（Daniels 第 14 章 2Q：「头 6 周 VDOT=min(当前, 目标−2)→中 +1→末 +1」，配速层递进归 pace_zones 刷新）；工程化=projectZones 纯函数（L4 输入构造时调用）：起点 min(当前,目标−2)、线性剩余均摊、**分档封顶 0.8/<45 · 0.5/45-52 · 0.25/≥52**（=群体 p90 取整，20 用户标定+17 用户 1800 点回测中位偏差 −0.08 无偏；已知偏差=45-52 档偏前置待 R0 回头校）；gap≤0 维持；封顶时比赛周带可未达目标（残差→风险声明），比赛课处方仍锚 goal_pace；定稿=daniels-l4-content.md §4，实现 #811；
  ⑦ E 课时长分层（修正拍板：弃固定 km——不随水平缩放）：普通 E 日 **60-90min**、**质量课间隔日 30-60min**（8weeks.md 教练原话+E 家族原生下限 30min），里程=时长×各自 E 带配速折算（chaoyi 间隔日≈10.7-12km、精英≈15km）；重 E 挪到无质量课日而非砍量。
  ⑨ **有氧/轻松跑以时间为量纲**（⑦的延伸定稿）：E 课/恢复跑（含热身/放松/组间慢跑）处方 duration 为主，距离=时长×E 带配速派生仅参考显示；量纲边界=E/REC 时间｜T/I/R/M 结构（距离×组）｜LR 距离（比赛关联，原生帽双量纲）。校验 C9=E 课 duration 必填且落⑦分层带；派生 km 参与 C1（**recovery 步 time 处方同样按 E 带中点折算，#824**）；#802 完成度按 duration+带比对（抗配速漂移）。**显示估距已落地（devops#838）**：coach_contract `estimatedTotalDistanceM` 单源（distance 步直读｜time+配速处方按处方中点｜其余 time 步按 E 带中点，无校准/easy 带不可用一律 330s/km 兜底、任一非 rest 步不可估则 null），写侧两处回填 `total_distance_m`（周计划 mergeSimulationIntoPlan、自建课卡片 buildCard——null 才填、不覆盖处方距离、strength 恒 null）；估算仅参考显示，**不进 C 门/剂量**（守恒与剂量仍走 stepKmOf/estimatePlannedRunLoad）。
- **taper 削长跑**（#809 追加拍板）：taper 周 LR 20-25km 并随 taper 深度递减（8weeks.md 参照），LR_MAX 顶格不适用于 taper/race 周；race 周 lr=null 不变。
- **跨周规则**：taper 周总里程逐周递减；质量课组数/结构跨周不倒退（同族只增不减）、taper 缩短不换型（组数递进直接读 block.repeat）；赛周 Sunday=比赛课本身（type=M、里程≈42.2、name 含赛事名，该周无 LR）。
- **无映射层**（终审收益）：L4 产出即存储格式，#803 不含 schema 统一工程；小程序/Go 推送/custom_workout 对可选字段零感知。

### 5.4 课表库分工（#797 编目已收 / #798 机制 ⏳）

库=结构缺省+合法性校验集（27 条目六家族 T6/I5/R7/M3/E3/LR3 + 表 5-5 九带分档量帽=组数 N 查表 + 冬季同带等分值换算（锚 E0.2/M0.4/T0.6/I1.0/R1.5 分/min）+ 3+1 块位递进阶梯；**配速不在库**，与 VDOT 六带解耦；5 条 [待验证] 条目不进缺省集）。LLM=库内选择+配速换算+组数适配，不自由发明结构；超限裁剪优先级=先删 R/I→再减 T→不动 E 与 L。库直出兜底路径与「库内变体」判定 ⏳#798。

**刷新**：块界生成+按需重生成（R1）。**待定 ⏳**：解析失败重试/兜底（#796 ⑤）、8weeks.md 用法（#796 ④）、C9 E 课下限数值与多样性/赛周激活校验（#796 已记规则）、质量课间隔归 L4 还是 L5、strides 组数锚定（#798）；距离 profile 化 HM 先行（Epic Not yet specified）。

**契约模块落地**：devops#807（已合并）= coach_contract v1 追加 type/purpose（strict/lenient/normalize 三层）+ `phasing/content/`（derive 判定表 / validators 一致性+C1-C8 读 V1 / migrate E2E 样本迁移回放，`l4-e2e-shanghai.json` 六周全绿）。

## 6. L4b 波浪排位段 ✅（#799 已实现 2026-10-29；E2E spike 实证 2026-10-27、wave-poc 行为对照）

**职责**：课包→周内具体日+日历映射+负荷序列。纯代码逐日贪心（谷=比值≤阈值排下一刺激/高时 E 短消化消化、LR 固定周日位型先验、周六=LR 前日轻量、谷阈值动态化=剩余质量课≥剩余合法日到期强制+强制窗口含周五——POC 丢课修复）；E 槽位实例化（位置定带：间隔日/再生周短带、LR 前日 km 帽、赛周激活窗短帽；water-fill 收敛 C1）；**层内仲裁**=挪日/缩 E 时长/剪余量槽位/双练准入（P5），无解上浮带原因重生成 L4a。**剂量估算**=分步时长×五带系数（E=1 基准，生产回归标定 `lsq-20261029`：R²=0.851/739 活动，报告 dose-calibration-report.md、快照+复现单测进仓；系数 config `training_plan.dose_coefficients` 可配）。**P6 结构性上浮**：种子（生产 PMC 直读）×L3 周量联合可越 cap（伤退低 CTL 长跑道实测）——正确行为，解在 L3 压量/R2，不在排位层。`scheduleOnly(bag, row, ctx, pmcSnapshot)`=R0 夜复盘微调入口（换日/单课减量只重跑本段不碰 LLM）。

### 6.1 输入

```typescript
{
  bags: Array<WeekBag>;         // L4a 课包（结构课无 day；E=槽位+时长带）
  rows: ContentWeekRow[];       // L3 周行（km/lr/q 硬边界 + 该周投影带）
  plan_start_monday: string;    // week1 周一 YYYY-MM-DD（日历映射锚）
  race: ContentRaceContext;     // 比赛日（P4 校验基准）
  athlete: { weeklyRunDaysMax };  // P1 上限
  pmc_seed: { acute; chronic };   // 生产 daily_training_load.acute_load/chronic_load 直读
}
```

### 6.2 输出（spike 实证形态）

```typescript
{
  calendar: Array<{            // 按周内日序排列的最终日历
    week: number;              // 周序号
    date: string;              // 具体日期 YYYY-MM-DD
    day: "Mon".."Sun";
    sessions: Session[];       // 该日全部课（双练日 >1 节，⏳P5）
  }>;
  checks: GateCheck[];         // 排日门结果（P1-P4 每周逐门）
  repairs: string[];           // 修复留痕文案，如「w3 T 3×3km Tue→Thu（P2 质量课相邻）」
  load_series: Array<{         // 逐日负荷序列（2026-10-28 拍板一等输出，前端波浪曲线直读）
    date: string;
    week: number;              // 周序号（join 键：相位带着色经 L3 骨架按周查 canonical）
    load_pt: number;           // 当日处方剂量——量纲与生产 stride_training_dose 同源（系数回归标定 ⏳）
    atl: number; ctl: number;  // **指数 PMC 与生产同款：kAcute=1−e^(−1/7)、kChronic=1−e^(−1/42)**（trainingload/daily.go；POC 曾用 8/30 系笔误口径，作废）
    ratio: number;             // atl/ctl——命名=**日负荷比**（区别于 L3 的「周量比」km-ACWR；峰 1.1-1.2/谷 ~1.0/cap 1.3）
    sessions: string[];        // 当日课名数组（双练日 >1；休=空数组）——与 calendar.sessions 同构
  }>;
  load_meta: {                 // 模型元数据必须随序列落库（系数再标定后旧计划的数字仍可解释）
    model: "exp-pmc-7-42";     // 与生产 daily_training_load 同款常数
    seed: "生成时点直读生产 PMC 当日 ATL/CTL 快照（daily_training_load.acute_load/chronic_load）——不自算种子，保证计划曲线与实际曲线同一分母体系"
    coefficient_version: string;  // 剂量系数版本（回归标定后递增）
  };                           // 时点语义：load_series=生成时点的预测轨迹，R1 每次块界重生成刷新（种子随之更新）；R0 上线后前端展示「实际到今天+计划从明天」
}
```

### 6.3 排位门与约束（P1-P7，gates.ts 实现）

- **P1 训练日 ≤availability**（按 date 去重；双练日算一天——C4 承接）｜**P2 质量课不相邻日**（判定表口径：含带质量尾段的 LR 与比赛课；已知边界=跨周相邻（周日 LR/比赛 ↔ 下周一 Q 的 deadline 破例）不在周内判定内，后续票）｜**P3 LR 周日+前日轻量**（周六全 E 且 ≤8km 或休）｜**P4 比赛课=比赛日**（赛日恰一节）｜**P5 双练准入**（>1 节/日 仅当周量 >110km；判定归本段）｜**P6 比值 cap 1.3**（比赛日豁免——马拉松=目标事件非可调度负荷；越界=调度无解上浮；种子×L3 周量联合可结构性越 cap——个体剂量尺度偏差，正确行为=上浮，解在 L3/R2）｜**P7 有氧份额按阶段下限**（recovery .85/foundation .76/early .80/transition .70/final .65；absorb −9pct/taper −2pct——校准基线=38 案例包络；赛周豁免）。
- **层内仲裁**（排位失败先确定性修复）：C1 超界→周六 E 缩短/置休→剪下限最高槽位重灌；P6 越界→质量课挪日（空平日+间距合法）→当日 E 缩至带下限/置休；P6×C1 不可兼得=结构冲突上浮；结构课永不剪（排不下=课包无解上浮重生成 L4a——统一重试环，排位段绝不直接触发 LLM）。
- **位型先验**（用户拍板 2026-10-27 + #799 落地）：LR 固定周日；周一=LR 后日不排 Q；周六=LR 前日轻量（≤8km 或休）；质量课 Mon-Fri 间距 ≥2；位型=2Q+1L（Tue/Thu 位型由贪心自然涌现）。

---

## 7. 执行回路（R0-R3 + 完成追踪）——骨架 🟢 拍板（§3.2），数据结构 ⏳

| 组件 | 契约 | 状态 |
|---|---|---|
| 完成追踪 | activity↔计划课启发式匹配：日期窗+距离+类型+时长打分；完成度四态=完成/改天/未练/练超；误判容忍边界（用户自主练了别的课）；精确关联（completed_label_id 回填+推送侧带 planWorkoutId）本期做否 ⏳ | #802 ⏳（生产现状=零追踪，夜复盘第一前置） |
| R0 每夜复盘 | 挂晚间同步管线（race_detection→calibration→compute）之后；确定性阈值、零 LLM 常态，结论「不动」为绝大多数夜晚；信号清单=日级（今日课完成态/练超 X%）/周级（周量 vs 骨架 Y%/实际 ACWR/连续超量 N 次）/块级（块位偏移）；**调整分级**=微调（换日期/单课减量）静默+记录、中调（减质量课/块位回退）通知、大调（提前吸收/重出 L3/L2）用户确认；信号源=activities.feel/每日 HRV·RHR/session_class/配速漂移/PMC ATL·CTL·form；通知文案=教练口吻不吓人不静默降级 | 骨架拍板；阈值逐项用户拍板 ⏳ #800 |
| R1 块界生成 | 块（3+1）到界一次生成整块课表（L4+L5）；偏差触发重生成「未执行部分」+范围计算+幂等（重入不双写）；例外——final_quality 含 taper 整段一次生成（跨周单调）、recovery 1-2 周单独成批；rollingSeed 接线（L3 已实现）；与现有 weekly 周界触发共存/替换 ⏳ | #801 ⏳（blocked by #796+#799） |
| R2 块边界级 | 每~4 周块界：读 L3 recovery_policy 三场景（normal/fatigue/overshoot 的 trigger 字段形式化映射实际信号）→ 影响下一块 ⏳ | #805 ⏳ |
| R3 结构级 | 重发 L2（一次小调用，便宜）：伤停 X 天/比赛改期/连续偏差 Y 周/目标变更/VDOT 漂移 Z；与 #792 needs_confirmation 衔接——**政策变更必须用户确认的边界** ⏳ | #805 ⏳ |

**各层刷新频率**（拍板）：L1 每晚；L3 滚动种子每周；L3 骨架/L2 事件驱动（R2/R3）；L4/L5 块界+按需重生成。

## 8. 政策包化与链路接线 ⏳（#803 存储/接入 → #804 前端）

**政策包**（master plan 改版后的产物形态）= L2 `PhaseDivisionIntent` + L3 `LoadPlan` 序列化（周骨架+块标记+回补/力量 policy+里程碑对齐），**不含全期课表明细**；weekly plan = 政策包的逐周投影（L4→L5 执行时调用）。两产物生命周期分离理由已拍板（§3.2）：政策/执行变更周期错位、偏差可计算（R2/R3 信号=实际 vs 骨架基准线）、全跑道门只能在整期上验证。**落库 schema、两条真实生成链路（聊天 deepagent 卡片 apply_token + worker kernel Admin 代生成）的替换/嫁接、weekly graph 消费接线与灰度开关** ⏳#803；**前端呈现**（阶段带/周量包络/里程碑 gate/块节奏 3+1 可视/「示意周」=每阶段一个典型周且标注示意非课表承诺/与 #575 v2 卡片线兼容；课表详情页吃 weekly 产物不动）⏳#804。

## 9. 层间契约总表（总览 §4 扩展版）

| 上游 → 下游 | 交接物 | 状态 |
|---|---|---|
| 调用方 → L1 | ContextSnapshot + PhasingActivityInput[] + PhasingGoalInput + asOf | ✅ |
| L1 → L1.5 | PhaseEvidence（improvement_pct/equivalents） | ✅ |
| L1.5 → 编排/Chat | GoalVerdict（needs_confirmation 上浮，不代做决定） | 🟢 |
| L1 → L2 | PhasingIntentInput（evidence 全量 + runwayWeeks + raceDate） | ✅ |
| L2 → L3 | PhaseDivisionIntent（phases+taper_weeks+milestones+gates+volume_bands） | ✅ |
| L2/L3 → 政策包 | intent + LoadPlan 序列化 | ⏳ #803 |
| L3 → L4a | week_rows 投影（weeks+quality_family+block 位置）+ athlete（vdot/pace_zones/max_training_days/fitness=PMC 种子） | ✅ |
| L3 → R2 | recovery_policy + blocks + milestones 周对齐 | 🟢骨架 ⏳触发表 |
| L4a → L4b | 课包 WeekBag[]（结构课无 day；E=槽位+时长带） | ✅ |
| L4b → 用户/weekly | calendar[]{week,date,day,sessions} + load_series + load_meta + P 门/C 终检 + repairs | ✅ |
| L4/L5 → 完成追踪 | 计划课侧标识（启发式匹配锚点） | ⏳ #802 |
| R0 → R1/R2/R3 | 信号与分级路由（静默/通知/确认） | 🟢骨架 ⏳ #800 |
| R3 → L2 | 重发触发（新跑道/新目标参数） | ⏳ #805 |

## 10. 票据映射（Epic devops#795）

| 层/组件 | 设计票 | 实现状态 |
|---|---|---|
| L1/L2 | #782（PR running#630）、#789（PR #634）、#790（PR #637） | ✅ 已合并 |
| L1.5 | #792（非本图，在途） | 🟢 契约拍板 |
| L3 | #793（PR #638，38 fixture）；#806 短块三处修正（PR #642）；#809 赛周低量档修复+taper 门右支+taper 削 LR | ✅ 已合并 |
| 课表库编目 | #797 | ✅ 已关（草案在分支 research/daniels-session-library） |
| L4 契约+生成器+排位 | #796 已关（决议）→ #807 契约模块（PR running#643）+ #811 生成器（已合并）+ **#799 两段制+波浪排位+load_series（已实现 2026-10-29：L4a 删 day/E 槽位化+剂量系数生产标定+P1-P7）** | ✅ #799 落地；#798 库 ⏳ |
| 库×LLM 分工 | #798（#796✅+#797✅ 已解锁） | ⏳ 前沿 |
| 夜复盘阈值 | #800（微调入口=L4b scheduleOnly 已随 #799 留口） | ⏳ |
| 块界生成 | #801（原 blocked by #799——已解锁） | ⏳ |
| 完成追踪 | #802 | ⏳ |
| 政策包存储/接入 | #803（#796✅ 已解锁） | ⏳ 前沿 |
| 前端呈现 | #804（blocked by #803） | ⏳ |
| R2/R3 触发表 | #805（blocked by #800） | ⏳ |

Epic Not-yet-specified（后续另立）：距离 profile 化（HM 先行）、测试赛插排机制、L4/L5 E2E 验证策略（fixtures/replay）、C 目标支持时机、气候标注完整层、偏差沟通文案库。
