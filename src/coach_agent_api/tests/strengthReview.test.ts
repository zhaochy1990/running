import assert from "node:assert/strict";
import test from "node:test";
import type { ManualStrengthRecord } from "@stride/coach-agent";
import { createApp } from "../src/app.js";
import { AuthError } from "../src/auth.js";
import type { ThreadHistoryReader, ThreadSessionReader } from "../src/routes/history.js";

test("the same record has a stable private session and a different record has a different session", async () => {
  const recordA = "4bc80c96-0415-4bdc-bf17-83a919154594";
  const recordB = "4bc80c96-0415-4bdc-bf17-83a919154593";
  const session = (recordId: string) => `manual-strength-${recordId}`;
  const historyThreadIds: string[] = [];
  const chatContexts: unknown[] = [];
  const checkpointer = {
    async getTuple(config) {
      historyThreadIds.push(config.configurable.thread_id);
      return undefined;
    },
    async listThreadsForUser() {
      return [session(recordA), "mini-default", session(recordB)].map((sessionId) => ({ sessionId, updatedAt: null, preview: "" }));
    },
  } satisfies ThreadHistoryReader & ThreadSessionReader;
  const app = createApp({
    jwtVerifier: {
      async verify(header) {
        if (header === "Bearer owner") return { userId: "owner", isAdmin: false };
        if (header === "Bearer other") return { userId: "other", isAdmin: false };
        throw new AuthError("missing");
      },
    },
    strengthReviewRecords: {
      async getManualStrengthDetail(userId, recordId): Promise<ManualStrengthRecord | null> {
        if (userId !== "owner" || (recordId !== recordA && recordId !== recordB)) return null;
        const start = new Date("2026-11-26T00:00:00Z");
        return { id: recordId, name: recordId === recordA ? "早练" : "晚练", startedAt: start, endedAt: start, note: "", actions: [] };
      },
    },
    checkpointer,
    coachInvoker: {
      async invoke(_input, config) {
        chatContexts.push(config.context);
        return { messages: [{ type: "ai", content: "复盘完成" }] };
      },
      async streamEvents(_input, config) {
        chatContexts.push(config.context);
        return {
          events: (async function* () {
            yield ["values", { messages: [{ type: "ai", content: "复盘完成" }] }] as const;
          })(),
        };
      },
    },
  });
  const base = "/api/users/me/coach";
  const headers = (user = "owner") => ({ authorization: `Bearer ${user}` });
  const history = (id: string, user = "owner") => app.request(`${base}/sessions/${id}/messages`, { headers: headers(user) });
  const chat = (id: string, user = "owner", extra: Record<string, unknown> = {}, accept = "application/json") =>
    app.request(`${base}/chat`, {
      method: "POST",
      headers: { ...headers(user), "content-type": "application/json", accept },
      body: JSON.stringify({ session_id: id, client_turn_id: "turn-1", message: "做了什么", ...extra }),
    });

  const [first, repeated, second] = await Promise.all([history(session(recordA)), history(session(recordA)), history(session(recordB))]);
  assert.equal(first.status, 200);
  const firstHistory = {
    session_id: session(recordA), thread_id: `owner:coach:${session(recordA)}`, messages: [],
    strength_review: { record_id: recordA, name: "早练", started_at: "2026-11-26T00:00:00.000Z" },
  };
  const secondHistory = {
    ...firstHistory, session_id: session(recordB), thread_id: `owner:coach:${session(recordB)}`,
    strength_review: { ...firstHistory.strength_review, record_id: recordB, name: "晚练" },
  };
  assert.deepEqual(await first.json(), firstHistory);
  assert.deepEqual(await repeated.json(), firstHistory);
  assert.deepEqual(await second.json(), secondHistory);
  assert.notEqual(firstHistory.thread_id, secondHistory.thread_id);
  assert.deepEqual(historyThreadIds.sort(), [firstHistory.thread_id, firstHistory.thread_id, secondHistory.thread_id].sort());
  assert.equal(chatContexts.length, 0, "opening the session never starts a model turn");
  assert.equal((await history(session(recordA), "other")).status, 404);
  assert.equal((await chat(session(recordA), "other", {}, "text/event-stream")).status, 404);
  const alias = `Manual-strength-${recordA}`;
  assert.equal((await history(alias)).status, 404);
  assert.equal((await chat(alias)).status, 404);
  assert.equal((await chat(session(recordA), "owner", { target: { kind: "master" } })).status, 400);
  assert.equal(chatContexts.length, 0);

  assert.equal((await chat(session(recordA))).status, 200);
  const stream = await chat(session(recordB), "owner", {}, "text/event-stream");
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /event: done/);
  assert.equal((await chat("mini-default", "owner", { strengthReviewRecordId: recordA })).status, 200);
  assert.deepEqual(chatContexts.map((scope) => Reflect.get(scope as object, "strengthReviewRecordId")), [recordA, recordB, undefined]);
  const list = await (await app.request(`${base}/sessions`, { headers: headers() })).json();
  assert.deepEqual(list, { sessions: [{ session_id: "mini-default", updated_at: null, preview: "" }] });
});
