import assert from "node:assert/strict";
import test from "node:test";
import { type ActivityFeelWriter, createActivityFeelTools } from "./feel.js";

const userId = "athlete-1";
const asof = "2026-10-12";

// --- 工具行为 ----------------------------------------------------------------

function recordingWriter(impl?: (feelNote: string) => Promise<void>): {
  writer: ActivityFeelWriter;
  calls: Array<{ userId: string; labelId: string; feelNote: string }>;
} {
  const calls: Array<{ userId: string; labelId: string; feelNote: string }> = [];
  return {
    calls,
    writer: {
      async setActivityFeelNote(wUserId, labelId, feelNote) {
        calls.push({ userId: wUserId, labelId, feelNote });
        await impl?.(feelNote);
      },
    },
  };
}

test("set_activity_feel writes the athlete's words through verbatim", async () => {
  const { writer, calls } = recordingWriter();
  const [tool] = createActivityFeelTools(writer);
  assert.ok(tool);

  assert.equal(tool.name, "set_activity_feel");
  const note = "前面4组体感6，最后两组7-8";
  const result = await tool.invoke({ labelId: "act-1", feelNote: note }, { context: { userId, asof } });
  assert.match(String(result), /已记录体感原话/);
  assert.deepEqual(calls, [{ userId, labelId: "act-1", feelNote: note }]);
});

test("set_activity_feel requires the runtime user", async () => {
  const { writer } = recordingWriter();
  const [tool] = createActivityFeelTools(writer);
  assert.ok(tool);
  await assert.rejects(() => tool.invoke({ labelId: "act-1", feelNote: "轻松" }, {}), /missing userId/);
});

test("set_activity_feel schema bounds feelNote to non-empty text ≤500 chars", () => {
  const [tool] = createActivityFeelTools(recordingWriter().writer);
  assert.ok(tool);
  const schema = tool.schema as unknown as { safeParse(input: unknown): { success: boolean } };
  assert.equal(schema.safeParse({ labelId: "act-1", feelNote: "" }).success, false);
  assert.equal(schema.safeParse({ labelId: "act-1", feelNote: "   " }).success, false);
  assert.equal(schema.safeParse({ labelId: "act-1", feelNote: " ".repeat(501) }).success, false);
  assert.equal(schema.safeParse({ labelId: "act-1", feelNote: "字".repeat(500) }).success, true);
  assert.equal(schema.safeParse({ labelId: "act-1", feelNote: 7 }).success, false);
});
