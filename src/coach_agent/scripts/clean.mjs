/**
 * Remove the `dist/` build output so the next build starts clean.
 *
 * Neither `tsc` nor `copy-assets` prune files whose source was renamed/deleted
 * (e.g. a renamed skill dir would leave a stale duplicate SKILL.md in dist and
 * get loaded twice). Running this before every build guarantees `dist/` mirrors
 * `src/`. Pure Node stdlib.
 */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> coach_agent/
await rm(join(ROOT, "dist"), { recursive: true, force: true });
console.log("clean: removed dist/");
