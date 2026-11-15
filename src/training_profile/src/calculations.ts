/** Run agent-authored arithmetic in a separate WASM JavaScript interpreter. */
import { getQuickJS } from "quickjs-emscripten";
import { z } from "zod/v4";
import type { Snapshot } from "./types.js";

const CalculationResult = z.object({ result: z.unknown(), inspectedIds: z.array(z.string()) });

export async function calculateSnapshot(snapshot: Snapshot, code: string, timeoutMs = 2500) {
  if (code.length > 24000) throw new Error("Calculation too long; split it into smaller checks");
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(96 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const serialized = JSON.stringify(snapshot.evidence.filter((e) => e.active));
    // No host functions, process, filesystem, module loader, network or secrets
    // are installed in this interpreter. All rows are frozen private copies.
    // A Function constructor keeps agent code out of the audit closure's scope.
    const program = `(() => {
      const original = JSON.parse(${JSON.stringify(serialized)});
      const inspected = new Set();
      const freeze = o => { if(o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
      const sources = Object.freeze(original.map(row => new Proxy(freeze(row), {
        get(target, property) { inspected.add(target.id); return Reflect.get(target, property); },
        ownKeys(target) { inspected.add(target.id); return Reflect.ownKeys(target); }
      })));
      const stringify = JSON.stringify;
      const result = new Function('sources', ${JSON.stringify(`"use strict";\n${code}`)})(sources);
      if(result === undefined || (result && typeof result.then === 'function')) throw Error('Return a synchronous JSON result');
      return stringify({ result, inspectedIds: [...inspected] });
    })()`;
    const evaluated = context.evalCode(program);
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(`Calculation failed: ${JSON.stringify(error)}`);
    }
    const serializedResult = context.getString(evaluated.value);
    evaluated.value.dispose();
    if (serializedResult.length > 50000) throw new Error("Result too large; return summaries and sample IDs, or page the records");
    return CalculationResult.parse(JSON.parse(serializedResult));
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
