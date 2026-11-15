import assert from "node:assert/strict";
import test from "node:test";
import { ToolMessage } from "@langchain/core/messages";
import { type Hypothesis, ProfileAgentSession } from "./agentSession.js";
import { journalToolCall, profileAgentTools } from "./agentTools.js";
import { calculateSnapshot } from "./calculations.js";
import type { Snapshot } from "./types.js";

function fixture(): Snapshot {
  return {
    userId: "one",
    startDay: "2026-11-01",
    endDay: "2026-11-15",
    capturedAt: "2026-11-15T00:00:00Z",
    coverage: {},
    evidence: [
      { id: "a", revision: "one", kind: "activity", eventTime: null, reportedAt: null, active: true, content: { shanghaiDay: "2026-11-01", distanceM: 10000 } },
      { id: "b", revision: "one", kind: "activity", eventTime: null, reportedAt: null, active: true, content: { shanghaiDay: "2026-11-03", distanceM: 5000 } },
      { id: "withdrawn", revision: "one", kind: "activity", eventTime: null, reportedAt: null, active: false, content: { distanceM: 900000 } },
    ],
  };
}
const hypothesis: Hypothesis = {
  id: "h1",
  statement: "短记录与长记录应分别理解",
  refutationPlan: "检查所有记录是否都落在同一距离范围",
  status: "proposed",
  supportReceipts: [],
  challengeReceipts: [],
  revisionNote: "提出待检查问题",
};

test("agent calculations use a private immutable snapshot, bind its input and expose no host APIs", async () => {
  const data = fixture(),
    before = JSON.stringify(data);
  const result = await calculateSnapshot(
    data,
    "return {total:sources.reduce((s,e)=>s+e.content.distanceM,0),host:[typeof process,typeof require,typeof fetch]};",
  );
  assert.deepEqual(result.result, { total: 15000, host: ["undefined", "undefined", "undefined"] });
  assert.deepEqual(result.inspectedIds.sort(), ["a", "b"]);
  await assert.rejects(calculateSnapshot(data, "sources[0].content.distanceM=0; return 0;"));
  await assert.rejects(calculateSnapshot(data, "while(true){}", 20), /interrupted/);
  assert.equal(JSON.stringify(data), before);
});

test("calculation code cannot forge input dependencies through descriptors or mutated intrinsics", async () => {
  const result = await calculateSnapshot(
    fixture(),
    `Set.prototype[Symbol.iterator] = function*(){ yield "a"; };
     const distance = Object.getOwnPropertyDescriptor(sources[1], "content").value.distanceM;
     return {distance, inspectedIds:["a"]};`,
  );
  assert.deepEqual(result.result, { distance: 5000, inspectedIds: ["a"] });
  assert.deepEqual(result.inspectedIds, ["a", "b"]);
  assert.equal(result.readInput, true);
  const constant = await calculateSnapshot(fixture(), "Object.prototype.toJSON = () => ({readInput:true}); return 42;");
  assert.equal(constant.readInput, false);
});

test("constant support or counterexample outputs do not qualify as data checks", async () => {
  const session = new ProfileAgentSession(fixture(), async () => {});
  await session.update(hypothesis);
  for (const purpose of ["support", "counterexample"] as const)
    await assert.rejects(session.calculate({ hypothesisId: "h1", purpose, question: "返回未读取资料的常量", code: "return {observations:100};" }), /must read/);
  assert.equal(session.receipts.size, 0);
});

test("a validation receipt cannot substitute for a distinct counterexample", async () => {
  const session = new ProfileAgentSession(fixture(), async () => {});
  await session.update(hypothesis);
  const code = "return sources.map(e=>e.content.distanceM);";
  const support = await session.calculate({ hypothesisId: "h1", purpose: "support", question: "读取全部记录的距离", code });
  const counter = await session.calculate({ hypothesisId: "h1", purpose: "counterexample", question: "重复支持计算作为反证", code });
  const validation = await session.calculate({
    hypothesisId: "h1",
    purpose: "validation",
    question: "检查记录数量但不执行反证",
    code: "return sources.length;",
  });
  await assert.rejects(
    session.update({ ...hypothesis, status: "retained", supportReceipts: [support.receiptId], challengeReceipts: [counter.receiptId, validation.receiptId] }),
    /counterexample/,
  );
});

