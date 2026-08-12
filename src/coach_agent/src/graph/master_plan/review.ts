import { z } from "zod/v4";
import type { AssessmentFacts } from "./assessment.js";
import type { RuleReport } from "./rules.js";
import type { SimulationReport } from "./simulation.js";

export const ReviewerTypeSchema = z.enum([
	"periodization",
	"load_progression",
	"constraint_grounding",
]);
export type ReviewerType = z.infer<typeof ReviewerTypeSchema>;

export const ReviewIssueSchema = z
	.object({
		issue_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		severity: z.enum(["warning", "error", "hard"]),
		evidence_fact_ids: z.array(z.string().min(1)),
		evidence_refs: z
			.array(z.string().regex(/^(?:fact|simulation|rule|system):/))
			.min(1),
		target_path: z.string().startsWith("/"),
		suggested_action: z.string().min(1),
	})
	.strict();
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ReviewReportSchema = z
	.object({
		review_task_id: z.string().min(1),
		reviewer_type: ReviewerTypeSchema,
		artifact_revision: z.int().positive(),
		rubric_version: z.string().min(1),
		prompt_version: z.string().min(1),
		verdict: z.enum(["pass", "warning", "revise", "block"]),
		scores: z
			.record(z.string().min(1), z.int().min(1).max(5))
			.refine(
				(scores) => Object.keys(scores).length > 0,
				"at least one score axis is required",
			),
		evidence_refs: z
			.array(z.string().regex(/^(?:fact|simulation|rule|system):/))
			.min(1),
		issues: z.array(ReviewIssueSchema),
		rationale: z.string().min(1),
		confidence: z.number().min(0).max(1),
	})
	.strict()
	.superRefine((report, ctx) => {
		if ((report.verdict === "pass") !== (report.issues.length === 0))
			ctx.addIssue({
				code: "custom",
				path: ["issues"],
				message: "pass must have no issues and non-pass must have issues",
			});
		const expectedAxes: Record<ReviewerType, string[]> = {
			periodization: [
				"season_structure",
				"peak_timing",
				"recovery_absorption",
				"taper_quality",
			],
			load_progression: [
				"volume_progression",
				"dose_trajectory",
				"hard_stimulus_density",
				"long_run_concentration",
			],
			constraint_grounding: [
				"goal_fidelity",
				"availability_fit",
				"evidence_grounding",
				"selected_strategy_fidelity",
			],
		};
		const actual = Object.keys(report.scores).sort();
		const expected = expectedAxes[report.reviewer_type].slice().sort();
		if (JSON.stringify(actual) !== JSON.stringify(expected))
			ctx.addIssue({
				code: "custom",
				path: ["scores"],
				message: `expected axes: ${expected.join(",")}`,
			});
		if (
			report.rubric_version !== "rubric-v1" ||
			report.prompt_version !== "prompt-v1"
		)
			ctx.addIssue({
				code: "custom",
				path: ["rubric_version"],
				message: "unsupported review rubric/prompt version",
			});
		if (
			report.review_task_id !==
			reviewTaskId(
				report.reviewer_type,
				report.artifact_revision,
				report.rubric_version,
				report.prompt_version,
			)
		)
			ctx.addIssue({
				code: "custom",
				path: ["review_task_id"],
				message: "review task identity does not match report versions",
			});
	});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export const ReviewWorkerErrorSchema = z
	.object({
		review_task_id: z.string().min(1),
		reviewer_type: ReviewerTypeSchema,
		artifact_revision: z.int().positive(),
		kind: z.enum(["infrastructure", "contract"]),
		code: z.string().min(1),
	})
	.strict();
export type ReviewWorkerError = z.infer<typeof ReviewWorkerErrorSchema>;

export const ReviewAdjudicationSchema = z
	.object({
		artifact_revision: z.int().positive(),
		decision: z.enum(["pass", "pass_with_warnings", "revise", "block"]),
		issues: z.array(ReviewIssueSchema),
		rationale: z.string().min(1),
	})
	.strict();
