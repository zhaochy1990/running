import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { ProfileAgentSession } from "./agentSession.js";
import { briefEntry } from "./deterministic.js";
import { DimensionId, Nature } from "./dimensions.js";
import type { Explorations } from "./exploration.js";
import { carryPrior, type PriorEntry } from "./history.js";
import type { Conclusion, Profile, Snapshot } from "./types.js";

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
  candidates: z.array(z.object({ id: z.string(), include: z.boolean(), reason: z.string().min(5) })),
  highlights: z.array(z.string()).max(10),
  summary: z.string(),
});
function sameSet(actual: string[], expected: string[], label: string) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some((id) => !actual.includes(id)))
    throw new Error(`Account for every ${label} exactly once`);
}

/** The master selects/reconciles immutable entries, rather than rewriting computed values. */
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
      if (!prior.valid)
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
    const prior = this.history.filter((p) => p.valid),
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
    const entries = new Map<string, Conclusion>(
      [...this.computed, ...candidates.filter((c) => review.candidates.some((d) => d.id === c.id && d.include))].map((c) => [c.id, c]),
    );
    const includedChildren = new Map(candidates.filter((c) => review.candidates.some((d) => d.id === c.id && d.include)).map((c) => [c.id, c]));
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
