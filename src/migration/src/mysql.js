// mysql.js — Tencent MySQL connection + upsert for provider_credentials.
//
// Connection can be configured two ways (Option A wins if present):
//   A) STRIDE_WORKER_MYSQL_DSN — the Go worker's DSN, verbatim:
//        user:pass@tcp(host:port)/dbname?tls=true
//   B) discrete MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD /
//      MYSQL_DATABASE (+ MYSQL_SSL)
//
// The upsert mirrors the Go store's clause.OnConflict{UpdateAll:true}
// (src/go/internal/storage/watch.go :: SaveCredential).

import mysql from "mysql2/promise";

import {
  DAILY_HEALTH_COLUMNS,
  DAILY_HRV_COLUMNS,
  DASHBOARD_COLUMNS,
  RACE_PREDICTIONS_COLUMNS,
} from "./health-transform.js";

/**
 * Parse a Go-style DSN: `user:pass@tcp(host:port)/dbname?params`.
 * @returns {{host:string,port:number,user:string,password:string,database:string,tls:string|null}}
 */
export function parseGoDSN(dsn) {
  const m =
    /^(?:([^:@/]+)(?::([^@/]*))?@)?tcp\(([^)]+)\)\/([^?]*)(?:\?(.*))?$/.exec(
      dsn.trim(),
    );
  if (!m) throw new Error(`could not parse STRIDE_WORKER_MYSQL_DSN: ${dsn}`);
  const [, user = "", password = "", address, database, query = ""] = m;
  const colon = address.lastIndexOf(":");
  const host = colon >= 0 ? address.slice(0, colon) : address;
  const port = colon >= 0 ? Number(address.slice(colon + 1)) : 3306;
  const params = new URLSearchParams(query);
  return {
    host,
    port,
    user,
    password,
    database,
    tls: params.get("tls"),
  };
}

/**
 * Resolve a mysql2 connection config from environment variables (pure).
 * @returns {{host:string,port:number,user:string,password:string,database:string,ssl?:object}}
 */
export function parseMysqlConfig(env) {
  let base;
  let sslHint;
  if (env.STRIDE_WORKER_MYSQL_DSN && env.STRIDE_WORKER_MYSQL_DSN.trim()) {
    const dsn = parseGoDSN(env.STRIDE_WORKER_MYSQL_DSN);
    base = dsn;
    sslHint = dsn.tls; // DSN tls= wins
  } else {
    base = {
      host: env.MYSQL_HOST || "127.0.0.1",
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER || "root",
      password: env.MYSQL_PASSWORD || "",
      database: env.MYSQL_DATABASE || "stride",
    };
    sslHint = env.MYSQL_SSL || null;
  }
  if (!base.database) throw new Error("MySQL database name is required");

  const config = {
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: base.database,
    // datetime(6) values are handed in as pre-formatted UTC strings, so keep the
    // driver from re-interpreting them in a local zone.
    timezone: "Z",
    // BLOBs come back as Buffers (default), which is what we want.
  };
  const ssl = sslToOption(sslHint);
  if (ssl) config.ssl = ssl;
  return config;
}

function sslToOption(hint) {
  if (!hint) return null;
  const v = String(hint).trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "off") return null;
  if (v === "skip-verify" || v === "insecure") {
    return { rejectUnauthorized: false };
  }
  // "true" / "require" / "preferred" / anything else -> TLS with cert verification
  return { rejectUnauthorized: true };
}

/** Format a Date as MySQL datetime(6) in UTC: `YYYY-MM-DD HH:MM:SS.ffffff`. */
export function formatUpdatedAt(date = new Date()) {
  // toISOString() -> 2026-08-02T12:34:56.789Z (millisecond precision)
  const iso = date.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 23) + "000";
}

export async function connect(config) {
  return mysql.createConnection(config);
}

/** Execute one DDL statement (e.g. a single CREATE TABLE IF NOT EXISTS). */
export async function ensureSchema(conn, ddl) {
  await conn.query(ddl);
}

/**
 * Split a `.sql` file into individual statements so a multi-table schema can be
 * applied without enabling mysql2's `multipleStatements` (which `conn.query`
 * rejects by default). Full-line `--` comments are dropped *before* the split,
 * then statements are split on `;`.
 *
 * Invariant this relies on: every comment in schema.sql is on its own `--` line
 * (they may contain `;`), and no statement has a `;` inside a string literal or
 * a trailing/inline comment. That holds for schema.sql; a trailing inline
 * comment containing `;` would mis-split.
 */
export function splitSqlStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const UPSERT_SQL = `
INSERT INTO provider_credentials
  (user_id, provider, email, region, provider_user_id, secret, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  email = VALUES(email),
  region = VALUES(region),
  provider_user_id = VALUES(provider_user_id),
  secret = VALUES(secret),
  updated_at = VALUES(updated_at)`;