export type ReviewAdjudication = z.infer<typeof ReviewAdjudicationSchema>;

export const REQUIRED_REVIEWERS: readonly ReviewerType[] = [
	"periodization",
	"load_progression",
	"constraint_grounding",
];

export function reviewTaskId(
	reviewer: ReviewerType,
	artifactRevision: number,
	rubricVersion = "rubric-v1",
	promptVersion = "prompt-v1",
): string {
	return `master-plan:r${artifactRevision}:${reviewer}:${rubricVersion}:${promptVersion}`;
}

/** Commutative keyed reducer: retains only the newest revision and one canonical report per task. */
export function mergeReviewReportsByRevisionAndTask(
	current: ReviewReport[],
	update: ReviewReport[],
): ReviewReport[] {
	const parsed = [...current, ...update].map((item) =>
		ReviewReportSchema.parse(item),
	);
	if (!parsed.length) return [];
	const revision = Math.max(...parsed.map((item) => item.artifact_revision));
	const keyed = new Map<string, ReviewReport>();
	for (const item of parsed.filter(
		(candidate) => candidate.artifact_revision === revision,
	)) {
		const key = `${item.artifact_revision}:${item.review_task_id}`;
		const existing = keyed.get(key);
		if (existing && JSON.stringify(existing) !== JSON.stringify(item))
			throw new Error(`conflicting duplicate review task: ${key}`);
		if (!existing) keyed.set(key, item);
	}
	return [...keyed.values()].sort((a, b) =>
		a.review_task_id.localeCompare(b.review_task_id),
	);
}

export function mergeReviewWorkerErrors(
	current: ReviewWorkerError[],
	update: ReviewWorkerError[],
): ReviewWorkerError[] {
	const keyed = new Map<string, ReviewWorkerError>();
	for (const item of [...current, ...update].map((candidate) =>
		ReviewWorkerErrorSchema.parse(candidate),
	)) {
		const key = `${item.artifact_revision}:${item.review_task_id}`;
		const existing = keyed.get(key);
		if (!existing || workerErrorOrder(item, existing) < 0) keyed.set(key, item);
	}
	return [...keyed.values()].sort((a, b) =>
		a.review_task_id.localeCompare(b.review_task_id),
	);
}

export function adjudicateMasterPlanReviews(
	artifactRevision: number,
	rawReports: ReviewReport[],
	facts: AssessmentFacts,
	evidence?: { simulation: SimulationReport; rules: RuleReport },
): ReviewAdjudication {
	const reports = mergeReviewReportsByRevisionAndTask([], rawReports).filter(
		(report) => report.artifact_revision === artifactRevision,
	);
	const factIds = new Set(facts.facts.map((fact) => fact.fact_id));
	for (const report of reports) {
		for (const ref of report.evidence_refs.filter((item) =>
			item.startsWith("fact:"),
		))
			if (!factIds.has(ref.slice(5)))
				throw new Error(`unknown report evidence ref: ${ref}`);
		if (evidence)
			for (const ref of report.evidence_refs)
				validateArtifactEvidence(ref, evidence);
		for (const issue of report.issues) {
			for (const factId of issue.evidence_fact_ids)
				if (!factIds.has(factId))
					throw new Error(`unknown evidence fact_id: ${factId}`);
			for (const ref of issue.evidence_refs.filter((item) =>
				item.startsWith("fact:"),
			))
				if (!factIds.has(ref.slice(5)))
					throw new Error(`unknown evidence ref: ${ref}`);
		}
		if (evidence)
			for (const ref of report.issues.flatMap((issue) => issue.evidence_refs))
				validateArtifactEvidence(ref, evidence);
	}
	const issues = mergeIssues(reports.flatMap((report) => report.issues));
	const missing = REQUIRED_REVIEWERS.filter(
		(reviewer) =>
			reports.filter((report) => report.reviewer_type === reviewer).length !==
			1,
	);
	for (const reviewer of missing)
		issues.push({
			issue_id: `missing-reviewer-${reviewer.replaceAll("_", "-")}`,
			severity: "hard",
			evidence_fact_ids: [],
			evidence_refs: ["system:missing-reviewer"],
			target_path: "/",
			suggested_action: `Obtain exactly one current ${reviewer} report.`,
		});
	issues.sort(issueOrder);
	const hasBlock = reports.some((report) => report.verdict === "block");
	const hasHard = issues.some((issue) => issue.severity === "hard");
	const hasError = issues.some((issue) => issue.severity === "error");
	const hasRevise = reports.some((report) => report.verdict === "revise");
	const hasWarning =
		reports.some((report) => report.verdict === "warning") ||
		issues.some((issue) => issue.severity === "warning");
	const decision =
		missing.length || hasBlock || hasHard
			? "block"
			: hasError || hasRevise
				? "revise"
				: hasWarning
					? "pass_with_warnings"
					: "pass";
	return ReviewAdjudicationSchema.parse({
		artifact_revision: artifactRevision,
		decision,
		issues,
		rationale: `Deterministic adjudication of ${reports.length} current reports: ${decision}; hard/error/block vetoes override aggregate scores.`,
	});
}

