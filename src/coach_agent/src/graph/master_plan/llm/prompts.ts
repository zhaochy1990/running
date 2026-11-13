/**
 * master plan kernel 的目标评估提示（原样保留：它的教义与 validateGoalAssessment*
 * 的确定性校验一一对应——allowed claims、A/B/C 目标阶梯、gate 必须绑可观测信号、
 * 每条结论必须引用指定 fact_id。重写这段提示会直接让 assess_goal 被判合同违规）。
 * 策略/评审/骨架四份提示随老拓扑删除（#803）。
 */
import type { PromptMessage } from "@stride/common";

interface AssessmentPromptInput {
  request: unknown;
  facts: unknown;
  snapshot: unknown;
  retry?: { violations: string[] } | undefined;
}

type GoalAssessmentPromptInput = AssessmentPromptInput;

export function goalAssessmentPrompt(input: GoalAssessmentPromptInput): PromptMessage[] {
  return messages(
    "You are the race-goal feasibility assessor. Submit only the forced function schema. Treat AssessmentFacts as immutable truth. Assess only goal feasibility. Allowed claims are only goal_requires_improvement, goal_runway_limited, goal_supported_by_history. For a timed goal, A is the confirmed target; B is a strictly slower time or the exact matching PB; C is safe completion or a strictly slower time. Every gate must name an observable signal and a concrete criterion that can be evaluated later, such as a race-specific performance, long-run durability, health readiness, fueling execution, or availability consistency. A gate cannot merely say readiness supports the target or restate a historical fact. Cite fact_ids as the evidence that motivates each future criterion. Each material conclusion must also cite the fact_ids that deterministically back its claim: goal_requires_improvement must cite goal.a.improvement_pct; goal_runway_limited must cite race.a.weeks_to_race and is allowed only when that fact is strictly <12. This fact is the unrounded calendar-day difference from the Shanghai generation day (snapshot.as_of) to the A race date divided by 7, NOT the number of natural training weeks from the planning-start Monday. Exactly 12 or more weeks cannot support this claim. Omit unsupported claims and retain at least one evidence-backed conclusion; goal_supported_by_history must cite both history.peak_weekly_km and history.longest_road_run_km. The goal level ladder is deterministic: unsafe_or_incompatible only when race.a.weeks_to_race <= 0 or the goal is incompatible; conditional when goal.a.improvement_pct is unavailable; multi_cycle_required when goal.a.improvement_pct > 15 or (goal.a.improvement_pct > 10 and race.a.weeks_to_race < 16); aggressive_but_plausible when goal.a.improvement_pct > 3 or race.a.weeks_to_race < 12; otherwise supported. Do not prescribe training. Use multi_cycle_required only for the deterministic extreme-gap case; otherwise multi_cycle_path must be empty.",
    {
      task: "Assess the confirmed race goal against the athlete capability facts",
      request: input.request,
      assessment_facts: input.facts,
      snapshot: input.snapshot,
      ...(input.retry ? { retry: input.retry } : {}),
    },
  );
}

function messages(system: string, user: unknown): PromptMessage[] {
  return [
    ["system", system],
    ["user", JSON.stringify(user)],
  ];
}
