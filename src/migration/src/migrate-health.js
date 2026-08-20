#!/usr/bin/env node
// migrate-health.js — migrate the four watch health-domain tables from each
// user's local coros.db SQLite snapshot into the Tencent MySQL tables read by
// the Go worker (src/go/):
//   daily_health · daily_hrv · dashboard · race_predictions
//
// The source coros.db files are the per-user watch databases downloaded from
// prod Azure Files into the repo-root data/<uuid>/ dir. This migration reads
// them read-only; it never touches prod storage.
//
// SAFE BY DEFAULT: runs in dry-run mode (reads SQLite, prints a per-table plan,
// never writes) unless you pass --commit.
//
//   node src/migrate-health.js                       # dry-run, all real users
//   node src/migrate-health.js --user <uuid>         # one real user (repeatable)
//   node src/migrate-health.js --tables daily_health,daily_hrv
//   node src/migrate-health.js --data-dir <path>     # override the data/ root
//   node src/migrate-health.js --commit              # actually upsert into MySQL
//   node src/migrate-health.js --commit --ensure-schema
//
// ONLY the real users listed in src/users.js are ever migrated; every other UUID
// is a test account and is discarded (src/migration/AGENTS.md). See README.md.
//
// Requires Node >= 22.5 for the built-in node:sqlite reader (health-source.js).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { readHealthTables } from "./health-source.js";
import {
  HEALTH_TABLES,
  HealthTransformError,
  transformRow,
} from "./health-transform.js";
import {
  connect,
  ensureSchema,
  formatUpdatedAt,
  parseMysqlConfig,
  splitSqlStatements,
  upsertHealthRow,
} from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
// PROJECT_DIR = <repo>/src/migration → the repo-root data/ dir is two up.
const DEFAULT_DATA_DIR = resolve(PROJECT_DIR, "..", "..", "data");

