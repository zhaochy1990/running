/**
 * Agent observability middleware.
 *
 * Under `createDeepAgent` there is no hand-written node (like the legacy
 * `getQaNode`) where you can see each LLM turn and its tool calls. This
 * middleware restores that visibility via the two framework hooks:
 *
 *   - `wrapModelCall`  → one log line per LLM call (bound tools going in, the
 *     tool calls the model chose + latency coming out).
 *   - `wrapToolCall`   → one log line per tool execution (name + latency).
 *
 * Privacy (AGENTS.md HARD rule: prompts / responses / tokens never hit logs):
 * we log **metadata only** — tool names, message counts, arg *keys*, durations.
 * No message content, no argument values, no model output text.
 *
 * Scope note: middleware only observes the agent it is attached to. Deep-agent
 * subagents have their own middleware stack, so attach a (scoped) instance to
 * each subagent too if you want their turns logged. Use
 * {@link createLoggingMiddleware} to tag each scope distinctly.
 */

import { createMiddleware } from "langchain";
import { getLogger } from "../logging/index.js";

/** Best-effort tool name from a bound tool (ClientTool has `name`; ServerTool is opaque). */
function toolName(tool: unknown): string {
    return (tool as { name?: string })?.name ?? "<unknown>";
}

/**
 * Build a logging middleware scoped to a logger namespace (e.g. `"agent"`,
 * `"agent:qa"`), so main-agent and subagent turns stay filterable in the logs.
 */
export function createLoggingMiddleware(scope = "agent") {
    const log = getLogger(scope);

    return createMiddleware({
        name: `LoggingMiddleware(${scope})`,

        // One LLM call: what tools were bound → what the model decided to call.
        wrapModelCall: async (request, handler) => {
            const startedAt = Date.now();
            log.info(
                {
                    messages: request.messages.length,
                    boundTools: request.tools.map(toolName),
                },
                "request send to LLM,",
            );
            log.info(request.messages);

            const response = await handler(request);

            const toolCalls = response.tool_calls ?? [];
            log.info(
                {
                    ms: Date.now() - startedAt,
                    toolCalls: toolCalls.map((call) => call.name),
                    done: toolCalls.length === 0,
                },
                "response received from LLM,",
            );
            return response;
        },

        // One tool execution: name + latency (arg keys only, never values).
        wrapToolCall: async (request, handler) => {
            const startedAt = Date.now();
            const name = request.toolCall.name;
            log.info({ tool: name, argKeys: Object.keys(request.toolCall.args ?? {}) }, "before tool execution,");

            try {
                const result = await handler(request);
                log.info({ tool: name, ms: Date.now() - startedAt }, "after tool execution,");
                return result;
            } catch (error) {
                log.warn(
                    { tool: name, ms: Date.now() - startedAt, err: (error as Error).message },
                    "tool ✗",
                );
                throw error;
            }
        },
    });
}
