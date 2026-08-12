/**
 * Copy non-TypeScript assets from `src/` into `dist/`, preserving structure.
 *
 * `tsc` only emits `.js`/`.d.ts` and ignores everything else, so runtime assets
 * that live next to the source — currently the Agent Skills under
 * `src/agents/skills/**` (SKILL.md + any bundled files) — never reach `dist/`.
 * The deep agent loads skills from the compiled tree, so they must be copied.
 *
 * Pure Node stdlib (no deps); run after `tsc` via `npm run build`.
 */

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> coach_agent/
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

// Source-only extensions that `tsc` handles (or that make no sense in dist).
const SKIP_EXT = new Set([".ts", ".tsx"]);

async function* walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

async function main() {
	try {
		await stat(SRC);
	} catch {
		console.error(`copy-assets: source dir not found: ${SRC}`);
		process.exit(1);
	}

	let copied = 0;
	for await (const file of walk(SRC)) {
		if (SKIP_EXT.has(extname(file))) continue;
		const rel = relative(SRC, file);
		const dest = join(DIST, rel);
		await mkdir(dirname(dest), { recursive: true });
		await cp(file, dest);
		copied += 1;
		console.log(`  ${rel}`);
	}
	console.log(`copy-assets: copied ${copied} asset(s) src/ -> dist/`);
}

await main();
