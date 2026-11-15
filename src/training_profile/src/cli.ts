/** Explicit, manually invoked POC. No SQL, HTTP service, jobs, or Coach integration. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, type ModelConfig } from "@stride/common";
import { z } from "zod/v4";
import { createRunDirectory, savePrivate, saveProfile } from "./files.js";
import { generateProfile } from "./generate.js";
import { ProfileSchema, SnapshotSchema } from "./types.js";

const [snapshotPath, outputPath, configPath, modelName, previousPath] = process.argv.slice(2);
if (!snapshotPath || !outputPath || !configPath || !modelName)
  throw new Error(
    "usage: poc <snapshot.json> <new-private-run-dir> <model-config.yaml> <model-name> [previous-profile.json]; set model API key in environment",
  );
const snapshot = SnapshotSchema.parse(JSON.parse(await readFile(resolve(snapshotPath), "utf8")));
const previous = previousPath ? ProfileSchema.parse(JSON.parse(await readFile(resolve(previousPath), "utf8"))) : null;
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
await createRunDirectory(resolve(outputPath));
const result = await generateProfile(snapshot, model as ModelConfig, previous, (raw) => savePrivate(resolve(outputPath), "model-response.json", raw));
await saveProfile(resolve(outputPath), result.profile);
await savePrivate(resolve(outputPath), "metrics.json", result.metrics);
console.log(JSON.stringify({ output: resolve(outputPath), conclusions: result.profile.conclusions.length, ...result.metrics }));
