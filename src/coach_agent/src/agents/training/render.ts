import { AIMessage } from "@langchain/core/messages";
import { type MasterPlan, type MasterPlanCard, PHASE_NAME_CN, type SimulationReport } from "@stride/contract";

/**
 * Athlete-facing text projections for the in-turn master-plan generation (#427:
 * text-form plan content; the `master-plan` card lands in #428).
 */

export function renderMasterPlanMarkdown(plan: MasterPlan, simulation?: SimulationReport): string {
  const goal = plan.goal;
  const goalLine = goal.target_time
    ? `${goal.race_name}（${distanceLabel(goal.distance)}，${goal.race_date}，目标 ${goal.target_time}）`
    : `${goal.race_name}（${distanceLabel(goal.distance)}，${goal.race_date}）`;
  const lines: string[] = [
    "赛季训练计划初稿已生成：",
    "",
    `**目标**：${goalLine}`,
    `**周期**：${plan.start_date} ~ ${plan.end_date}，共 ${plan.total_weeks} 周`,
  ];
  if (plan.training_principles.length > 0) {
    lines.push("", "**训练原则**", ...plan.training_principles.map((principle) => `- ${principle}`));
  }
  lines.push("", "**阶段划分**");
  for (const phase of plan.phases) {
    const range = `${phase.start_date} ~ ${phase.end_date}`;
    const km = `${phase.weekly_distance_km_low}-${phase.weekly_distance_km_high} km/周`;
    lines.push(`- **${phaseLabel(phase.name)}**（${range}，${km}）：${phase.focus}`);
  }
  lines.push("", "**周骨架**");
  for (const week of plan.weeks) {
    const tags = [week.is_recovery_week ? "恢复周" : null].filter((tag): tag is string => tag !== null);
    const sessions = week.key_sessions.map((session) => sessionTypeLabel(session.type)).join("、");
    lines.push(
      `- 第 ${week.week_index} 周（${week.week_start} 起，${phaseLabel(week.phase_name)}${tags.length > 0 ? `，${tags.join("")}` : ""}）：${week.target_weekly_km_low}-${week.target_weekly_km_high} km${sessions ? `，重点课：${sessions}` : ""}`,
    );
  }
  const load = loadProjectionLines(plan, simulation);
  if (load.length > 0) {
    lines.push("", "**负荷投影**", ...load);
  }
  lines.push("", "这是一版初稿，你可以直接告诉我想怎么调整（比如改比赛目标、周跑量上限或某个阶段的安排）。");
  return lines.join("\n");
}

/** 负荷投影摘要：周跑量曲线的三个锚点 + 模拟期末 CTL（有模拟才给）。 */
function loadProjectionLines(plan: MasterPlan, simulation?: SimulationReport): string[] {
  const first = plan.weeks[0];
  const final = plan.weeks.at(-1);
  if (first === undefined || final === undefined) return [];
  let peak = first;
  for (const week of plan.weeks) {
    if (week.target_weekly_km_high > peak.target_weekly_km_high) peak = week;
  }
  const lines = [
    `- 周跑量 ${first.target_weekly_km_low}-${first.target_weekly_km_high} km 起步，第 ${peak.week_index} 周到峰值 ${peak.target_weekly_km_high} km，最后一周回落到 ${final.target_weekly_km_low}-${final.target_weekly_km_high} km`,
  ];
  const finalCtl = simulation?.weeks.at(-1)?.end_ctl;
  if (finalCtl != null) lines.push(`- 模拟到期末的稳态负荷（CTL）约 ${Math.round(finalCtl)}`);
  return lines;
}

/**
 * completed 产物的回复消息（#428）：正文是可读 markdown 摘要，卡片信封
 * `{$type: "master-plan", data}` 挂在消息自身（additional_kwargs.card）随
 * checkpoint 持久化，done 与历史投影都从消息读取（与 race-strategy 同模式，
 * 不再运行时复验——投影是已校验 plan 的确定性标量挑选，形状由返回类型
 * 编译期钉死，契约由单测对信封 safeParse 把关）。
 */
export function masterPlanCardMessage(plan: MasterPlan, planId?: string, simulation?: SimulationReport): AIMessage {
  return new AIMessage({
    content: renderMasterPlanMarkdown(plan, simulation),
    additional_kwargs: { card: { $type: "master-plan", data: projectMasterPlanCard(plan, planId) } },
  });
}

/** plan → 卡片结构（渲染/定位需要的标量摘要；时间轴与负荷投影走 markdown 正文）。 */
function projectMasterPlanCard(plan: MasterPlan, planId?: string): MasterPlanCard {
  return {
    goal: {
      race_name: plan.goal.race_name,
      distance: plan.goal.distance,
      race_date: plan.goal.race_date,
      target_time: plan.goal.target_time,
    },
    start_date: plan.start_date,
    end_date: plan.end_date,
    total_weeks: plan.total_weeks,
    // #429：draft 落库成功才有 plan_id（卡片「启用/放弃」CTA 的定位）；落库
    // 失败/无 race goal 时整个省略，前端降级为无 CTA 卡片。
    ...(planId !== undefined ? { plan_id: planId } : {}),
  };
}

function distanceLabel(distance: "FM" | "HM"): string {
  return distance === "FM" ? "全马" : "半马";
}

/** 契约存英文名、展示用中文标签（PHASE_NAME_CN）。 */
function phaseLabel(name: string): string {
  return PHASE_NAME_CN[name as keyof typeof PHASE_NAME_CN] ?? name;
}

const SESSION_LABELS: Record<string, string> = {
  long_run: "长距离",
  threshold: "阈值",
  tempo: "节奏",
  interval: "间歇",
  vo2max: "最大摄氧",
  hill: "坡跑",
  race_pace: "比赛配速",
  time_trial: "测验",
  tune_up_race: "热身赛",
  race: "比赛",
  strength_key: "力量",
};

function sessionTypeLabel(type: string): string {
  return SESSION_LABELS[type] ?? type;
}
