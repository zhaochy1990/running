import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  MasterPlanGraphContext,
  MasterPlanGraphOutcome,
  MasterPlanGraphRequest,
} from "./contracts.js";
import { MasterPlanSchema } from "./schemas.js";

interface SkeletonModel {
  invoke(input: {
    request: MasterPlanGraphRequest;
    context: MasterPlanGraphContext;
  }): Promise<unknown>;
}

interface MasterPlanGraphDependencies {
  skeletonModel: SkeletonModel;
}

const GraphInput = new StateSchema({
  request: MasterPlanGraphRequest,
});

const GraphOutput = new StateSchema({
  outcome: MasterPlanGraphOutcome,
});

const GraphState = new StateSchema({
  request: MasterPlanGraphRequest,
  outcome: MasterPlanGraphOutcome.optional(),
});

/** Build the compiled Master Plan Planning Kernel. */
export function createMasterPlanGraph(dependencies: MasterPlanGraphDependencies) {
  const runPlanning = async (
    state: typeof GraphState.State,
    runtime: { context?: MasterPlanGraphContext },
  ) => {
    const request = MasterPlanGraphRequest.parse(state.request);
    const context = MasterPlanGraphContext.parse(runtime.context);

    if (request.requested_mode !== "new_season") {
      return {
        outcome: MasterPlanGraphOutcome.parse({
          decision: "unsupported",
          request_id: request.request_id,
          generation_id: context.generationId,
          artifact: {
            type: "capability_gap",
            requested_mode: request.requested_mode,
            supported_modes: ["new_season"],
          },
        }),
      };
    }

    const plan = MasterPlanSchema.parse(await dependencies.skeletonModel.invoke({ request, context }));
    const primaryGoal = request.goals.find((goal) => goal.priority === "A") ?? request.goals[0]!;
    if (
      plan.goal.race_name !== primaryGoal.race_name
      || plan.goal.location !== primaryGoal.location
      || plan.goal.distance !== primaryGoal.distance
      || plan.goal.race_date !== primaryGoal.race_date
      || plan.goal.target_time !== (primaryGoal.target_time ?? "finish_only")
    ) {
      throw new Error("candidate plan does not match confirmed primary goal");
    }

    return {
      outcome: MasterPlanGraphOutcome.parse({
        decision: "completed",
        request_id: request.request_id,
        generation_id: context.generationId,
        artifact: {
          type: "master_plan_draft",
          activation_status: "inactive",
          plan,
        },
      }),
    };
  };

  return new StateGraph({
    state: GraphState,
    input: GraphInput,
    output: GraphOutput,
    context: MasterPlanGraphContext,
  })
    .addNode("run_planning", runPlanning)
    .addEdge(START, "run_planning")
    .addEdge("run_planning", END)
    .compile();
}