/**
 * Upsert one credential row.
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertCredential(conn, row, updatedAt) {
  const [res] = await conn.execute(UPSERT_SQL, [
    row.user_id,
    row.provider,
    row.email,
    row.region,
    row.provider_user_id,
    row.secret,
    updatedAt,
  ]);
  // mysql affectedRows: 1 = inserted, 2 = updated (an existing row changed),
  // 0 = matched but identical.
  return res.affectedRows === 1 ? "inserted" : "updated";
}

// ── user_profile / user_onboarding (profile+onboarding migration) ────────────
//
// Both upserts mirror the Go store's clause.OnConflict{UpdateAll:true} but keep
// created_at out of the UPDATE set so the original first-write time is preserved
// on re-runs (the Go user store lets GORM manage created_at the same way).

const UPSERT_PROFILE_SQL = `
INSERT INTO user_profile
  (user_id, display_name, dob, sex, height_cm, weight_kg, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  dob = VALUES(dob),
  sex = VALUES(sex),
  height_cm = VALUES(height_cm),
  weight_kg = VALUES(weight_kg),
  updated_at = VALUES(updated_at)`;

/**
 * Upsert one user_profile row. `now` is the shared run timestamp used for both
 * created_at (insert only) and updated_at.
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertUserProfile(conn, row, now) {
  const [res] = await conn.execute(UPSERT_PROFILE_SQL, [
    row.user_id,
    row.display_name,
    row.dob,
    row.sex,
    row.height_cm,
    row.weight_kg,
    now,
    now,
  ]);
  return res.affectedRows === 1 ? "inserted" : "updated";
}

const UPSERT_ONBOARDING_SQL = `
INSERT INTO user_onboarding
  (user_id, watch_ready, profile_ready, completed_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  watch_ready = VALUES(watch_ready),
  profile_ready = VALUES(profile_ready),
  completed_at = VALUES(completed_at),
  updated_at = VALUES(updated_at)`;

/**
 * Upsert one user_onboarding row. Booleans are bound as 0/1 (TINYINT(1)) and
 * completed_at may be a datetime(6) string or null.
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertUserOnboarding(conn, row, now) {
  const [res] = await conn.execute(UPSERT_ONBOARDING_SQL, [
    row.user_id,
    row.watch_ready ? 1 : 0,
    row.profile_ready ? 1 : 0,
    row.completed_at,
    now,
    now,
  ]);
  return res.affectedRows === 1 ? "inserted" : "updated";
}

// ── health domain (daily_health / daily_hrv / dashboard / race_predictions) ──
//
// The four watch health tables read by the Go worker
// (src/go/internal/storage/watch_models.go). Each upsert mirrors the Go store's
// clause.OnConflict{UpdateAll:true} — every non-PK column is overwritten on a
// re-run — and binds a row's values in the transform's column order.

/** Primary-key columns per health table (kept out of the UPDATE set). */
export const HEALTH_PK = {
  daily_health: ["user_id", "date"],
  daily_hrv: ["user_id", "date", "provider"],
  dashboard: ["user_id"],
  race_predictions: ["user_id", "race_type"],
};

const HEALTH_COLUMNS = {
  daily_health: DAILY_HEALTH_COLUMNS,
  daily_hrv: DAILY_HRV_COLUMNS,
  dashboard: DASHBOARD_COLUMNS,
  race_predictions: RACE_PREDICTIONS_COLUMNS,
};

/**
 * Build an `INSERT … ON DUPLICATE KEY UPDATE` for a table from its full column
 * list and primary-key columns. Every non-PK column is set to VALUES(col), so a
 * re-run overwrites the row exactly like GORM's OnConflict{UpdateAll}.
 */
export function buildUpsertSql(table, columns, pkColumns) {
  const pk = new Set(pkColumns);
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns
    .filter((c) => !pk.has(c))
    .map((c) => `${c} = VALUES(${c})`)
    .join(",\n  ");
  return (
    `INSERT INTO ${table}\n  (${columns.join(", ")})\n` +
    `VALUES (${placeholders})\n` +
    `ON DUPLICATE KEY UPDATE\n  ${updates}`
  );
}

const HEALTH_UPSERT_SQL = Object.fromEntries(
  Object.keys(HEALTH_COLUMNS).map((table) => [
    table,
    buildUpsertSql(table, HEALTH_COLUMNS[table], HEALTH_PK[table]),
  ]),
);

