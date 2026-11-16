/** Run agent-authored arithmetic in a separate WASM JavaScript interpreter. */
import { getQuickJS } from "quickjs-emscripten";
import type { Snapshot } from "./types.js";

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
    const rows = snapshot.evidence.filter((e) => e.active);
    const serialized = JSON.stringify(rows);
    // No host functions, process, filesystem, module loader, network or secrets
    // are installed in this interpreter. All rows are frozen private copies.
    // A Function constructor keeps agent code out of the audit closure's scope.
    const program = `(() => {
      const original = JSON.parse(${JSON.stringify(serialized)});
      const freeze = o => { if(o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
      freeze(original);
      let readInput = false;
      const get = Reflect.get, ownKeys = Reflect.ownKeys, descriptor = Reflect.getOwnPropertyDescriptor;
      const sources = new Proxy(original, {
        get(target, property) { readInput = true; return get(target, property); },
        ownKeys(target) { readInput = true; return ownKeys(target); },
        getOwnPropertyDescriptor(target, property) { readInput = true; return descriptor(target, property); }
      });
      const stringify = JSON.stringify;
      const result = new Function('sources', ${JSON.stringify(`"use strict";\n${code}`)})(sources);
      if(result === undefined || (result && typeof result.then === 'function')) throw Error('Return a synchronous JSON result');
      // Return the audit bit separately from agent-controlled JSON serialization.
      return { serialized: stringify(result), readInput };
    })()`;
    const evaluated = context.evalCode(program);
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(`Calculation failed: ${JSON.stringify(error)}`);
    }
    const serializedHandle = context.getProp(evaluated.value, "serialized");
    const readHandle = context.getProp(evaluated.value, "readInput");
    const serializedResult = context.getString(serializedHandle);
    const readInput = context.dump(readHandle) === true;
    serializedHandle.dispose();
    readHandle.dispose();
    evaluated.value.dispose();
    if (serializedResult.length > 50000) throw new Error("Result too large; return summaries and sample IDs, or page the records");
    // Conservative POC dependency: a query can depend on records it excludes or
    // on their absence. The host binds the entire input, never IDs returned by
    // agent-authored code. This is an input scope, not a supporting sample count.
    return { result: JSON.parse(serializedResult) as unknown, inspectedIds: rows.map((e) => e.id), readInput };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
