import { z } from "zod/v4";

export type RuleSeverity = "error" | "warning";
export const RuleViolationSchema = z
  .object({
    rule_id: z.string(),
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    evidence: z.record(z.string(), z.unknown()),
    suggested_fix: z.string(),
  })
  .strict();
export const RuleReportSchema = z
  .object({
    authority: z.literal("typescript-master-plan-rule-filter-v1"),
    checked_rule_ids: z.array(z.string()),
    violations: z.array(RuleViolationSchema),
    has_errors: z.boolean(),
  })
  .strict();
export type RuleViolation = z.infer<typeof RuleViolationSchema>;
export type RuleReport = z.infer<typeof RuleReportSchema>;
