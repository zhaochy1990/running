import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvironment } from "@stride/common";

const WORKER_CONFIG_BASE = "coach-worker.yaml";
const COACH_CONFIG_BASE = "coach.yaml";

/**
 * Absolute path to this package's `config/` directory. Runtime modules live at
 * `<repoRoot>/src/coach_agent_worker/dist/<subDir>/<file>`, so the package root
 * is two directories up from the module.
 */
function resolveWorkerConfigDir(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  return join(moduleDir, "..", "..", "config");
}

/** Repo-root `config/` dir — home of the shared `coach.yaml` agent registry. */
function resolveRootConfigDir(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  return join(moduleDir, "..", "..", "..", "..", "config");
}

function overlayPath(dir: string, baseName: string, env: string): string {
  const extIndex = baseName.lastIndexOf(".");
  const stem = extIndex === -1 ? baseName : baseName.slice(0, extIndex);
  const ext = extIndex === -1 ? "" : baseName.slice(extIndex);
  return join(dir, `${stem}.${env}${ext}`);
}

/** Worker config files (base + environment overlay). */
export function workerConfigFiles(moduleUrl: string): string[] {
  const env = resolveEnvironment();
  const dir = resolveWorkerConfigDir(moduleUrl);
  const files = [join(dir, WORKER_CONFIG_BASE)];
  const overlay = overlayPath(dir, WORKER_CONFIG_BASE, env);
  if (existsSync(overlay)) files.push(overlay);
  return files;
}

/** Coach agent config files (base + overlay) at the repo root. */
export function coachAgentConfigFiles(moduleUrl: string): string[] {
  const env = resolveEnvironment();
  const dir = resolveRootConfigDir(moduleUrl);
  const files: string[] = [];
  const base = join(dir, COACH_CONFIG_BASE);
  if (existsSync(base)) files.push(base);
  const overlay = overlayPath(dir, COACH_CONFIG_BASE, env);
  if (existsSync(overlay)) files.push(overlay);
  return files;
}
