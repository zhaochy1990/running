import assert from "node:assert/strict";
import test from "node:test";
import type { Checkpoint, CheckpointMetadata } from "@stride/coach-agent";
import { MySqlSaver } from "../../src/persistence/checkpointer.js";

function checkpoint(messages: unknown[]): Checkpoint {
  return {
    v: 1,
    id: "0001",
    ts: "2026-08-19T00:00:00.000Z",
    channel_values: { messages },
    channel_versions: {},
    versions_seen: {},
  };
}

test("checkpoint metadata makes a completed turn receipt recoverable", async () => {
  let inserted: unknown[] = [];
  const pool = {
    async execute(_sql: string, values: unknown[]) {
      inserted = values;
      return [[], []];
    },
    async query(sql: string) {
      if (sql.includes("checkpoint_writes")) return [[]];
      return [
        [
          {
            checkpoint: inserted[5],
            metadata: inserted[6],
            type: inserted[4],
          },
        ],
      ];
    },
  } as never;
  const saver = new MySqlSaver(pool);
  const config = {
    configurable: { thread_id: "thread" },
    metadata: { client_turn_id: "turn", turn_fingerprint: "fingerprint" },
  };
  await saver.put(config, checkpoint([{ type: "ai", content: "done" }]), { source: "loop", step: 1, parents: {} } as CheckpointMetadata, {});
  assert.deepEqual(await saver.recoverTurn("thread", "turn"), {
    kind: "complete",
    receipt: {
      fingerprint: "fingerprint",
      response: { status: "completed", message: "done" },
    },
  });
  assert.deepEqual((inserted[6] as Buffer).toString("utf8").includes("turn_fingerprint"), true);
});

test("an intermediate tagged checkpoint is recovered as incomplete", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("checkpoint_writes")) return [[]];
      return [
        [
          {
            checkpoint: Buffer.from(JSON.stringify(checkpoint([{ type: "ai", content: "thinking", tool_calls: [{}] }]))),
            metadata: Buffer.from(
              JSON.stringify({
                source: "loop",
                step: 1,
                parents: {},
                client_turn_id: "turn",
                turn_fingerprint: "fingerprint",
              }),
            ),
            type: "json",
          },
        ],
      ];
    },
  } as never;
  assert.deepEqual(await new MySqlSaver(pool).recoverTurn("thread", "turn"), {
    kind: "incomplete",
    fingerprint: "fingerprint",
  });
});

test("recovery does not mistake a prior turn assistant message for this turn", async () => {
  const prior = checkpoint([{ type: "ai", content: "old answer" }]);
  prior.id = "parent";
  const current = checkpoint([
    { type: "ai", content: "old answer" },
    { type: "human", content: "new question" },
  ]);
  current.id = "current";
  const taggedMetadata = Buffer.from(
    JSON.stringify({
      source: "input",
      step: 2,
      parents: {},
      client_turn_id: "new-turn",
      turn_fingerprint: "fingerprint",
    }),
  );
  const pool = {
    async query(sql: string) {
      if (sql.includes("checkpoint_writes")) return [[]];
      return [
        [
          {
            checkpoint_id: "current",
            parent_checkpoint_id: "parent",
            checkpoint: Buffer.from(JSON.stringify(current)),
            metadata: taggedMetadata,
            type: "json",
          },
          {
            checkpoint_id: "parent",
            parent_checkpoint_id: null,
            checkpoint: Buffer.from(JSON.stringify(prior)),
            metadata: Buffer.from(JSON.stringify({ source: "loop", step: 1, parents: {} })),
            type: "json",
          },
        ],
      ];
    },
  } as never;
  assert.deepEqual(await new MySqlSaver(pool).recoverTurn("thread", "new-turn"), { kind: "incomplete", fingerprint: "fingerprint" });
});

test("an interrupt checkpoint recovers the needs-input response", async () => {
  const current = checkpoint([{ type: "human", content: "question" }]);
  current.id = "current";
  const pool = {
    async query(sql: string) {
      if (sql.includes("checkpoint_writes")) {
        return [
          [
            {
              task_id: "task",
              channel: "__interrupt__",
              type: "json",
              blob_data: Buffer.from(JSON.stringify([{ value: { question: "Choose" } }])),
            },
          ],
        ];
      }
      return [
        [
          {
            checkpoint_id: "current",
            parent_checkpoint_id: null,
            checkpoint: Buffer.from(JSON.stringify(current)),
            metadata: Buffer.from(
              JSON.stringify({
                source: "loop",
                step: 1,
                parents: {},
                client_turn_id: "turn",
                turn_fingerprint: "fingerprint",
              }),
            ),
            type: "json",
          },
        ],
      ];
    },
  } as never;
  assert.deepEqual(await new MySqlSaver(pool).recoverTurn("thread", "turn"), {
    kind: "complete",
    receipt: {
      fingerprint: "fingerprint",
      response: { status: "needs_input", interrupt: { question: "Choose" } },
    },
  });
});
