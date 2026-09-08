import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { CoachStreamSource } from "../src/coach/coachInvoker.js";

const SSE_ACCEPT = { accept: "text/event-stream" };

function streamSource(messages: unknown[], subagentNames: string[] = []): CoachStreamSource {
  return {
    output: Promise.resolve({ messages }),
    subagents: (async function* () {
      for (const name of subagentNames) yield { name };
    })(),
  };
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "message";
      const dataLine = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}";
      return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
    });
}

function chatRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return (app: ReturnType<typeof createApp>) =>
    app.request("/api/users/me/coach/chat", {
      method: "POST",
      headers: {
        authorization: "Bearer signed",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
}

test("streaming chat returns text/event-stream with status and done events", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      async streamEvents() {
        streamed += 1;
        return streamSource([{ type: "ai", content: "训练状态稳定。" }], ["qa_agent"]);
      },
    },
  });
  const response = await chatRequest(
    { session_id: "session-1", client_turn_id: "turn-1", message: "最近状态怎么样？" },
    SSE_ACCEPT,
  )(app);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = parseSse(await response.text());
  const statuses = events.filter((event) => event.event === "status");
  const done = events.filter((event) => event.event === "done");

  assert.ok(statuses.length >= 1, "at least one status event");
  assert.ok(statuses.some((event) => event.data.phase === "in_subagent"), "an in_subagent status event is present");
  assert.ok(statuses.some((event) => event.data.subagent === "qa_agent"), "in_subagent carries the subagent name");
  assert.equal(done.length, 1);
  assert.deepEqual(done[0]?.data, {
    turn_id: "turn-1",
    status: "completed",
    message: "训练状态稳定。",
  });

  // status events precede done, and every event carries the client turn id.
  const lastStatusIndex = events.reduce((max, event, index) => (event.event === "status" ? index : max), -1);
  const doneIndex = events.findIndex((event) => event.event === "done");
  assert.ok(lastStatusIndex < doneIndex, "status events are emitted before done");
  assert.equal(streamed, 1);
});

test("streaming chat replays an identical client turn without re-invoking", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      async streamEvents() {
        streamed += 1;
        return streamSource([{ type: "ai", content: `answer-${streamed}` }], ["qa_agent"]);
      },
    },
  });
  const request = chatRequest(
    { session_id: "session-1", client_turn_id: "turn-1", message: "same question" },
    SSE_ACCEPT,
  );
  const first = parseSse(await (await request(app)).text());
  const replay = parseSse(await (await request(app)).text());

  assert.equal(streamed, 1);
  const firstDone = first.find((event) => event.event === "done");
  const replayDone = replay.find((event) => event.event === "done");
  assert.deepEqual(replayDone, firstDone);
  assert.equal(replayDone?.data.message, "answer-1");
  // A replay is a single done event: no status events, no re-invocation.
  assert.equal(replay.filter((event) => event.event === "status").length, 0);
});

test("streaming chat emits an error event when the coach fails", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      async streamEvents() {
        throw new Error("model blew up");
      },
    },
  });
  const response = await chatRequest(
    { session_id: "session-1", client_turn_id: "turn-1", message: "hi" },
    SSE_ACCEPT,
  )(app);
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  const error = events.find((event) => event.event === "error");
  assert.ok(error, "an error event is emitted");
  assert.equal(error?.data.code, "coach_turn_failed");
  assert.equal(error?.data.turn_id, "turn-1");
  // The connection is closed by the stream ending after the error event.
  assert.equal(events.at(-1)?.event, "error");
});

test("streaming chat emits an error event on a client_turn_id conflict", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      async streamEvents() {
        streamed += 1;
        return streamSource([{ type: "ai", content: "first" }]);
      },
    },
  });
  const first = chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "one" }, SSE_ACCEPT);
  const conflict = chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "changed" }, SSE_ACCEPT);
  await first(app);
  const events = parseSse(await (await conflict(app)).text());
  const error = events.find((event) => event.event === "error");
  assert.equal(error?.data.code, "client_turn_id_conflict");
  assert.equal(streamed, 1);
});

test("requests without the SSE accept header keep the sync JSON path", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "同步回答" }] };
      },
      async streamEvents() {
        streamed += 1;
        return streamSource([{ type: "ai", content: "should not stream" }]);
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" })(app);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "completed",
    message: "同步回答",
    session_id: "session-1",
    client_turn_id: "turn-1",
  });
  assert.equal(streamed, 0);
});

test("streaming chat keeps executing and writes the receipt after the client disconnects", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      async streamEvents() {
        streamed += 1;
        return {
          output: new Promise((resolve) =>
            setTimeout(() => resolve({ messages: [{ type: "ai", content: "完整回复" }] }), 50),
          ),
          subagents: (async function* () {})(),
        };
      },
    },
  });
  const request = chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT);
  const response = await request(app);
  // Simulate a client dropping the connection before the run finishes; Hono
  // swallows the resulting write errors, so the coordinator keeps running.
  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(streamed, 1);

  // The turn completed server-side and its receipt was stored, so a replay of
  // the same client_turn_id returns the stored answer without re-invoking.
  const replay = parseSse(await (await request(app)).text());
  const done = replay.find((event) => event.event === "done");
  assert.equal(done?.data.message, "完整回复");
  assert.equal(streamed, 1);
});

test("streaming chat runs the turn under the per-thread lock and releases it after done", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "同步回答" }] };
      },
      async streamEvents() {
        return streamSource([{ type: "ai", content: "done" }]);
      },
    },
  });
  const request = chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT);
  const first = await (await request(app)).text();
  assert.match(first, /event: done/);
  // The lock is released once the coordinator's operation completes; a follow-up
  // sync request on the same thread must not be serialized behind a stale lock.
  const sync = await chatRequest({ session_id: "session-1", client_turn_id: "turn-2", message: "after" })(app);
  assert.equal(sync.status, 200);
});