/** Explicit, manually invoked POC. No SQL, HTTP service, jobs, or Coach integration. */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, type ModelConfig } from "@stride/common";
import { z } from "zod/v4";
import { createRunDirectory, savePrivate, saveProfile } from "./files.js";
import { generateProfile } from "./generate.js";
import { ProfileSchema, SnapshotSchema } from "./types.js";

const [snapshotPath, outputPath, configPath, modelName, ...previousPaths] = process.argv.slice(2);
if (!snapshotPath || !outputPath || !configPath || !modelName)
  throw new Error(
    "usage: poc <snapshot.json> <new-private-run-dir> <model-config.yaml> <model-name> [previous-profile.json ...]; set model API key in environment",
  );
const snapshot = SnapshotSchema.parse(JSON.parse(await readFile(resolve(snapshotPath), "utf8")));
const previous = await Promise.all(previousPaths.map(async (path) => ProfileSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")))));
const registry = z
  .object({
    models: z.array(
      z.object({
        name: z.string(),
        model: z.string(),
        endpoint: z.url(),
        api_key_env: z.string(),
        api_kind: z.enum(["responses", "chat-completions"]),
        max_tokens: z.number(),
        timeout_s: z.number(),
        reasoning_effort: z.enum(["low", "medium", "high", "max"]).optional(),
      }),
    ),
  })
  .parse(
    loadConfig({
      schema: { models: { format: Array, default: [] }, agents: { format: Array, default: [] }, observability: { default: {} } },
      configFiles: [resolve(configPath)],
      strict: false,
    }),
  );
const model = registry.models.find((m) => m.name === modelName);
if (!model) throw new Error(`Unknown model registry name: ${modelName}`);
const settings = z
  .object({
    maxOutputTokens: z.coerce.number().int().positive(),
    reasoningEffort: z.enum(["low", "medium", "high"]),
  })
  .parse({ maxOutputTokens: process.env.PROFILE_MAX_OUTPUT_TOKENS ?? "32768", reasoningEffort: process.env.PROFILE_REASONING_EFFORT ?? "high" });
const runConfig: ModelConfig = { ...model, max_tokens: settings.maxOutputTokens, reasoning_effort: settings.reasoningEffort, timeout_s: 300 };
const reuseDirectory = process.env.PROFILE_REVIEW_RUN;
const reuse = reuseDirectory
  ? {
      profile: ProfileSchema.parse(JSON.parse(await readFile(resolve(reuseDirectory, "profile.json"), "utf8"))),
      analysis: JSON.parse(await readFile(resolve(reuseDirectory, "analysis.json"), "utf8")) as unknown,
      feedback: process.env.PROFILE_REVIEW_FEEDBACK
        ? await readFile(resolve(process.env.PROFILE_REVIEW_FEEDBACK), "utf8")
        : "独立复查已完成探索，修正数值、分类、来源与越界用途，代码值不可改。",
      sourceRun: resolve(reuseDirectory),
    }
  : undefined;
if (reuseDirectory) {
  // Early POC analysis stored model-facing brief entries. Recover their full
  // immutable references from the original child_report journal, not inference.
  if (reuse) {
    const state = z
      .object({ workers: z.array(z.object({ worker: z.string(), attempt: z.number(), entries: z.array(z.record(z.string(), z.unknown())) }).passthrough()) })
      .parse(reuse.analysis);
    if (state.workers.some((w) => w.entries.some((e) => !Array.isArray(e.evidence)))) {
      const events = (await readFile(resolve(reuseDirectory, "agent-trace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const worker of state.workers) {
        const event = events.find((e) => e.type === "child_report" && e.worker === worker.worker && e.attempt === worker.attempt);
        if (!event || !Array.isArray(event.entries)) throw new Error("Full saved child report missing from journal");
        worker.entries = event.entries;
      }
      reuse.analysis = state;
    }
  }
  const metrics = z.object({ model: z.literal("deepseek-flash") }).parse(JSON.parse(await readFile(resolve(reuseDirectory, "metrics.json"), "utf8")));
  if (!metrics.model) throw new Error("Invalid saved model");
}
await createRunDirectory(resolve(outputPath));
let events = Promise.resolve();
const result = await generateProfile(
  snapshot,
  runConfig,
  previous,
  (event) => {
    events = events.then(() => appendFile(resolve(outputPath, "agent-trace.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 }));
    return events;
  },
  reuse,
);
await saveProfile(resolve(outputPath), result.profile);
await savePrivate(resolve(outputPath), "analysis.json", result.analysis);
await savePrivate(resolve(outputPath), "metrics.json", result.metrics);
await writeFile(
  resolve(outputPath, "coverage.md"),
  `${[
    "# 十维覆盖与处理状态",
    "空维度是本轮未获得可发布内容，不解释为用户没有相关经历、目标或限制。",
    [
      "|维度|条目|代码条目|探索状态|",
      "|---|---:|---:|---|",
      ...result.analysis.coverage.map(
        (c) =>
          `|${c.title}|${c.entries}|${c.codeEntries}|${c.relevantWorkers.map((w) => `${w.worker}:${w.status}${w.error ? `（${w.error}）` : ""}`).join("；") || "按现有来源直接计算／无可探索来源"}|`,
      ),
    ].join("\n"),
  ].join("\n\n")}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  JSON.stringify({
    output: resolve(outputPath),
    conclusions: result.profile.conclusions.length,
    durationMs: result.metrics.durationMs,
    model: result.metrics.model,
    modelCalls: result.metrics.modelCalls,
    usage: result.metrics.usage,
  }),
);
