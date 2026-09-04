import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "@stride/coach-agent";
import { createApp } from "../src/app.js";
import { AuthError } from "../src/auth.js";
import { ThreadBusyError } from "../src/turn/errors.js";
import { createInMemoryTurnCoordinator } from "../src/turn/index.js";

const fingerprintTurn = (payload: unknown) => createInMemoryTurnCoordinator().getFingerprint(payload);

test("health is public", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new AuthError("no");
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
    },
  });
  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("OpenAPI document describes the live routes and bearer authentication", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new Error("must not verify");
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
    },
  });
  const response = await app.request("/openapi.json");
  assert.equal(response.status, 200);
  const document = (await response.json()) as Record<string, unknown>;
  assert.equal(document.openapi, "3.1.0");
  const paths = document.paths as Record<string, Record<string, unknown>>;
  assert.ok(paths["/health"]?.get);
  const chat = paths["/api/users/me/coach/chat"]?.post as Record<string, unknown>;
  assert.deepEqual(chat.security, [{ bearerAuth: [] }]);
  const components = document.components as Record<string, unknown>;
  assert.ok((components.schemas as Record<string, unknown>).ChatRequest);
});

test("Swagger UI is served for the OpenAPI document", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new Error("must not verify");
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
    },
  });
  const response = await app.request("/docs");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  const html = await response.text();
  assert.match(html, /Coach Agent API documentation/);
  assert.match(html, /\/openapi\.json/);
  assert.match(html, /swagger-ui-dist@5\.32\.14/);
  assert.match(html, /persistAuthorization: false/);
  assert.match(html, /integrity="sha384-/);
  assert.doesNotMatch(html, /swagger-ui-dist(?!@5\.32\.14)/);
});

test("chat derives user and thread identity from the verified token", async () => {
  let invocation: { input: unknown; config: Record<string, unknown> } | undefined;
  const app = createApp({
    jwtVerifier: {
      async verify(header) {
        assert.equal(header, "Bearer signed");
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke(input, config) {
        invocation = { input, config };
        return { messages: [{ type: "ai", content: "训练状态稳定。" }] };
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-1",
      message: "最近状态怎么样？",
      timestamp: "2026-05-09T14:30:00+08:00",
      user_id: "attacker",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "completed",
    message: "训练状态稳定。",
    session_id: "session-1",
    client_turn_id: "turn-1",
  });
  assert.deepEqual(invocation, {
    input: {
      messages: [
        { role: "user", content: '{"timestamp":"2026-05-09T14:30:00+08:00","message":"最近状态怎么样？"}' },
      ],
    },
    config: {
      context: {
        userId: "athlete-1",
        asof: new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      },
      configurable: {
        thread_id: "athlete-1:coach:session-1",
        client_turn_id: "turn-1",
      },
      metadata: {
        client_turn_id: "turn-1",
        turn_fingerprint: fingerprintTurn({
          sessionId: "session-1",
          clientTurnId: "turn-1",
          message: "最近状态怎么样？",
          timestamp: "2026-05-09T14:30:00+08:00",
        }),
      },
    },
  });
});

test("chat never exposes a tool message as the public answer", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        return {
          messages: [
            { type: "ai", content: "安全回答" },
            { type: "tool", content: "private tool payload" },
          ],
        };
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-1",
      message: "hi",
    }),
  });
  assert.deepEqual(await response.json(), {
    status: "completed",
    message: "安全回答",
    session_id: "session-1",
    client_turn_id: "turn-1",
  });
});

