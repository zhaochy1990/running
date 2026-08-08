/**
 * MySQL connection for coach-agent persistence (checkpoints + store).
 *
 * Local dev default targets the Docker MySQL (root / root_password @ 127.0.0.1:3306,
 * database `coach_agent`). Override via COACH_AGENT_MYSQL_* env vars.
 */

import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";

export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function readMySqlConfig(): MySqlConfig {
  return {
    host: process.env.COACH_AGENT_MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.COACH_AGENT_MYSQL_PORT ?? "3306"),
    user: process.env.COACH_AGENT_MYSQL_USER ?? "root",
    password: process.env.COACH_AGENT_MYSQL_PASSWORD ?? "root_password",
    database: process.env.COACH_AGENT_MYSQL_DATABASE ?? "coach_agent",
  };
}

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
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${assertIdentifier(config.database)}\` ` +
        `CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
  } finally {
    await conn.end();
  }
}

export function createPool(config: MySqlConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
  });
}

/**
 * Pool for the `stride` data DB. Pins `timezone: "Z"` so mysql2 reads/writes
 * DATETIME columns as UTC — matching the storage convention that every
 * `stride`/`coros.db` timestamp is UTC ISO 8601 (see AGENTS.md timezone rule).
 * The config comes from the coach config's `data_store` block via
 * `readStrideMySqlConfig` (config/config.ts).
 */
export function createStridePool(config: MySqlConfig): Pool {
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
