# L1 证据层——详细设计

> 归属：[daniels.md 总览](./daniels.md) · 随 devops#782 交付（current_capability / improvement_pct 随 devops#789）· 治理规则同总览（只录已拍板决定）。数据结构与第六轮已验证的 spike 证据层一致（`spikePhaseIntent.ts buildEvidence`），标注 ⏳ 的为待拍板扩展。

## 1. 定位

证据层即「训练画像」（早期讨论名 profile）模块，导出入口 **`buildPhaseEvidence(snapshot, activities, goal, asOf): PhaseEvidence`**——**纯聚合函数、无存储、生成时现算**，取数由调用方完成（复用现有 ContextSnapshot/DataProvider 加载路径；测试 fixture 直喂），L2 阶段划分、L3 载荷、R2 执行回路共用同一份事实。燃料=session_class 生产分类（#743/#745，97.6% 全量验证），消费前经 `normalizeSessionClass` 双值归一（`tempo|interval→quality`、`long→long_easy`，兼容 365 天窗口外的旧值行）。已随 devops#782 落地（PR #630）。

## 2. 输入

| 参数 | 类型 | 说明 |
|---|---|---|
| `snapshot` | `ContextSnapshot` | master plan 现有快照（体能/PB/周序列/比赛史/伤病/gap 期），走 DataProvider |
| `activities` | `PhasingActivityInput[]` | 活动行投影（date/name/sport/sportName/distanceM/strideSessionClass），测试 fixture 直接满足 |
| `goal` | `PhasingGoalInput` | 目标参数（见下；生产来源=`race_goals` 表 status=active 的 A 赛目标，由调用方转换） |
| `asOf` | `string` | 锚定日期 YYYY-MM-DD（周一；历史回放/测试用，生产=当天） |

```typescript
interface PhasingGoalInput {
  raceName: string;
  distance: "FM";                  // V1 仅 FM（教义只验证过 FM；HM 需连同教义另立）
  targetTime: string;              // "2:50:00"（⏳ 无时间目标/完赛 C 目标暂不支持，待拍板）
  weeklyRunDaysMax: number;        // 每周可用训练日
}
```

**编排层入口**（L2 消费形态）：`PhasingIntentInput = { evidence: PhaseEvidence, runwayWeeks: number, raceDate: string }`——跑道周数与比赛日在编排层携带（goal_pace 由 targetTime÷42.195 推导进 target；`weeks_to_race` 即 runwayWeeks）。

**数据源（调用方加载，喂给本函数）**：

| 数据 | 来源 |
|---|---|
| 活动与分类 | `activities` ⋈ `activity_training_load`（session_class；跑步判定=有 sport 信息走 `isRunningActivity` 防骑行污染，无则退回 >2km 距离阈值） |
| 比赛史 | `race_history`（快照）+ session_class=race ≥10km |
| 体能 | 快照 `fitness_state`（CTL/ATL/form，PMC 已算） |
| PB | 快照 `personal_bests` |
| 伤病 | 快照 `injuries`（在册 active 前缀）+ `macro_history.gap_periods`（伤退推导） |

## 3. 输出：PhaseEvidence 数据结构

