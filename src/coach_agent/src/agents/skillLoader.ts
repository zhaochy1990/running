import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Skills are copied from `src/skills/**` to `dist/skills/**` by `npm run build`
// (see scripts/copy-assets.mjs). This module lives at `dist/agents/skillLoader.js`,
// so `..` resolves to `dist/` and `skills` to `dist/skills/`.
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Read a SKILL.md body (YAML frontmatter stripped) for inlining into a prompt. */
export function loadSkillMarkdown(name: string): string {
  const raw = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
  return stripFrontmatter(raw).trim();
}

function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}
