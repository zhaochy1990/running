import { type ToolCall, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import { CalculationSchema, HypothesisSchema, type ProfileAgentSession, SubmissionSchema } from "./agentSession.js";
import type { Profile } from "./types.js";

/** The agent wrapper also sees failures that happen before a tool callback. */
export async function journalToolCall<T>(session: ProfileAgentSession, call: Pick<ToolCall, "name" | "args">, execute: () => Promise<T> | T): Promise<T> {
  try {
    const result = await execute();
    if (result instanceof ToolMessage && result.status === "error")
      await session.toolError(call.name, call.args, typeof result.content === "string" ? result.content : JSON.stringify(result.content));
    return result;
  } catch (error) {
    await session.toolError(call.name, call.args, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function profileAgentTools(session: ProfileAgentSession, previous: Profile | null) {
  const attempt = async (name: string, input: unknown, fn: () => unknown) => {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.toolError(name, input, message);
      return {
        error: message,
        action: "Revise the query, calculation or hypothesis and try again. No result has been accepted.",
      };
    }
  };
  return [
    tool(() => session.catalog(), {
      name: "describe_training_data",
      description: "查看本用户固定快照的数据集、字段覆盖和单位，发现可分析的问题。只读，不提供预先选好的结论。",
      schema: z.object({}),
    }),
    tool(
      (input) => attempt("read_training_data", input, () => session.read(input.kind, input.fields, input.startDay, input.endDay, input.offset, input.limit)),
      {
        name: "read_training_data",
        description: "按数据集、上海日期窗口和字段分页查看原始记录。先查catalog字段；每条带稳定id。详情分段另用read_activity_detail。",
        schema: z.object({
          kind: z.string(),
          fields: z.array(z.string()).min(1).max(16),
          startDay: z.string().nullable(),
          endDay: z.string().nullable(),
          offset: z.number().int().min(0),
          limit: z.number().int().min(1).max(80),
        }),
      },
    ),
    tool((input) => attempt("read_activity_detail", input, () => session.activity(input.sourceId)), {
      name: "read_activity_detail",
      description: "根据activity来源id读取完整记录与canonical laps，检查过程、异常和实际完成量。数据来自当前本地快照。",
      schema: z.object({ sourceId: z.string() }),
    }),
    tool((input) => attempt("calculate_training_data", input, () => session.calculate(input)), {
      name: "calculate_training_data",
      description:
        "运行你编写的同步JavaScript，筛选、连接、分组、比较或检验反例。唯一输入sources是只读原始证据数组，每行{id,revision,kind,content,...}，可用所有字段和laps。标准JS/Math/Date/JSON可用，无Node、网络、文件、第三方库。代码必须return一个简洁JSON对象（写方法、窗口、实际样本数/ids、数值和反例）；数组不可原地sort，先slice。缺失不当0。所有算术由此工具执行，不在脑中估算。宿主保守绑定整份有效快照依赖，dependencySourceCount不是支持样本数；receiptId供假设引用。先record_hypothesis，再以support/counterexample测试；探索可hypothesisId:null。",
      schema: CalculationSchema,
    }),
    tool((input) => attempt("record_hypothesis", input, () => session.update(input)), {
      name: "record_hypothesis",
      description:
        "提出或修订开放假设，写明可推翻它的检查。status proposed/testing/retained/qualified/rejected。首次可用空receipts；保留前必须有support和独立counterexample计算receipt。若反证改变认识，更新statement与revisionNote。状态和历史由工具保存，不靠口头记忆。",
      schema: HypothesisSchema,
    }),
    tool(
      () => ({
        hypotheses: [...session.hypotheses.values()],
        successfulCalculations: [...session.receipts.values()]
          .filter((r) => r.code)
          .map((r) => ({ id: r.id, hypothesisId: r.hypothesisId, purpose: r.purpose, question: r.question })),
        submitted: session.submitted !== null,
      }),
      {
        name: "inspect_evaluation_progress",
        description: "查看假设状态和成功计算的receipt，找出待反证、待修订或应舍弃的方向。",
        schema: z.object({}),
      },
    ),
    tool((value) => attempt("submit_training_profile", value, () => session.submit(value, previous)), {
      name: "submit_training_profile",
      description:
        "完成自主探索后提交有计划用途的个体认识。kind分别标明fact记录事实、estimate既有算法估计、user_report本人原话、insight系统综合推断；不可混淆。只可引用retained/qualified假设；每条已有支持和单独反例检查。不要提交待研究占位或无增量的统计目录。允许0条并如实报告未形成认识；成功后结束本轮。具体规划用途为定性输入，不生成或应用课表。",
      schema: SubmissionSchema,
    }),
  ];
}
