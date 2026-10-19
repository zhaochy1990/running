import { writeFileSync } from "node:fs";
import { z } from "zod/v4";
import { WeeklyPlanSchema } from "../dist/weekly_plan/schema.js";
import { RunWorkoutLenientSchema, RunWorkoutSchema, StrengthWorkoutSchema } from "../dist/workout/schema.js";

// 全部对外契约 schema 的唯一生成入口：写入 Go api 包，由 verify 脚本防漂移。
// lenient 层供 Go 落库 seam 校验 LLM 直出的 workout_structure（master plan 深校验用）。
const outputs = [
  ["https://stride-running.cn/schemas/weekly-plan-v1.json", WeeklyPlanSchema, "weekly_plan_schema.json"],
  ["https://stride-running.cn/schemas/run-workout-v1.json", RunWorkoutSchema, "run-workout.schema.json"],
  ["https://stride-running.cn/schemas/run-workout-v1-lenient.json", RunWorkoutLenientSchema, "run-workout.lenient.schema.json", { io: "input" }],
  ["https://stride-running.cn/schemas/strength-workout-v1.json", StrengthWorkoutSchema, "strength-workout.schema.json"],
];

for (const [$id, schema, file, opts] of outputs) {
  const generated = z.toJSONSchema(schema, opts);
  const document = {
    $schema: generated.$schema,
    $id,
    ...Object.fromEntries(Object.entries(generated).filter(([key]) => key !== "$schema")),
  };
  writeFileSync(new URL(`../../go/internal/api/${file}`, import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
}
