import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { ProfileAgentSession } from "./agentSession.js";
import { briefEntry, sourceTypesFor } from "./deterministic.js";
import { DimensionId, dimensions, Nature } from "./dimensions.js";
import type { Explorations } from "./exploration.js";
import { activePrior, carryPrior, type PriorEntry } from "./history.js";
import { type Conclusion, type Profile, refs, type Snapshot } from "./types.js";

export const ReviewSchema = z.object({
  prior: z.array(
    z.object({
      id: z.string(),
      action: z.enum(["retain", "pending_review", "update", "merge", "withdraw"]),
      dimensionId: DimensionId,
      nature: Nature,
      replacementId: z.string().nullable(),
      reason: z.string().min(8),
      validationReceiptId: z.string().nullable(),
    }),
  ),
  candidates: z.array(
    z.object({
      id: z.string(),
      include: z.boolean(),
      reason: z.string().min(5),
      correction: z
        .object({
          title: z.string(),
          text: z.string().max(1000),
          planningUse: z.string(),
          conditions: z.string(),
          limitations: z.array(z.string()).max(3),
          dimensionId: DimensionId,
          sourceIds: z.array(z.string()).min(1).max(40),
          validationReceiptIds: z.array(z.string()).min(1),
        })
        .optional(),
    }),
  ),
  highlights: z.array(z.string()).max(10),
  summary: z.string(),
});
function sameSet(actual: string[], expected: string[], label: string) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some((id) => !actual.includes(id)))
    throw new Error(`Account for every ${label} exactly once`);
}

/** Fixed entries stay immutable; candidate corrections retain their validation dependencies. */
export class ProfileAssembly {
  profile: Profile | null = null;
  readonly inspected = new Set<string>();
  constructor(
    readonly snapshot: Snapshot,
    readonly computed: Conclusion[],
    readonly history: PriorEntry[],
    readonly workers: Explorations,
    readonly validation: ProfileAgentSession,
  ) {}

  inspect(id: string) {
    const prior = this.history.find((p) => p.id === id);
    if (prior) {
      if (!activePrior(prior))
        return { id, protected: true, reason: prior.inactiveReason ?? "Underlying source was withdrawn or revised; historical text is not exposed" };
      this.inspected.add(id);
      return { ...briefEntry(prior.conclusion), id, priorMethod: prior.method };
    }
    const c = [...this.computed, ...this.workers.entries()].find((c) => c.id === id);
    if (!c) throw new Error("Unknown entry");
    this.inspected.add(id);
    return briefEntry(c);
  }

