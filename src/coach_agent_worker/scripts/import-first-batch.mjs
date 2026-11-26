// Run after pnpm --filter @stride/coach-agent-worker... build.
import { importFirstBatch, loadFirstBatch } from "../dist/src/eval/benchmark.js";

const [mode, manifest, state] = process.argv.slice(2);
try {
  if (!manifest || !["--check", "--apply"].includes(mode) || (mode === "--apply" && !state)) {
    throw new Error("usage: import-first-batch.mjs --check <private-manifest> | --apply <private-manifest> <private-state>");
  }
  if (mode === "--check") {
    const { manifest: checked } = await loadFirstBatch(manifest);
    console.log(JSON.stringify({ checked: 8, snapshots: checked.snapshots, rolling_sources: checked.rolling_sources }));
  } else {
    console.log(JSON.stringify(await importFirstBatch(manifest, process.env.PLAN_EVAL_ADMIN_ORIGIN ?? "", process.env.PLAN_EVAL_ADMIN_TOKEN ?? "", state)));
  }
} catch (error) {
  // Never print Zod operands, request bodies, tokens or private source contents.
  console.error(error instanceof SyntaxError ? "invalid JSON in private manifest, snapshot, source or import state" : error instanceof Error ? error.message : "first-batch import failed");
  process.exitCode = 1;
}
