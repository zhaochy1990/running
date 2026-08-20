import assert from "node:assert/strict";
import test from "node:test";
import type { DataProvider } from "../data/dataProvider.js";
import { createActivitiesTools } from "./activities.js";
import { createTrainingLoadTools } from "./trainingLoad.js";

const userId = "athlete-1";
const provider = {
  async getActivitiesByDateRange() {
    return [];
  },
  async getDailyTrainingLoadByDateRange() {
    return [];
  },
} as unknown as DataProvider;

test("activity and load tools label STRIDE provenance", async () => {
  const [activityTool] = createActivitiesTools(provider);
  const [loadTool] = createTrainingLoadTools(provider);
  const config = { context: { userId, asof: "2026-08-14" } };
  assert.deepEqual(await activityTool?.invoke({ startDay: "2026-08-01" }, config), {
    activities: [],
    provenance: { source: "stride", vendor_derived: false },
  });
  assert.deepEqual(await loadTool?.invoke({ startDay: "2026-08-01" }, config), {
    available: false,
    stride_training_load: [],
    missing_reason: "stride_load_not_computed",
    provenance: { source: "stride", vendor_derived: false },
  });
});

test("load tool marks computed STRIDE PMC as available", async () => {
  const computedProvider = {
    async getDailyTrainingLoadByDateRange() {
      return [
        {
          date: "2026-08-01",
          trainingDose: 42,
          acuteLoad: 40,
          chronicLoad: 38,
          form: -2,
          loadRatio: 1.05,
          coverageStatus: "complete",
        },
      ];
    },
  } as unknown as DataProvider;
  const [loadTool] = createTrainingLoadTools(computedProvider);
  assert.deepEqual(await loadTool?.invoke({ startDay: "2026-08-01" }, { context: { userId, asof: "2026-08-14" } }), {
    available: true,
    stride_training_load: [
      {
        date: "2026-08-01",
        trainingDose: 42,
        acuteLoad: 40,
        chronicLoad: 38,
        form: -2,
        loadRatio: 1.05,
        coverageStatus: "complete",
      },
    ],
    provenance: { source: "stride", vendor_derived: false },
  });
});
