import type { MasterPlan } from "@stride/contract";

/**
 * Adapt the kernel's `MasterPlan` output into the Go stored content_version=2
 * doc the draft-insert endpoint validates (`validateStructuredPlanDoc`):
 * Go requires top-level `milestones` and deterministic `id`s on phases, weeks
 * and milestones (the kernel output carries milestones nested under phases and
 * links weeks to phases by name). Ids are structural (`phase-1`,
 * `milestone-1-2`) so an at-least-once re-run produces identical content.
 * `goal_id` is the athlete's active race-goal id (Go enforces a UUID here).
 */
export function masterPlanToDraftContent(plan: MasterPlan, goalId: string): Record<string, unknown> {
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
