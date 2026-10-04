import type { MasterPlan, MasterPlanGraphOutcome } from "@stride/contract";
import type { MasterPlanRequestGap } from "./request.js";

/**
 * Athlete-facing text projections for the in-turn master kernel (#427:
 * text-form plan content; the `master-plan` card lands in #428).
 */

export function renderRequestGap(gap: MasterPlanRequestGap): string {
  switch (gap.kind) {
    case "no_race_goal":
      return "还没有找到你的赛季目标。请先在 App 里设置一场目标比赛（全马或半马）和每周可训练天数，我们再从这里开始制定赛季训练计划。";
    case "unsupported_distance":
      return `赛季训练计划目前支持全马/半马目标，你当前的目标距离是「${gap.distance}」。设置一场全马或半马目标后我就能为你规划整个赛季。`;
    case "invalid_goal":
      return `你的目标比赛信息（${gap.reason}）无法用于生成计划，请到 App 里检查目标设置后再试。`;
  }
}

export function renderKernelOutcome(outcome: MasterPlanGraphOutcome): string {
  if (outcome.decision === "completed") {
    return renderMasterPlanMarkdown(outcome.artifact.plan);
  }
  switch (outcome.decision) {
    case "needs_clarification":
      return [
        "在开始制定赛季计划前，我还需要确认几件事：",
        ...outcome.questions.map((question) => `- ${question.intent}`),
        "",
        "回复上面的问题后我们继续。",
      ].join("\n");
    case "needs_baseline":
      return [
        "你近期的跑步数据还不够支撑一份安全的赛季计划。",
        ...outcome.artifact.next_steps.map((step) => `- ${step}`),
        "",
        "先按计划积累一段时间，随时回来找我重新生成。",
      ].join("\n");
    case "blocked_for_safety":
      return [
        "出于安全考虑，我现在不能为你生成训练计划：",
        ...outcome.reasons.map((reason) => `- ${reason}`),
        "",
        ...outcome.prerequisites.map((item) => `- ${item}`),
      ].join("\n");
    case "goal_conflict":
      return "你的多个比赛目标和赛季窗口存在冲突，我暂时无法给出单一计划。可以把主要目标调整为一场比赛后再试。";
    case "multi_cycle_required":
      return "从现在的准备时间到目标比赛需要拆成多个训练周期，这一版还不支持自动拆分多周期计划。";
    case "failed_quality_gate":
      return "这次生成的计划没有通过质量审核，我把它拦下来了。请稍后再试一次。";
    case "unsupported":
      return "这个生成模式暂时还不支持，当前支持为新赛季制定完整训练计划。";
    case "review_completed":
    case "preview_completed":
      return outcome.artifact.summary;
    case "infrastructure_failure":
      return "生成服务暂时不可用，请稍后再试一次。";
  }
}

export function renderMasterPlanMarkdown(plan: MasterPlan): string {
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
    lines.push(`- **${phase.name}**（${range}，${km}）：${phase.focus}`);
  }
  lines.push("", "**周骨架**");
  for (const week of plan.weeks) {
    const tags = [week.is_recovery_week ? "恢复周" : null].filter((tag): tag is string => tag !== null);
    const sessions = week.key_sessions.map((session) => sessionTypeLabel(session.type)).join("、");
    lines.push(
      `- 第 ${week.week_index} 周（${week.week_start} 起，${week.phase_name}${tags.length > 0 ? `，${tags.join("")}` : ""}）：${week.target_weekly_km_low}-${week.target_weekly_km_high} km${sessions ? `，重点课：${sessions}` : ""}`,
    );
  }
  lines.push("", "这是一版初稿，你可以直接告诉我想怎么调整（比如改比赛目标、周跑量上限或某个阶段的安排）。");
  return lines.join("\n");
}

function distanceLabel(distance: "FM" | "HM"): string {
  return distance === "FM" ? "全马" : "半马";
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
