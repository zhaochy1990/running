import assert from "node:assert/strict";
import test from "node:test";
import { createLangfuseCallbackHandler, isLangfuseEnabled, maskSensitiveData, withLangfuseInvokeTracing } from "./langfuse.js";

const KEYS = ["LANGFUSE_TRACING", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_REDACT_CONTENT"] as const;

type LangfuseEnv = Partial<Record<(typeof KEYS)[number], string | undefined>>;

function withEnv(env: LangfuseEnv, fn: () => void): void {
  const previous = Object.fromEntries(KEYS.map((k) => [k, process.env[k] as string | undefined]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      const prev = previous[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

test("isLangfuseEnabled is false without credentials", () => {
  withEnv({ LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined, LANGFUSE_BASE_URL: undefined }, () => {
    assert.equal(isLangfuseEnabled(), false);
  });
});

test("isLangfuseEnabled is true when credentials are set", () => {
  withEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://cloud.langfuse.com" }, () => {
    assert.equal(isLangfuseEnabled(), true);
  });
});

test("LANGFUSE_TRACING=false disables even with credentials", () => {
  withEnv(
    {
      LANGFUSE_TRACING: "false",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
    },
    () => {
      assert.equal(isLangfuseEnabled(), false);
    },
  );
});

test("maskSensitiveData passes content through by default", () => {
  withEnv({ LANGFUSE_REDACT_CONTENT: undefined }, () => {
    const input = { role: "user", content: "今天跑量多少？", count: 3 };
    assert.deepEqual(maskSensitiveData({ data: input }), input);
  });
});

test("maskSensitiveData redacts content but keeps structural keys", () => {
  withEnv({ LANGFUSE_REDACT_CONTENT: "true" }, () => {
    const input = {
      role: "user",
      content: "我今天跑了 10 公里",
      tool: "get_activities_by_date_range",
      args: { start_date: "2026-08-01" },
      count: 3,
    };
    const masked = maskSensitiveData({ data: input }) as Record<string, unknown>;
    assert.equal(masked.role, "user");
    assert.equal(masked.tool, "get_activities_by_date_range");
    assert.equal(typeof masked.content, "string");
    assert.match(masked.content as string, /^\[redacted:\d+ chars\]$/);
    // Argument KEY is preserved; the VALUE is redacted (metadata-only convention).
    const args = masked.args as Record<string, unknown>;
    assert.ok("start_date" in args);
    assert.match(args.start_date as string, /^\[redacted:\d+ chars\]$/);
    assert.equal(masked.count, 3);
  });
});

test("maskSensitiveData bounds arrays", () => {
  withEnv({ LANGFUSE_REDACT_CONTENT: "true" }, () => {
    const masked = maskSensitiveData({ data: { messages: Array.from({ length: 400 }, (_, i) => `msg-${i}`) } }) as {
      messages: unknown[];
    };
    assert.equal(masked.messages.length, 201); // 200 kept + `[+200 more]`
  });
});

test("createLangfuseCallbackHandler returns undefined when disabled", () => {
  withEnv({ LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined, LANGFUSE_BASE_URL: undefined }, () => {
    assert.equal(createLangfuseCallbackHandler({ userId: "u", sessionId: "s" }), undefined);
  });
});

test("createLangfuseCallbackHandler returns a handler when enabled", () => {
  withEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://cloud.langfuse.com" }, () => {
    const handler = createLangfuseCallbackHandler({ userId: "u", sessionId: "s", tags: ["coach-agent"] });
    assert.ok(handler);
  });
});

test("withLangfuseInvokeTracing is a passthrough when disabled", async () => {
  withEnv({ LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined, LANGFUSE_BASE_URL: undefined }, async () => {
    let calls = 0;
    const original = async (input: unknown, config?: Record<string, unknown>) => {
      calls += 1;
      return { input, config };
    };
    const agent = { invoke: original };
    const wrapped = withLangfuseInvokeTracing(agent);
    assert.equal(wrapped, agent);
    assert.equal(agent.invoke, original);
    const result = await agent.invoke({ x: 1 }, { context: { userId: "u" } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { input: { x: 1 }, config: { context: { userId: "u" } } });
  });
});

test("withLangfuseInvokeTracing injects a callbacks handler when enabled", async () => {
  withEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://cloud.langfuse.com" }, async () => {
    let seenConfig: Record<string, unknown> | undefined;
    const original = async (_input: unknown, config?: Record<string, unknown>) => {
      seenConfig = config;
      return { ok: true };
    };
    const agent = { invoke: original };
    const wrapped = withLangfuseInvokeTracing(agent);
    const result = await wrapped.invoke({ messages: [] }, { context: { userId: "u" }, configurable: { thread_id: "t1" } });
    assert.deepEqual(result, { ok: true });
    const callbacks = seenConfig?.callbacks as unknown[];
    assert.ok(Array.isArray(callbacks));
    assert.equal(callbacks.length, 1);
  });
});
