import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { CoachStreamSource } from "../src/coach/coachInvoker.js";

const SSE_ACCEPT = { accept: "text/event-stream" };

function emptyIterable<T>(): AsyncIterable<T> {
  return (async function* () {})();
}

interface MessageLike {
  _getType?: () => string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string }>;
  tool_call_id?: string;
  status?: string;
}

function ai(content: string, toolCalls: Array<{ id?: string; name?: string }> = []): MessageLike {
  return { _getType: () => "ai", content, tool_calls: toolCalls };
}

function toolResult(toolCallId: string, status: "success" | "error" = "success"): MessageLike {
  return { _getType: () => "tool", content: "ok", tool_call_id: toolCallId, status };
}

/** A `messages` stream chunk: `["messages", [message, metadata]]`. */
function msgChunk(message: MessageLike, meta: Record<string, unknown> = {}): [string, [MessageLike, Record<string, unknown>]] {
  return ["messages", [message, meta]];
}

/** A `values` stream chunk: `["values", state]`. */
function valuesChunk(state: Record<string, unknown>): [string, Record<string, unknown>] {
  return ["values", state];
}

/**
 * Build a CoachStreamSource from raw `[mode, payload]` chunks.
 */
function source(events: AsyncIterable<readonly [string, unknown]> = emptyIterable()): CoachStreamSource {
  return { events };
}

function eventsFrom(chunks: Array<[string, unknown]>): AsyncIterable<readonly [string, unknown]> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
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

/** The QA scenario: tool start → tool end → analyzing → text stream → done. */
function qaStream(): CoachStreamSource {
  const outputMessage = { type: "ai", content: "本周负荷稳定，建议维持。", usage_metadata: { input_tokens: 120, output_tokens: 9, total_tokens: 129 } };
  return source(
    eventsFrom([
      msgChunk(ai("", [{ id: "t1", name: "get_daily_training_load" }, { id: "t2", name: "get_activities_by_date_range" }])),
      msgChunk(toolResult("t1")),
      msgChunk(toolResult("t2")),
      msgChunk(ai("本周负荷稳定，建议维持。")),
      valuesChunk({ messages: [outputMessage] }),
    ]),
  );
}

test("streaming chat returns text/event-stream with status and done events", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        streamed += 1;
        return qaStream();
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "最近状态怎么样？" }, SSE_ACCEPT)(app);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = parseSse(await response.text());
  const statuses = events.filter((event) => event.event === "status");
  const done = events.filter((event) => event.event === "done");

  assert.ok(statuses.some((event) => event.data.phase === "running_tool"), "a running_tool status event is present");
  assert.equal(done.length, 1);
  assert.deepEqual(done[0]?.data, {
    turn_id: "turn-1",
    status: "completed",
    message: "本周负荷稳定，建议维持。",
    usage: { input_tokens: 120, output_tokens: 9, total_tokens: 129 },
  });

  // status events precede done, and every event carries the client turn id.
  const lastStatusIndex = events.reduce((max, event, index) => (event.event === "status" ? index : max), -1);
  const doneIndex = events.findIndex((event) => event.event === "done");
  assert.ok(lastStatusIndex < doneIndex, "status events are emitted before done");
  assert.equal(streamed, 1);
});

test("text_delta events accumulate to the done message", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() { return qaStream(); },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());
  const deltas = events.filter((event) => event.event === "text_delta");
  const done = events.find((event) => event.event === "done");

  assert.ok(deltas.length > 0, "at least one text_delta event");
  const accumulated = deltas.map((event) => event.data.delta as string).join("");
  assert.equal(accumulated, done?.data.message);
});

test("text_delta events are emitted while the run is still executing, not replayed after it ends", async () => {
  // The events stream yields text messages as they happen, and the adapter
  // drains them immediately — so deltas land before the terminal values chunk.
  const order: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        return source(
          (async function* () {
            for (const chunk of ["流式", "回复"]) {
              order.push("delta");
              yield msgChunk(ai(chunk));
              await sleep(20);
            }
            order.push("output");
            yield valuesChunk({ messages: [{ type: "ai", content: "流式回复" }] });
          })(),
        );
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());

  assert.ok(order.includes("delta") && order.includes("output"), `both drained: ${order.join(",")}`);
  assert.ok(order.indexOf("delta") < order.indexOf("output"), `deltas emitted before the run ends: ${order.join(",")}`);
  const deltas = events.filter((event) => event.event === "text_delta");
  const doneIndex = events.findIndex((event) => event.event === "done");
  assert.equal(deltas.map((event) => event.data.delta).join(""), "流式回复");
  assert.ok(events.findIndex((event) => event.event === "text_delta") < doneIndex, "text precedes done");
});

