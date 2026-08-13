import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "@langchain/langgraph";
import { createApp } from "./app.js";
import { AuthError } from "./auth.js";

test("health is public", async () => {
	const app = createApp({
		jwtVerifier: {
			async verify() {
				throw new AuthError("no");
			},
		},
		coach: {
			async invoke() {
				throw new Error("must not invoke");
			},
		},
	});
	const response = await app.request("/health");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "ok" });
});

test("chat derives user and thread identity from the verified token", async () => {
	let invocation:
		| { input: unknown; config: Record<string, unknown> }
		| undefined;
	const app = createApp({
		jwtVerifier: {
			async verify(header) {
				assert.equal(header, "Bearer signed");
				return { userId: "athlete-1" };
			},
		},
		coach: {
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
			user_id: "attacker",
		}),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "completed",
		message: "训练状态稳定。",
	});
	assert.deepEqual(invocation, {
		input: { messages: [{ role: "user", content: "最近状态怎么样？" }] },
		config: {
			context: { userId: "athlete-1" },
			configurable: {
				thread_id: "athlete-1:coach:session-1",
				client_turn_id: "turn-1",
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
		coach: {
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
		coach: {
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
		coach: {
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
		coach: {
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
		coach: {
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

test("chat replays an identical client turn and conflicts on changed input", async () => {
	let calls = 0;
	const app = createApp({
		jwtVerifier: {
			async verify() {
				return { userId: "athlete-1" };
			},
		},
		coach: {
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

test("chat rejects empty interrupt answers", async () => {
	const app = createApp({
		jwtVerifier: {
			async verify() {
				return { userId: "athlete-1" };
			},
		},
		coach: {
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
