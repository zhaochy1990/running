import { END, START, StateGraph } from "@langchain/langgraph";
import type { CoachAgentConfig } from "../../config/config.js";
import type { WeeklyPlanContextProvider } from "../../persistence/weeklyPlanContextProvider.js";
import {
	WeeklyPlanGeneratorContext,
	WeeklyPlanGeneratorRequest,
} from "./contracts.js";
import {
	GraphInput,
	GraphOutput,
	GraphState,
	WeeklyPlanGeneratorNodes,
} from "./nodes.js";

/** Build the compiled weekly plan generator graph: initialize -> greet -> (shout?) -> finalize. */
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
		.addNode("initialize", nodes.initialize)
		.addNode("greet", nodes.greet)
		.addNode("shout", nodes.shout)
		.addNode("finalize", nodes.finalize)
		.addEdge(START, "initialize")
		.addConditionalEdges(
			"initialize",
			(state) => (state.outcome ? END : "greet"),
			["greet", END],
		)
		.addConditionalEdges(
			"greet",
			(state) => {
				const request = WeeklyPlanGeneratorRequest.parse(state.request);
				return request.name === "world" ? "finalize" : "shout";
			},
			["shout", "finalize"],
		)
		.addEdge("shout", "finalize")
		.addEdge("finalize", END)
		.compile();
}
