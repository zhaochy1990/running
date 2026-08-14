#!/usr/bin/env node
// Backfill activities.start_gps_* from each activity's first valid timeseries
// GPS pair. The CLI is dry-run by default and processes one indexed activity
// lookup at a time to avoid recreating the all-history GROUP BY load spike.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { connect, parseMysqlConfig } from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const ACTIVITY_COUNTS_SQL = `
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(start_gps_lat IS NOT NULL AND start_gps_lon IS NOT NULL), 0) AS cached,
  COALESCE(SUM(start_gps_lat IS NULL AND start_gps_lon IS NULL), 0) AS missing,
  COALESCE(SUM((start_gps_lat IS NULL) <> (start_gps_lon IS NULL)), 0) AS partial
FROM activities
WHERE user_id = ?`;

function missingActivitiesSQL(limit) {
  return `
SELECT label_id
FROM activities
WHERE user_id = ? AND label_id > ?
  AND start_gps_lat IS NULL AND start_gps_lon IS NULL
ORDER BY label_id
LIMIT ${limit}`;
}

const FIRST_VALID_GPS_SQL = `
SELECT gps_lat, gps_lon
FROM timeseries FORCE INDEX (idx_timeseries_user_label)
WHERE user_id = ? AND label_id = ?
  AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
  AND gps_lat BETWEEN -90 AND 90 AND gps_lon BETWEEN -180 AND 180
  AND NOT (gps_lat = 0 AND gps_lon = 0)
ORDER BY id
LIMIT 1`;

const UPDATE_ACTIVITY_START_SQL = `
UPDATE activities
SET start_gps_lat = ?, start_gps_lon = ?
WHERE user_id = ? AND label_id = ?
  AND start_gps_lat IS NULL AND start_gps_lon IS NULL`;

const VERIFY_ACTIVITY_START_SQL = `
SELECT start_gps_lat, start_gps_lon
FROM activities
WHERE user_id = ? AND label_id = ?`;

function number(row, key) {
  return Number(row?.[key] ?? 0);
}

function emptyReport(commit) {
  return {
    mode: commit ? "commit" : "dry-run",
    users: 0,
    total: 0,
    already_cached: 0,
    missing: 0,
    scanned: 0,
    fillable: 0,
    updated: 0,
    verified: 0,
    no_valid_gps: 0,
    skipped_concurrent: 0,
    failed: 0,
  };
}

export async function runActivityStartGPSBackfill({
  connection,
  userIds,
  commit = false,
  batchSize = 25,
  delayMs = 25,
  maxActivities = Infinity,
}) {
  if (!connection) throw new Error("MySQL connection is required");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("batchSize must be an integer from 1 to 500");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("delayMs must be non-negative");
  }
  if (maxActivities !== Infinity && (!Number.isInteger(maxActivities) || maxActivities < 1)) {
    throw new Error("maxActivities must be a positive integer");
  }
  const report = emptyReport(commit);
  for (const userId of userIds) {
    report.users++;
    const [countRows] = await connection.execute(ACTIVITY_COUNTS_SQL, [userId]);
    const counts = countRows[0] || {};
    report.total += number(counts, "total");
    report.already_cached += number(counts, "cached");
    report.missing += number(counts, "missing");
    report.failed += number(counts, "partial");

    let cursor = "";
    while (report.scanned < maxActivities) {
      const limit = Math.min(batchSize, maxActivities - report.scanned);
      const [activities] = await connection.execute(missingActivitiesSQL(limit), [
        userId, cursor,
      ]);
      if (activities.length === 0) break;
      for (const activity of activities) {
        cursor = activity.label_id;
        report.scanned++;
        try {
          const [points] = await connection.execute(FIRST_VALID_GPS_SQL, [
            userId, activity.label_id,
          ]);
          if (points.length === 0) {
            report.no_valid_gps++;
          } else {
            report.fillable++;
            if (commit) {
              const point = points[0];
              const [result] = await connection.execute(UPDATE_ACTIVITY_START_SQL, [
                point.gps_lat, point.gps_lon, userId, activity.label_id,
              ]);
              if (result.affectedRows === 0) {
                report.skipped_concurrent++;
              } else {
                report.updated++;
                const [rows] = await connection.execute(VERIFY_ACTIVITY_START_SQL, [
                  userId, activity.label_id,
                ]);
                const stored = rows[0];
                if (
                  !stored || Number(stored.start_gps_lat) !== Number(point.gps_lat) ||
                  Number(stored.start_gps_lon) !== Number(point.gps_lon)
                ) {
                  throw new Error("activity start GPS readback mismatch");
                }
                report.verified++;
              }
            }
          }
        } catch {
          report.failed++;
        }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return report;
}

function loadDotEnv(dir, env) {
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
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in env)) env[key] = value;
    }
  }
}

export function parseActivityStartGPSCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      "batch-size": { type: "string", default: "25" },
      "delay-ms": { type: "string", default: "25" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const maxActivities = values.limit == null ? Infinity : Number(values.limit);
  const batchSize = Number(values["batch-size"]);
  const delayMs = Number(values["delay-ms"]);
  if (maxActivities !== Infinity && (!Number.isInteger(maxActivities) || maxActivities < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("--batch-size must be an integer from 1 to 500");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }
  return {
    commit: values.commit,
    requestedUsers: values.user.flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase()).filter(Boolean),
    maxActivities, batchSize, delayMs, help: values.help,
  };
}

function usage() {
  process.stdout.write("backfill-activity-start-gps - timeseries to activities.start_gps_*\n\n" +
    "Usage: npm run migrate:activity-start-gps -- [options]\n\n" +
    "  --commit           Write and verify cached starts. Default is dry-run.\n" +
    "  --user <uuid>      Real-user UUID from src/users.js; repeatable/comma-separated.\n" +
    "  --limit <n>        Scan at most n missing activities across selected users.\n" +
    "  --batch-size <n>   Keyset page size, 1-500 (default 25).\n" +
    "  --delay-ms <n>     Delay after every activity lookup (default 25ms).\n" +
    "  --help             Show this help.\n\n" +
    "MySQL uses STRIDE_WORKER_MYSQL_DSN or the discrete MYSQL_* variables.\n" +
    "Only real users declared in src/users.js are eligible. Output contains counts only.\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  loadDotEnv(PROJECT_DIR, env);
  const options = parseActivityStartGPSCli(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const { ids, rejected } = selectUserIds(REAL_USERS, options.requestedUsers);
  if (rejected.length > 0) {
    throw new Error("--user is not in src/users.js real-user allowlist: " + rejected.join(","));
  }
  if (ids.length === 0) throw new Error("no real users selected");
  const connection = await connect(parseMysqlConfig(env));
  try {
    const report = await runActivityStartGPSBackfill({
      connection, userIds: ids, commit: options.commit,
      batchSize: options.batchSize, delayMs: options.delayMs,
      maxActivities: options.maxActivities,
    });
    process.stdout.write(JSON.stringify(report) + "\n");
    return report.failed > 0 ? 1 : 0;
  } finally {
    await connection.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write("fatal: " + (error?.message || "migration failed") + "\n");
    process.exitCode = 2;
  });
}
