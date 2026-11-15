import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { FlashRuntime } from "./agentRuntime.js";
import { ProfileAgentSession } from "./agentSession.js";
import { profileAgentTools } from "./agentTools.js";
import { briefEntry } from "./deterministic.js";
import { dimensions, type WorkerId, workerScopes } from "./dimensions.js";
import type { PriorEntry } from "./history.js";
import type { Conclusion, Snapshot } from "./types.js";

const RULES = `你是训练画像的专项子Agent。只在指定维度提出有个人价值的问题，自主选择比较方法、样本与反例；不必为每个属性凑结论。
先用现有固定计算，避免重写已验证的分段、天气配对、周结构与负荷统计。必要的新方法才调用calculate_training_data写JS；这是受限只读解释器，sources含原始记录，不含上轮结果。record_hypothesis记录假设；每项推断先有support和不同方法的counterexample，结合反例修订主体或放弃。adopt_computed_evidence可以把固定计算绑定假设，无需重复算。完成后submit_training_profile，每轮最多3条有用认识。
每条明确dimensionId、nature和实际选用sourceIds。fact事实、observation统计观察、estimate已有估计、preference本人偏好、goal目标、constraint限制、subjective本人感受、association关联规律。只有用户原话能支持明确偏好/目标/主观感受：quotes必须逐字来自feelNote或user_statement.text；h可以null，不要求统计证明。旧user_report是混合教练分析，不能当用户原话。经常在某时段跑不等于喜欢或有空。formation由runtime保存，不能把Agent写的代码说成固定算法。
个人基线只引用calibration，不能另算HRmax/阈值/静息基线。时间归属用shanghaiDay；缺失不是0，无记录不是休息/无伤病。记录数不等于训练课数，同日不等于同课。标题和系统分类不是完成强度的独立证明。
分段按距离比较；用distanceBlock等固定工具优先，粗分段不伪装精确测量。数值、单位、分母、筛选范围、中位/平均与实际结果一致，不遗漏末段或已找到的反例。能力指数不直接互比，也不当百分位。配速、步频、步幅的数学关系不证明改善技术的方法。不能从排除一个原因推导另一个原因。
既有认识是需要复核的历史材料，不是必须证实的答案；同一训练在多个统计中出现不算独立证据。重复观察可描述执行经历，关联只作柔性提示，不给精确配速/负荷修正、医学诊断或增加训练许可。planningUse要说本用户的计划为何会不同，不能把一次经历变固定处方。没有新认识可提交空数组，研究空白写summary而非塞进正文。留出预算给反证和提交。`;

const scopes: Record<WorkerId, string> = {
  ability: "探索现有能力估计与实际速度/耐力表现、历史经历如何对应；不要把一次表现当极限或把条件变化当生理进步。",
  recovery: "探索不同训练后恢复指标、本人感受和后续完成表现的关系，核查负荷口径与替代解释；不从单日指标诊断或放行加量。",
  preferences: "从本人原话提取目标、时间限制、偏好、身体反馈与经历，区分一次行为和长期偏好；可检验记录中的执行习惯，但不能替用户猜动机。",
  fueling: "探索补给/比赛/课型执行经验及后程表现；补给使用、耐受和效果分开，单次记录保持历史范围。",
  response: "重点复核温度相关旧认识，并探索湿度、爬升等条件与表现的关系；检查可比性、反例和样本筛选，不要求每个因素都得出关联。",
};

export interface WorkerReport {
  worker: WorkerId;
  attempt: number;
  status: "running" | "complete" | "failed";
  entries: Conclusion[];
  session: ProfileAgentSession;
  error?: string;
}

export class Explorations {
  readonly reports = new Map<WorkerId, WorkerReport>();
  readonly planned: WorkerId[];
  readonly archived: WorkerReport[] = [];
  constructor(
    readonly snapshot: Snapshot,
    readonly computed: Conclusion[],
    readonly history: PriorEntry[],
    readonly runtime: FlashRuntime,
  ) {
    const active = snapshot.evidence.filter((e) => e.active);
    this.planned = [];
    if (active.some((e) => e.kind === "activity")) this.planned.push("ability", "fueling");
    if (active.some((e) => e.kind === "recovery" || e.kind === "load")) this.planned.push("recovery");
    if (active.some((e) => e.kind === "user_statement" || (e.kind === "activity" && typeof e.content.feelNote === "string" && e.content.feelNote.trim())))
      this.planned.push("preferences");
    if (active.some((e) => e.kind === "activity" && [e.content.temperature, e.content.humidity, e.content.ascentM].some((v) => typeof v === "number")))
      this.planned.push("response");
  }

