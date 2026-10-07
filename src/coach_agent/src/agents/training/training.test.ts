import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MasterPlanCardSchema } from "@stride/contract";
import { createTestMasterPlan } from "../../graph/master_plan/testFixtures.js";
import { makeTrainingNode, type TrainingAgent } from "./node.js";
import { renderMasterPlanMarkdown } from "./render.js";

// ---------------------------------------------------------------------------
// node behavior (fake inner agent)
// ---------------------------------------------------------------------------

function fakeAgent(respond: (input: { messages: BaseMessage[] }) => { messages: BaseMessage[] } & Record<string, unknown>): TrainingAgent & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async invoke(input: unknown) {
      calls += 1;
      return respond(input as { messages: BaseMessage[] });
    },
  };
}

const RUNTIME = { context: { userId: "user-1" } };

async function replyOf(node: ReturnType<typeof makeTrainingNode>, intentLabel: string | null = "master_plan") {
  const intent = intentLabel === null ? null : { intent: intentLabel };
  const result = (await node({ intent, messages: [] } as never, RUNTIME as never)) as { messages: unknown[] };
  const last = result.messages.at(-1);
  assert.ok(last instanceof AIMessage);
  return { text: String(last.content), message: last, count: result.messages.length };
}

function envelopeResult(plan: unknown) {
  return (input: { messages: BaseMessage[] }) => ({
    messages: [...input.messages, new AIMessage("(结构化输出)")],
    structuredResponse: { disposition: "return_direct", content: plan },
  });
}

test("training node answers non-master_plan intents without touching the agent", async () => {
  const agent = fakeAgent(envelopeResult(createTestMasterPlan()));
  const node = makeTrainingNode({ agent });
  const { text } = await replyOf(node, "weekly_plan");
  assert.match(text, /学习中/);
  assert.equal(agent.calls, 0);
});

test("training node renders the envelope plan as markdown and attaches a validated master-plan card", async () => {
  const plan = createTestMasterPlan();
  const node = makeTrainingNode({ agent: fakeAgent(envelopeResult(plan)) });
  const { text, message, count } = await replyOf(node);
  assert.match(text, /赛季训练计划初稿/);
  assert.equal(count, 1, "只有渲染后的回复进入会话历史，工具轨迹留在节点内");
  const kwargs = message.additional_kwargs as Record<string, unknown> | undefined;
  const card = kwargs?.card as Record<string, unknown> | undefined;
  assert.ok(card, "completed reply should carry additional_kwargs.card");
  assert.equal(card.$type, "master-plan");
  // 信封 data 是渲染/定位需要的标量摘要（时间轴走 markdown 正文）
  const parsed = MasterPlanCardSchema.safeParse(card.data);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  if (parsed.success) {
    assert.deepEqual(parsed.data, {
      goal: {
        race_name: plan.goal.race_name,
        distance: plan.goal.distance,
        race_date: plan.goal.race_date,
        target_time: plan.goal.target_time,
      },
      start_date: plan.start_date,
      end_date: plan.end_date,
      total_weeks: plan.total_weeks,
    });
  }
});

test("training node writes the agent's plain-text follow-up back when no envelope is produced", async () => {
  const followUp = "这场比赛你想以什么完赛时间作为目标？";
  const node = makeTrainingNode({
    agent: fakeAgent((input) => ({ messages: [...input.messages, new AIMessage(followUp)] })),
  });
  const { text, message } = await replyOf(node);
  assert.equal(text, followUp);
  const kwargs = message.additional_kwargs as Record<string, unknown> | undefined;
  assert.equal(kwargs?.card, undefined);
});

test("training node recovers an envelope leaked as plain text", async () => {
  const plan = createTestMasterPlan();
  const leaked = JSON.stringify({ disposition: "return_direct", content: plan });
  const leakedText = "```json\n" + leaked + "\n```";
  const node = makeTrainingNode({
    agent: fakeAgent((input) => ({ messages: [...input.messages, new AIMessage(leakedText)] })),
  });
  const { text, message } = await replyOf(node);
  assert.match(text, /赛季训练计划初稿/, "泄漏信封被防御性解析为渲染后的计划");
  const kwargs = message.additional_kwargs as Record<string, unknown> | undefined;
  assert.equal((kwargs?.card as Record<string, unknown> | undefined)?.$type, "master-plan");
});

test("training node returns failure copy when the agent throws", async () => {
  const node = makeTrainingNode({
    agent: fakeAgent(() => {
      throw new Error("model provider down");
    }),
  });
  const { text } = await replyOf(node);
  assert.match(text, /没能完成/);
});

test("training node enforces the in-turn wall-clock budget", async () => {
  const node = makeTrainingNode({
    agent: {
      invoke: () => new Promise(() => {}), // never resolves — silent stall
    },
    timeoutMs: 20,
  });
  const { text } = await replyOf(node);
  assert.match(text, /超出.*限制/);
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

test("renderMasterPlanMarkdown covers goal, phases and weeks", () => {
  const plan = createTestMasterPlan();
  const firstWeek = plan.weeks[0];
  assert.ok(firstWeek !== undefined);
  const text = renderMasterPlanMarkdown(plan);
  assert.match(text, new RegExp(plan.goal.race_name));
  assert.match(text, /阶段划分/);
  assert.match(text, /周骨架/);
  assert.match(text, /周跑量/);
  assert.match(text, new RegExp(`第 ${firstWeek.week_index} 周`));
});
