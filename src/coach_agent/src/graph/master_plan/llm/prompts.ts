import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_REVIEWERS, type ReviewerType } from "../review.js";
import type { PromptMessage } from "./structured.js";

interface AssessmentPromptInput {
	request: unknown;
	facts: unknown;
	snapshot: unknown;
}

interface GoalAssessmentPromptInput extends AssessmentPromptInput {
	athleteAssessment: unknown;
}

export async function loadMasterPlanPromptAssets() {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const doctrine = await readFile(
		resolve(moduleDir, "../doctrine/planning.md"),
		"utf8",
	);
	const reviewRubricEntries = await Promise.all(
		REQUIRED_REVIEWERS.map(
			async (name) =>
				[
					name,
					await readFile(
						resolve(moduleDir, `../doctrine/review/${name}.md`),
						"utf8",
					),
				] as const,
		),
	);

	return {
		doctrine,
		reviewRubrics: Object.fromEntries(reviewRubricEntries) as Record<
			ReviewerType,
			string
		>,
	};
}

export function athleteAssessmentPrompt(
	input: AssessmentPromptInput,
): PromptMessage[] {
	return messages(
		"You are the athlete capability assessor. Submit only the forced function schema. Treat AssessmentFacts as immutable truth. Assess the athlete independently of race-goal feasibility: current capability, evidence confidence, continuity, current and recommended entry phase, limiting factors, assumptions, and safe training boundaries. weekly_distance_km is the peak ceiling; starting_weekly_distance_km is the safe initial range. Allowed claims are only volume_baseline_established, long_run_tolerance_established, quality_tolerance_established, availability_requires_adjustment, load_state_supportive, coverage_sufficient. Do not discuss target improvement, race runway, or A/B/C goals. Every conclusion, factor, assumption, and gap cites fact_ids. Do not prescribe a season strategy.",
		{
			task: "Assess the athlete's current capability and safe planning entry point",
			request: input.request,
			assessment_facts: input.facts,
			snapshot: input.snapshot,
		},
	);
}

export function goalAssessmentPrompt(
	input: GoalAssessmentPromptInput,
): PromptMessage[] {
	return messages(
		"You are the race-goal feasibility assessor. Submit only the forced function schema. Treat AssessmentFacts and AthleteAssessment as immutable truth. Assess only goal feasibility; do not repeat the athlete capability assessment. Allowed claims are only goal_requires_improvement, goal_runway_limited, goal_supported_by_history. For a timed goal, A is the confirmed target; B is a strictly slower time or the exact matching PB; C is safe completion or a strictly slower time. Every gate must name an observable signal and a concrete criterion that can be evaluated later, such as a race-specific performance, long-run durability, health readiness, fueling execution, or availability consistency. A gate cannot merely say readiness supports the target or restate a historical fact. Cite fact_ids as the evidence that motivates each future criterion. Do not prescribe training. Use multi_cycle_required only for the deterministic extreme-gap case; otherwise multi_cycle_path must be empty.",
		{
			task: "Assess the confirmed race goal against the athlete assessment",
			request: input.request,
			assessment_facts: input.facts,
			athlete_assessment: input.athleteAssessment,
			snapshot: input.snapshot,
		},
	);
}

export function strategyPrompt(
	input: unknown,
	doctrine: string,
): PromptMessage[] {
	return messages(
		`Generate exactly one macro strategy for the archetype supplied in the user message. Candidate ID must match the schema. Strategies differ materially but ALL must stay inside AthleteAssessment safe_training_ranges: phase weekly high never exceeds assessed weekly high; planned longest run never exceeds assessed long_run high; quality frequency never exceeds assessed quality high; load-week growth never exceeds 10% across recovery; phase weeks must fit race runway. Aggressive means using the upper safe boundary with stricter gates, never exceeding it. Fill weekly_highs_km, max_long_run_km, max_quality_sessions_per_week, and race_week_index so constraints are machine-checkable. Set hard_constraints_satisfied=false and list violations if any bound cannot be met. Use only supplied fact_ids as evidence. Do not generate weekly sessions yet.\n\n${doctrine}`,
		input,
	);
}

export function judgmentPrompt(
	input: unknown,
	doctrine: string,
): PromptMessage[] {
	return messages(
		`Evaluate the judge role supplied in the user message against immutable facts, assessments, confirmed availability, and doctrine. Set veto=true only for a concrete confirmed hard-constraint or safety violation; low score or an ordinary tradeoff is not a veto. Use candidate_id exactly and cite only existing fact_ids.\n\n${doctrine}`,
		input,
	);
}

export function skeletonPrompt(
	input: unknown,
	doctrine: string,
): PromptMessage[] {
	return messages(
		`Generate the complete strategic Master Plan JSON in Chinese from the selected strategy. Cover every Monday-Sunday week from the current planning week through race day plus two recovery weeks. Use 1-3 strategic key sessions only; no ordinary easy/recovery/filler runs. Each key_sessions object is exactly one independently performed workout: distance_km and duration_min describe the complete workout, including warm-up, recoveries, and cool-down, never only its work intervals. Every running key session must include workout_structure using the canonical run-workout/v1 schema. Put linear segments in repeat=1 blocks and repeated intervals in one block whose repeat is the repetition count and whose ordered steps include both work and active recovery. Encode warm-up, work, active recovery, passive rest, and cooldown separately; passive rest uses step_kind=rest and active jog recovery uses step_kind=recovery. Use SI units: time_s, distance_m, and pace_s_km. Use open targets only for warm-up, cooldown, or active recovery without a prescribed target; work steps need an explicit pace or HR range. workout_structure must cover the complete session and its date must fall inside the containing week. Recovery weeks have at most one key session; race week contains only race. Respect max session duration and confirmed goal. MP/HMP, threshold, hill, or fueling blocks embedded in a long run stay inside that one long_run and its workout_structure, and must not be repeated as sibling sessions. Do not place two heavy marathon-specific long runs in consecutive weeks: the week before the maximal specific rehearsal must be an absorption week or use an easy/shorter long run with materially less MP exposure. Every week must fall inside its named phase date range and weekly volume range; each phase low must be <= the minimum weekly low inside that phase and each phase high must be >= the maximum weekly high. For every index before and including race week, copy selectedStrategy.candidate.weekly_highs_km exactly into weeks[index].target_weekly_km_high; do not optimize or round it. The race session must be at selectedStrategy.candidate.race_week_index. Non-recovery/pre-race weeks stay within AthleteAssessment safe high; long runs do not exceed selectedStrategy.max_long_run_km; hard running stimuli do not exceed selectedStrategy.max_quality_sessions_per_week. status=draft, generated_by=coach_agent, version=1, UTC timestamps.\n\n${doctrine}`,
		input,
	);
}

export function reviewPrompt(input: unknown, rubric: string): PromptMessage[] {
	return messages(
		`You are an independent Master Plan reviewer. Follow this versioned rubric exactly. Return the supplied review_task_id, reviewer_type, artifact_revision, rubric_version='rubric-v1', prompt_version='prompt-v1'. Use exactly the rubric score axes. Every report must cite evidence_refs using fact:<fact_id>, simulation:<field/path>, rule:<rule_id>, or system:<reason>. A pass has no issues; every non-pass has issues. Every issue must include at least one evidence_ref and include evidence_fact_ids for referenced facts.\n\n${rubric}`,
		input,
	);
}

function messages(system: string, user: unknown): PromptMessage[] {
	return [
		["system", system],
		["user", JSON.stringify(user)],
	];
}