  async launch(worker: WorkerId, question: string, revise: boolean) {
    if (!this.planned.includes(worker)) throw new Error(`No relevant snapshot source for ${worker}`);
    const previous = this.reports.get(worker);
    if (previous?.status === "running") throw new Error("This dimension is already running");
    if (previous && (!revise || previous.attempt >= 2)) throw new Error("Use at most one explicit revision after the first dimension report");
    if (previous) this.archived.push(previous);
    const attempt = (previous?.attempt ?? 0) + 1;
    const session = new ProfileAgentSession(
      this.snapshot,
      (e) => this.runtime.record({ agent: `${worker}-${attempt}`, event: e }),
      `${worker}-${attempt}`,
      workerScopes[worker],
    );
    const report: WorkerReport = { worker, attempt, status: "running", entries: [], session };
    this.reports.set(worker, report);
    try {
      await this.runtime.child(async () => {
        const fixed = tool(
          async ({ id, hypothesisId, purpose }) => {
            const entry = this.computed.find((c) => c.id === id);
            if (!entry) throw new Error("Unknown computed evidence");
            if (hypothesisId && !session.hypotheses.has(hypothesisId)) throw new Error("Record hypothesis first");
            if (purpose !== "read" && !hypothesisId) throw new Error("Bind support/counterexample to a hypothesis");
            return session.receipt({
              hypothesisId,
              purpose,
              question: entry.title,
              sourceIds: entry.evidence.map((e) => e.id),
              ...(purpose === "read" ? {} : { code: `fixed:${entry.metadata?.methodId}` }),
              result: briefEntry(entry),
            });
          },
          {
            name: "adopt_computed_evidence",
            description:
              "读取固定代码结果，或把该计算作为本假设support/counterexample。只能引用真实id；metadata为形成过程，values含原始统计。代码统计不能自动证明因果。",
            schema: z.object({ id: z.string(), hypothesisId: z.string().nullable(), purpose: z.enum(["read", "support", "counterexample"]) }),
          },
        );
        const input = {
          worker,
          budgetModelCalls: 12,
          allowedDimensions: workerScopes[worker].map((id) => ({ id, title: dimensions[id] })),
          question,
          catalog: session.catalog(),
          computedEvidence: this.computed.map((c) => ({ id: c.id, title: c.title, dimensionId: c.metadata?.dimensionId })),
          priorKnowledge: this.history
            .filter((p) => p.valid)
            .map((p) => ({ id: p.id, title: p.conclusion.title, text: p.conclusion.text, conditions: p.conclusion.conditions, support: p.conclusion.support })),
          revisionOf: previous ? { entries: previous.entries.map(briefEntry), error: previous.error ?? null } : null,
        };
        await this.runtime.run(
          `${worker}-${attempt}`,
          session,
          [...profileAgentTools(session, null), fixed],
          `${RULES}\n本次范围：${scopes[worker]}`,
          JSON.stringify(input),
          () => session.submitted !== null,
          12,
        );
      });
      report.entries = (session.submitted?.conclusions ?? []).map((c) => ({ ...c, id: `child:${worker}:${attempt}:${c.id}` }));
      report.status = "complete";
    } catch (error) {
      report.status = "failed";
      report.error = error instanceof Error ? error.message : String(error);
    }
    await this.runtime.record({ type: "child_report", worker, attempt, status: report.status, error: report.error, entries: report.entries });
    return this.brief(report);
  }
  brief(r: WorkerReport) {
    return { worker: r.worker, attempt: r.attempt, status: r.status, error: r.error, entries: r.entries.map(briefEntry) };
  }
  entries() {
    return [...this.reports.values()].flatMap((r) => r.entries);
  }
  ready() {
    return this.planned.every((w) => {
      const r = this.reports.get(w);
      return r && r.status !== "running";
    });
  }
}