```typescript
interface PhaseEvidence {
  as_of: string;                       // "2026-10-26"（周一）

  // ── 目标透传+推导 ───────────────────────────
  target: {
    race: string;                      // "全程马拉松 无锡马拉松"（单赛制，A 赛）
    target_time: string;               // "2:50:00"（⏳ 完赛 C 目标暂不支持，待拍板）
    goal_pace: string;                 // "4:02/km"（targetTime ÷ 42.195 推导）
    improvement_pct: number | null;    // 相对当前等效水平的提升幅度（%，1 位小数；正值=目标快于当前水平、null=无法估计）——锚按目标距离取，主锚与校准档同时可得取保守（VDOT 低者）
  };
  availability: {
    weekly_run_days_max: number;       // 每周可用训练日（goal 透传）
  };

  // ── 派生事实 ───────────────────────────────
  personal_bests: Record<string, string>;   // {"5K":"19:30","10K":"39:21","HM":"86:38","FM":"177:11"}
  peak_fm_pb: { time_sec: number; achieved_at: string | null } | null;  // FM 历史 PB（辅助字段：追平/超越峰值叙事与多周期参考，不作可行性锚）
  current_capability: {               // 当前训练水平（devops#789）：锚「当前能力」而非历史 PB
    vdot: number | null;              // 能力标量（换算阶梯的 VDOT 直读，距离无关）
    equivalents: { "5K": number; "10K": number; HM: number; FM: number } | null;  // 同一 VDOT 四换算（秒）；短距离源对比源更长距离已含 ×1.03 保守折扣
    source: "recent_race_hm_fm" | "recent_race_short" | "calibration" | "none";
    source_date: string | null;       // 换算源日期（比赛日 / 校准 as_of）
    confidence: "high" | "medium" | "low";  // hm_fm=high；短距离折扣=medium；校准=medium；none=low
    pace_zones: {                     // 当前配速带（校准快照直读，s/km；开放端 null）
      easy: [lo, hi] | null; m: [lo, hi] | null; t: [lo, hi] | null; i: [lo, hi] | null; r: [lo, hi] | null;
    } | null;
  };
  fitness: { ctl: number; atl: number; form: number };   // 取整
  recent_volume: {
    avg_8wk_km: number;                // 近 8 完成周均值（见 §4 口径）
    avg_4wk_km: number;
    recent_peak_week_km: number;       // 近 8 周峰值周
    longest_run_8wk_km: number;        // 近 8 周最长单课
    gap_weeks_last16: number;          // 近 16 周 <5km 的周数（注意：与基线算法断练周 <15km 是两个阈值）
  };
  monthly_focus: Array<{               // as_of 往前 6 个整月，逐月（spike 验证窗口；扩 12 需重验）
    month: string;
    km: number;                        // 月总跑量（km，取整）
    weekly_km: number;                 // 折算周均 = 月总量/月内跑步日数×7
    run_days: number;                  // 月内跑步日数
    e_share_pct: number;               // E 份额 0-100 =（easy+long_easy）km 占比
    quality_sessions: number;          // quality+long_quality 课次
    long_quality_sessions: number;     // 其中渐加速长距离课次（单独拆出）
    strides_sessions: number;          // strides 课次（不算质量课）
    longest_run_km: number;            // long_easy+long_quality 最长单课（0.1 精度）
    race_like: Array<{ date: string; name: string; km: number }>;  // race 类且 ≥10km
  }>;
  phase_credit: {                      // 学分=L2 免修/压缩判据（阈值即字段名；marathons_since_april 为 spike 历史字段名，窗口随 6 整月）
    sustained_volume_months_ge40wk: number;
    e_share_months_ge85: number;
    months_with_long_run_ge25: number;     // 按 longest_run_km（E+LQ 并算）
    months_with_ge4_quality: number;
    marathons_since_april: number;         // race_like ≥40km 计数
  };
  last_race: { date: string; distance_km: number; days_ago: number } | null;
  injuries: Array<{ body_area: string; status: string; note?: string }>;
  injury_return: {                     // 伤退回归推导：在册 active 前缀伤，或近 12 周内结束的 ≥21 天断练期
    pre_injury_peak_week_km: number;   //   （伤停前 8 周峰值周量）；null=无伤退
    weeks_out: number;
  } | null;
  evidence_note: string;               // 「分类来自生产 session_class，直接采信」说明（进 prompt）

  // ── ⏳ 待拍板扩展 ───────────────────────────
  habitual_week_km?: number;           // ⏳ 常态基线（R0-R6 算法，21 用户实测待批；入档后 recent_volume 均值降为参考）
}
```

## 4. 计算口径（易错点即规则）