test("chat resumes an interrupt without requiring a new message", async () => {
  let input: unknown;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke(value) {
        input = value;
        return { messages: [{ type: "ai", content: "继续处理" }] };
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-2",
      resume: "每周六长跑",
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(input instanceof Command);
  assert.equal(input.resume, "每周六长跑");
});

test("chat accepts multi-select interrupt answers", async () => {
  let input: unknown;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke(value) {
        input = value;
        return { messages: [{ type: "ai", content: "继续处理" }] };
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-2",
      resume: ["周六", "周日"],
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(input instanceof Command);
  assert.deepEqual(input.resume, ["周六", "周日"]);
});

test("chat fails closed without a valid bearer token", async () => {
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new AuthError("missing");
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
});

test("chat validates the public request contract before invoking Coach", async () => {
  let called = false;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        called = true;
        return {};
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "bad/id",
      client_turn_id: "turn-1",
      message: "hi",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("chat rejects a malformed timestamp", async () => {
  let called = false;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        called = true;
        return {};
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-1",
      message: "hi",
      timestamp: "not-a-date",
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_timestamp" });
  assert.equal(called, false);
});

test("chat defaults the message timestamp to Asia/Shanghai time", async () => {
  let input: unknown;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke(value) {
        input = value;
        return { messages: [{ type: "ai", content: "ok" }] };
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-1",
      message: "hi",
    }),
  });
  assert.equal(response.status, 200);
  const raw = (input as { messages: { content: string }[] }).messages[0]!.content;
  const content = JSON.parse(raw) as { timestamp: string; message: string };
  assert.equal(content.message, "hi");
  assert.notEqual(content.timestamp, undefined);
  assert.match(content.timestamp, /\+08:00$/);
  assert.equal(new Date(content.timestamp).valueOf() <= Date.now(), true);
});

test("chat replays an identical client turn and conflicts on changed input", async () => {
  let calls = 0;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        calls += 1;
        return { messages: [{ type: "ai", content: `answer-${calls}` }] };
      },
    },
  });
  const request = (message: string) =>
    app.request("/api/users/me/coach/chat", {
      method: "POST",
      headers: {
        authorization: "Bearer signed",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-1",
        client_turn_id: "turn-1",
        message,
      }),
    });
  const first = await request("same");
  const replay = await request("same");
  assert.deepEqual(await first.json(), await replay.json());
  assert.equal(calls, 1);
  const conflict = await request("changed");
  assert.equal(conflict.status, 409);
  assert.equal(calls, 1);
});

test("chat carries validated target and review context into request identity and runtime", async () => {
  let invocation: { input: unknown; config: Record<string, unknown> } | undefined;
  const app = createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke(input, config) {
        invocation = { input, config };
        return { messages: [{ type: "ai", content: "scoped" }] };
      },
    },
  });
  const target = { kind: "week", folder: "2026-08-17_08-23" };
  const reviewContext = {
    kind: "weekly_create",
    proposal: { folder: target.folder, days: [] },
  };
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-scope",
      message: "解释这个草稿",
      target,
      review_context: reviewContext,
    }),
  });
  assert.equal(response.status, 200);
  const runtimeContext = invocation?.config.context as Record<string, unknown>;
  assert.deepEqual(runtimeContext.target, target);
  assert.deepEqual(runtimeContext.reviewContext, reviewContext);
  assert.ok(invocation);
  const fingerprint = (invocation.config.metadata as Record<string, unknown>).turn_fingerprint;
  assert.equal(
    fingerprint,
    fingerprintTurn({
      sessionId: "session-1",
      clientTurnId: "turn-scope",
      message: "解释这个草稿",
      target,
      reviewContext,
    }),
  );
});

test("chat rejects review context that does not match the target week", async () => {
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
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-scope",
      message: "解释这个草稿",
      target: { kind: "week", folder: "2026-08-17_08-23" },
      review_context: {
        kind: "weekly_create",
        proposal: { folder: "2026-08-24_08-30" },
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_turn_scope" });
});

test("chat returns an explicit retryable response when the thread is busy", async () => {
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
    },
    turnCoordinator: {
      getFingerprint() {
        return "fingerprint";
      },
      async run() {
        throw new ThreadBusyError("busy");
      },
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-1",
      message: "hi",
    }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.deepEqual(await response.json(), { error: "coach_thread_busy" });
});

test("chat rejects empty interrupt answers", async () => {
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
    },
  });
  const response = await app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer signed",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_id: "session-1",
      client_turn_id: "turn-1",
      resume: "   ",
    }),
  });
  assert.equal(response.status, 400);
});
