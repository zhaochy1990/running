import mysql from "mysql2/promise";
import type { MySqlConfig } from "../config.js";

// NOTE: this module is DB bootstrap/provisioning (create-database + pool factory),
// not table read/write. AGENTS.md's SQL-ownership rule governs the storage seams;
// the only table this runtime reads is the athlete `stride` data behind
// `data/mysqlDataProvider.ts` — plan-job *state* is Go's `jobs` table and is
// reached through the internal API, never a pool from here (ADR 0033).
// `ensureDatabase`'s CREATE DATABASE runs once at service start, before any
// storage code, so it is outside that read/write rule.

/** Reject anything that isn't a plain identifier (defends the DDL interpolation). */
function assertIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe MySQL database name: ${name}`);
  }
  return name;
}

/** Create the target database if it doesn't exist (connect without a db first). */
export async function ensureDatabase(config: MySqlConfig): Promise<void> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${assertIdentifier(config.database)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  } finally {
    await conn.end();
  }
}

/**
 * Pool for the coach persistence DB (LangGraph checkpoints). No `timezone: "Z"`:
 * it must match the chat service's persistence pool (same database, shared
 * mysql2 session convention) so checkpoint timestamps serialize identically.
 * Plan-job state is no longer read here at all — Go owns `jobs` and is reached
 * through the internal API (ADR 0033), so nothing in the worker compares
 * heartbeats in SQL any more.
 */
export function createPool(config: MySqlConfig): mysql.Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: false,
  });
}

/**
 * Read-only-style pool for the athlete `stride` DB. Pins `timezone: "Z"` so
 * mysql2 reads/writes DATETIME columns as UTC (AGENTS.md timezone rule).
 */
export function createStridePool(config: MySqlConfig): mysql.Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
  });
}
