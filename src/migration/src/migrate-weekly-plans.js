#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";
import { makeWeeklyPlanSource, parseWeeklyPlanSourceConfig } from "./weekly-plan-azure.js";
import { migrateWeeklyPlans } from "./weekly-plan-migration.js";
import {
  connect,
  insertWeeklyPlan,
  listActiveWeeklyPlans,
  listMasterPlans,
  parseMysqlConfig,
} from "./mysql.js";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  process.stdout.write(`migrate-weekly-plans — Azure Table/Blob -> MySQL weekly_plan

Usage: node src/migrate-weekly-plans.js [options]

  --commit        Insert missing rows. Default is dry-run.
  --user <uuid>   Restrict to a real-user UUID. Repeatable or comma-separated.
  --allow-unowned-user <uuid>
                  Confirm a selected real user's plans are independent.
                  Repeatable or comma-separated.
  --limit <n>     Process at most n users.
  --help          Show this help.

The tool never updates an existing active row. Manual-review findings and
conflicts are emitted in the final JSON report.
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
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
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
      "allow-unowned-user": { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const requestedUsers = values.user
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const limit = values.limit == null ? Infinity : Number(values.limit);
  if (!(limit > 0)) throw new Error("--limit must be a positive number");
  const allowUnownedUsers = values["allow-unowned-user"]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return { commit: values.commit, requestedUsers, allowUnownedUsers, limit, help: values.help };
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  const { ids, rejected } = selectUserIds(REAL_USERS, options.requestedUsers, options.limit);
  for (const userId of rejected) {
    console.warn(`ignore --user ${userId}: not in src/users.js real-user allowlist`);
  }
  const selected = new Set(ids);
  const realUsers = new Set(REAL_USERS.map((userId) => userId.toLowerCase()));
  const invalidUnowned = options.allowUnownedUsers.filter(
    (userId) => !realUsers.has(userId) || !selected.has(userId),
  );
  if (invalidUnowned.length > 0) {
    throw new Error(`--allow-unowned-user must be selected real users: ${invalidUnowned.join(",")}`);
  }

  const source = makeWeeklyPlanSource(parseWeeklyPlanSourceConfig(process.env));
  const mysqlConfig = parseMysqlConfig(process.env);
  const connection = await connect(mysqlConfig);
  try {
    if (options.commit) await connection.beginTransaction();
    const target = {
      listActiveWeeklyPlans: (userId) => listActiveWeeklyPlans(connection, userId),
      listMasterPlans: (userId) => listMasterPlans(connection, userId),
      insertWeeklyPlan: (row) => insertWeeklyPlan(connection, row),
    };
    const report = await migrateWeeklyPlans({
      userIds: ids,
      source,
      target,
      apply: options.commit,
      allowUnownedUserIds: new Set(options.allowUnownedUsers),
    });
    if (options.commit) await connection.commit();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.stats.conflicts > 0 || report.stats.manual > 0 ? 1 : 0;
  } catch (error) {
    if (options.commit) await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(`fatal: ${error?.stack || error?.message || error}`);
    process.exit(2);
  });
