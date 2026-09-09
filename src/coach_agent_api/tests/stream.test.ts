import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { CoachStreamSource, CoachStreamSubagent, CoachStreamToolCall } from "../src/coach/coachInvoker.js";

const SSE_ACCEPT = { accept: "text/event-stream" };

function emptyIterable<T>(): AsyncIterable<T> {
  return (async function* () {})();
}

function message(text: string[]): { text: AsyncIterable<string> } {
  return { text: (async function* () { for (const chunk of text) yield chunk; })() };
}

function tool(name: string, status: CoachStreamToolCall["status"] = Promise.resolve("finished")): CoachStreamToolCall {
  return { name, status };
}

function subagent(name: string): CoachStreamSubagent {
  return { name, toolCalls: emptyIterable(), subagents: emptyIterable() };
}

function subagents(list: CoachStreamSubagent[]): AsyncIterable<CoachStreamSubagent> {
  return (async function* () {
    for (const item of list) yield item;
  })();
}

/**
 * Build a CoachStreamSource from parts.
 */
function source(overrides: Partial<CoachStreamSource>): CoachStreamSource {
  return { output: Promise.resolve({ messages: [] }), messages: emptyIterable(), toolCalls: emptyIterable(), subagents: emptyIterable(), ...overrides };
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

/** The QA scenario from the acceptance criteria: intent → subagent → tool start → tool end → ... → generating → text stream → done. */
function qaStream(): CoachStreamSource {
  const outputMessage = { type: "ai", content: "本周负荷稳定，建议维持。", usage_metadata: { input_tokens: 120, output_tokens: 9, total_tokens: 129 } };
  return source({
    output: Promise.resolve({ messages: [outputMessage] }),
    // The reply is the outer agent's message; the subagent's own text is an
    // intermediate tool result and is not streamed.
    messages: (async function* () {
      yield message(["本周负荷稳定", "，建议维持。"]);
    })(),
    subagents: subagents([
      {
        name: "qa_agent",
        toolCalls: (async function* () {
          yield tool("get_daily_training_load");
          yield tool("get_activities_by_date_range");
        })(),
        subagents: emptyIterable(),
      },
    ]),
  });
}

test("streaming chat returns text/event-stream with status and done events", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
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

  assert.ok(statuses.some((event) => event.data.phase === "in_subagent"), "an in_subagent status event is present");
  assert.ok(statuses.some((event) => event.data.subagent === "qa_agent"), "in_subagent carries the subagent name");
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
      async appendThreadMessage() { throw new Error("must not append"); },
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

test("every tool call emits a start and a matching end running_tool event carrying the tool name", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() { return qaStream(); },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());
  const toolEvents = events.filter((event) => event.event === "status" && event.data.phase === "running_tool");

  const names = toolEvents.map((event) => event.data.tool as string);
  assert.deepEqual(names, ["get_daily_training_load", "get_daily_training_load", "get_activities_by_date_range", "get_activities_by_date_range"]);
  assert.deepEqual(toolEvents.map((event) => event.data.tool_status), ["running", "finished", "running", "finished"]);
});

test("a failing tool still emits a running_tool end event with tool_status error", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        return source({
          output: Promise.resolve({ messages: [{ type: "ai", content: "回答" }] }),
          messages: (async function* () { yield message(["回答"]); })(),
          subagents: subagents([
            {
              name: "qa_agent",
              toolCalls: (async function* () {
                yield tool("get_daily_training_load", Promise.reject(new Error("boom")));
              })(),
              subagents: emptyIterable(),
            },
          ]),
        });
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
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        return source({
          output: Promise.resolve({
            messages: [
              { type: "ai", content: "x", usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
              { type: "ai", content: "y", usage_metadata: { input_tokens: 2, output_tokens: 3 } },
            ],
          }),
          messages: (async function* () { yield message(["y"]); })(),
        });
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());
  const done = events.find((event) => event.event === "done");

  assert.equal(done?.data.message, "y");
  assert.deepEqual(done?.data.usage, { input_tokens: 12, output_tokens: 8, total_tokens: 20 });
});

test("QA multi-tool flow emits events in a reasonable order: intent → subagent → tool → generating → text → done", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() { return qaStream(); },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  const events = parseSse(await response.text());

  // Condense to the label that matters for ordering.
  const labels = events.map((event) => {
    if (event.event === "done") return "done";
    if (event.event === "text_delta") return "text";
    return (event.data.phase as string) ?? event.event;
  });

  const intent = labels.indexOf("analyzing_intent");
  const inSubagent = labels.indexOf("in_subagent");
  const firstTool = labels.indexOf("running_tool");
  const generating = labels.indexOf("generating_response");
  const firstText = labels.indexOf("text");
  const done = labels.indexOf("done");

  assert.ok(intent >= 0, "analyzing_intent emitted");
  assert.ok(inSubagent > intent, "in_subagent after analyzing_intent");
  assert.ok(firstTool > inSubagent, "running_tool after in_subagent");
  assert.ok(generating > firstTool, "generating_response after tools");
  assert.ok(firstText > generating, "text after generating_response");
  assert.ok(done > firstText, "done after the text stream");
  assert.equal(done, labels.length - 1, "done is the last event");
});

test("streaming chat replays an identical client turn without re-invoking", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
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

test("streaming chat ignores a failing status iterable and still emits done", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        return source({
          output: Promise.resolve({ messages: [{ type: "ai", content: "仍在回答" }] }),
          subagents: (async function* () {
            throw new Error("status stream blew up");
            yield subagent("qa_agent");
          })(),
        });
      },
    },
  });
  const response = await chatRequest({ session_id: "session-1", client_turn_id: "turn-1", message: "hi" }, SSE_ACCEPT)(app);
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  const done = events.filter((event) => event.event === "done");
  // The run's final state is authoritative; a subagent-status failure is
  // non-fatal, so the turn still completes with a single done event.
  assert.equal(done.length, 1);
  assert.equal(done[0]?.data.message, "仍在回答");
});

test("streaming chat emits an error event when the coach fails", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
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
  // The connection is closed by the stream ending after the error event.
  assert.equal(events.at(-1)?.event, "error");
});

test("streaming chat emits an error event on a client_turn_id conflict", async () => {
  let streamed = 0;
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "athlete-1" }; } },
    coachInvoker: {
      async invoke() { throw new Error("must not invoke"); },
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        streamed += 1;
        return source({ output: Promise.resolve({ messages: [{ type: "ai", content: "first" }] }) });
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
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        streamed += 1;
        return source({ output: Promise.resolve({ messages: [{ type: "ai", content: "should not stream" }] }) });
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
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        streamed += 1;
        return source({
          output: new Promise((resolve) =>
            setTimeout(() => resolve({ messages: [{ type: "ai", content: "完整回复" }] }), 50),
          ),
        });
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
      async appendThreadMessage() { throw new Error("must not append"); },
      async streamEvents() {
        return source({ output: Promise.resolve({ messages: [{ type: "ai", content: "done" }] }) });
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
