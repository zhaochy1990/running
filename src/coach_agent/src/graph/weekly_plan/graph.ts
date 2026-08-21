import { END, START, StateGraph } from "@langchain/langgraph";
import { WeeklyPlanGeneratorContext } from "@stride/contract";
import { type CoachAgentConfig, getAgentConfig } from "../../config/config.js";
import type { WeeklyPlanContextProvider } from "../../persistence/weeklyPlanContextProvider.js";
import { GraphInput, GraphOutput, GraphState, WeeklyPlanGeneratorNodes } from "./nodes.js";
import { createWeeklyPlanLlm } from "./weeklyPlanNode.js";

const PHASE_NODE_TARGETS = ["phase_base", "phase_build", "phase_speed", "phase_marathon", "phase_taper", "phase_recovery"] as const;

/** Build the compiled weekly plan generator graph: loadWeeklyPlanContext -> getTargetTrainingLoad -> phase node -> finalize. */
export function createWeeklyPlanGeneratorGraph(config: CoachAgentConfig, contextProvider: WeeklyPlanContextProvider) {
  const llm = createWeeklyPlanLlm(getAgentConfig(config, "weekly_plan"));

  const nodes = new WeeklyPlanGeneratorNodes(config, contextProvider, llm);

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
    .addNode("simulate_load", nodes.simulateLoad)
    .addNode("load_mismatch", nodes.loadMismatch)
    .addNode("finalize", nodes.finalize)
    .addEdge(START, "loadWeeklyPlanContext")
    .addConditionalEdges("loadWeeklyPlanContext", (state) => (state.outcome ? END : "getTargetTrainingLoad"), ["getTargetTrainingLoad", END])
    .addConditionalEdges("getTargetTrainingLoad", nodes.routeByPhase, [...PHASE_NODE_TARGETS, "phase_unresolvable"])
    .addConditionalEdges("phase_base", (state) => (state.outcome ? END : "simulate_load"), ["simulate_load", END])
    .addConditionalEdges("phase_build", (state) => (state.outcome ? END : "simulate_load"), ["simulate_load", END])
    .addConditionalEdges("phase_speed", (state) => (state.outcome ? END : "simulate_load"), ["simulate_load", END])
    .addConditionalEdges("phase_marathon", (state) => (state.outcome ? END : "simulate_load"), ["simulate_load", END])
    .addConditionalEdges("phase_taper", (state) => (state.outcome ? END : "simulate_load"), ["simulate_load", END])
    .addConditionalEdges("phase_recovery", (state) => (state.outcome ? END : "simulate_load"), ["simulate_load", END])
    .addEdge("phase_unresolvable", END)
    .addConditionalEdges("simulate_load", nodes.evaluateLoadMatch, [...PHASE_NODE_TARGETS, "finalize", "load_mismatch"])
    .addEdge("load_mismatch", END)
    .addEdge("finalize", END)
    .compile();
}
