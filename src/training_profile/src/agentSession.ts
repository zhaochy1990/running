/** Per-run working state. Hypotheses, receipts and revisions live here, not in a prompt. */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { calculateSnapshot } from "./calculations.js";
import { sourceTypesFor } from "./deterministic.js";
import { DimensionId, dimensions, Nature } from "./dimensions.js";
import { Lifecycle, type Profile, refs, type Snapshot, validConclusions } from "./types.js";

export const HypothesisSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(5),
  refutationPlan: z.string().min(8),
  status: z.enum(["proposed", "testing", "retained", "qualified", "rejected"]),
  supportReceipts: z.array(z.string()),
  challengeReceipts: z.array(z.string()),
  revisionNote: z.string(),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export const CalculationSchema = z.object({
  hypothesisId: z.string().nullable(),
  purpose: z.enum(["exploration", "support", "counterexample", "validation"]),
  question: z.string().min(5),
  code: z.string().min(5),
});
export const SubmissionSchema = z.object({
  insights: z
    .array(
      z.object({
        hypothesisId: z.string().nullable(),
        title: z.string(),
        kind: z.enum(["fact", "estimate", "user_report", "insight"]),
        dimensionId: DimensionId,
        nature: Nature,
        sourceIds: z.array(z.string()).min(1).max(30),
        quotes: z.array(z.object({ sourceId: z.string(), text: z.string().min(1) })),
        text: z.string().max(650),
        dimension: z.string(),
        lifecycle: Lifecycle,
        planningUse: z.string().min(12),
        support: z.enum(["repeated_observation", "preliminary_association", "single_episode"]),
        conditions: z.string(),
        limitations: z.array(z.string()).max(3),
      }),
    )
    .max(10),
  summary: z.string(),
});
interface Receipt {
  id: string;
  hypothesisId: string | null;
  purpose: string;
  question: string;
  sourceIds: string[];
  result: unknown;
  code?: string;
  reusedFrom?: string;
  inputRead?: boolean;
}

export class ProfileAgentSession {
  readonly receipts = new Map<string, Receipt>();
  readonly hypotheses = new Map<string, Hypothesis>();
  readonly revisions: Hypothesis[] = [];
  submitted: Profile | null = null;
  executedCalculations = 0;
  fixedEvidenceUses = 0;
  reusedCalculations = 0;
  private serial = 0;
  constructor(
    readonly snapshot: Snapshot,
    private readonly record: (event: unknown) => Promise<void>,
    readonly agentId = "explorer",
    readonly allowedDimensions: readonly DimensionId[] = DimensionId.options,
  ) {}

  async receipt(input: Omit<Receipt, "id">) {
    const receipt = { ...input, id: `evidence-${++this.serial}` };
    this.receipts.set(receipt.id, receipt);
    await this.record({ type: "tool_result", ...receipt });
    // Full dependencies stay in the local journal, outside the model context.
    return { receiptId: receipt.id, result: receipt.result, dependencySourceCount: receipt.sourceIds.length };
  }

  async toolError(tool: string, input: unknown, error: string) {
    await this.record({ type: "tool_error", tool, input, error });
  }

  restoreWorkingState(previous: ProfileAgentSession) {
    if (JSON.stringify(previous.snapshot) !== JSON.stringify(this.snapshot)) throw new Error("Cannot reuse calculations across different snapshots");
    for (const [id, r] of previous.receipts) this.receipts.set(id, structuredClone(r));
    for (const [id, h] of previous.hypotheses) this.hypotheses.set(id, structuredClone(h));
    this.revisions.push(...structuredClone(previous.revisions));
    this.serial = previous.serial;
  }

  async reuseCalculation(receiptId: string, hypothesisId: string, purpose: "support" | "counterexample") {
    const original = this.receipts.get(receiptId);
    if (!this.hypotheses.has(hypothesisId) || !original?.code || !original.sourceIds.length || !original.inputRead)
      throw new Error("Reuse needs an existing hypothesis and a successful calculation that read input");
    this.reusedCalculations++;
    return this.receipt({ ...original, hypothesisId, purpose, reusedFrom: receiptId });
  }

