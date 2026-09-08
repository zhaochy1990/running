import mysql from "mysql2/promise";
import type { MySqlConfig } from "../config.js";

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
 * Pool for the coach persistence DB (plan_jobs + LangGraph checkpoints). No
 * `timezone: "Z"`: it must match the chat service's persistence pool (same
 * database, shared mysql2 session convention) so enqueue-side and worker-side
 * plan_jobs timestamps serialize identically. The plan_jobs heartbeat window
 * is compared in-SQL on the same pool, so the round-trip is internally
 * consistent; these are internal job timestamps, not user-facing data.
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
