import { DataProviderMasterPlanContextProvider, type MasterPlanContextProvider, MasterPlanGraphRequest, type RunnerSnapshotSchema } from "@stride/coach-agent";
import { asPermanent } from "../job/errors.js";
import type { Heartbeat } from "../job/ports.js";
import { type MasterPlanGraphShim, runMasterKernel } from "../kernel/master/kernel.js";
import type { ExecutionInput, GenerateResult } from "./protocol.js";
import { SnapshotDataProvider, type SnapshotNotCoveredError } from "./snapshotDataProvider.js";

export interface GenerateDeps {
  /** 被测版本的图装配：LLM 模型取自本镜像的 coach 配置，上下文取自只读快照 Provider。 */
  buildGraph(contextProvider: MasterPlanContextProvider): MasterPlanGraphShim;
}

const failed = (code: string, message: string): GenerateResult => ({ kind: "failed", error: { code, message } });

/**
 * 对一条冻结输入执行 Generate：装配只读快照 Provider → 跑本镜像的真实 master kernel →
 * 产出 `{type:"master_plan", plan, weekly_docs}` 原文，或结构化错误。错误分三类：
 * 快照/请求不合约（执行输入不兼容）、快照未覆盖被读取的数据（具体缺口）、kernel 的
 * 非完成终态（沿用它自己的稳定错误码）。
 */
export async function generateArtifact(input: ExecutionInput, deps: GenerateDeps, hb: Heartbeat): Promise<GenerateResult> {
  let snapshot: ReturnType<typeof RunnerSnapshotSchema.parse>;
  let request: MasterPlanGraphRequest;
  try {
    snapshot = SnapshotDataProvider.parse(input.snapshot);
    request = MasterPlanGraphRequest.parse(input.request);
  } catch (error) {
    return failed("execution_input_invalid", describe(error));
  }
  const userId = snapshot.records.profile?.userId ?? snapshot.snapshot_id;
  const notCovered: SnapshotNotCoveredError[] = [];
  const provider = new SnapshotDataProvider(snapshot, userId, (error) => notCovered.push(error));
  try {
    const result = await runMasterKernel(
      deps.buildGraph(new DataProviderMasterPlanContextProvider(provider)),
      request,
      { userId, generationId: `plan-eval-${input.as_of}` },
      hb,
    );
    return {
      kind: "artifact",
      artifact_type: "master_plan",
      content: JSON.stringify({ type: "master_plan", plan: result.plan, weekly_docs: result.weeklyDocs }),
    };
  } catch (error) {
    // 图把取数失败收成 infrastructure_failure；把快照未覆盖的具体缺口补回报告。
    const gap = notCovered.length > 0 ? ` (${notCovered[0]!.message})` : "";
    const permanent = asPermanent(error);
    return failed(permanent !== null ? permanent.code : "infrastructure_failure", `${describe(error)}${gap}`);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") return error.message;
  return error instanceof Error ? error.message : String(error);
}
