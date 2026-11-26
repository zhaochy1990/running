import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import type { CoachAgentConfig } from "../config/config.js";
import type { DataProvider, ManualStrengthRecord } from "../data/dataProvider.js";
import { createCoachAgent } from "./coachAgent.js";

test("the production graph reloads only the anchored record on each turn and resumes its own thread", async (t) => {
  const recordA = "4bc80c96-0415-4bdc-bf17-83a919154594";
  const recordB = "4bc80c96-0415-4bdc-bf17-83a919154593";
  const reads: string[] = [];
  const evidence: unknown[] = [];
  const modelChoices: string[] = [];
  let quantity = 7;
  let malformedArguments = false;
  let omitToolCall = false;
  const store = {
    async getManualStrengthDetail(userId: string, recordId: string): Promise<ManualStrengthRecord | null> {
      assert.equal(userId, "athlete");
      reads.push(recordId);
      return {
        id: recordId,
        name: recordId === recordA ? "早练" : "晚练",
        startedAt: new Date("2026-11-26T00:00:00Z"),
        endedAt: new Date("2026-11-26T00:10:00Z"),
        note: "",
        actions: [{ name: "平板", sets: [{ load: "", load_unit: "bodyweight", quantity, quantity_unit: "seconds" }] }],
      };
    },
    async getManualStrengthSummaries() {
      throw new Error("an anchored turn must not search by date");
    },
    async getWatchStrengthSummaries() {
      throw new Error("an unrequested watch must not be read");
    },
  } satisfies Partial<DataProvider>;
  process.env.STRIDE_STRENGTH_REVIEW_TEST_KEY = "test-key";
  t.after(() => {
    delete process.env.STRIDE_STRENGTH_REVIEW_TEST_KEY;
  });
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    modelChoices.push(body.tool_choice ?? "");
    const toolTurn = body.tool_choice === "required" && !omitToolCall;
    if (!toolTurn && body.messages.at(-1)?.role === "tool") evidence.push(JSON.parse(body.messages.at(-1).content));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `chatcmpl-strength-review-${modelChoices.length}`,
        object: "chat.completion",
        created: 1,
        model: "deepseek-test",
        choices: [
          {
            index: 0,
            message: toolTurn
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `review-${modelChoices.length}`,
                      type: "function",
                      function: {
                        name: "get_strength_training_review",
                        arguments: JSON.stringify(malformedArguments ? { watchReference: 123 } : { recordId: recordB, startDay: "2025-09-01" }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "复盘完成" },
            finish_reason: toolTurn ? "tool_calls" : "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const config: CoachAgentConfig = {
    models: [
      {
        name: "test",
        model: "deepseek-test",
        api_key_env: "STRIDE_STRENGTH_REVIEW_TEST_KEY",
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        api_kind: "chat-completions",
        max_tokens: 64,
        timeout_s: 10,
      },
    ],
    agents: ["orchestrator", "qa", "master_plan", "race_strategy", "custom_workout", "workout_manage"].map((name) => ({ name, model: "test" })),
    observability: { langsmith_enabled: false, langsmith_project: "", langsmith_endpoint: "", langsmith_api_key_env: "" },
  };
  const graph = await createCoachAgent(store as unknown as DataProvider, config);
  function turn(recordId: string, message: string | null) {
    return graph.invoke(message === null ? null : { messages: [new HumanMessage(message)] }, {
      context: { userId: "athlete", asof: "2026-11-26", strengthReviewRecordId: recordId },
      configurable: { thread_id: `athlete:coach:manual-strength-${recordId}` },
    });
  }
  await turn(recordA, "早练做了什么？");
  await turn(recordB, "晚练做了什么？");
  quantity = 42;
  const resumed = await turn(recordA, "平板撑了多久？");
  assert.deepEqual(reads, [recordA, recordB, recordA]);
  assert.deepEqual(modelChoices, ["required", "none", "required", "none", "required", "none"]);
  assert.match(JSON.stringify(evidence.at(-1)), /"quantity":42/);
  assert.deepEqual(
    resumed.messages.filter((message) => message.getType() === "human").map((message) => message.text),
    ["早练做了什么？", "平板撑了多久？"],
  );
  assert.equal(resumed.messages.at(-1)?.text, "复盘完成");
  malformedArguments = true;
  await assert.rejects(turn(recordA, "这轮不能沿用旧数据"), /当前训练记录读取失败/);
  assert.deepEqual(reads, [recordA, recordB, recordA]);
  assert.equal(modelChoices.length, 7, "a malformed tool call must not reach the reply model");
  malformedArguments = false;
  const recovered = await turn(recordA, null);
  assert.equal(recovered.messages.at(-1)?.text, "复盘完成");
  assert.equal(recovered.messages.filter((message) => message.text === "这轮不能沿用旧数据").length, 1);
  assert.deepEqual(reads, [recordA, recordB, recordA, recordA]);
  omitToolCall = true;
  await assert.rejects(turn(recordB, "不能在未调用工具时回答"), /当前训练记录读取失败/);
  assert.deepEqual(reads, [recordA, recordB, recordA, recordA]);
  assert.equal(modelChoices.at(-1), "required");
});
