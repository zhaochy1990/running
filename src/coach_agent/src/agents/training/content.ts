import type { MasterPlan } from "@stride/contract";

/**
 * Adapt the kernel's `MasterPlan` output into the Go stored content_version=2
 * doc the apply endpoints validate (`validateStructuredPlanDoc`): Go requires
 * top-level `milestones` and deterministic `id`s on phases, weeks and
 * milestones (the kernel output carries milestones nested under phases and
 * links weeks to phases by name). Ids are structural (`phase-1`,
 * `milestone-1-2`) so an at-least-once re-run produces identical content.
 * `goal_id` is the athlete's active race-goal id (Go enforces a UUID here).
 *
 * #585: the transformed doc is no longer persisted by the coach — it rides the
 * card (and the plan-job's result_json) and lands in master_plan only when the
 * athlete applies it.
 */
export function masterPlanToContent(plan: MasterPlan, goalId: string): Record<string, unknown> {
  const phaseIdByIndex = plan.phases.map((_, index) => `phase-${index + 1}`);

  const phases = plan.phases.map((phase, phaseIndex) => ({
    id: phaseIdByIndex[phaseIndex],
    name: phase.name,
    start_date: phase.start_date,
    end_date: phase.end_date,
    focus: phase.focus,
    weekly_distance_km_low: phase.weekly_distance_km_low,
    weekly_distance_km_high: phase.weekly_distance_km_high,
    key_session_types: phase.key_session_types,
    milestone_ids: phase.milestones.map((_, milestoneIndex) => milestoneId(phaseIndex, milestoneIndex)),
    is_completed: phase.is_completed,
  }));

  const milestones = plan.phases.flatMap((phase, phaseIndex) =>
    phase.milestones.map((milestone, milestoneIndex) => ({
      id: milestoneId(phaseIndex, milestoneIndex),
      type: milestone.type,
      date: milestone.date,
      phase_id: phaseIdByIndex[phaseIndex],
      target: milestone.target,
      completed_actual: milestone.completed_actual,
    })),
  );

  const phaseIdByName = new Map(plan.phases.map((phase, index) => [phase.name, phaseIdByIndex[index]]));
  const weeks = plan.weeks.map((week) => ({
    week_index: week.week_index,
    week_start: week.week_start,
    phase_id: phaseIdByName.get(week.phase_name),
    target_weekly_km_low: week.target_weekly_km_low,
    target_weekly_km_high: week.target_weekly_km_high,
    key_sessions: week.key_sessions,
    is_recovery_week: week.is_recovery_week,
  }));

  return {
    ...plan,
    goal: { ...plan.goal, goal_id: goalId },
    phases,
    milestones,
    weeks,
  };
}

function milestoneId(phaseIndex: number, milestoneIndex: number): string {
  return `milestone-${phaseIndex + 1}-${milestoneIndex + 1}`;
}

/**
 * 聊天侧宽松 schema（MasterPlanLenientSchema）不校验 week.phase_name ∈
 * phases[].name，也不校验 phase 名唯一——transform 会产出丢失/错绑的
 * phase_id，Go validWeek 必拒（422 应用失败）。生成卡片前显式拒绝并记具体
 * 原因，让卡片降级成无 apply 载荷，而不是让用户点「应用」时才发现内容无效。
 */
export function assertWeeksLinkedToPhases(plan: MasterPlan, content: Record<string, unknown>): void {
  const phaseNames = plan.phases.map((phase) => phase.name);
  if (new Set(phaseNames).size !== phaseNames.length) {
    throw new Error(`plan has duplicate phase names: [${phaseNames.join(", ")}]`);
  }
  const phaseIds = new Set((content.phases as Array<{ id?: unknown }>).map((phase) => phase.id));
  const weeks = content.weeks as Array<{ phase_id?: unknown; week_index?: unknown }>;
  for (const week of weeks) {
    if (typeof week.phase_id !== "string" || !phaseIds.has(week.phase_id)) {
      throw new Error(`week ${String(week.week_index)} phase_name does not match any phase`);
    }
  }
}
