import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider, RunningCalibration } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getRunningCalibrationSchema = z.object({});

/**
 * Model-facing view: the raw `thresholdSpeedMps` is dropped and replaced by the
 * same threshold as a pace, the unit every other field here (and every zone
 * bound) already uses. The core type keeps m/s because the load estimators
 * multiply by it.
 */
type RunningCalibrationView = Omit<RunningCalibration, "thresholdSpeedMps"> & { thresholdPaceSPerKm: number | null };

class RunningCalibrationToolImpl {
  constructor(private readonly store: DataProvider) {}

  async getRunningCalibration(_input: z.infer<typeof getRunningCalibrationSchema>, runtime: CoachToolRuntime): Promise<RunningCalibrationView | null> {
    const userId = runtime.context?.userId;
    const asof = runtime.context?.asof;
    if (!userId) {
      throw new Error("get_running_calibration: missing userId in runtime context");
    }
    if (!asof) {
      throw new Error("get_running_calibration: missing asof in runtime context");
    }
    const calibration = await this.store.getLatestRunningCalibration(userId, asof);
    if (calibration === null) return null;
    const { thresholdSpeedMps, ...rest } = calibration;
    return {
      ...rest,
      thresholdPaceSPerKm: toPaceSPerKm(thresholdSpeedMps),
    };
  }
}

/** Threshold pace in s/km, derived here so the caller never inverts m/s itself. */
function toPaceSPerKm(speedMps: number | null): number | null {
  return speedMps !== null && speedMps > 0 ? Math.round(1000 / speedMps) : null;
}

/** Build the canonical running-threshold and zone query tool. */
export function createRunningCalibrationTools(store: DataProvider): StructuredTool[] {
  const impl = new RunningCalibrationToolImpl(store);
  return defineCoachTools([
    {
      name: "get_running_calibration",
      description:
        "获取运动员最新的 STRIDE 跑步校准数据：乳酸阈值心率、乳酸阈值配速（thresholdPaceSPerKm，秒/公里），以及心率区间和配速区间。" +
        "返回 null 表示校准尚未计算，不能自行估算或假设。",
      schema: getRunningCalibrationSchema,
      handler: (input, runtime) => impl.getRunningCalibration(input, runtime),
    },
  ]);
}
