import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { createApp } from "../src/app.js";
import { AuthError, type JwtIdentity } from "../src/auth.js";
import type { CoachDataDeleter } from "../src/persistence/deletion.js";
import { MySqlCoachDataDeleter } from "../src/persistence/deletion.js";

const neverInvoke = {
  async invoke() {
    throw new Error("must not invoke");
  },
  streamEvents: () => {
    throw new Error("must not stream");
  },
};

function appFor(verify: (header: string | undefined) => Promise<JwtIdentity>, deleter: CoachDataDeleter) {
  return createApp({
    jwtVerifier: { verify },
    coachInvoker: neverInvoke,
    coachDataDeleter: deleter,
  });
}

function recordingDeleter() {
  const calls: string[] = [];
  const deleter: CoachDataDeleter = {
    async deleteForUser(userId) {
      calls.push(userId);
      return { checkpoints: 1, checkpoint_writes: 2, coach_turn_receipts: 3, store: 4 };
    },
  };
  return { deleter, calls };
}

const request = (app: ReturnType<typeof appFor>, target: string, authorization = "Bearer token") =>
  app.request(`/api/admin/users/${target}/coach-data`, { method: "DELETE", headers: { authorization } });

test("admin may delete any user's coach data", async () => {
  const { deleter, calls } = recordingDeleter();
  const app = appFor(
    async () => ({ userId: "admin-1", isAdmin: true }),
    deleter,
  );
  const response = await request(app, "athlete-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user_id: "athlete-1", deleted: { checkpoints: 1, checkpoint_writes: 2, coach_turn_receipts: 3, store: 4 } });
  assert.deepEqual(calls, ["athlete-1"]);
});

test("a regular user may delete only their own coach data", async () => {
  const { deleter, calls } = recordingDeleter();
  const app = appFor(
    async () => ({ userId: "athlete-1", isAdmin: false }),
    deleter,
  );
  assert.equal((await request(app, "athlete-1")).status, 200);

  const forbidden = await request(app, "athlete-2");
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "forbidden" });
  assert.deepEqual(calls, ["athlete-1"]);
});

test("coach data deletion requires a valid bearer token", async () => {
  const { deleter, calls } = recordingDeleter();
  const app = appFor(
    async () => {
      throw new AuthError("missing");
    },
    deleter,
  );
  const response = await request(app, "athlete-1", "");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(calls, []);
});

test("coach data deletion rejects an oversized user id", async () => {
  const { deleter, calls } = recordingDeleter();
  const app = appFor(
    async () => ({ userId: "admin-1", isAdmin: true }),
    deleter,
  );
  const response = await request(app, "x".repeat(129));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test("deleter escapes LIKE wildcards and returns per-table counts", async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async execute(sql: string, params: unknown[]) {
      executed.push({ sql, params });
      return [{ affectedRows: 3 }, []];
    },
  } as unknown as Pool;
  const deleter = new MySqlCoachDataDeleter(pool);
  const counts = await deleter.deleteForUser("user_with%wild_");
  assert.equal(Object.keys(counts).length, 4);
  assert.equal(counts.checkpoints, 3);
  const threadParams = executed.filter((e) => e.sql.includes("checkpoints") || e.sql.includes("checkpoint_writes") || e.sql.includes("receipts")).map((e) => e.params[0]);
  for (const param of threadParams) {
    assert.match(String(param), /^user\\_with\\%wild\\_:coach:%$/);
  }
  const storeParams = executed.find((e) => e.sql.includes("FROM store"))?.params ?? [];
  assert.equal(storeParams[0], "athlete_memory\u001fuser_with%wild_");
  assert.equal(storeParams[1], "athlete\\_memory\u001fuser\\_with\\%wild\\_\u001f%");
});
