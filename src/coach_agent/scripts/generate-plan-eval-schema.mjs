import { writeFileSync } from "node:fs";
import { z } from "zod/v4";
import { MasterPlanGraphRequest } from "../../coach_contract/dist/master_plan/contracts.js";
import {
  AvailabilityDetailSchema,
  LoadPlanSchema,
  MasterPlanAnchorSchema,
  MasterPlanAvailabilitySchema,
  PhaseDivisionIntentSchema,
} from "../../coach_contract/dist/master_plan/policy.js";
import { MasterPlanLenientSchema } from "../../coach_contract/dist/master_plan/schemas.js";
import { RollingJobRequest } from "../../coach_contract/dist/weekly_plan/rolling.js";
import { RunnerSnapshotSchema } from "../dist/data/runnerSnapshot.js";

// Only the persisted fields consumed by fromStoredContent; policy bundles stay canonical.
const rollingMaster = z
  .object({
    start_date: z.iso.date(),
    total_weeks: z.int().positive(),
    goal: MasterPlanLenientSchema.shape.goal.omit({ timezone: true }).extend({ race_name: z.string().min(1), target_time: z.string().min(1) }),
    availability: AvailabilityDetailSchema.omit({ max_session_duration_min: true })
      .extend({ weekly_run_days_max: MasterPlanAvailabilitySchema.shape.weekly_run_days_max })
      .loose(),
    policy: PhaseDivisionIntentSchema,
    skeleton: LoadPlanSchema,
    anchor: MasterPlanAnchorSchema,
  })
  .passthrough();

// Import the canonical contracts, never maintain a parallel Go schema.
for (const [name, schema] of [
  ["runner-snapshot", RunnerSnapshotSchema],
  ["master-request", MasterPlanGraphRequest],
  ["rolling-request", RollingJobRequest],
  ["rolling-master", rollingMaster],
]) {
  writeFileSync(
    new URL(`../../go/internal/planeval/${name}.schema.json`, import.meta.url),
    `${JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2)}\n`,
  );
}
