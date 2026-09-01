import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvironment } from "@stride/common";

const API_CONFIG_BASE = "coach-api.yaml";
const COACH_CONFIG_BASE = "coach.yaml";

/**
 * Absolute path to this package's `config/` directory
 * (`<repoRoot>/src/coach_agent_api/config`). Runtime modules live at
 * `<repoRoot>/src/coach_agent_api/dist/<subDir>/<file>` when compiled, so the
 * package root is two directories up from the module.
 */
function resolveApiConfigDir(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  return join(moduleDir, "..", "..", "config");
}

/**
 * Absolute path to the repository-root `config/` directory, used by the shared
 * `coach.yaml` agent registry (a separate, cross-package config). The Coach API's
 * own YAML config lives beside this package and is resolved by `resolveApiConfigDir`.
 *
 * Runtime modules live at `<repoRoot>/src/coach_agent_api/dist/<subDir>/<file>`
 * when compiled, so the repo root is four directories up from the module.
 */
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

/** Absolute config file path(s) for `coach_agent` (base + environment overlay). */
export function coachAgentConfigFiles(moduleUrl: string): string[] {
  const env = resolveEnvironment();
  const dir = resolveRootConfigDir(moduleUrl);
  const files: string[] = [];
  const base = join(dir, COACH_CONFIG_BASE);
  if (existsSync(base)) {
    files.push(base);
  }
  const overlay = overlayPath(dir, COACH_CONFIG_BASE, env);
  if (existsSync(overlay)) {
    files.push(overlay);
  }
  return files;
}

/** Absolute config file path(s) for the Coach API (base + environment overlay). */
export function coachApiConfigFiles(moduleUrl: string): string[] {
  const env = resolveEnvironment();
  const dir = resolveApiConfigDir(moduleUrl);
  const files = [join(dir, API_CONFIG_BASE)];
  const overlay = overlayPath(dir, API_CONFIG_BASE, env);
  if (existsSync(overlay)) {
    files.push(overlay);
  }
  return files;
}