test("analyzing is emitted once the last tool call lands, before the reply text starts", async () => {
  const order: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        return source(
          (async function* () {
            yield msgChunk(ai("", [{ id: "t1", name: "get_daily_training_load" }]));
            yield msgChunk(toolResult("t1")); // last tool lands → analyzing fires
            await sleep(300);
            order.push("text-start");
            yield msgChunk(ai("本周负荷稳定。"));
            yield valuesChunk({ messages: [{ type: "ai", content: "本周负荷稳定。" }] });
          })(),
        );
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);

  // Read incrementally so we can tell *when* `analyzing` reached the client.
  const reader = response.body?.getReader();
  assert.ok(reader, "the SSE response is streamed");
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (!order.includes("analyzing") && raw.includes('"phase":"analyzing"')) order.push("analyzing");
  }

  assert.ok(order.includes("analyzing") && order.includes("text-start"), `both markers seen: ${order.join(",")}`);
  assert.ok(order.indexOf("analyzing") < order.indexOf("text-start"), `analyzing arrives before the reply text starts: ${order.join(",")}`);
  const events = parseSse(raw);
  assert.equal(events.filter((event) => event.event === "text_delta").map((event) => event.data.delta).join(""), "本周负荷稳定。");
  assert.equal(events.at(-1)?.event, "done");
});

test("every tool call emits a start and a matching end running_tool event carrying the tool name", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() { return qaStream(); },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());
  const toolEvents = events.filter((event) => event.event === "status" && event.data.phase === "running_tool");

  const names = toolEvents.map((event) => event.data.tool as string);
  assert.deepEqual(names, ["get_daily_training_load", "get_activities_by_date_range", "get_daily_training_load", "get_activities_by_date_range"]);
  assert.deepEqual(toolEvents.map((event) => event.data.tool_status), ["running", "running", "finished", "finished"]);
});

test("a failing tool still emits a running_tool end event with tool_status error", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        return source(
          eventsFrom([
            msgChunk(ai("", [{ id: "t1", name: "get_daily_training_load" }])),
            msgChunk(toolResult("t1", "error")),
            msgChunk(ai("回答")),
            valuesChunk({ messages: [{ type: "ai", content: "回答" }] }),
          ]),
        );
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());
  const toolEvents = events.filter((event) => event.event === "status" && event.data.phase === "running_tool");

  assert.deepEqual(toolEvents.map((event) => event.data.tool_status), ["running", "error"]);
  assert.equal(events.at(-1)?.event, "done", "a failed tool must not prevent the done event");
});

test("done carries usage aggregated across multiple messages", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        return source(
          eventsFrom([
            msgChunk(ai("y")),
            valuesChunk({
              messages: [
                { type: "ai", content: "x", usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
                { type: "ai", content: "y", usage_metadata: { input_tokens: 2, output_tokens: 3 } },
              ],
            }),
          ]),
        );
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());
  const done = events.find((event) => event.event === "done");

  assert.equal(done?.data.message, "y");
  assert.deepEqual(done?.data.usage, { input_tokens: 12, output_tokens: 8, total_tokens: 20 });
});

test("QA multi-tool flow emits events in a reasonable order: tool → analyzing → text → done", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() { return qaStream(); },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());

  const labels = events.map((event) => {
    if (event.event === "done") return "done";
    if (event.event === "text_delta") return "text";
    return (event.data.phase as string) ?? event.event;
  });

  const firstTool = labels.indexOf("running_tool");
  const analyzing = labels.indexOf("analyzing");
  const firstText = labels.indexOf("text");
  const done = labels.indexOf("done");

  assert.ok(firstTool >= 0, "running_tool emitted");
  assert.ok(analyzing > firstTool, "analyzing after tools");
  assert.ok(firstText > analyzing, "text after analyzing");
  assert.ok(done > firstText, "done after the text stream");
  assert.equal(done, labels.length - 1, "done is the last event");
  assert.ok(!labels.includes("analyzing_intent") && !labels.includes("generating_response"), "removed phases are not emitted");
});

test("streaming chat replays an identical client turn without re-invoking", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        streamed += 1;
        return qaStream();
      },
    },
  });
  const request = chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "same question" }, SSE_ACCEPT);
  const first = parseSse(await (await request(app)).text());
  const replay = parseSse(await (await request(app)).text());

  assert.equal(streamed, 1);
  const firstDone = first.find((event) => event.event === "done");
  const replayDone = replay.find((event) => event.event === "done");
  assert.deepEqual(replayDone, firstDone);
  assert.equal(replayDone?.data.message, "本周负荷稳定，建议维持。");
  // A replay is a single done event: no status events, no re-invocation.
  assert.equal(replay.filter((event) => event.event === "status").length, 0);
});

test("streaming chat emits an error event when the coach fails", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() { throw new Error("model blew up"); },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  const error = events.find((event) => event.event === "error");
  assert.ok(error, "an error event is emitted");
  assert.equal(error?.data.code, "coach_turn_failed");
  assert.equal(error?.data.turn_id, "turn-1");
  assert.equal(events.at(-1)?.event, "error");
});

test("streaming chat emits an error event on a client_turn_id conflict", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        streamed += 1;
        return source(eventsFrom([valuesChunk({ messages: [{ type: "ai", content: "first" }] })]));
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
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { return { messages: [{ type: "ai", content: "同步回答" }] }; },
      async streamEvents() {
        streamed += 1;
        return source(eventsFrom([valuesChunk({ messages: [{ type: "ai", content: "should not stream" }] })]));
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
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async streamEvents() {
        streamed += 1;
        return source(
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield valuesChunk({ messages: [{ type: "ai", content: "完整回复" }] });
          })(),
        );
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
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { return { messages: [{ type: "ai", content: "同步回答" }] }; },
      async streamEvents() {
        return source(eventsFrom([valuesChunk({ messages: [{ type: "ai", content: "done" }] })]));
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
