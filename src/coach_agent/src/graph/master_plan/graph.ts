import { END, START, StateGraph } from "@langchain/langgraph";
import { MasterPlanGraphContext } from "@stride/contract";
import { GraphInput, GraphOutput, GraphState, type MasterPlanGraphDependencies, MasterPlanNodes } from "./nodes.js";

export { ModelContractError } from "./nodes.js";

/**
 * 新拓扑（devops#803 §3，2026-11-08 breaking 替换）：8 节点串行。
 *
 * 老拓扑的 strategies 三扇出 + judges 九评审 + reviews 三评审全部删除——spike
 * 实证 9/17 次调用花在评审上而收益存疑；确定性质量证据改由 L3 六门 + L4 C/P 门
 * + danielsAudit 承担。回炉环全部内建在下游模块里（L2 门挂→T 表兜底、L4 排位
 * 无解→重生成课包、终局→模板兜底），图上不需要额外循环边。
 */
export function createMasterPlanGraph(dependencies: MasterPlanGraphDependencies) {
  const nodes = new MasterPlanNodes(dependencies);

  return new StateGraph({
    state: GraphState,
    input: GraphInput,
    output: GraphOutput,
    context: MasterPlanGraphContext,
  })
    .addNode("initialize", nodes.initialize)
    .addNode("assess_goal", nodes.assessGoal)
    .addNode("l1_evidence", nodes.evidence)
    .addNode("l2_phasing", nodes.phasing)
    .addNode("l3_load", nodes.load)
    .addNode("l4_content", nodes.content)
    .addNode("daniels_audit", nodes.audit)
    .addNode("snapshot_plan", nodes.snapshotPlan)
    .addNode("finalize", nodes.finalize)
    .addEdge(START, "initialize")
    .addConditionalEdges("initialize", nodes.stopOr("assess_goal"), ["assess_goal", END])
    .addConditionalEdges("assess_goal", nodes.stopOr("l1_evidence"), ["l1_evidence", END])
    .addConditionalEdges("l1_evidence", nodes.stopOr("l2_phasing"), ["l2_phasing", END])
    .addConditionalEdges("l2_phasing", nodes.stopOr("l3_load"), ["l3_load", END])
    .addConditionalEdges("l3_load", nodes.stopOr("l4_content"), ["l4_content", END])
    .addConditionalEdges("l4_content", nodes.stopOr("daniels_audit"), ["daniels_audit", END])
    .addConditionalEdges("daniels_audit", nodes.stopOr("snapshot_plan"), ["snapshot_plan", END])
    .addConditionalEdges("snapshot_plan", nodes.stopOr("finalize"), ["finalize", END])
    .addEdge("finalize", END)
    .compile();
}
