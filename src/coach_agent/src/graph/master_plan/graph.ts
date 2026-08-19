import { END, START, StateGraph } from "@langchain/langgraph";
import { MasterPlanGraphContext } from "@stride/contract";
import {
	createMasterPlanNodes,
	GraphInput,
	GraphOutput,
	GraphState,
	type MasterPlanGraphDependencies,
} from "./nodes.js";

export {
	ModelContractError,
	validateSkeletonAgainstStrategy,
} from "./nodes.js";

/** Build the compiled Master Plan Planning Kernel. */
export function createMasterPlanGraph(
	dependencies: MasterPlanGraphDependencies,
) {
	const nodes = createMasterPlanNodes(dependencies);

	return new StateGraph({
		state: GraphState,
		input: GraphInput,
		output: GraphOutput,
		context: MasterPlanGraphContext,
	})
		.addNode("initialize", nodes.initialize)
		.addNode("assess_athlete", nodes.assessAthlete)
		.addNode("assess_goal", nodes.assessGoal)
		.addNode("strategy_worker", nodes.strategyWorker)
		.addNode("dispatch_judges", nodes.dispatchJudges)
		.addNode("judge_worker", nodes.judgeWorker)
		.addNode("select_strategy", nodes.selectStrategy)
		.addNode("expand_skeleton", nodes.expandSkeleton)
		.addNode("simulate_load", nodes.simulateLoad)
		.addNode("filter_rules", nodes.filterRules)
		.addNode("validate_selected", nodes.validateSelected)
		.addNode("review_worker", nodes.reviewWorker)
		.addNode("adjudicate_reviews", nodes.adjudicateReviews)
		.addNode("finalize", nodes.finalize)
		.addEdge(START, "initialize")
		.addConditionalEdges("initialize", nodes.stopOr("assess_athlete"), [
			"assess_athlete",
			END,
		])
		.addConditionalEdges("assess_athlete", nodes.stopOr("assess_goal"), [
			"assess_goal",
			END,
		])
		.addConditionalEdges(
			"assess_goal",
			(state) => (state.outcome ? END : nodes.fanStrategies(state)),
			["strategy_worker", END],
		)
		.addEdge("strategy_worker", "dispatch_judges")
		.addConditionalEdges(
			"dispatch_judges",
			(state) => (state.outcome ? END : nodes.fanJudges(state)),
			["judge_worker", END],
		)
		.addEdge("judge_worker", "select_strategy")
		.addConditionalEdges("select_strategy", nodes.stopOr("expand_skeleton"), [
			"expand_skeleton",
			END,
		])
		.addConditionalEdges("expand_skeleton", nodes.stopOr("simulate_load"), [
			"simulate_load",
			END,
		])
		.addConditionalEdges("simulate_load", nodes.stopOr("filter_rules"), [
			"filter_rules",
			END,
		])
		.addConditionalEdges("filter_rules", nodes.stopOr("validate_selected"), [
			"validate_selected",
			END,
		])
		.addConditionalEdges(
			"validate_selected",
			(state) => (state.outcome ? END : nodes.fanReviewers(state)),
			["review_worker", END],
		)
		.addEdge("review_worker", "adjudicate_reviews")
		.addConditionalEdges("adjudicate_reviews", nodes.stopOr("finalize"), [
			"finalize",
			END,
		])
		.addEdge("finalize", END)
		.compile();
}
