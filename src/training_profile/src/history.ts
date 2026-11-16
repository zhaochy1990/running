import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import { type DimensionId, dimensions, type Nature } from "./dimensions.js";
import { type Conclusion, ConclusionSchema, type Profile, type Snapshot, validConclusions } from "./types.js";

export interface PriorEntry {
  id: string;
  conclusion: Conclusion | null;
  method: string;
  inputHash: string;
  evaluatedAt: string;
  valid: boolean;
  inactiveReason?: string;
  disposition?: { action: string; reason: string; replacementId: string | null };
}
export function activePrior(p: PriorEntry): p is PriorEntry & { conclusion: Conclusion } {
  return p.valid && p.conclusion !== null;
}

/** A partial re-review must use exactly the historical input of its source run. */
export function assertSameReviewHistory(input: unknown, current: PriorEntry[]) {
  const saved = z
    .object({ history: z.array(z.object({ id: z.string(), valid: z.boolean(), method: z.string(), conclusion: ConclusionSchema.nullable().optional() })) })
    .parse(input).history;
  const canonical = (rows: typeof saved) =>
    rows
      .map((p) => ({ id: p.id, valid: p.valid, method: p.method, conclusion: p.valid && p.conclusion ? ConclusionSchema.parse(p.conclusion) : null }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  if (new Set(saved.map((p) => p.id)).size !== saved.length || !isDeepStrictEqual(canonical(saved), canonical(current)))
    throw new Error("Review reuse requires the same complete historical inputs; repeat the original previous-profile arguments");
}
export function loadHistory(profiles: Profile[], snapshot: Snapshot): PriorEntry[] {
  const result = new Map<string, PriorEntry>();
  const terminal = new Map<string, { time: number; action: string; reason: string; replacementId: string | null }>();
  if (profiles.some((p) => !Number.isFinite(Date.parse(p.evaluatedAt)))) throw new Error("Historical publication time must be known");
  for (const profile of profiles.toSorted((a, b) => Date.parse(a.evaluatedAt) - Date.parse(b.evaluatedAt))) {
    if (profile.userId !== snapshot.userId) throw new Error("Previous profile belongs to another user");
    const valid = new Set(validConclusions(profile, snapshot).map((c) => c.id));
    const time = Date.parse(profile.evaluatedAt),
      localIds = new Map<string, string>();
    const updates = new Set((profile.previousDecisions ?? []).filter((d) => d.action === "update").map((d) => d.id));
    for (const c of profile.conclusions) {
      const id = c.id.startsWith("history:")
        ? c.id
        : `history:${createHash("sha256").update(`${profile.userId}:${profile.method}:${profile.inputHash}:${profile.evaluatedAt}:${c.id}`).digest("hex").slice(0, 18)}`;
      localIds.set(c.id, id);
      const stopped = terminal.get(id);
      if (stopped) {
        if (stopped.time === time) throw new Error(`Conflicting historical disposition ${id} at the same publication time`);
        if (!updates.has(id)) continue;
        terminal.delete(id);
      }
      const existing = result.get(id);
      if (existing) {
        const core = (entry: Conclusion) =>
          JSON.stringify({
            title: entry.title,
            text: entry.text,
            conditions: entry.conditions,
            limitations: entry.limitations,
            support: entry.support,
            evidence: entry.evidence,
          });
        const oldTime = Date.parse(existing.evaluatedAt),
          newTime = Date.parse(profile.evaluatedAt);
        if (existing.conclusion && core(existing.conclusion) !== core(c) && !(Number.isFinite(oldTime) && Number.isFinite(newTime) && oldTime !== newTime))
          throw new Error(`Conflicting historical identity ${id} at the same publication time`);
        if (newTime < oldTime || (newTime === oldTime && existing.conclusion?.metadata && !c.metadata)) continue;
      }
      result.set(id, { id, conclusion: c, method: profile.method, inputHash: profile.inputHash, evaluatedAt: profile.evaluatedAt, valid: valid.has(c.id) });
    }
    for (const d of profile.previousDecisions ?? []) {
      if (!["withdraw", "blocked", "merge"].includes(d.action)) continue;
      const id = localIds.get(d.id) ?? d.id,
        existing = result.get(id),
        old = terminal.get(id);
      const replacementId = d.replacementId ? (localIds.get(d.replacementId) ?? d.replacementId) : null;
      if (profile.conclusions.some((c) => c.id === d.id) || (existing?.conclusion && Date.parse(existing.evaluatedAt) === time))
        throw new Error(`Conflicting historical disposition ${id} at the same publication time`);
      if (old?.time === time && (old.action !== d.action || old.replacementId !== replacementId))
        throw new Error(`Conflicting historical disposition ${id} at the same publication time`);
      terminal.set(id, { time, action: d.action, reason: d.reason, replacementId });
      if (!existing)
        result.set(id, { id, conclusion: null, method: profile.method, inputHash: profile.inputHash, evaluatedAt: profile.evaluatedAt, valid: false });
    }
  }
  return [...result.values()].map((p) => {
    const d = terminal.get(p.id);
    const reason = p.valid && p.conclusion ? d?.reason : "Historical disposition retained; source text/details unavailable or invalid";
    return d
      ? {
          ...p,
          valid: false,
          inactiveReason: reason ?? "Historical disposition retained",
          disposition: { action: d.action, reason: reason ?? "Historical disposition retained", replacementId: d.replacementId },
        }
      : p;
  });
}

export function carryPrior(prior: PriorEntry, dimensionId: DimensionId, nature: Nature, reviewStatus: string): Conclusion {
  if (!activePrior(prior)) throw new Error("A protected historical conclusion cannot be retained");
  const c = prior.conclusion;
  if (["preference", "goal", "constraint", "subjective"].includes(nature) && !c.metadata?.quotes.length)
    throw new Error("Cannot relabel an old observation as an explicit user statement without a quote");
  return {
    ...c,
    id: prior.id,
    dimension: dimensions[dimensionId],
    metadata: {
      dimensionId,
      nature,
      sourceTypes: c.metadata?.sourceTypes ?? ["historical_profile"],
      formation: c.metadata?.formation ?? "agent_exploration",
      methodId: c.metadata?.methodId ?? prior.method,
      computation: c.metadata?.computation ?? "legacy",
      supportingSources: c.metadata?.supportingSources ?? c.evidence,
      quotes: c.metadata?.quotes ?? [],
      producer: c.metadata?.producer ?? "prior-reviewed-profile",
      reviewStatus,
    },
  };
}