/**
 * Upsert one health-table row. The row is a plain object keyed by the table's
 * columns (as produced by health-transform.js); values are bound in column
 * order, undefined collapsing to SQL NULL.
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertHealthRow(conn, table, row) {
  const columns = HEALTH_COLUMNS[table];
  if (!columns) throw new Error(`unknown health table: ${table}`);
  const values = columns.map((c) => (row[c] === undefined ? null : row[c]));
  const [res] = await conn.execute(HEALTH_UPSERT_SQL[table], values);
  return res.affectedRows === 1 ? "inserted" : "updated";
}

// ── race_goal (training-goal migration) ──────────────────────────────────────
//
// The migrated row is the always-active goal (status='active', active_flag=1).
// created_at is kept out of the UPDATE set so a re-run preserves the original
// first-write instant (same discipline as the profile upsert); every other
// column is overwritten, mirroring the Go store's create/update semantics
// (src/go/internal/storage/goal.go). The PK is goal_id, so the caller must
// resolve a *stable* goal_id first (getActiveRaceGoalId to reuse a prior
// re-mint) — a re-run with a fresh random uuid would insert a second active row
// and collide on UNIQUE(user_id, active_flag).

const UPSERT_RACE_GOAL_SQL = `
INSERT INTO race_goal
  (goal_id, user_id, status, active_flag, race_date, race_distance, race_name,
   target_finish_time, weekly_training_days, available_time_slots,
   strength_willingness, race_location, race_timezone, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  user_id = VALUES(user_id),
  status = VALUES(status),
  active_flag = VALUES(active_flag),
  race_date = VALUES(race_date),
  race_distance = VALUES(race_distance),
  race_name = VALUES(race_name),
  target_finish_time = VALUES(target_finish_time),
  weekly_training_days = VALUES(weekly_training_days),
  available_time_slots = VALUES(available_time_slots),
  strength_willingness = VALUES(strength_willingness),
  race_location = VALUES(race_location),
  race_timezone = VALUES(race_timezone),
  updated_at = VALUES(updated_at)`;

/**
 * Upsert one race_goal row. `now` is the shared run timestamp used as a fallback
 * for created_at/updated_at when the blob carried no ISO instant (both are
 * normally present and preserved). active_flag is bound as 1 (the row is active).
 *
 * The inserted/updated outcome is decided by a PK (goal_id) pre-existence probe,
 * NOT by res.affectedRows. Unlike the profile/health upserts (whose updated_at
 * always advances to `now`, so a re-run genuinely changes the row and MySQL
 * returns affectedRows=2), this row's updated_at is carried verbatim from the
 * blob: a re-run rewrites identical values, and mysql2 reports affectedRows=1
 * for that no-op — indistinguishable from a fresh insert (also 1). The probe is
 * safe because the migration is single-connection and serial (no concurrent
 * writer can insert the same goal_id between the SELECT and the INSERT).
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertRaceGoal(conn, row, now) {
  const [existing] = await conn.execute(
    "SELECT 1 FROM race_goal WHERE goal_id = ? LIMIT 1",
    [row.goal_id],
  );
  const preExisted = existing.length > 0;
  await conn.execute(UPSERT_RACE_GOAL_SQL, [
    row.goal_id,
    row.user_id,
    row.status,
    row.active_flag,
    row.race_date,
    row.race_distance,
    row.race_name,
    row.target_finish_time,
    row.weekly_training_days,
    row.available_time_slots,
    row.strength_willingness,
    row.race_location,
    row.race_timezone,
    row.created_at ?? now,
    row.updated_at ?? now,
  ]);
  return preExisted ? "updated" : "inserted";
}

/**
 * Return the goal_id of the athlete's existing active race goal, or null when
 * none exists. Used to anchor the slug→uuid re-mint so re-runs are idempotent:
 * a slug goal whose row already exists reuses the previously minted uuid instead
 * of minting a fresh one (which would clobber the master-plan snapshot linkage).
 * @returns {Promise<string|null>}
 */
export async function getActiveRaceGoalId(conn, userId) {
  const [rows] = await conn.execute(
    "SELECT goal_id FROM race_goal WHERE user_id = ? AND status = 'active' LIMIT 1",
    [userId],
  );
  return rows.length > 0 ? rows[0].goal_id : null;
}

// ── master_plan (master-plan migration) ──────────────────────────────────────
//
// One active row per athlete (content_version 1=markdown or 2=structured), with
// content stored verbatim. created_at is carried from the source, so — like
// race_goal — a re-run rewrites identical values and mysql2 reports
// affectedRows=1 for that no-op; the inserted/updated outcome is therefore
// decided by a PK (plan_id) pre-existence probe, safe under the serial
// single-connection migration.

export const MASTER_PLAN_COLUMNS = [
  "plan_id",
  "user_id",
  "content_version",
  "content",
  "goal_id",
  "status",
  "active_flag",
  "version",
  "created_at",
  "updated_at",
];

const UPSERT_MASTER_PLAN_SQL = buildUpsertSql(
  "master_plan",
  MASTER_PLAN_COLUMNS,
  ["plan_id"],
);