function usage() {
  process.stdout.write(
    `migrate-health — local coros.db health tables -> Tencent MySQL

Usage: node src/migrate-health.js [options]

  --commit           Actually write to MySQL. Default is dry-run (no writes).
  --user <uuid>      Restrict to a user UUID. Repeatable; also accepts a comma
                     list. Must be in the real-user allowlist (src/users.js);
                     anything else is ignored. Default: all real users.
  --tables <list>    Comma list of health tables to migrate. Default: all four
                     (${HEALTH_TABLES.join(", ")}).
  --data-dir <path>  Root holding <uuid>/coros.db. Default: STRIDE_DATA_DIR or
                     the repo-root data/ dir.
  --limit <n>        Process at most n users.
  --ensure-schema    Apply schema.sql (CREATE TABLE IF NOT EXISTS) before writing.
  --verbose          Log every row upsert (default logs per-table counts).
  --help             Show this help.

MySQL env (or .env in this directory): see .env.example — either
STRIDE_WORKER_MYSQL_DSN or the discrete MYSQL_* vars.
`,
  );
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
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      tables: { type: "string" },
      "data-dir": { type: "string" },
      limit: { type: "string" },
      "ensure-schema": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const users = values.user
    .flatMap((u) => u.split(","))
    .map((u) => u.trim())
    .filter(Boolean);

  const tables = (values.tables ? values.tables.split(",") : HEALTH_TABLES)
    .map((t) => t.trim())
    .filter(Boolean);
  const unknown = tables.filter((t) => !HEALTH_TABLES.includes(t));
  if (unknown.length > 0) {
    throw new Error(
      `unknown --tables ${unknown.join(",")} (valid: ${HEALTH_TABLES.join(", ")})`,
    );
  }

  const limit = values.limit != null ? Number(values.limit) : Infinity;
  if (!(limit > 0)) throw new Error(`--limit must be a positive number`);

  return {
    commit: values.commit,
    ensureSchema: values["ensure-schema"],
    verbose: values.verbose,
    help: values.help,
    users,
    tables,
    dataDir: values["data-dir"],
    limit,
  };
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const dataDir = opts.dataDir || process.env.STRIDE_DATA_DIR || DEFAULT_DATA_DIR;
  console.log(
    `mode=${opts.commit ? "COMMIT" : "dry-run"} data=${dataDir} ` +
      `tables=${opts.tables.join(",")} allowlist=${REAL_USERS.length} real user(s)`,
  );

  const { ids, rejected } = selectUserIds(REAL_USERS, opts.users, opts.limit);
  for (const r of rejected) {
    console.warn(`  ignore --user ${r}: not in real-user allowlist (test account)`);
  }
  console.log(`selected ${ids.length} user(s)\n`);

  const now = formatUpdatedAt();

  // Planned rows, grouped by table: { table: [row, …] }.
  const planned = Object.fromEntries(opts.tables.map((t) => [t, []]));
  const errors = [];
  const skipped = [];

  for (const uid of ids) {
    let tablesRows;
    try {
      tablesRows = readHealthTables(dataDir, uid, opts.tables);
    } catch (err) {
      errors.push({ id: uid, kind: "read", message: err.message });
      console.error(`  ERROR reading ${uid}: ${err.message}`);
      continue;
    }
    if (tablesRows == null) {
      skipped.push(uid);
      console.warn(`  skip ${uid}: no coros.db under ${dataDir}`);
      continue;
    }

    const counts = [];
    for (const table of opts.tables) {
      const srcRows = tablesRows[table] || [];
      let ok = 0;
      for (const src of srcRows) {
        try {
          planned[table].push(transformRow(table, uid, src, now));
          ok++;
        } catch (err) {
          const message =
            err instanceof HealthTransformError ? err.message : String(err);
          errors.push({ id: uid, kind: table, message });
          console.error(`  ERROR ${table} ${uid}: ${message}`);
        }
      }
      counts.push(`${table}=${ok}`);
    }
    console.log(`  plan ${uid}  ${counts.join("  ")}`);
  }

  const totals = opts.tables
    .map((t) => `${t}=${planned[t].length}`)
    .join(", ");
  console.log(
    `\nplanned rows [${totals}], skipped ${skipped.length}, errors ${errors.length}`,
  );

  if (!opts.commit) {
    console.log(
      "\ndry-run complete — nothing written. Re-run with --commit to apply.",
    );
    return errors.length > 0 ? 1 : 0;
  }

  const totalRows = opts.tables.reduce((n, t) => n + planned[t].length, 0);
  if (totalRows === 0) {
    console.log("\nnothing to write.");
    return errors.length > 0 ? 1 : 0;
  }

  // ── write phase ────────────────────────────────────────────────────────────
  const dbConfig = parseMysqlConfig(process.env);
  console.log(
    `\nconnecting to mysql ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}${dbConfig.ssl ? " (tls)" : ""}`,
  );
  const conn = await connect(dbConfig);
  const tally = Object.fromEntries(opts.tables.map((t) => [t, 0]));
  try {
    if (opts.ensureSchema) {
      const ddl = readFileSync(join(PROJECT_DIR, "schema.sql"), "utf8");
      for (const stmt of splitSqlStatements(ddl)) {
        await ensureSchema(conn, stmt);
      }
      console.log("ensured health-domain schema");
    }
    for (const table of opts.tables) {
      for (const row of planned[table]) {
        try {
          // The row is upserted (OnConflict{UpdateAll}); we count total rows
          // written rather than splitting insert/update, since ODKU
          // affectedRows is not a reliable insert-vs-update signal across the
          // mysql2 protocol. The before/after row counts are the source of
          // truth for whether anything was created vs. overwritten.
          await upsertHealthRow(conn, table, row);
          tally[table]++;
          if (opts.verbose) {
            const key = row.date || row.race_type || row.user_id;
            console.log(`  upserted ${table} ${row.user_id} ${key}`);
          }
        } catch (err) {
          errors.push({ id: row.user_id, kind: table, message: err.message });
          console.error(
            `  ERROR upserting ${table} ${row.user_id}: ${err.message}`,
          );
        }
      }
    }
  } finally {
    await conn.end();
  }

  const summary = opts.tables.map((t) => `${t}(upserted ${tally[t]})`).join(", ");
  console.log(`\ncommit complete — ${summary}, errors ${errors.length}`);
  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(2);
  });