1. **周序列连续补零 + 只计完成周**：周一起始；`week_start < as_of` 的周才计入（当周剔除）；零周语义继承 snapshot.recent_history 周序列（连续含零周——跳过零周会令断练期均值虚高数倍，基线第二轮 postmortem）
2. **跑步判定**：有 sport/sportName 走 `isRunningActivity`（骑行等不入画像）；无 sport 信息退回 >2km 距离阈值
3. **E 份额**=(easy+long_easy) km ÷ 月总跑 km；**longest_run_km 必须含 long_quality**（渐加速长跑同样积累有氧学分）
4. **race_like**：session_class=race 且 ≥10km（防标签误标的小课混入）
5. **双值归一在聚合前做**（旧值 tempo/interval/long 先映射再分桶）
6. **VDOT 取锚阶梯**（current_capability / improvement_pct，`phasing/vdot.ts` 公开 Daniels–Gilbert 方程，与官方 V.O2 计算器同式；锚点单测对照原书表 ±1%）：
   - **第 1 档**：近 12 个月 HM 及以上距离上的最佳表现（max VDOT，非最近）→ 主锚 `recent_race_hm_fm`（high）。全力识别：活动均配慢于校准阈值配速 ×1.15 视为训练性比赛、不参与取锚（污染源=周末长距离混入 race_history）；完赛时间用 duration_min（race_history 无独立移动时长字段）
   - **第 2 档**：无 HM+ 比赛则近 12 个月最佳 10K/5K → `recent_race_short`（medium），**×1.03 保守折扣只打在比源距离更长的等效成绩上**（短距离高估的只是长距离兑现）
   - **第 3 档**：无比赛 → 校准阈值配速（速度-时长模型的 60 分钟可持续速度）按 %max(60) 代入同一方程 → `calibration`（medium）
   - **规则 4**：主锚与校准档同时可得时，improvement_pct 用两者中保守（VDOT 低者）——比赛代表最高已证实水平，校准代表日常状态；current_capability.vdot 保持阶梯直读
   - **improvement_pct = round(((equivalents[goal.distance] − target_sec) / equivalents[goal.distance]) × 1000) / 10**；锚按目标距离取（去 FM 硬编码，HM 目标锚 equivalent HM）；PB 降级为 peak_fm_pb 辅助字段（PB 是历史峰值，当前水平已退化/已超越都会算错）
   - 版本注记：丹尼尔斯原书表的 5K/10K/HM 列与公开方程一致（±1%）；**FM 列 2nd 版为人工保守修订**（@VDOT50 原书 3:19:03 vs 公开方程 3:10:4x，约 +4.5%），公开方程与官方计算器均不复现——本模块按公开方程实现，短距离→长距离高估由 ×1.03 折扣机制吸收

## 5. 输出与消费

单一 PhaseEvidence JSON：L2 全量消费（经 PhasingIntentInput 携带 runwayWeeks/raceDate）（教义 prompt 的 payload；target.improvement_pct 已进教义调整职责段——正值越大目标越激进→体量带取保守端）；L3 消费 recent_volume/体量带推导/（⏳ habitual_week_km 起点）；R2 消费滚动状态。**不输出**：单课明细/laps（消费时按需下钻）、PMC 全仿真（验收门产物）、周序列原始数组（⏳ 若 R0-R6 入档，仅外露 habitual_week_km 一个数，序列留在函数内部）。

## 6. 待拍板

- `habitual_week_km`（常态基线 R0-R6）：有效训练周筛选（剔比赛周/赛后 14 天/taper 特征/断练 <15km）→ 中位数 → 逐级回退 + 新鲜度衰减 + 五档场景门 + 1.3×avg4 硬安全门；21 用户第二轮实测报告 `coach_agent/src/tests/spike-out/habitual-baseline-round2.md`
- 训练城市月度气候常态标注（总览 §3.4 季节性插入点的前提，静态表）