function mergeIssues(issues: ReviewIssue[]): ReviewIssue[] {
	const keyed = new Map<string, ReviewIssue>();
	for (const issue of issues
		.map((item) => ReviewIssueSchema.parse(item))
		.sort(issueOrder)) {
		const key = `${issue.issue_id}:${issue.target_path}`;
		const existing = keyed.get(key);
		if (!existing) keyed.set(key, issue);
		else
			keyed.set(key, {
				...existing,
				severity:
					severityRank(issue.severity) > severityRank(existing.severity)
						? issue.severity
						: existing.severity,
				evidence_fact_ids: [
					...new Set([
						...existing.evidence_fact_ids,
						...issue.evidence_fact_ids,
					]),
				].sort(),
				evidence_refs: [
					...new Set([...existing.evidence_refs, ...issue.evidence_refs]),
				].sort(),
				suggested_action: resolveSuggestedActions(
					existing.suggested_action,
					issue.suggested_action,
				),
			});
	}
	return [...keyed.values()].sort(issueOrder);
}

function severityRank(severity: ReviewIssue["severity"]): number {
	return { warning: 1, error: 2, hard: 3 }[severity];
}
function issueOrder(a: ReviewIssue, b: ReviewIssue): number {
	return `${a.issue_id}:${a.target_path}`.localeCompare(
		`${b.issue_id}:${b.target_path}`,
	);
}
function workerErrorOrder(a: ReviewWorkerError, b: ReviewWorkerError): number {
	return `${a.kind === "infrastructure" ? 0 : 1}:${a.code}`.localeCompare(
		`${b.kind === "infrastructure" ? 0 : 1}:${b.code}`,
	);
}
function resolveSuggestedActions(...actions: string[]): string {
	return [...new Set(actions)][0]!;
}
function validateArtifactEvidence(
	ref: string,
	evidence: { simulation: SimulationReport; rules: RuleReport },
): void {
	if (
		ref.startsWith("rule:") &&
		!evidence.rules.checked_rule_ids.includes(ref.slice(5))
	)
		throw new Error(`unknown rule evidence ref: ${ref}`);
	if (ref.startsWith("simulation:")) {
		const path = ref.slice(11).replace(/^\/?/, "/");
		if (!jsonPointerExists(evidence.simulation, path))
			throw new Error(`unknown simulation evidence ref: ${ref}`);
	}
}
function jsonPointerExists(value: unknown, pointer: string): boolean {
	let current: unknown = value;
	for (const token of pointer.split("/").slice(1)) {
		const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
		if (current === null || typeof current !== "object" || !(key in current))
			return false;
		current = (current as Record<string, unknown>)[key];
	}
	return true;
}
