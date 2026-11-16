import { SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { buildModel, type ModelConfig } from "@stride/common";
import { createAgent, createMiddleware } from "langchain";
import { z } from "zod/v4";
import type { ProfileAgentSession } from "./agentSession.js";
import { journalToolCall } from "./agentTools.js";

export class FlashRuntime {
  readonly failures: Array<{ agent: string; index: number; durationMs: number; error: string }> = [];
  readonly calls: Array<{ agent: string; index: number; durationMs: number; inputTokens: number; outputTokens: number; totalTokens: number }> = [];
  private attempts = 0;
  get attemptedCalls() {
    return this.attempts;
  }
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(
    readonly config: ModelConfig,
    readonly record: (event: unknown) => Promise<void>,
    readonly signal: AbortSignal,
  ) {
    if (config.model !== "deepseek-flash") throw new Error("Training profile POC tests may only use deepseek-flash");
  }

  async child<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= 3) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      this.signal.throwIfAborted();
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async run(
    name: string,
    session: ProfileAgentSession,
    tools: StructuredToolInterface[],
    prompt: string,
    input: string,
    done: () => boolean,
    maxCalls: number,
  ) {
    let local = 0;
    const middleware = createMiddleware({
      name: "ProfileRunLifecycle",
      beforeModel: { canJumpTo: ["end"], hook: () => (done() ? { jumpTo: "end" } : undefined) },
      wrapToolCall: (request, handler) => journalToolCall(session, request.toolCall, () => handler(request)),
      wrapModelCall: async (request, handler) => {
        this.signal.throwIfAborted();
        if (local >= maxCalls || this.attempts >= 150) throw new Error("Profile POC model-call budget exhausted");
        const index = ++this.attempts,
          round = ++local,
          started = performance.now();
        try {
          const remaining = maxCalls - round;
          const reminder =
            name === "master"
              ? "检查旧认识、独立复算后收口；剩余轮次少时停止新增任务，优先修正submit_profile_review的校验问题。"
              : remaining <= 5
                ? "停止新增探索，绑定已有成功计算（reuse_calculation），修订假设并立即收口；最后2轮必须提交已有有效结果，允许空数组。"
                : round >= 6
                  ? "现在优先记录并检验1–2个有价值的假设；先前探索计算可reuse，避免重复查数。"
                  : "先完成少量有用认识的支持/反证，再扩展。";
          const response = await handler({
            ...request,
            systemMessage: new SystemMessage(`${prompt}\n当前模型轮次${round}/${maxCalls}，剩余${remaining}轮。${reminder}`),
          });
          const parsed = z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() }).safeParse(response.usage_metadata);
          const usage = parsed.success ? parsed.data : null;
          const metrics = {
            agent: name,
            index,
            durationMs: Math.round(performance.now() - started),
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            totalTokens: usage?.total_tokens ?? 0,
          };
          this.calls.push(metrics);
          const text =
            typeof response.content === "string"
              ? response.content
              : response.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
          await this.record({
            type: "model",
            ...metrics,
            round,
            model: this.config.model,
            usageAvailable: usage !== null,
            text,
            toolCalls: response.tool_calls ?? [],
            providerResponseId: response.id,
          });
          console.log(JSON.stringify({ agent: name, round, index, tools: (response.tool_calls ?? []).map((t) => t.name), tokens: metrics.totalTokens }));
          return response;
        } catch (error) {
          this.failures.push({
            agent: name,
            index,
            durationMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.message : String(error),
          });
          await this.record({ type: "model_failure", agent: name, index, round, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    });
    const model = buildModel({ ...this.config, api_kind: "responses" });
    // OpenAI SDK retries are already disabled by LangChain; disable its caller's
    // default retries too, so each budgeted attempt is one provider request.
    model.caller = new AsyncCaller({ maxRetries: 0 });
    const agent = createAgent({ name, model, tools, systemPrompt: prompt, middleware: [middleware] });
    await this.record({ type: "agent_start", agent: name, model: this.config.model, maxCalls, input });
    await agent.invoke({ messages: [{ role: "user", content: input }] }, { recursionLimit: maxCalls * 6 + 10, signal: this.signal });
    if (!done()) throw new Error(`${name} stopped without submitting a result`);
  }
}
