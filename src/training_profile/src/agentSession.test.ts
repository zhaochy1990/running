import assert from "node:assert/strict";
import test from "node:test";
import { type Hypothesis, ProfileAgentSession } from "./agentSession.js";
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

test("agent calculations use a private immutable snapshot, track sources and expose no host APIs", async () => {
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