  catalog() {
    const rows = this.snapshot.evidence.filter((e) => e.active);
    return {
      window: { start: this.snapshot.startDay, end: this.snapshot.endDay },
      datasets: [...new Set(rows.map((e) => e.kind))].map((kind) => {
        const group = rows.filter((e) => e.kind === kind);
        const keys = [...new Set(group.flatMap((e) => Object.keys(e.content)))];
        return {
          kind,
          count: group.length,
          fields: keys.map((field) => ({ field, nonNull: group.filter((e) => e.content[field] !== null && e.content[field] !== undefined).length })),
        };
      }),
      conventions:
        "activity.content.shanghaiDay是上海日；date是UTC瞬间。距离米、durationS秒、avgPaceSKm秒/公里。活动laps已由既有Provider选择canonical分段，不能混合重复分段族。calibration是已有估计；load是已有STRIDE计算。user_report旧周复盘混有教练客观分析，不能自动当本人原话；活动feelNote是本人原文。无记录不等于休息/无伤病，null不是0。标题可能是计划描述，实际数值以字段为准。",
    };
  }

  async read(kind: string, fields: string[], startDay: string | null, endDay: string | null, offset: number, limit: number) {
    if (
      (startDay || endDay) &&
      kind === "activity" &&
      this.snapshot.evidence.some((e) => e.active && e.kind === kind && typeof e.content.shanghaiDay !== "string")
    )
      throw new Error("Time-filtered activity reads require provider shanghaiDay; UTC date cannot substitute");
    const rows = this.snapshot.evidence.filter((e) => {
      if (!e.active || e.kind !== kind) return false;
      const date = String(e.kind === "activity" ? (e.content.shanghaiDay ?? "") : (e.content.date ?? e.content.as_of_date ?? e.content.weekStart ?? ""));
      return (!startDay || date >= startDay) && (!endDay || date <= endDay);
    });
    const selected = rows.slice(offset, offset + limit);
    return this.receipt({
      hypothesisId: null,
      purpose: "read",
      question: `Read ${kind} ${startDay ?? ""}..${endDay ?? ""} offset ${offset}`,
      sourceIds: rows.map((e) => e.id),
      result: {
        total: rows.length,
        offset,
        rows: selected.map((e) => ({
          id: e.id,
          revision: e.revision,
          content: Object.fromEntries(fields.filter((k) => k !== "laps").map((k) => [k, e.content[k] ?? null])),
        })),
      },
    });
  }

  async activity(sourceId: string) {
    const e = this.snapshot.evidence.find((e) => e.id === sourceId && e.kind === "activity" && e.active);
    if (!e) throw new Error("Active activity not found in this user's snapshot");
    return this.receipt({ hypothesisId: null, purpose: "detail", question: `Read activity ${sourceId}`, sourceIds: [sourceId], result: e });
  }

  async calculate(input: z.infer<typeof CalculationSchema>) {
    if (input.hypothesisId !== null && !this.hypotheses.has(input.hypothesisId)) throw new Error("Record the hypothesis before testing it");
    if (["support", "counterexample"].includes(input.purpose) && !input.hypothesisId) throw new Error("Support and counterexample checks need a hypothesisId");
    const calculated = await calculateSnapshot(this.snapshot, input.code);
    this.executedCalculations++;
    if (["support", "counterexample", "validation"].includes(input.purpose) && !calculated.readInput)
      throw new Error("Support and counterexample calculations must read the snapshot input");
    return this.receipt({
      hypothesisId: input.hypothesisId,
      purpose: input.purpose,
      question: input.question,
      code: input.code,
      inputRead: calculated.readInput,
      sourceIds: calculated.inspectedIds,
      result: calculated.result,
    });
  }

  async update(hypothesis: Hypothesis) {
    for (const id of [...hypothesis.supportReceipts, ...hypothesis.challengeReceipts]) {
      const receipt = this.receipts.get(id);
      if (!receipt || receipt.hypothesisId !== hypothesis.id) throw new Error(`Receipt ${id} was not a calculation for hypothesis ${hypothesis.id}`);
    }
    if (["retained", "qualified"].includes(hypothesis.status)) this.checkEvidence(hypothesis);
    this.hypotheses.set(hypothesis.id, structuredClone(hypothesis));
    this.revisions.push(structuredClone(hypothesis));
    await this.record({ type: "hypothesis", ...hypothesis });
    return { id: hypothesis.id, status: hypothesis.status, revision: this.revisions.filter((h) => h.id === hypothesis.id).length };
  }

  private checkEvidence(hypothesis: Hypothesis) {
    if (!hypothesis.supportReceipts.some((id) => this.receipts.get(id)?.purpose === "support"))
      throw new Error("A retained insight needs a successful support calculation");
    const challenges = hypothesis.challengeReceipts.map((id) => this.receipts.get(id));
    const supportCode = hypothesis.supportReceipts.map((id) => this.receipts.get(id)?.code);
    if (!challenges.some((r) => r?.purpose === "counterexample" && r.sourceIds.length > 0 && r.code && !supportCode.includes(r.code)))
      throw new Error("Run a separate counterexample calculation with different code before retaining the hypothesis");
  }

