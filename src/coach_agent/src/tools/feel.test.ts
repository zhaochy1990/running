import assert from "node:assert/strict";
import test from "node:test";
import { type ActivityFeelWriter, createActivityFeelTools, feelBand, feelBandDisagrees, mapFeelUtterance } from "./feel.js";

const userId = "athlete-1";
const asof = "2026-10-12";

// --- 映射口径（#508 §4，与 analyze-activity skill 同源） ----------------------

test("mapFeelUtterance anchors descriptive answers to the RPE scale", () => {
  assert.deepEqual(mapFeelUtterance("跟散步一样"), [1, 2]);
  assert.deepEqual(mapFeelUtterance("非常轻松"), [1, 2]);
  assert.deepEqual(mapFeelUtterance("挺轻松的"), [3, 4]);
  assert.deepEqual(mapFeelUtterance("就是一场恢复跑"), [3, 4]);
  assert.deepEqual(mapFeelUtterance("还行，有点强度"), [5, 6]);
  assert.deepEqual(mapFeelUtterance("按马拉松节奏跑的"), [5, 6]);
  assert.deepEqual(mapFeelUtterance("后程有点吃力"), [7, 7]);
  assert.deepEqual(mapFeelUtterance("很吃力，喘得说不出话"), [8, 8]);
  assert.deepEqual(mapFeelUtterance("差点崩了"), [9, 9]);
  assert.deepEqual(mapFeelUtterance("最后冲刺了一把，全力"), [10, 10]);
});

test("mapFeelUtterance maps 成力 phrasing directly onto the 0–10 scale", () => {
  assert.deepEqual(mapFeelUtterance("体感大约7-8成力"), [7, 8]);
  assert.deepEqual(mapFeelUtterance("差不多9成力吧"), [9, 9]);
});

test("mapFeelUtterance returns null for unmatched or non-feel text", () => {
  assert.equal(mapFeelUtterance("今天天气不错"), null);
  assert.equal(mapFeelUtterance(""), null);
});

test("feelBand buckets scores into the talk-test bands", () => {
  assert.deepEqual(feelBand(0), [0, 0]);
  assert.deepEqual(feelBand(1.5), [1, 2]);
  assert.deepEqual(feelBand(4), [3, 4]);
  assert.deepEqual(feelBand(5.5), [5, 6]);
  assert.deepEqual(feelBand(7), [7, 7]);
  assert.deepEqual(feelBand(10), [10, 10]);
  assert.equal(feelBand(11), null);
  assert.equal(feelBand(-1), null);
  assert.equal(feelBand(Number.NaN), null);
});

test("feelBandDisagrees only fires across band boundaries", () => {
  assert.equal(feelBandDisagrees(7, [7, 8]), false);
  assert.equal(feelBandDisagrees(8, [7, 8]), false);
  assert.equal(feelBandDisagrees(4, [3, 4]), false);
  assert.equal(feelBandDisagrees(8, [3, 4]), true);
  assert.equal(feelBandDisagrees(11, [10, 10]), true);
});

// --- 工具行为 ----------------------------------------------------------------

function recordingWriter(impl?: (feel: number) => Promise<void>): {
  writer: ActivityFeelWriter;
  calls: Array<{ userId: string; labelId: string; feel: number }>;
} {
  const calls: Array<{ userId: string; labelId: string; feel: number }> = [];
  return {
    calls,
    writer: {
      async setActivityFeel(wUserId, labelId, feel) {
        calls.push({ userId: wUserId, labelId, feel });
        await impl?.(feel);
      },
    },
  };
}

test("set_activity_feel writes through the Go API writer with the runtime user", async () => {
  const { writer, calls } = recordingWriter();
  const [tool] = createActivityFeelTools(writer);
  assert.ok(tool);

  assert.equal(tool.name, "set_activity_feel");
  const result = await tool.invoke({ labelId: "act-1", feel: 7 }, { context: { userId, asof } });
  assert.match(String(result), /已记录体感 7\/10/);
  assert.deepEqual(calls, [{ userId, labelId: "act-1", feel: 7 }]);
});

test("set_activity_feel rejects writes that contradict the athlete's own words", async () => {
  const { writer, calls } = recordingWriter();
  const [tool] = createActivityFeelTools(writer);
  assert.ok(tool);

  const result = await tool.invoke({ labelId: "act-1", feel: 8, sourceUtterance: "挺轻松的" }, { context: { userId, asof } });
  assert.match(String(result), /未落库/);
  assert.match(String(result), /3–4/);
  assert.equal(calls.length, 0);
});

test("set_activity_feel accepts a confirmed value within the utterance band", async () => {
  const { writer, calls } = recordingWriter();
  const [tool] = createActivityFeelTools(writer);
  assert.ok(tool);

  const result = await tool.invoke({ labelId: "act-1", feel: 4, sourceUtterance: "挺轻松的" }, { context: { userId, asof } });
  assert.match(String(result), /已记录体感 4\/10/);
  assert.equal(calls.length, 1);
});

test("set_activity_feel requires the runtime user", async () => {
  const { writer } = recordingWriter();
  const [tool] = createActivityFeelTools(writer);
  assert.ok(tool);
  await assert.rejects(() => tool.invoke({ labelId: "act-1", feel: 7 }, {}), /missing userId/);
});

test("set_activity_feel schema bounds feel to 0–10", () => {
  const [tool] = createActivityFeelTools(recordingWriter().writer);
  assert.ok(tool);
  const schema = tool.schema as unknown as { safeParse(input: unknown): { success: boolean } };
  assert.equal(schema.safeParse({ labelId: "act-1", feel: 11 }).success, false);
  assert.equal(schema.safeParse({ labelId: "act-1", feel: -0.5 }).success, false);
  assert.equal(schema.safeParse({ labelId: "act-1", feel: 7.5 }).success, true);
});
