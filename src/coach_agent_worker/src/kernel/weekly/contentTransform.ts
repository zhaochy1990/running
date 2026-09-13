import { type WeeklyPlan, WeeklyPlanSchema } from "@stride/contract";

/**
 * Adapt the kernel's `WeeklyPlan` output into the Go stored content_version=2
 * doc the draft-insert endpoint validates (`validateAppliedWeeklyPlan`): the
 * kernel already finalizes the canonical `weekly-plan/v1` document, so this is
 * a defensive re-parse boundary (mirroring the master transform) rather than a
 * shape change. Unlike the master plan, the weekly doc needs no id synthesis
 * or field hoisting — Go strips the `schema`/`week_name` metadata before
 * storage.
 */
export function weeklyPlanToDraftContent(weeklyPlan: WeeklyPlan): Record<string, unknown> {
  return WeeklyPlanSchema.parse(weeklyPlan);
}
