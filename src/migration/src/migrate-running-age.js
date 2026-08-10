#!/usr/bin/env node
// Migrate the declared running age from legacy data/<user>/running_profile.json
// into an existing MySQL user_profile row. Dry-run is the default; --commit is
// the only write mode. Injuries and every other legacy field are ignored.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  connect,
  ensureRunningAgeColumn,
  formatUpdatedAt,
  parseMysqlConfig,
  updateRunningAgeIfUnknown,
} from "./mysql.js";
import { readUserJsonFile, selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
const DEFAULT_DATA_DIR = resolve(PROJECT_DIR, "..", "..", "data");

export const RUNNING_AGE_VALUES = new Set([
  "lt_6m",
  "6m_1y",
  "1y_3y",
  "3y_plus",
]);

export function normalizeRunningAge(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim() === "lt6m" ? "lt_6m" : value.trim();
  return RUNNING_AGE_VALUES.has(normalized) ? normalized : null;
}

export function runningAgeFromJson(source) {
  const current = source && typeof source === "object" ? source.current : null;
  if (!current || typeof current !== "object") return null;
  return normalizeRunningAge(current.running_age ?? current.running_age_range);
}

export function emptyReport() {
  return { migrated: 0, skipped: 0, missing: 0, failed: 0 };
}

function usage() {
  process.stdout.write(`migrate-running-age — legacy running profile -> user_profile

Usage: node src/migrate-running-age.js [options]

  --commit           Write values. Default is dry-run (no writes).
  --user <selector> Restrict to a real user UUID or data/.slug_aliases.json alias.
                     Repeatable; comma-separated values are accepted.
  --data-dir <path> Root holding <uuid>/running_profile.json. Default:
                     STRIDE_DATA_DIR or the repo-root data/ dir.
  --ensure-schema    Add user_profile.running_age_range when it is absent.
  --help             Show this help.

Only UUIDs in src/users.js are eligible. The report contains counts only.
`);
}

function loadDotEnv(dir) {
  for (const file of [".env", ".env.local"]) {
    let text;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      "data-dir": { type: "string" },
      "ensure-schema": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const requested = values.user
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    commit: values.commit,
    dataDir: values["data-dir"],
    ensureSchema: values["ensure-schema"],
    help: values.help,
    requested,
  };
}

function loadAliases(dataDir) {
  let text;
  try {
    text = readFileSync(join(dataDir, ".slug_aliases.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const aliases = JSON.parse(text);
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error("slug aliases must be a JSON object");
  }
  return aliases;
}

export async function runRunningAgeMigration({
  dataDir,
  requested = [],
  commit = false,
  connection = null,
  aliases = {},
  allowlist = REAL_USERS,
  now = new Date(),
}) {
  const { ids, rejected } = selectUserIds(allowlist, requested, Infinity, aliases);
  const report = emptyReport();
  report.skipped += rejected.length;

  for (const userId of ids) {
    let source;
    try {
      source = readUserJsonFile(dataDir, userId, "running_profile.json");
    } catch {
      report.failed++;
      continue;
    }
    if (source == null) {
      report.missing++;
      continue;
    }

    const runningAge = runningAgeFromJson(source);
    if (runningAge == null) {
      report.failed++;
      continue;
    }
    if (!commit) {
      report.migrated++;
      continue;
    }

    try {
      const updated = await updateRunningAgeIfUnknown(
        connection,
        userId,
        runningAge,
        now instanceof Date ? formatUpdatedAt(now) : now,
      );
      if (updated) report.migrated++;
      else report.skipped++;
    } catch {
      report.failed++;
    }
  }
  return report;
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const dataDir = options.dataDir || process.env.STRIDE_DATA_DIR || DEFAULT_DATA_DIR;
  const aliases = loadAliases(dataDir);
  let connection = null;
  try {
    if (options.commit) {
      connection = await connect(parseMysqlConfig(process.env));
      if (options.ensureSchema) await ensureRunningAgeColumn(connection);
    }
    const report = await runRunningAgeMigration({
      dataDir,
      requested: options.requested,
      commit: options.commit,
      connection,
      aliases,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.failed > 0 ? 1 : 0;
  } finally {
    if (connection) await connection.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch(() => process.exit(2));
}
