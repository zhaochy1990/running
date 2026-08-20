#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { connect, formatUpdatedAt, parseMysqlConfig } from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";
import {
  normalizePhaseNames,
  PhaseNameMigrationError,
} from "./master-plan-phase-enum.js";

const PROJECT_DIR = join(import.meta.dirname, "..");

function usage() {
  process.stdout.write(`migrate-master-plan-phase-enum — normalize master_plan phase names to the English enum

Rewrites the active structured master plan's phases[].name to
base/build/speed/marathon/taper/recovery and back-fills weeks[].phase_name
from each week's phase_id (reviewed per-user mapping in
src/master-plan-phase-enum.js). Idempotent: documents that already satisfy
the enum contract are skipped.

Usage: node src/migrate-master-plan-phase-enum.js [options]

  --commit           Write values. Default is dry-run (no writes).
  --user <selector>  Restrict to a real user UUID or data/.slug_aliases.json
                     alias. Repeatable; comma-separated values are accepted.
  --limit <n>        Process at most n users (dry-run or commit).
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
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const limit = values.limit == null ? Infinity : Number(values.limit);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const requested = values.user
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return { commit: values.commit, requested, limit, help: values.help };
}

function emptyReport() {
  return {
    dry_run: null,
    users: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    conflicts: 0,
    missing: 0,
    rejected: 0,
    details: {},
  };
}

/**
 * Run the migration for the selected real users. Pure enough for unit tests:
 * `connection` is used read-only in dry-run mode (no writes unless commit),
 * and `now` is injectable.
 */
export async function runPhaseEnumMigration({
  requested = [],
  limit = Infinity,
  commit = false,
  connection = null,
  aliases = {},
  allowlist = REAL_USERS,
  now = new Date(),
}) {
  const { ids, rejected } = selectUserIds(allowlist, requested, limit, aliases);
  const report = emptyReport();
  report.dry_run = !commit;
  report.rejected += rejected.length;

  for (const userId of ids) {
    report.users++;
    let rows;
    try {
      [rows] = await connection.query(
        `SELECT plan_id, revision, content
           FROM master_plan
          WHERE user_id = ? AND content_version = 2 AND status = 'active'`,
        [userId],
      );
    } catch (error) {
      report.failed++;
      report.details[userId] = { error: String(error?.message ?? error) };
      continue;
    }
    if (rows.length === 0) {
      report.missing++;
      report.details[userId] = { plan_id: null, changes: [], skipped: true };
      continue;
    }
    const row = rows[0];
    let content;
    try {
      content = typeof row.content === "string" ? JSON.parse(row.content) : row.content;
    } catch {
      report.failed++;
      report.details[userId] = { plan_id: row.plan_id, error: "content is not valid JSON" };
      continue;
    }
    let normalized;
    try {
      normalized = normalizePhaseNames(content, userId);
    } catch (error) {
      const phaseError = error instanceof PhaseNameMigrationError;
      if (phaseError) {
        report.failed++;
        report.details[userId] = { plan_id: row.plan_id, error: error.message };
        continue;
      }
      throw error;
    }
    if (normalized.changes.length === 0) {
      report.skipped++;
      report.details[userId] = { plan_id: row.plan_id, changes: [], skipped: true };
      continue;
    }
    if (!commit) {
      report.migrated++;
      report.details[userId] = {
        plan_id: row.plan_id,
        revision: row.revision,
        changes: normalized.changes,
        skipped: false,
      };
      continue;
    }
    try {
      const [update] = await connection.query(
        `UPDATE master_plan
            SET content = ?, revision = revision + 1, updated_at = ?
          WHERE plan_id = ? AND revision = ? AND content_version = 2 AND status = 'active'`,
        [JSON.stringify(normalized.content), formatUpdatedAt(now), row.plan_id, row.revision],
      );
      if (update.affectedRows === 1) {
        report.migrated++;
        report.details[userId] = {
          plan_id: row.plan_id,
          revision: row.revision + 1,
          changes: normalized.changes,
          skipped: false,
        };
      } else {
        report.conflicts++;
        report.details[userId] = { plan_id: row.plan_id, error: "revision conflict", changes: normalized.changes };
      }
    } catch (error) {
      report.failed++;
      report.details[userId] = { plan_id: row.plan_id, error: String(error?.message ?? error) };
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
  let aliases = {};
  try {
    aliases = JSON.parse(readFileSync(join(PROJECT_DIR, "..", "data", ".slug_aliases.json"), "utf8"));
  } catch {
    aliases = {};
  }
  let connection = null;
  try {
    connection = await connect(parseMysqlConfig(process.env));
    const report = await runPhaseEnumMigration({
      requested: options.requested,
      limit: options.limit,
      commit: options.commit,
      connection,
      aliases,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.failed > 0 || report.conflicts > 0 ? 1 : 0;
  } finally {
    if (connection) await connection.end();
  }
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code)).catch(() => process.exit(2));
}