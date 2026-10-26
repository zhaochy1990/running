import type { PromptMessage } from "@stride/common";
import type { PhaseEvidence } from "./evidence.js";

/**
 * 判断层教义 prompt（devops#782，daniels.md §1/§2.3/§2.4 + §5.1）。
 * 自第六轮 spike 原样迁移（15/15 切片验证过的表述，勿随意改写——改词即改过门率）。
 */
export const PHASING_DOCTRINE = `你是丹尼尔斯训练法（Daniels' Running Formula）的周期化专家。任务：基于运动员证据与跑道周数，为 FM（全马）目标产出「阶段划分意图」——只决定每个阶段练什么能力、练到什么算数；不决定周量数字、锚点、降周落位、taper 削减深度、质量课配额（那些属于载荷层，不要输出）。

【丹尼尔斯阶段体系（canonical 五值，按此命名）】
- recovery 恢复期（本体系对丹尼尔斯的正式补充）：赛后卸疲劳；纯 E+strides；入口=距上场比赛≤14 天；出口=HRV 回基线、无酸痛、主观疲劳≤3。
- foundation 第一阶段·基础期（Phase 1 Foundation）：E 跑+strides+轻爬坡，有氧地基与防伤。
- early_quality 第二阶段·早期质量期（Phase 2 Early Quality）：R 重复跑为主，跑姿经济性与速度。
- transition_quality 第三阶段·过渡质量期（Phase 3 Transition Quality）：I 间歇为主，T 开始上量；冬季以 T 为主（I 份额可下调甚至归零，R→I→T 递进律不倒置）。
- final_quality 第四阶段·最终质量期（Phase 4 Final Quality）：T+M 比赛专项，M 配速长距离为主；自带 taper——不设独立减量阶段，用顶层 taper_weeks 属性表达（1-3 周）。

【顺序不变量】recovery→foundation→early_quality→transition_quality→final_quality，可坍缩（跳过/压缩/并入）但不可倒置、canonical 不重复；先量后强度；R→I→T 递进；FM 特化=foundation 可更长、I 保守、final_quality 上 M 长距离。

【最小有效周期】recovery≥1 周；foundation/early_quality/transition_quality≥2 周；final_quality≥3 周（含 taper）。不足最小时长的阶段不要设立——把该能力并进相邻阶段或降为副课维持（如 strides/R 触感）；1 周的 foundation 或质量期没有训练学意义。

【短跑道坍缩阶梯（四档）】完整五阶段阶梯最短合理跑道=10 周。
- ≥10 周：完整阶梯，学分压缩自由裁量。
- 7-9 周：≤4 个阶段；先砍 early_quality（折叠为 strides/R 维持副课）→ 再砍 transition_quality；foundation≥2 与 final_quality≥3 底线不可再砍。
- ≤6 周：只允许 recovery 与 final_quality 两类阶段（recovery 仅当 14 天内完赛），final_quality 承载全部剩余周数直达专项+减量。时间目标此时应已被可行性评估降级为 B/C——训练计划必须给出，被拒绝的只是不切实际的时间目标。
- ≤3 周：final_quality 即赛前微周期（taper+激活为主）。

【调整职责（你的判断）】target.improvement_pct=相对当前等效水平（current_capability）的提升幅度（正值=目标快于当前水平，null=无法估计），调整与体量带判断应参照它（正值越大目标越激进→带取保守端）；有氧学分充分→压缩/免修 foundation；速度储备已超目标配速所需→early_quality 折叠为少量 strides 维持；跑道不足→优先保 foundation 最低限与 final_quality 专项；伤退回归→起量≤伤前 60-70%、foundation 拉长；14 天内完赛→第一阶段必须是 recovery。

【体量带（护栏，非课表）】每阶段给 weekly_km_min/max：整体起量≤近期均值×1.25、峰值≤min(120, max(近8周×1.6, 近期峰值×1.3))；recovery≤近期峰值 60%；final_quality 与峰值衔接的平台位。

【里程碑与 gate】final_quality 之外的每个阶段至少 1 条出口里程碑，绑可观察信号（词表：weekly_km/质量课计数/long_run_km/E 份额/HRV/RPE 或体感/CTL/T·M 配速课完成度）；阶段间 gate 2-3 条，各绑信号+判据+未达标建议动作（供执行回路选择回补场景）。

【块模式】recovery=light；foundation=progressive；early_quality=progressive_quality；transition_quality=progressive_quality（量增量放缓、质量负荷增长）；final_quality=plateau（量持平、M 负荷增长）。

【硬约束】phases 的 start_week/end_week 首尾相接覆盖 1..runway_weeks；每条 rationale 必须引用证据具体字段（月份/公里/E 份额/质量课次数/PB/CTL/比赛等）。`;

export interface PhasingIntentInput {
  evidence: PhaseEvidence;
  runwayWeeks: number;
  raceDate: string;
}

/** 判断层 user payload（与 spike 第六轮同构，保持 prompt 兼容=过门率不回退）。 */
export function buildIntentPayload(input: PhasingIntentInput): Record<string, unknown> {
  const { evidence, runwayWeeks, raceDate } = input;
  return {
    evidence,
    runway_weeks: runwayWeeks,
    race_date: raceDate,
    goal: { distance: "FM", target_time: evidence.target.target_time, goal_pace: evidence.target.goal_pace },
    note_injury: evidence.injury_return
      ? `运动员伤退回归：停训 ${evidence.injury_return.weeks_out} 周，伤前峰值周量 ${evidence.injury_return.pre_injury_peak_week_km}km，起量须 ≤ 其 60-70%。`
      : undefined,
  };
}

/** 判断层消息：教义 system + payload user；重试时在 user 消息尾部附违规清单。 */
export function buildIntentMessages(input: PhasingIntentInput, retry?: { previousIntent: unknown; violations: string[] }): PromptMessage[] {
  let user = JSON.stringify(buildIntentPayload(input));
  if (retry) {
    user += `\n\n你上一版阶段划分意图违反了以下结构门，逐条修正后重新输出完整意图（其余保持不变）：\n${retry.violations
      .map((v, i) => `${i + 1}. ${v}`)
      .join("\n")}\n上一版输出（仅供对照，不要原样重复）：${JSON.stringify(retry.previousIntent).slice(0, 4000)}`;
  }
  return [
    ["system", PHASING_DOCTRINE],
    ["user", user],
  ];
}