  submit(review: z.infer<typeof ReviewSchema>) {
    if (this.profile) throw new Error("Master already submitted");
    if (!this.workers.ready()) throw new Error("Complete or explicitly fail all planned dimension explorations before assembly");
    const prior = this.history.filter(activePrior),
      candidates = this.workers.entries();
    sameSet(
      review.prior.map((d) => d.id),
      prior.map((p) => p.id),
      "valid historical entry",
    );
    sameSet(
      review.candidates.map((d) => d.id),
      candidates.map((c) => c.id),
      "child candidate",
    );
    if (prior.some((p) => !this.inspected.has(p.id))) throw new Error("Inspect every historical entry before deciding its disposition");
    if (![...this.validation.receipts.values()].some((r) => r.code && r.purpose === "validation"))
      throw new Error("Master must run at least one independent validation calculation");
    if (review.candidates.some((d) => !d.include && d.correction)) throw new Error("Only included candidates can have corrections");
    const selected = candidates
      .filter((c) => review.candidates.some((d) => d.id === c.id && d.include))
      .map((c) => {
        const correction = review.candidates.find((d) => d.id === c.id)?.correction;
        if (!correction) return c;
        if (!c.metadata) throw new Error("Correction needs original candidate metadata");
        if (correction.validationReceiptIds.some((id) => this.validation.receipts.get(id)?.purpose !== "validation" || !this.validation.receipts.get(id)?.code))
          throw new Error("Every master correction needs successful validation receipts");
        const { validationReceiptIds, dimensionId, sourceIds, ...text } = correction;
        const rows = [...new Set([...sourceIds, ...c.metadata.quotes.map((q) => q.sourceId)])].map((id) => {
          const e = this.snapshot.evidence.find((e) => e.id === id && e.active);
          if (!e) throw new Error("Correction needs active actual source references");
          return e;
        });
        const validationSources = correction.validationReceiptIds.flatMap((id) => this.validation.receipts.get(id)?.sourceIds ?? []);
        const dependencies = [...new Set(validationSources)].map((id) => {
          const e = this.snapshot.evidence.find((e) => e.id === id && e.active);
          if (!e) throw new Error("Correction validation depends on an unavailable source");
          return e;
        });
        const evidence = [...new Map([...c.evidence, ...refs(rows), ...refs(dependencies)].map((r) => [r.id, r])).values()];
        return {
          ...c,
          ...text,
          evidence,
          dimension: dimensions[dimensionId],
          metadata: {
            ...c.metadata,
            dimensionId,
            sourceTypes: sourceTypesFor(rows, c.metadata.quotes.length > 0),
            supportingSources: refs(rows),
            producer: "master",
            computation: "agent_authored" as const,
            methodId: "master-verified-correction-v1",
            reviewStatus: "master_corrected",
            masterReview: { originalCandidateId: c.id, validationReceiptIds },
          },
        };
      });
    const entries = new Map<string, Conclusion>([...this.computed, ...selected].map((c) => [c.id, c]));
    const includedChildren = new Map(selected.map((c) => [c.id, c]));
    const aliases = new Map<string, string>();
    for (const decision of review.prior) {
      const p = prior.find((p) => p.id === decision.id);
      if (!p) throw new Error("Unknown history");
      if (
        decision.action !== "update" &&
        p.conclusion.metadata &&
        (p.conclusion.metadata.dimensionId !== decision.dimensionId || p.conclusion.metadata.nature !== decision.nature)
      )
        throw new Error("Existing historical dimension/nature cannot change without an explicit verified update");
      if (p.conclusion.support === "preliminary_association" && !["association", "observation"].includes(decision.nature))
        throw new Error("A preliminary historical association cannot be relabelled as an objective fact or user preference");
      if (["retain", "pending_review"].includes(decision.action)) {
        if (decision.replacementId) throw new Error("Retained history cannot also have a replacement");
        entries.set(p.id, carryPrior(p, decision.dimensionId, decision.nature, decision.action));
      } else if (decision.action === "update" || decision.action === "withdraw") {
        const validation = this.validation.receipts.get(decision.validationReceiptId ?? "");
        if (validation?.purpose !== "validation" || !validation.code) throw new Error("Updating/withdrawing prior knowledge needs a master validation receipt");
        if (decision.action === "update") {
          const replacement = includedChildren.get(decision.replacementId ?? "");
          if (
            !replacement ||
            replacement.metadata?.producer === "code" ||
            replacement.metadata?.dimensionId !== decision.dimensionId ||
            replacement.metadata.nature !== decision.nature
          )
            throw new Error("Update needs an included child candidate with the chosen dimension and nature");
          entries.delete(replacement.id);
          includedChildren.delete(replacement.id);
          aliases.set(replacement.id, p.id);
          entries.set(p.id, { ...replacement, id: p.id, metadata: { ...replacement.metadata, reviewStatus: "updated" } });
        } else if (decision.replacementId) throw new Error("Withdrawal is not a replacement");
      }
    }
    for (const decision of review.prior.filter((d) => d.action === "merge")) {
      const verification = this.validation.receipts.get(decision.validationReceiptId ?? "");
      if (verification?.purpose !== "validation" || !verification.code) throw new Error("Merging historical knowledge needs a master validation receipt");
      const targetId = aliases.get(decision.replacementId ?? "") ?? decision.replacementId;
      const target = targetId ? entries.get(targetId) : null;
      if (!target || target.id === decision.id || target.metadata?.dimensionId !== decision.dimensionId || target.metadata.nature !== decision.nature)
        throw new Error("Merge must point to a retained entry of the same dimension and nature");
      aliases.set(decision.id, target.id);
    }
    if (review.prior.some((d) => ["retain", "pending_review"].includes(d.action) && !entries.has(d.id)))
      throw new Error("Every retained/pending historical entry must survive final assembly");
    const highlights = [...new Set(review.highlights.map((id) => aliases.get(id) ?? id))];
    if (highlights.some((id) => !entries.has(id))) throw new Error("Highlights can only reference retained entries");
    const decisions = [
      ...review.prior.map((d) => ({
        id: d.id,
        action: d.action,
        reason: d.reason,
        replacementId: d.replacementId ? (aliases.get(d.replacementId) ?? d.replacementId) : null,
      })),
      ...this.history
        .filter((p) => !p.valid)
        .map((p) => ({
          id: p.id,
          action: p.disposition?.action ?? "blocked",
          reason: p.inactiveReason ?? "Underlying source revision or active state no longer matches",
          replacementId: p.disposition?.replacementId ?? null,
        })),
    ];
    this.profile = {
      prototype: true,
      userId: this.snapshot.userId,
      inputHash: createHash("sha256").update(JSON.stringify(this.snapshot)).digest("hex"),
      evaluatedAt: new Date().toISOString(),
      window: { startDay: this.snapshot.startDay, endDay: this.snapshot.endDay },
      method: "ten-dimension-hybrid-v2:fixed-code+Flash-subagents+master-review",
      conclusions: [...entries.values()],
      unknowns: [],
      highlights,
      previousDecisions: decisions,
      change: {
        previousInputHash: this.history[0]?.inputHash ?? null,
        removedConclusionIds: decisions.filter((d) => ["withdraw", "blocked"].includes(d.action)).map((d) => d.id),
        reason: review.summary,
      },
    };
    return { accepted: true, entries: entries.size, historicalDecisions: decisions.length, highlights: highlights.length };
  }
}