  submit(value: z.infer<typeof SubmissionSchema>, previous: Profile | null) {
    if (this.submitted) throw new Error("Already submitted");
    const active = new Map(this.snapshot.evidence.filter((e) => e.active).map((e) => [e.id, e]));
    const conclusions = value.insights.map((insight, i) => {
      if (!this.allowedDimensions.includes(insight.dimensionId)) throw new Error(`Dimension ${insight.dimensionId} is outside this agent's scope`);
      const h = insight.hypothesisId ? this.hypotheses.get(insight.hypothesisId) : null;
      if (insight.hypothesisId && (!h || !["retained", "qualified"].includes(h.status)))
        throw new Error(`Hypothesis ${insight.hypothesisId} is not retained/qualified`);
      if (h) this.checkEvidence(h);
      const selected = insight.sourceIds.map((id) => {
        const e = active.get(id);
        if (!e) throw new Error(`Inactive/unknown supporting source ${id}`);
        return e;
      });
      for (const quote of insight.quotes) {
        const e = active.get(quote.sourceId);
        const original = e?.kind === "activity" ? e.content.feelNote : e?.kind === "user_statement" ? e.content.text : null;
        if (!e || !insight.sourceIds.includes(e.id) || typeof original !== "string" || !original.includes(quote.text))
          throw new Error("Quotes must be literal text from an active user statement/feelNote, not retrospective coach analysis");
      }
      const extraction = ["preference", "goal", "constraint", "subjective"].includes(insight.nature);
      if (extraction && !insight.quotes.length) throw new Error("User preference, goal, constraint or feeling needs a literal attributed quote");
      if (!h && !insight.quotes.length) throw new Error("An untested extraction needs literal user quotes; inferred findings need a tested hypothesis");
      const receipts = h ? [...h.supportReceipts, ...h.challengeReceipts].map((id) => this.receipts.get(id)) : [];
      const sourceIds = [...new Set([...insight.sourceIds, ...receipts.flatMap((r) => r?.sourceIds ?? [])])];
      const rows = sourceIds.map((id) => {
        const e = active.get(id);
        if (!e) throw new Error(`Inactive/unknown source ${id}`);
        return e;
      });
      if (!rows.length) throw new Error("Insight lacks source evidence");
      const dates = rows
        .map((e) => String(e.kind === "activity" ? e.content.shanghaiDay : (e.content.date ?? e.content.as_of_date ?? e.content.weekStart ?? "")))
        .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
      return {
        id: `insight-${i + 1}`,
        kind: insight.kind,
        title: insight.title,
        text: insight.text,
        dimension: dimensions[insight.dimensionId],
        lifecycle: insight.lifecycle,
        planningUse: insight.planningUse,
        support: h ? insight.support : undefined,
        conditions: insight.conditions,
        limitations: insight.limitations,
        evidence: refs(rows),
        sourceDates: [...new Set(dates)].sort(),
        hypothesisId: h?.id,
        supportingReceiptIds: h?.supportReceipts ?? [],
        counterexampleReceiptIds: h?.challengeReceipts ?? [],
        metadata: {
          dimensionId: insight.dimensionId,
          nature: insight.nature,
          sourceTypes: sourceTypesFor(selected, insight.quotes.length > 0),
          formation: h ? ("agent_exploration" as const) : ("agent_extraction" as const),
          methodId: h ? "hypothesis-support-counterexample-v2" : "literal-user-extraction-v1",
          computation: h
            ? receipts.some((r) => r?.code && !r.code.startsWith("fixed:"))
              ? ("agent_authored" as const)
              : ("predefined" as const)
            : ("none" as const),
          supportingSources: refs(selected),
          quotes: insight.quotes,
          producer: this.agentId,
        },
      };
    });
    const valid = new Set(previous ? validConclusions(previous, this.snapshot).map((c) => c.id) : []);
    this.submitted = {
      prototype: true,
      userId: this.snapshot.userId,
      inputHash: createHash("sha256").update(JSON.stringify(this.snapshot)).digest("hex"),
      evaluatedAt: new Date().toISOString(),
      window: { startDay: this.snapshot.startDay, endDay: this.snapshot.endDay },
      method: "independent-profile-agent-v1:open-hypotheses+tools+counterexamples",
      conclusions,
      unknowns: [],
      change: {
        previousInputHash: previous?.inputHash ?? null,
        removedConclusionIds: previous?.conclusions.filter((c) => !valid.has(c.id)).map((c) => c.id) ?? [],
        reason: value.summary,
      },
    };
    return { accepted: true, insights: conclusions.length };
  }
}