/**
 * Upsert one master_plan row. `now` is the shared run timestamp used as a
 * fallback for created_at/updated_at when the source carried no instant.
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertMasterPlan(conn, row, now) {
  const [existing] = await conn.execute(
    "SELECT 1 FROM master_plan WHERE plan_id = ? LIMIT 1",
    [row.plan_id],
  );
  const preExisted = existing.length > 0;
  const values = MASTER_PLAN_COLUMNS.map((c) => {
    if (c === "created_at" || c === "updated_at") return row[c] ?? now;
    return row[c] === undefined ? null : row[c];
  });
  await conn.execute(UPSERT_MASTER_PLAN_SQL, values);
  return preExisted ? "updated" : "inserted";
}

/**
 * Return the plan_id of the athlete's existing active master plan of the given
 * content_version, or null. Used to anchor a minted v1 plan_id so re-runs are
 * idempotent (a fresh uuid would insert a second active row and collide on
 * UNIQUE(user_id, active_flag)).
 * @returns {Promise<string|null>}
 */
export async function getActiveMasterPlanId(conn, userId, contentVersion) {
  const [rows] = await conn.execute(
    "SELECT plan_id FROM master_plan WHERE user_id = ? AND content_version = ? AND status = 'active' LIMIT 1",
    [userId, contentVersion],
  );
  return rows.length > 0 ? rows[0].plan_id : null;
}

// ── weekly_plan (read-only backfill migration) ───────────────────────────────

export const WEEKLY_PLAN_COLUMNS = [
  "plan_id",
  "user_id",
  "master_plan_id",
  "week_start",
  "content_version",
  "content",
  "status",
  "status_slot",
  "revision",
  "created_at",
  "updated_at",
];

const INSERT_WEEKLY_PLAN_SQL = `
INSERT INTO weekly_plan
  (${WEEKLY_PLAN_COLUMNS.join(", ")})
VALUES (${WEEKLY_PLAN_COLUMNS.map(() => "?").join(", ")})`;

/** Insert only: an existing active slot is never overwritten. */
export async function insertWeeklyPlan(conn, row) {
  await conn.execute(
    INSERT_WEEKLY_PLAN_SQL,
    WEEKLY_PLAN_COLUMNS.map((column) => row[column] ?? null),
  );
}

/** Replace content fields of an existing active weekly plan without changing its identity. */
export async function replaceWeeklyPlan(conn, row) {
  await conn.execute(
    "UPDATE weekly_plan SET master_plan_id = ?, content_version = ?, content = ?, updated_at = ? WHERE plan_id = ? AND status = 'active'",
    [row.master_plan_id, row.content_version, row.content, row.updated_at, row.plan_id],
  );
}

export async function listActiveWeeklyPlans(conn, userId) {
  const [rows] = await conn.execute(
    "SELECT plan_id, user_id, master_plan_id, week_start, content_version, content " +
      "FROM weekly_plan WHERE user_id = ? AND status = 'active'",
    [userId],
  );
  return rows.map((row) => ({
    ...row,
    week_start: row.week_start instanceof Date
      ? row.week_start.toISOString().slice(0, 10)
      : String(row.week_start),
  }));
}

export async function listMasterPlans(conn, userId) {
  const [rows] = await conn.execute(
    "SELECT plan_id, content_version, content FROM master_plan WHERE user_id = ? AND active_flag = 1",
    [userId],
  );
  return rows;
}

// ── running age backfill (legacy running_profile.json) ───────────────────────

export const RUNNING_AGE_UPDATE_SQL =
  "UPDATE user_profile SET running_age_range = ?, updated_at = ? " +
  "WHERE user_id = ? AND running_age_range = 'unknown'";

/**
 * Conditionally update one existing unknown profile. The predicate is the
 * idempotency/concurrency guard; callers must treat affectedRows=0 as skipped.
 */
export async function updateRunningAgeIfUnknown(conn, userId, runningAge, now) {
  const [result] = await conn.execute(RUNNING_AGE_UPDATE_SQL, [
    runningAge,
    now,
    userId,
  ]);
  return result.affectedRows > 0;
}

/**
 * Add the column to an existing user_profile table without touching rows. The
 * CREATE TABLE definition in schema.sql covers fresh databases; this helper is
 * for the already-created table used by the one-time backfill.
 */
export async function ensureRunningAgeColumn(conn) {
  const [rows] = await conn.execute(
    "SELECT COUNT(*) AS column_count FROM information_schema.columns " +
      "WHERE table_schema = DATABASE() AND table_name = 'user_profile' " +
      "AND column_name = 'running_age_range'",
  );
  if (Number(rows[0]?.column_count ?? 0) === 0) {
    await conn.execute(
      "ALTER TABLE user_profile ADD COLUMN running_age_range VARCHAR(16) " +
        "NOT NULL DEFAULT 'unknown'",
    );
    return true;
  }
  return false;
}
