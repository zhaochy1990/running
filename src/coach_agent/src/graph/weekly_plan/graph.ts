import { END, START, StateGraph } from "@langchain/langgraph";
import type { CoachAgentConfig } from "../../config/config.js";
import type { WeeklyPlanContextProvider } from "../../persistence/weeklyPlanContextProvider.js";
import { WeeklyPlanGeneratorContext } from "./contracts.js";
import {
	GraphInput,
	GraphOutput,
	GraphState,
	WeeklyPlanGeneratorNodes,
} from "./nodes.js";

/** Build the compiled weekly plan generator graph: loadWeeklyPlanContext -> getTargetTrainingLoad -> finalize. */
export function createWeeklyPlanGeneratorGraph(
	config: CoachAgentConfig,
	contextProvider: WeeklyPlanContextProvider,
) {
	const nodes = new WeeklyPlanGeneratorNodes(config, contextProvider);

	return new StateGraph({
		state: GraphState,
		input: GraphInput,
		output: GraphOutput,
		context: WeeklyPlanGeneratorContext,
	})
		.addNode("loadWeeklyPlanContext", nodes.loadWeeklyPlanContext)
		.addNode("getTargetTrainingLoad", nodes.getTargetTrainingLoad)
		.addNode("finalize", nodes.finalize)
		.addEdge(START, "loadWeeklyPlanContext")
		.addConditionalEdges(
			"loadWeeklyPlanContext",
			(state) => (state.outcome ? END : "getTargetTrainingLoad"),
			["getTargetTrainingLoad", END],
		)
		.addEdge("getTargetTrainingLoad", "finalize")
		.addEdge("finalize", END)
		.compile();
}
