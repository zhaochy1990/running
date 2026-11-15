import { createHash } from "node:crypto";
import { type DimensionId, dimensions, type Nature } from "./dimensions.js";
import { type Conclusion, type Profile, type Snapshot, validConclusions } from "./types.js";

export interface PriorEntry {
  id: string;
  conclusion: Conclusion;
  method: string;
  inputHash: string;
  evaluatedAt: string;
  valid: boolean;
}
export function loadHistory(profiles: Profile[], snapshot: Snapshot): PriorEntry[] {
  const result = new Map<string, PriorEntry>();
  for (const profile of profiles) {
    if (profile.userId !== snapshot.userId) throw new Error("Previous profile belongs to another user");
    const valid = new Set(validConclusions(profile, snapshot).map((c) => c.id));
    for (const c of profile.conclusions) {
      const id = c.id.startsWith("history:")
        ? c.id
        : `history:${createHash("sha256").update(`${profile.userId}:${profile.method}:${profile.inputHash}:${profile.evaluatedAt}:${c.id}`).digest("hex").slice(0, 18)}`;
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
        if (core(existing.conclusion) !== core(c) && !(Number.isFinite(oldTime) && Number.isFinite(newTime) && oldTime !== newTime))
          throw new Error(`Conflicting historical identity ${id} at the same publication time`);
        if (newTime < oldTime || (newTime === oldTime && existing.conclusion.metadata && !c.metadata)) continue;
      }
      result.set(id, { id, conclusion: c, method: profile.method, inputHash: profile.inputHash, evaluatedAt: profile.evaluatedAt, valid: valid.has(c.id) });
    }
  }
  return [...result.values()];
}

export function carryPrior(prior: PriorEntry, dimensionId: DimensionId, nature: Nature, reviewStatus: string): Conclusion {
  if (!prior.valid) throw new Error("A protected historical conclusion cannot be retained");
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
