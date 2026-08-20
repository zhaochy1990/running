import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { RunningCalibration, StrideDataStore } from "../persistence/index.js";
import { defineCoachTools } from "./common.js";

const getRunningCalibrationSchema = z.object({});

class MySQLRunningCalibrationTool {
  constructor(private readonly store: StrideDataStore) {}

  async getRunningCalibration(_input: z.infer<typeof getRunningCalibrationSchema>, runtime: CoachToolRuntime): Promise<RunningCalibration | null> {
    const userId = runtime.context?.userId;
    const asof = runtime.context?.asof;
    if (!userId) {
      throw new Error("get_running_calibration: missing userId in runtime context");
    }
    if (!asof) {
      throw new Error("get_running_calibration: missing asof in runtime context");
    }
    return this.store.getLatestRunningCalibration(userId, asof);
  }
}

/** Build the canonical running-threshold and zone query tool. */
export function createRunningCalibrationTools(store: StrideDataStore): StructuredTool[] {
  const impl = new MySQLRunningCalibrationTool(store);
  return defineCoachTools([
    {
      name: "get_running_calibration",
      description:
        "获取运动员最新的 STRIDE 跑步校准数据：乳酸阈值心率、阈值速度，以及心率区间和配速区间。" +
        "制定或解释个性化训练强度前必须调用；返回 null 表示校准尚未计算，不能自行估算或假设。",
      schema: getRunningCalibrationSchema,
      handler: (input, runtime) => impl.getRunningCalibration(input, runtime),
    },
  ]);
}
