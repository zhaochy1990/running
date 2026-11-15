/** POC only. Input is an already captured, private, read-only source snapshot. */
import { z } from "zod/v4";
import { MetadataSchema } from "./dimensions.js";

export const SnapshotSchema = z
  .object({
    userId: z.string().min(1),
    startDay: z.iso.date(),
    endDay: z.iso.date(),
    capturedAt: z.iso.datetime({ offset: true }),
    coverage: z.record(z.string(), z.unknown()),
    evidence: z.array(
      z.object({
        id: z.string().min(1),
        revision: z.string().min(1),
        kind: z.string(),
        eventTime: z.string().nullable(),
        reportedAt: z.string().nullable(),
        active: z.boolean(),
        content: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .superRefine((s, ctx) => {
    if (s.startDay > s.endDay) ctx.addIssue({ code: "custom", message: "Reversed source window" });
    if (new Set(s.evidence.map((e) => e.id)).size !== s.evidence.length) ctx.addIssue({ code: "custom", message: "Duplicate source IDs" });
  });
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Evidence = Snapshot["evidence"][number];
export const Lifecycle = z.enum(["historical", "long_term", "rolling", "unknown"]);
export const ConclusionSchema = z.object({
  id: z.string(),
  kind: z.enum(["fact", "estimate", "user_report", "candidate", "insight"]),
  title: z.string(),
  text: z.string(),
  dimension: z.string(),
  lifecycle: Lifecycle,
  conditions: z.string(),
  limitations: z.array(z.string()),
  evidence: z.array(z.object({ id: z.string(), revision: z.string() })).min(1),
  sourceDates: z.array(z.string()),
  derivedFromFactIds: z.array(z.string()).optional(),
  planningUse: z.string().optional(),
  support: z.enum(["repeated_observation", "preliminary_association", "single_episode"]).optional(),
  hypothesisId: z.string().optional(),
  supportingReceiptIds: z.array(z.string()).optional(),
  counterexampleReceiptIds: z.array(z.string()).optional(),
  metadata: MetadataSchema.optional(),
  values: z.unknown().optional(),
});
export type Conclusion = z.infer<typeof ConclusionSchema>;
export const ProfileSchema = z.object({
  prototype: z.literal(true),
  userId: z.string(),
  inputHash: z.string(),
  evaluatedAt: z.string(),
  window: z.object({ startDay: z.string(), endDay: z.string() }),
  method: z.string(),
  conclusions: z.array(ConclusionSchema),
  unknowns: z.array(z.string()),
  change: z.object({ previousInputHash: z.string().nullable(), removedConclusionIds: z.array(z.string()), reason: z.string() }),
  previousDecisions: z.array(z.object({ id: z.string(), action: z.string(), reason: z.string(), replacementId: z.string().nullable() })).optional(),
  highlights: z.array(z.string()).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const refs = (rows: Evidence[]) => rows.map(({ id, revision }) => ({ id, revision }));
export const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function validConclusions(profile: Profile, snapshot: Snapshot): Conclusion[] {
  const sources = new Map(snapshot.evidence.filter((e) => e.active).map((e) => [e.id, e.revision]));
  return profile.conclusions.filter((c) => c.evidence.every((r) => sources.get(r.id) === r.revision));
}
