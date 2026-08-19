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

const PHASE_NODE_TARGETS = [
	"phase_base",
	"phase_build",
	"phase_speed",
	"phase_marathon",
	"phase_taper",
	"phase_recovery",
] as const;

/** Build the compiled weekly plan generator graph: loadWeeklyPlanContext -> getTargetTrainingLoad -> phase node -> finalize. */
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
		.addNode("phase_base", nodes.phaseBase)
		.addNode("phase_build", nodes.phaseBuild)
		.addNode("phase_speed", nodes.phaseSpeed)
		.addNode("phase_marathon", nodes.phaseMarathon)
		.addNode("phase_taper", nodes.phaseTaper)
		.addNode("phase_recovery", nodes.phaseRecovery)
		.addNode("phase_unresolvable", nodes.phaseUnresolvable)
		.addNode("finalize", nodes.finalize)
		.addEdge(START, "loadWeeklyPlanContext")
		.addConditionalEdges(
			"loadWeeklyPlanContext",
			(state) => (state.outcome ? END : "getTargetTrainingLoad"),
			["getTargetTrainingLoad", END],
		)
		.addConditionalEdges("getTargetTrainingLoad", nodes.routeByPhase, [
			...PHASE_NODE_TARGETS,
			"phase_unresolvable",
		])
		.addEdge("phase_base", "finalize")
		.addEdge("phase_build", "finalize")
		.addEdge("phase_speed", "finalize")
		.addEdge("phase_marathon", "finalize")
		.addEdge("phase_taper", "finalize")
		.addEdge("phase_recovery", "finalize")
		.addEdge("phase_unresolvable", END)
		.addEdge("finalize", END)
		.compile();
}