test("failed calculations stay in the local journal and cannot count as evidence", async () => {
  const events: unknown[] = [];
  const session = new ProfileAgentSession(fixture(), async (event) => {
    events.push(event);
  });
  const calculate = profileAgentTools(session, null).find((t) => t.name === "calculate_training_data");
  assert.ok(calculate);
  const response = await calculate.invoke({ hypothesisId: null, purpose: "exploration", question: "检查错误计算如何留痕", code: "throw Error('bad query');" });
  assert.match(JSON.stringify(response), /bad query/);
  assert.equal(session.receipts.size, 0);
  assert.match(JSON.stringify(events), /"type":"tool_error"/);
  assert.match(JSON.stringify(events), /calculate_training_data/);
});

test("tool wrapper journals schema failures and preserves error messages for self-correction", async () => {
  const events: unknown[] = [];
  const session = new ProfileAgentSession(fixture(), async (event) => {
    events.push(event);
  });
  const detail = profileAgentTools(session, null).find((t) => t.name === "read_activity_detail");
  assert.ok(detail);
  const call = { name: "read_activity_detail", args: {}, id: "invalid-schema", type: "tool_call" as const };
  await assert.rejects(journalToolCall(session, call, () => detail.invoke(call)));
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events), /"type":"tool_error"/);
  assert.match(JSON.stringify(events), /sourceId/);
  const message = new ToolMessage({ content: "Unknown tool", tool_call_id: "unknown", status: "error" });
  assert.equal(await journalToolCall(session, { name: "missing_tool", args: {} }, () => message), message);
  assert.equal(events.length, 2);
});

test("retained findings require a distinct successful counterexample check and preserve revisions", async () => {
  const session = new ProfileAgentSession(fixture(), async () => {});
  await session.update(hypothesis);
  const support = await session.calculate({
    hypothesisId: "h1",
    purpose: "support",
    question: "计算所有记录的距离范围",
    code: "return sources.map(e=>({id:e.id,km:e.content.distanceM/1000}));",
  });
  await assert.rejects(session.update({ ...hypothesis, status: "retained", supportReceipts: [support.receiptId] }), /counterexample/);
  const counter = await session.calculate({
    hypothesisId: "h1",
    purpose: "counterexample",
    question: "寻找与统一十公里假设相反的所有记录",
    code: "return sources.filter(e=>e.content.distanceM!==10000).map(e=>({id:e.id,km:e.content.distanceM/1000}));",
  });
  await session.update({
    ...hypothesis,
    status: "qualified",
    supportReceipts: [support.receiptId],
    challengeReceipts: [counter.receiptId],
    revisionNote: "存在短记录，收窄到实际距离差异",
  });
  assert.equal(session.revisions.length, 2);
  assert.equal(session.revisions[0]?.status, "proposed");
  assert.equal(session.hypotheses.get("h1")?.status, "qualified");
  session.submit(
    {
      summary: "按反证修订后的结果",
      insights: [
        {
          hypothesisId: "h1",
          title: "存在不同长度记录",
          kind: "insight",
          dimensionId: "training",
          nature: "observation",
          sourceIds: ["a", "b"],
          quotes: [],
          text: "两条记录长度不同。",
          dimension: "开放主题",
          lifecycle: "rolling",
          planningUse: "计划应先依据实际活动粒度安排训练。",
          support: "preliminary_association",
          conditions: "本窗口",
          limitations: [],
        },
      ],
    },
    null,
  );
  assert.deepEqual(session.submitted?.conclusions[0]?.counterexampleReceiptIds, [counter.receiptId]);
  assert(!session.submitted?.conclusions[0]?.evidence.some((e) => e.id === "withdrawn"));
});
