import { Command } from "@langchain/langgraph";
import { Hono } from "hono";
import type { JwtVerifier } from "./auth.js";
import { AuthError } from "./auth.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CoachInvoker {
	invoke(input: unknown, config: Record<string, unknown>): Promise<unknown>;
}

export interface AppDependencies {
	jwtVerifier: JwtVerifier;
	coach: CoachInvoker;
}

export function createApp(dependencies: AppDependencies): Hono {
	const app = new Hono();

	app.get("/health", (context) => context.json({ status: "ok" }));

	app.post("/api/users/me/coach/chat", async (context) => {
		let identity: { userId: string };
		try {
			identity = await dependencies.jwtVerifier.verify(
				context.req.header("authorization"),
			);
		} catch (error) {
			if (error instanceof AuthError) {
				context.header("WWW-Authenticate", "Bearer");
				return context.json({ error: "unauthorized" }, 401);
			}
			throw error;
		}

		const body = await readChatRequest(context.req.raw);
		if (!body.ok) return context.json({ error: body.error }, 400);
		const threadId = `${identity.userId}:coach:${body.value.sessionId}`;
		const input =
			body.value.resume === undefined
				? {
						messages: [{ role: "user", content: body.value.message as string }],
					}
				: new Command({ resume: body.value.resume });
		const result = await dependencies.coach.invoke(input, {
			context: { userId: identity.userId },
			configurable: {
				thread_id: threadId,
				client_turn_id: body.value.clientTurnId,
			},
		});
		return context.json(toPublicResponse(result));
	});

	return app;
}

type ChatRequest = {
	sessionId: string;
	clientTurnId: string;
	message?: string;
	resume?: string | string[];
};
async function readChatRequest(
	request: Request,
): Promise<{ ok: true; value: ChatRequest } | { ok: false; error: string }> {
	let value: unknown;
	try {
		value = await request.json();
	} catch {
		return { ok: false, error: "invalid_json" };
	}
	if (!isRecord(value)) return { ok: false, error: "invalid_request" };
	const sessionId = value.session_id;
	const clientTurnId = value.client_turn_id;
	const message = value.message;
	const resume = value.resume;
	if (typeof sessionId !== "string" || !ID_RE.test(sessionId))
		return { ok: false, error: "invalid_session_id" };
	if (typeof clientTurnId !== "string" || !ID_RE.test(clientTurnId))
		return { ok: false, error: "invalid_client_turn_id" };
	if (
		message !== undefined &&
		(typeof message !== "string" ||
			message.trim().length === 0 ||
			message.length > 20_000)
	)
		return { ok: false, error: "invalid_message" };
	if (resume !== undefined && !isValidResume(resume))
		return { ok: false, error: "invalid_resume" };
	if ((message === undefined) === (resume === undefined)) {
		return { ok: false, error: "message_or_resume_required" };
	}
	return {
		ok: true,
		value: {
			sessionId,
			clientTurnId,
			...(typeof message === "string" ? { message } : {}),
			...(resume !== undefined ? { resume } : {}),
		},
	};
}

function isValidResume(value: unknown): value is string | string[] {
	if (typeof value === "string") return value.length <= 20_000;
	return (
		Array.isArray(value) &&
		value.length <= 50 &&
		value.every(
			(answer) => typeof answer === "string" && answer.length <= 2_000,
		) &&
		value.reduce((length, answer) => length + answer.length, 0) <= 20_000
	);
}

function toPublicResponse(result: unknown): Record<string, unknown> {
	if (!isRecord(result)) throw new Error("coach returned an invalid result");
	const interrupts = result.__interrupt__;
	if (Array.isArray(interrupts) && interrupts.length > 0) {
		const first = interrupts[0];
		return {
			status: "needs_input",
			interrupt: isRecord(first) ? first.value : first,
		};
	}
	const messages = result.messages;
	if (!Array.isArray(messages)) throw new Error("coach result has no messages");
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isAssistantMessage(message)) continue;
		const text = textContent(message.content);
		if (text !== undefined) return { status: "completed", message: text };
	}
	throw new Error("coach result has no public message");
}

function textContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts = content.flatMap((block) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string"
			? [block.text]
			: [],
	);
	return texts.length ? texts.join("\n") : undefined;
}
function isAssistantMessage(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	if (value.type === "ai") return true;
	const getType = value._getType;
	return typeof getType === "function" && getType.call(value) === "ai";
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
