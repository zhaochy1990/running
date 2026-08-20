import { writeFileSync } from "node:fs";
import { z } from "zod/v4";
import { WeeklyPlanSchema } from "../dist/weekly_plan/schema.js";

const generated = z.toJSONSchema(WeeklyPlanSchema);
const schema = {
	$schema: generated.$schema,
	$id: "https://stride-running.cn/schemas/weekly-plan-v1.json",
	...Object.fromEntries(
		Object.entries(generated).filter(([key]) => key !== "$schema"),
	),
};

writeFileSync(
	new URL("../../go/internal/api/weekly_plan_schema.json", import.meta.url),
	`${JSON.stringify(schema, null, 2)}\n`,
);
