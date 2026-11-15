/** Fixed POC measurements reuse the existing, tested summary/comparison methods. */
import { addDays } from "@stride/contract";
import { buildComparisons } from "./comparisons.js";
import { type DimensionId, dimensions, type Nature } from "./dimensions.js";
import { describeSnapshot } from "./facts.js";
import { activityHabits } from "./measurements.js";
import { type Conclusion, ConclusionSchema, type Evidence, refs, runningEvidence, type Snapshot } from "./types.js";

export function sourceTypesFor(rows: Evidence[], quoted = false) {
  const labels: Record<string, string> = {
    activity: "activity_record",
    recovery: "health_record",
    load: "existing_load",
    calibration: "existing_calibration",
    user_report: "legacy_retrospective",
  };
  return [...new Set([...rows.map((e) => labels[e.kind] ?? e.kind), ...(quoted ? ["user_statement"] : [])])];
}
const routes: Record<string, DimensionId> = {
  "recorded-structure": "background",
  "recent-volume": "training",
  "recorded-timing": "preferences",
  "long-exposure": "ability",
  "latest-run": "ability",
  "current-load": "recovery",
  "recent-measurements": "recovery",
  "weekly-recorded-history": "background",
  "comparison-week-structure": "training",
  "comparison-load-concentration": "training",
  "comparison-long-run-execution": "ability",
  "comparison-weather": "response",
  "comparison-race-training": "fueling",
};

export function buildDeterministic(snapshot: Snapshot) {
  const facts = describeSnapshot(snapshot),
    comparisons = buildComparisons(snapshot);
  const sources = new Map(snapshot.evidence.filter((e) => e.active).map((e) => [e.id, e]));
  const entries: Conclusion[] = [...facts.conclusions.filter((c) => c.kind !== "user_report"), ...comparisons.observations].map((c) => {
    const quoted = c.kind === "user_report";
    const dimensionId = routes[c.id] ?? (c.id.startsWith("calibration-") ? "ability" : c.id.startsWith("event-") || quoted ? "fueling" : "training");
    const rows = c.evidence.flatMap((r) => {
      const e = sources.get(r.id);
      return e ? [e] : [];
    });
    const nature: Nature = quoted
      ? "subjective"
      : c.kind === "estimate"
        ? "estimate"
        : c.id.startsWith("comparison-") || c.id === "recorded-timing"
          ? "observation"
          : "fact";
    return ConclusionSchema.parse({
      ...c,
      id: `code:${c.id}`,
      dimension: dimensions[dimensionId],
      values: "measurements" in c ? c.measurements : null,
      metadata: {
        dimensionId,
        nature,
        sourceTypes: sourceTypesFor(rows, quoted),
        formation: quoted || c.kind === "estimate" || c.id === "current-load" ? "direct" : "fixed_calculation",
        methodId: `file-poc-fixed-v2:${c.id}`,
        computation: quoted || c.kind === "estimate" || c.id === "current-load" ? "none" : "predefined",
        supportingSources: c.evidence,
        quotes: quoted ? rows.map((e) => ({ sourceId: e.id, text: String(e.content.feelNote) })) : [],
        producer: "code",
      },
    });
  });
  const strength = snapshot.evidence.filter((e) => e.active && e.kind === "activity" && e.content.sport === "strength");
  if (strength.length) {
    const blocks = Array.from(
      { length: Math.min(6, Math.floor((Date.parse(snapshot.endDay) - Date.parse(snapshot.startDay) + 86400000) / (28 * 86400000))) },
      (_, i) => {
        const end = addDays(snapshot.endDay, -28 * i),
          start = addDays(end, -27);
        const rows = strength.filter((e) => String(e.content.shanghaiDay) >= start && String(e.content.shanghaiDay) <= end);
        return { start, end, records: rows.length, trainingDays: new Set(rows.map((e) => e.content.shanghaiDay)).size };
      },
    ).reverse();
    if (blocks.length)
      entries.push({
        id: "code:strength-regularity",
        kind: "fact",
        title: "力量训练的实际执行频率",
        dimension: dimensions.training,
        lifecycle: "rolling",
        text: `由早到晚的28天区间，记录力量训练日分别为 ${blocks.map((b) => `${b.start}—${b.end}：${b.trainingDays}天（${b.records}条）`).join("；")}。`,
        conditions: "只统计窗口完整覆盖的28天区间；同日多条记录只计一个训练日。",
        limitations: ["记录缺口不等于现实中停练；频率不能用于估计肌肉力量。"],
        evidence: refs(strength),
        sourceDates: [...new Set(strength.map((e) => String(e.content.shanghaiDay)))].sort(),
        values: blocks,
        metadata: {
          dimensionId: "training",
          nature: "observation",
          sourceTypes: ["activity_record"],
          formation: "fixed_calculation",
          methodId: "strength-days-28d-v1",
          computation: "predefined",
          supportingSources: refs(strength),
          quotes: [],
          producer: "code",
        },
      });
  }
  const runs = runningEvidence(snapshot);
  if (runs.length) {
    const h = activityHabits(snapshot);
    entries.push({
      id: "code:execution-habits",
      kind: "fact",
      title: "时段分布与同日记录间隔",
      dimension: dimensions.preferences,
      lifecycle: "rolling",
      text: `${h.runs}条跑步分布于${h.runDays}天，其中${h.multipleRecordDays}天有多条记录。${h.pairs}对同日相邻记录的估算间隔中位${h.medianGapMinutes?.toFixed(1)}分钟，${h.gapUnder30Minutes}对不足30分钟；两段均≥2km且相隔≥3小时的有${h.separated2kmPairs.length}对。${h.cities
        .filter((c) => c.label !== "unknown_label")
        .map((c) => `${c.label}标签${c.records}条中，04–09时${c.morning4to10}条、18时后${c.evening18plus}条`)
        .join("；")}。`,
      conditions: "按记录时长估算结束时间；时间邻近只是疑似拆段线索。城市文字是标签，时段是行为而非本人偏好。",
      limitations: [],
      evidence: refs(runs),
      sourceDates: [...new Set(runs.map((e) => String(e.content.shanghaiDay)))].sort(),
      values: h,
      metadata: {
        dimensionId: "preferences",
        nature: "observation",
        sourceTypes: ["activity_record"],
        formation: "fixed_calculation",
        methodId: "execution-habits-unrounded-v1",
        computation: "predefined",
        supportingSources: refs(runs),
        quotes: [],
        producer: "code",
      },
    });
  }
  return { entries, facts: facts.context, diagnostics: comparisons.diagnostics };
}

/** Model-facing views omit conservative full-input dependencies, never actual measurements. */
export function briefEntry(c: Conclusion) {
  const { evidence, sourceDates, ...rest } = c;
  return {
    ...rest,
    metadata: c.metadata
      ? { ...c.metadata, supportingSources: c.metadata.supportingSources.slice(0, 12), supportingSourceCount: c.metadata.supportingSources.length }
      : undefined,
    dependencySourceCount: evidence.length,
    sourceWindow: [sourceDates[0] ?? null, sourceDates.at(-1) ?? null],
  };
}
